'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  baseDiskName,
  compareSemanticVersions,
  cpuUsage,
  HistoryStore,
  isPhysicalDiskName,
  parseCpuTimes,
  parseDiskStats,
  parseIpv4Addresses,
  parseMemInfo,
  parseMountTable,
  parseNetwork,
  parseServiceChecks,
  parseSocketStats,
  parseSmartctlJson,
  redactSnapshot,
  scheduleKey,
  validateSmartSchedule,
} = require('../server');

test('parses aggregate Linux CPU counters', () => {
  const result = parseCpuTimes('cpu  100 10 50 800 20 5 5 0\ncpu0 50 5 25 400 10 2 3 0');
  assert.deepEqual(result, { idle: 820, total: 990 });
});

test('calculates CPU usage from two samples', () => {
  const result = cpuUsage({ idle: 870, total: 1100 }, { idle: 820, total: 990 });
  assert.equal(Math.round(result), 55);
});

test('parses Linux memory totals as bytes', () => {
  const result = parseMemInfo('MemTotal:       1000 kB\nMemAvailable:    250 kB\nSwapTotal:       500 kB\nSwapFree:        300 kB');
  assert.equal(result.totalBytes, 1024000);
  assert.equal(result.usedBytes, 768000);
  assert.equal(result.usage, 75);
  assert.equal(result.swapUsedBytes, 204800);
});

test('aggregates active network interfaces and ignores loopback', () => {
  const text = `Inter-| Receive | Transmit
 face |bytes packets errs drop fifo frame compressed multicast|bytes packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
  eth0: 500 2 0 0 0 0 0 0 250 2 0 0 0 0 0 0`;
  const result = parseNetwork(text);
  assert.equal(result.rxBytes, 500);
  assert.equal(result.txBytes, 250);
  assert.equal(result.interfaces.length, 1);
  assert.equal(result.interfaces[0].name, 'eth0');
});

test('extracts host addresses and socket counts from proc network tables', () => {
  const trie = [
    ' +-- 192.168.1.25',
    '    /32 host LOCAL',
    ' +-- 127.0.0.1',
    '    /32 host LOCAL',
  ].join('\n');
  assert.deepEqual(parseIpv4Addresses(trie), ['192.168.1.25']);

  const header = 'sl local_address rem_address st tx_queue rx_queue';
  const tcp = `${header}\n0: 0100007F:1F90 00000000:0000 0A 0:0 0:0\n1: 0100007F:1F91 0100007F:C001 01 0:0 0:0`;
  const udp = `${header}\n0: 00000000:14E9 00000000:0000 07 0:0 0:0`;
  assert.deepEqual(parseSocketStats(tcp, '', udp, ''), { tcp: 2, established: 1, listening: 1, udp: 1 });
});

test('keeps usable host mounts and ignores virtual filesystems', () => {
  const result = parseMountTable([
    '/dev/sda2 / ext4 rw,relatime 0 0',
    '/dev/sdb1 /mnt/archive xfs rw,relatime 0 0',
    'tmpfs /run tmpfs rw,nosuid,nodev 0 0',
    'proc /proc proc rw,nosuid,nodev 0 0',
  ].join('\n'));
  assert.deepEqual(result, [
    { mount: '/', source: '/dev/sda2', filesystem: 'ext4' },
    { mount: '/mnt/archive', source: '/dev/sdb1', filesystem: 'xfs' },
  ]);
});

test('keeps metric history for the 24-hour and 30-day chart ranges', () => {
  const store = new HistoryStore('');
  const now = Date.parse('2026-08-10T12:00:00.000Z');
  const snapshotAt = (timestamp, cpuUsageValue, memoryUsage, diskUsage, rx, tx) => ({
    timestamp: new Date(timestamp).toISOString(),
    cpu: { usage: cpuUsageValue },
    memory: { usage: memoryUsage },
    disk: { usage: diskUsage },
    network: { rxBytesPerSecond: rx, txBytesPerSecond: tx },
  });

  store.record(snapshotAt(now - 26 * 60 * 60 * 1000, 11, 22, 33, 44, 55), now - 26 * 60 * 60 * 1000);
  store.record(snapshotAt(now - 2 * 60 * 60 * 1000, 66, 77, 88, 99, 111), now - 2 * 60 * 60 * 1000);
  const history = store.summary(now);

  assert.equal(history.last24Hours.length, 1);
  assert.equal(history.last24Hours[0].cpuUsage, 66);
  assert.equal(history.last30Days.length, 2);
  assert.equal(history.last30Days[0].diskUsage, 33);
  assert.equal(history.persistent, false);
});

test('recognizes whole physical disks and maps common partition names', () => {
  assert.equal(isPhysicalDiskName('sda'), true);
  assert.equal(isPhysicalDiskName('nvme0n1'), true);
  assert.equal(isPhysicalDiskName('sda1'), false);
  assert.equal(isPhysicalDiskName('loop0'), false);
  assert.equal(baseDiskName('/dev/sdb3'), 'sdb');
  assert.equal(baseDiskName('/dev/nvme0n1p2'), 'nvme0n1');
});

