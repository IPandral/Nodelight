'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cpuUsage, HistoryStore, parseCpuTimes, parseMemInfo, parseMountTable, parseNetwork } = require('../server');

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