test('parses Linux diskstats counters for physical disks only', () => {
  const result = parseDiskStats([
    '8 0 sda 10 0 20 0 30 0 40 0 0 500 0 0 0 0 0',
    '8 1 sda1 1 0 2 0 3 0 4 0 0 5 0',
    '259 0 nvme0n1 100 2 300 4 500 6 700 8 0 900 10',
  ].join('\n'));
  assert.deepEqual(result.sda, {
    readsCompleted: 10,
    sectorsRead: 20,
    writesCompleted: 30,
    sectorsWritten: 40,
    ioMilliseconds: 500,
  });
  assert.equal(result.sda1, undefined);
  assert.equal(result.nvme0n1.writesCompleted, 500);
});

test('parses ATA and NVMe SMART summaries', () => {
  const ata = parseSmartctlJson({
    device: { protocol: 'ATA' },
    smart_status: { passed: true },
    temperature: { current: 34 },
    power_on_time: { hours: 1234 },
    power_cycle_count: 42,
    ata_smart_attributes: { table: [{ id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw: { value: 0 }, when_failed: '' }] },
  });
  assert.equal(ata.healthPassed, true);
  assert.equal(ata.temperatureCelsius, 34);
  assert.equal(ata.attributes[0].raw, '0');

  const nvme = parseSmartctlJson({
    device: { protocol: 'NVMe' },
    model_name: 'Fast NVMe',
    serial_number: 'NVME-SERIAL',
    nvme_smart_health_information_log: { critical_warning: 0, temperature: 31, power_on_hours: 500, power_cycles: 12, percentage_used: 3, available_spare: 97, media_errors: 0 },
  });
  assert.equal(nvme.healthPassed, true);
  assert.equal(nvme.percentageUsed, 3);
  assert.equal(nvme.mediaErrors, 0);
  assert.equal(nvme.availableSpare, 97);
  assert.equal(nvme.model, 'Fast NVMe');

  assert.equal(parseSmartctlJson({
    smartctl: { exit_status: 2 },
    messages: [{ string: 'Permission denied' }],
  }), null);
});

test('compares release versions without treating branch builds as outdated releases', () => {
  assert.equal(compareSemanticVersions('v1.2.3', '1.2.4'), -1);
  assert.equal(compareSemanticVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(compareSemanticVersions('1.2.3-rc.1', '1.2.3'), -1);
  assert.equal(compareSemanticVersions('main-sha-abcdef0', '1.2.3'), null);
});

test('validates SMART schedules and detects their due minute', () => {
  const schedule = validateSmartSchedule({
    short: { enabled: true, frequency: 'weekly', dayOfWeek: 1, hour: 3, minute: 15 },
    long: { enabled: true, frequency: 'monthly', dayOfMonth: 10, hour: 4, minute: 30 },
  });
  const monday = new Date(2026, 7, 10, 3, 15, 0);
  assert.match(scheduleKey(schedule.short, 'short', monday), /^short:/);
  assert.throws(() => validateSmartSchedule({
    short: { enabled: true, frequency: 'hourly', hour: 3, minute: 0 },
    long: { enabled: true, frequency: 'monthly', dayOfMonth: 31, hour: 4, minute: 0 },
  }), /daily or weekly|between 1 and 28/);
});

test('parses typed service checks and ignores unsafe definitions', () => {
  const checks = parseServiceChecks('SSH=tcp:127.0.0.1:22;Database=process:postgres;Home=http:http://127.0.0.1/health;bad=process:foo$rm');
  assert.deepEqual(checks.map((check) => [check.name, check.type]), [
    ['SSH', 'tcp'],
    ['Database', 'process'],
    ['Home', 'http'],
  ]);
});

test('demo redaction hides host, serial, mount, process, interface, and service targets', () => {
  const snapshot = {
    dashboardName: 'Private',
    machine: { hostname: 'secret-host' },
    system: { topProcesses: [{ pid: 1, name: 'private-process' }] },
    mounts: [{ mount: '/media/archive', path: '/media/archive', source: '/dev/sdb1' }],
    physicalDisks: [{ name: 'sdb', device: '/dev/sdb', serial: 'SERIAL', mounts: [{ mount: '/media/archive' }] }],
    network: { interfaces: [{ name: 'eth0' }] },
    services: [{ target: 'http://secret.local' }],
    events: [{ title: 'Service failure', message: 'secret path' }],
    alerts: { active: [{ key: 'mount:/secret', message: '/secret is full' }] },
  };
  const result = redactSnapshot(snapshot, true);
  assert.equal(result.privacyMode, true);
  assert.equal(result.machine.hostname, 'hidden');
  assert.equal(result.physicalDisks[0].serial, null);
  assert.equal(result.mounts[0].source, 'hidden');
  assert.equal(result.system.topProcesses[0].name, 'hidden');
  assert.equal(result.network.interfaces[0].name, 'interface-1');
  assert.equal(result.services[0].target, 'hidden');
  assert.equal(result.alerts.active[0].key, 'alert-1');
});
