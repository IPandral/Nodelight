'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST_PROC = process.env.HOST_PROC || '/proc';
const HOST_SYS = process.env.HOST_SYS || '/sys';
const HOST_ETC = process.env.HOST_ETC || '/etc';
const HOST_ROOT = process.env.HOST_ROOT || path.parse(process.cwd()).root;
const DATA_DIR = process.env.DATA_DIR || '';
if (DATA_DIR && process.platform !== 'win32') process.umask(0o002);
const HISTORY_FILE = DATA_DIR ? path.join(DATA_DIR, 'metrics-history.ndjson') : '';
const HISTORY_SAMPLE_INTERVAL_MS = 60 * 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_MAX_POINTS = 360;
const SETTINGS_FILE = DATA_DIR ? path.join(DATA_DIR, 'settings.json') : '';
const EVENTS_FILE = DATA_DIR ? path.join(DATA_DIR, 'events.ndjson') : '';
const SMART_ENABLED = /^(1|true|yes)$/i.test(process.env.SMART_ENABLED || '');
const SMARTCTL_PATH = process.env.SMARTCTL_PATH || 'smartctl';
const SMART_DEVICE_ROOT = process.env.SMART_DEVICE_ROOT || '/host/dev';
const HOST_VAR_LOG = process.env.HOST_VAR_LOG || path.join(HOST_ROOT, 'var', 'log');
const SMART_CACHE_MS = 5 * 60 * 1000;
const SERVICE_CHECK_INTERVAL_MS = 30 * 1000;
const VERSION_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const JSON_BODY_LIMIT = 16 * 1024;
const DEMO_MODE = /^(1|true|yes)$/i.test(process.env.DEMO_MODE || '');
const APPLICATION_VERSION = process.env.APP_VERSION || 'development';
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY || 'IPandral/Computer-usage-dashboard';
const WEB_ROOT = path.join(__dirname, 'web');
const STARTED_AT = Date.now();

let previousCpu = null;
let previousNetwork = null;
let previousDiskIo = null;
let processCache = { at: 0, count: 0, top: [] };

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function cleanValue(value) {
  return String(value || '').replace(/^['"]|['"]$/g, '').trim();
}

function parseKeyValues(text, separator = ':') {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf(separator);
    if (index < 0) continue;
    values[line.slice(0, index).trim()] = cleanValue(line.slice(index + 1));
  }
  return values;
}

function parseCpuTimes(text) {
  const line = text.split(/\r?\n/).find((entry) => /^cpu\s/.test(entry));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some(Number.isNaN)) return null;
  const idle = (values[3] || 0) + (values[4] || 0);
  return { idle, total: values.reduce((sum, value) => sum + value, 0) };
}

function fallbackCpuTimes() {
  return os.cpus().reduce(
    (totals, cpu) => {
      const times = Object.values(cpu.times);
      totals.idle += cpu.times.idle;
      totals.total += times.reduce((sum, value) => sum + value, 0);
      return totals;
    },
    { idle: 0, total: 0 },
  );
}

function cpuUsage(current, previous) {
  if (!current) return 0;
  const total = previous ? current.total - previous.total : current.total;
  const idle = previous ? current.idle - previous.idle : current.idle;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
}

function parseMemInfo(text) {
  const entries = parseKeyValues(text);
  const bytes = (key) => Number.parseInt(entries[key] || '0', 10) * 1024;
  const total = bytes('MemTotal');
  const available = bytes('MemAvailable') || Math.max(0, bytes('MemFree') + bytes('Buffers') + bytes('Cached'));
  const swapTotal = bytes('SwapTotal');
  const swapFree = bytes('SwapFree');
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: Math.max(0, total - available),
    usage: total ? ((total - available) / total) * 100 : 0,
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

function fallbackMemory() {
  const total = os.totalmem();
  const available = os.freemem();
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: total - available,
    usage: total ? ((total - available) / total) * 100 : 0,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
  };
}

function parseNetwork(text) {
  let rxBytes = 0;
  let txBytes = 0;
  const interfaces = [];

  for (const line of text.split(/\r?\n/).slice(2)) {
    const [rawName, rawValues] = line.split(':');
    if (!rawValues) continue;
    const name = rawName.trim();
    const values = rawValues.trim().split(/\s+/).map(Number);
    if (!name || name === 'lo' || values.length < 9) continue;
    const received = values[0] || 0;
    const sent = values[8] || 0;
    rxBytes += received;
    txBytes += sent;
    interfaces.push({
      name,
      rxBytes: received,
      txBytes: sent,
      rxPackets: values[1] || 0,
      rxErrors: values[2] || 0,
      rxDropped: values[3] || 0,
      txPackets: values[9] || 0,
      txErrors: values[10] || 0,
      txDropped: values[11] || 0,
    });
  }

  return { rxBytes, txBytes, interfaces };
}

function fallbackNetwork() {
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/loopback/i.test(name))
    .map(([name]) => ({
      name,
      rxBytes: 0,
      txBytes: 0,
      rxPackets: 0,
      rxErrors: 0,
      rxDropped: 0,
      txPackets: 0,
      txErrors: 0,
      txDropped: 0,
    }));
  return { rxBytes: 0, txBytes: 0, interfaces };
}

function parseIpv4Addresses(text) {
  const lines = String(text || '').split(/\r?\n/);
  const addresses = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/--\s+(\d{1,3}(?:\.\d{1,3}){3})\s*$/);
    if (!match || !lines.slice(index + 1, index + 3).some((line) => /\/32 host LOCAL/.test(line))) continue;
    if (match[1] !== '127.0.0.1' && !match[1].startsWith('169.254.')) addresses.add(match[1]);
  }
  return [...addresses];
}

function parseIpv6Addresses(text) {
  const addresses = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{32}$/i.test(fields[0] || '') || fields[3] !== '00') continue;
    addresses.push(fields[0].match(/.{4}/g).join(':'));
  }
  return addresses;
}

function parseSocketStats(tcpText, tcp6Text, udpText, udp6Text) {
  const states = (text) => String(text || '').split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)[3]).filter(Boolean);
  const tcpStates = [...states(tcpText), ...states(tcp6Text)];
  const udpStates = [...states(udpText), ...states(udp6Text)];
  return {
    tcp: tcpStates.length,
    established: tcpStates.filter((state) => state === '01').length,
    listening: tcpStates.filter((state) => state === '0A').length,
    udp: udpStates.length,
  };
}

function hostNetworkText(name) {
  return readText(path.join(HOST_PROC, '1', 'net', name)) || readText(path.join(HOST_PROC, 'net', name));
}

function networkWithRate(current, now) {
  const elapsed = previousNetwork ? Math.max((now - previousNetwork.at) / 1000, 0.001) : 0;
  const previousInterfaces = new Map((previousNetwork?.interfaces || []).map((entry) => [entry.name, entry]));
  const interfaces = current.interfaces.map((entry) => {
    const previous = previousInterfaces.get(entry.name);
    return {
      ...entry,
      rxBytesPerSecond: elapsed && previous ? Math.max(0, (entry.rxBytes - previous.rxBytes) / elapsed) : 0,
      txBytesPerSecond: elapsed && previous ? Math.max(0, (entry.txBytes - previous.txBytes) / elapsed) : 0,
      rxPacketsPerSecond: elapsed && previous ? Math.max(0, (entry.rxPackets - previous.rxPackets) / elapsed) : 0,
      txPacketsPerSecond: elapsed && previous ? Math.max(0, (entry.txPackets - previous.txPackets) / elapsed) : 0,
      macAddress: readText(path.join(HOST_SYS, 'class', 'net', entry.name, 'address')) || null,
    };
  });
  const result = {
    ...current,
    interfaces,
    rxBytesPerSecond: elapsed ? Math.max(0, (current.rxBytes - previousNetwork.rxBytes) / elapsed) : 0,
    txBytesPerSecond: elapsed ? Math.max(0, (current.txBytes - previousNetwork.txBytes) / elapsed) : 0,
  };
  previousNetwork = { at: now, rxBytes: current.rxBytes, txBytes: current.txBytes, interfaces: current.interfaces };
  return result;
}

function storageLevel(usage) {
  if (usage >= 95) return 'critical';
  if (usage >= 80) return 'warning';
  return 'normal';
}

function filesystemStats(targetPath, details = {}) {
  try {
    const stats = fs.statfsSync(targetPath, { bigint: true });
    const blockSize = stats.bsize;
    const total = stats.blocks * blockSize;
    const available = stats.bavail * blockSize;
    const free = stats.bfree * blockSize;
    const used = total - free;
    const usage = total ? Number((used * 10000n) / total) / 100 : 0;
    return {
      ...details,
      totalBytes: Number(total),
      availableBytes: Number(available),
      usedBytes: Number(used),
      usage,
      status: storageLevel(usage),
    };
  } catch {
    return null;
  }
}

function diskStats() {
  return filesystemStats(HOST_ROOT, { path: '/', mount: '/', source: 'Host root', filesystem: '' })
    || { path: '/', mount: '/', source: 'Host root', filesystem: '', totalBytes: 0, availableBytes: 0, usedBytes: 0, usage: 0, status: 'normal' };
}

function decodeMountField(value) {
  return String(value || '').replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function parseMountTable(text) {
  const excludedFilesystems = new Set([
    'autofs', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs', 'devpts', 'devtmpfs', 'efivarfs', 'fusectl',
    'hugetlbfs', 'mqueue', 'nsfs', 'overlay', 'proc', 'pstore', 'ramfs', 'rpc_pipefs', 'securityfs', 'sysfs',
    'tmpfs', 'tracefs',
  ]);
  const mounts = new Map();

  for (const line of String(text || '').split(/\r?\n/)) {
    const [rawSource, rawMount, filesystem] = line.trim().split(/\s+/);
    if (!rawSource || !rawMount || !filesystem || excludedFilesystems.has(filesystem)) continue;
    const mount = path.posix.normalize(decodeMountField(rawMount));
    if (!mount.startsWith('/') || (mount !== '/' && /^(\/proc|\/sys|\/dev)(\/|$)/.test(mount))) continue;
    if (!mounts.has(mount)) {
      mounts.set(mount, { mount, source: decodeMountField(rawSource), filesystem });
    }
  }

  return [...mounts.values()].sort((a, b) => a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.localeCompare(b.mount));
}

function hostPathForMount(mount) {
  const root = path.resolve(HOST_ROOT);
  const target = path.resolve(root, `.${mount}`);
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null;
}

function mountedFilesystems() {
  const mounts = parseMountTable(readText(path.join(HOST_PROC, 'mounts')));
  const records = mounts
    .map((mount) => {
      const target = hostPathForMount(mount.mount);
      return target ? filesystemStats(target, { path: mount.mount, ...mount }) : null;
    })
    .filter(Boolean);

  if (!records.some((mount) => mount.mount === '/')) records.unshift(diskStats());
  return records;
}

function isPhysicalDiskName(name) {
  return /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(String(name || ''));
}

function baseDiskName(deviceName) {
  const name = String(deviceName || '').replace(/^\/dev\//, '').split('/').at(-1);
  if (/^nvme\d+n\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  if (/^mmcblk\d+p\d+$/.test(name)) return name.replace(/p\d+$/, '');
  if (/^(?:sd|vd|xvd)[a-z]+\d+$/.test(name)) return name.replace(/\d+$/, '');
  return isPhysicalDiskName(name) ? name : '';
}

function parseDiskStats(text) {
  const disks = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14 || !isPhysicalDiskName(fields[2])) continue;
    const values = fields.slice(3).map(Number);
    if (values.some((value) => !Number.isFinite(value))) continue;
    disks[fields[2]] = {
      readsCompleted: values[0],
      sectorsRead: values[2],
      writesCompleted: values[4],
      sectorsWritten: values[6],
      ioMilliseconds: values[9],
    };
  }
  return disks;
}

function diskIoWithRates(text, now = Date.now()) {
  const current = parseDiskStats(text);
  const elapsed = previousDiskIo ? Math.max((now - previousDiskIo.at) / 1000, 0.001) : 0;
  const result = {};

  for (const [name, counters] of Object.entries(current)) {
    const previous = previousDiskIo?.disks?.[name];
    result[name] = {
      ...counters,
      readBytesPerSecond: elapsed && previous ? Math.max(0, (counters.sectorsRead - previous.sectorsRead) * 512 / elapsed) : 0,
      writeBytesPerSecond: elapsed && previous ? Math.max(0, (counters.sectorsWritten - previous.sectorsWritten) * 512 / elapsed) : 0,
      readIops: elapsed && previous ? Math.max(0, (counters.readsCompleted - previous.readsCompleted) / elapsed) : 0,
      writeIops: elapsed && previous ? Math.max(0, (counters.writesCompleted - previous.writesCompleted) / elapsed) : 0,
      busyPercent: elapsed && previous ? Math.max(0, Math.min(100, (counters.ioMilliseconds - previous.ioMilliseconds) / (elapsed * 10))) : 0,
    };
  }

  previousDiskIo = { at: now, disks: current };
  return result;
}

function firstFinite(...values) {
  return values.find((value) => value !== null && value !== '' && Number.isFinite(Number(value))) ?? null;
}

function parseSmartctlJson(input) {
  let data;
  try {
    data = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const nvme = data.nvme_smart_health_information_log || {};
  const smartSupport = data.smart_support || {};
  const exitStatus = Number(data.smartctl?.exit_status || 0);
  const hasSmartPayload = Boolean(
    data.smart_status
    || data.temperature
    || data.power_on_time
    || data.ata_smart_attributes
    || data.nvme_smart_health_information_log
    || data.scsi_temperature
    || data.scsi_grown_defect_list !== undefined,
  );
  if (!hasSmartPayload && (exitStatus & 0b111 || smartSupport.available === false)) return null;
  const attributes = (data.ata_smart_attributes?.table || []).map((attribute) => ({
    id: Number(attribute.id),
    name: String(attribute.name || '').slice(0, 64),
    value: firstFinite(attribute.value),
    worst: firstFinite(attribute.worst),
    threshold: firstFinite(attribute.thresh),
    raw: String(attribute.raw?.string ?? attribute.raw?.value ?? '').slice(0, 96),
    failed: String(attribute.when_failed || '').trim() !== '',
  })).filter((attribute) => Number.isFinite(attribute.id));
  const ataTest = data.ata_smart_self_test_log?.standard?.table?.[0];
  const nvmeTest = data.nvme_self_test_log?.table?.[0];
  const currentAtaTest = data.ata_smart_data?.self_test?.status;
  const healthPassed = typeof data.smart_status?.passed === 'boolean'
    ? data.smart_status.passed
    : Number.isFinite(Number(nvme.critical_warning)) ? Number(nvme.critical_warning) === 0 : null;
  const temperature = firstFinite(
    data.temperature?.current,
    nvme.temperature,
    data.scsi_temperature?.current,
  );
  const powerOnHours = firstFinite(
    data.power_on_time?.hours,
    nvme.power_on_hours,
    attributes.find((entry) => entry.id === 9)?.raw.match(/^\d+/)?.[0],
  );
  const powerCycles = firstFinite(
    data.power_cycle_count,
    nvme.power_cycles,
    attributes.find((entry) => entry.id === 12)?.raw.match(/^\d+/)?.[0],
  );

  return {
    available: true,
    enabled: smartSupport.enabled !== false,
    sleeping: false,
    protocol: String(data.device?.protocol || '').toLowerCase() || null,
    model: String(data.model_name || data.product || '').trim() || null,
    serial: String(data.serial_number || '').trim() || null,
    firmware: String(data.firmware_version || data.revision || '').trim() || null,
    healthPassed,
    temperatureCelsius: temperature === null ? null : Number(temperature),
    powerOnHours: powerOnHours === null ? null : Number(powerOnHours),
    powerCycles: powerCycles === null ? null : Number(powerCycles),
    percentageUsed: firstFinite(nvme.percentage_used),
    availableSpare: firstFinite(nvme.available_spare),
    unsafeShutdowns: firstFinite(nvme.unsafe_shutdowns),
    mediaErrors: firstFinite(nvme.media_errors),
    grownDefects: firstFinite(data.scsi_grown_defect_list),
    attributes,
    selfTest: currentAtaTest ? {
      type: 'ATA self-test',
      status: String(currentAtaTest.string || ''),
      remainingPercent: firstFinite(currentAtaTest.remaining_percent),
    } : ataTest ? {
      type: String(ataTest.type?.string || ataTest.type || ''),
      status: String(ataTest.status?.string || ataTest.status || ''),
      lifetimeHours: firstFinite(ataTest.lifetime_hours),
    } : nvmeTest ? {
      type: String(nvmeTest.self_test_code?.string || nvmeTest.self_test_code || ''),
      status: String(nvmeTest.self_test_result?.string || nvmeTest.self_test_result || ''),
      lifetimeHours: firstFinite(nvmeTest.power_on_hours),
    } : null,
    checkedAt: new Date().toISOString(),
  };
}

const smartCache = new Map();

function smartDevicePath(name) {
  if (!isPhysicalDiskName(name)) return null;
  const root = path.resolve(SMART_DEVICE_ROOT);
  const target = path.resolve(root, name);
  return target.startsWith(`${root}${path.sep}`) ? target : null;
}

function smartDataForDisk(name, now = Date.now()) {
  if (!SMART_ENABLED) return { available: false, enabled: false, reason: 'SMART monitoring is disabled.' };
  const cached = smartCache.get(name);
  if (cached && now - cached.at < SMART_CACHE_MS) return cached.value;
  const device = smartDevicePath(name);
  if (!device) return { available: false, enabled: true, reason: 'Invalid device.' };

  const execution = childProcess.spawnSync(SMARTCTL_PATH, ['-a', '-j', '-n', 'standby,0', device], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  let value = parseSmartctlJson(execution.stdout);
  if (!value) {
    const sleeping = /standby|sleep/i.test(`${execution.stdout || ''}\n${execution.stderr || ''}`);
    value = {
      available: false,
      enabled: true,
      sleeping,
      reason: sleeping ? 'Disk is in standby; SMART refresh skipped.' : execution.error?.code === 'ENOENT'
        ? 'smartctl is not installed.'
        : 'SMART data is unavailable.',
      checkedAt: new Date(now).toISOString(),
    };
  }
  smartCache.set(name, { at: now, value });
  return value;
}

function diskMountMap(mounts) {
  const result = new Map();
  for (const mount of mounts) {
    const name = baseDiskName(mount.source);
    if (!name) continue;
    if (!result.has(name)) result.set(name, []);
    result.get(name).push({ mount: mount.mount, filesystem: mount.filesystem, usage: mount.usage, status: mount.status });
  }
  return result;
}

function physicalDisks(mounts, now = Date.now()) {
  const io = diskIoWithRates(readText(path.join(HOST_PROC, 'diskstats')), now);
  const mountMap = diskMountMap(mounts);
  let entries;
  try {
    entries = fs.readdirSync(path.join(HOST_SYS, 'block'), { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => isPhysicalDiskName(entry.name))
    .map((entry) => {
      const root = path.join(HOST_SYS, 'block', entry.name);
      const sectors = Number.parseInt(readText(path.join(root, 'size')) || '0', 10);
      const smart = smartDataForDisk(entry.name, now);
      return {
        name: entry.name,
        device: `/dev/${entry.name}`,
        model: readText(path.join(root, 'device', 'model')) || smart.model || 'Unknown disk',
        vendor: readText(path.join(root, 'device', 'vendor')) || '',
        serial: readText(path.join(root, 'device', 'serial')) || readText(path.join(root, 'serial')) || smart.serial || null,
        sizeBytes: Number.isFinite(sectors) ? sectors * 512 : 0,
        rotational: readText(path.join(root, 'queue', 'rotational')) === '1',
        removable: readText(path.join(root, 'removable')) === '1',
        mounts: mountMap.get(entry.name) || [],
        io: io[entry.name] || {
          readBytesPerSecond: 0,
          writeBytesPerSecond: 0,
          readIops: 0,
          writeIops: 0,
          busyPercent: 0,
        },
        smart,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function compactHistory(samples, maximumPoints = HISTORY_MAX_POINTS) {
  if (samples.length <= maximumPoints) return samples;
  const bucketSize = Math.ceil(samples.length / maximumPoints);
  const fields = ['cpuUsage', 'memoryUsage', 'diskUsage', 'rxBytesPerSecond', 'txBytesPerSecond'];
  const compacted = [];

  for (let index = 0; index < samples.length; index += bucketSize) {
    const bucket = samples.slice(index, index + bucketSize);
    const result = { timestamp: bucket.at(-1).timestamp };
    for (const field of fields) {
      result[field] = bucket.reduce((sum, sample) => sum + (Number(sample[field]) || 0), 0) / bucket.length;
    }
    compacted.push(result);
  }
  return compacted;
}

class HistoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.samples = [];
    this.persistenceError = false;
    this.lastCompactionAt = 0;
    this.load();
  }

  load() {
    if (!this.filePath) return;
    try {
      const entries = fs.readFileSync(this.filePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((sample) => Number.isFinite(Date.parse(sample.timestamp)));
      this.samples = entries.filter((sample) => Date.parse(sample.timestamp) >= Date.now() - HISTORY_RETENTION_MS);
    } catch (error) {
      if (error.code !== 'ENOENT') this.persistenceError = true;
    }
  }

  toSample(snapshot) {
    return {
      timestamp: snapshot.timestamp,
      cpuUsage: Math.round(snapshot.cpu.usage * 100) / 100,
      memoryUsage: Math.round(snapshot.memory.usage * 100) / 100,
      diskUsage: Math.round(snapshot.disk.usage * 100) / 100,
      rxBytesPerSecond: Math.round(snapshot.network.rxBytesPerSecond || 0),
      txBytesPerSecond: Math.round(snapshot.network.txBytesPerSecond || 0),
    };
  }

  record(snapshot, now = Date.now()) {
    const sample = this.toSample(snapshot);
    const timestamp = Date.parse(sample.timestamp) || now;
    const previous = this.samples.at(-1);
    if (previous && timestamp - Date.parse(previous.timestamp) < HISTORY_SAMPLE_INTERVAL_MS * 0.8) return false;

    this.samples.push(sample);
    const removed = this.prune(now);
    this.persist(sample, removed, now);
    return true;
  }

  prune(now = Date.now()) {
    const earliest = now - HISTORY_RETENTION_MS;
    const firstCurrent = this.samples.findIndex((sample) => Date.parse(sample.timestamp) >= earliest);
    if (firstCurrent === 0) return false;
    if (firstCurrent < 0) {
      this.samples = [];
      return true;
    }
    this.samples.splice(0, firstCurrent);
    return true;
  }

  persist(sample, compacted, now) {
    if (!this.filePath || this.persistenceError) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (compacted && now - this.lastCompactionAt > 6 * 60 * 60 * 1000) {
        fs.writeFileSync(this.filePath, `${this.samples.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
        this.lastCompactionAt = now;
      } else {
        fs.appendFileSync(this.filePath, `${JSON.stringify(sample)}\n`, 'utf8');
      }
    } catch {
      this.persistenceError = true;
    }
  }

  series(durationMs, now = Date.now()) {
    return compactHistory(this.samples.filter((sample) => Date.parse(sample.timestamp) >= now - durationMs));
  }

  summary(now = Date.now()) {
    return {
      last24Hours: this.series(24 * 60 * 60 * 1000, now),
      last30Days: this.series(HISTORY_RETENTION_MS, now),
      recordingSince: this.samples[0]?.timestamp || null,
      persistent: Boolean(this.filePath) && !this.persistenceError,
      retentionDays: 30,
    };
  }
}

const historyStore = new HistoryStore(HISTORY_FILE);

const DEFAULT_SMART_SCHEDULE = {
  short: { enabled: false, frequency: 'weekly', dayOfWeek: 0, hour: 2, minute: 0 },
  long: { enabled: false, frequency: 'monthly', dayOfMonth: 1, hour: 3, minute: 0 },
};

function validateSmartSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Schedule must be an object.');
  const normalizeTime = (rule) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('Each schedule rule must be an object.');
    const hour = Number(rule.hour);
    const minute = Number(rule.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('Schedule time is invalid.');
    }
    return { enabled: rule.enabled === true, frequency: String(rule.frequency || ''), hour, minute };
  };
  const short = normalizeTime(value.short);
  if (!['daily', 'weekly'].includes(short.frequency)) throw new Error('Short tests must run daily or weekly.');
  if (short.frequency === 'weekly') {
    short.dayOfWeek = Number(value.short.dayOfWeek);
    if (!Number.isInteger(short.dayOfWeek) || short.dayOfWeek < 0 || short.dayOfWeek > 6) throw new Error('Weekly day must be between 0 and 6.');
  }
  const long = normalizeTime(value.long);
  if (long.frequency !== 'monthly') throw new Error('Long tests must run monthly.');
  long.dayOfMonth = Number(value.long.dayOfMonth);
  if (!Number.isInteger(long.dayOfMonth) || long.dayOfMonth < 1 || long.dayOfMonth > 28) throw new Error('Monthly day must be between 1 and 28.');
  return { short, long };
}

function loadSettings() {
  if (!SETTINGS_FILE) return { smartSchedule: DEFAULT_SMART_SCHEDULE, smartLastRun: {} };
  try {
    const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    return {
      ...stored,
      smartSchedule: validateSmartSchedule(stored.smartSchedule || DEFAULT_SMART_SCHEDULE),
      smartLastRun: stored.smartLastRun && typeof stored.smartLastRun === 'object' ? stored.smartLastRun : {},
    };
  } catch {
    return { smartSchedule: DEFAULT_SMART_SCHEDULE, smartLastRun: {} };
  }
}

let settings = loadSettings();

function saveSettings() {
  if (!SETTINGS_FILE) return;
  try {
    fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
    const temporary = `${SETTINGS_FILE}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, SETTINGS_FILE);
  } catch (error) {
    console.error('Unable to save dashboard settings:', error.message);
  }
}

class EventStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.events = [];
    try {
      this.events = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).slice(-200);
    } catch {}
  }

  add(type, severity, title, message, details = {}) {
    const event = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      severity,
      title: String(title).slice(0, 100),
      message: String(message).slice(0, 500),
      ...details,
    };
    this.events.push(event);
    this.events = this.events.slice(-200);
    if (this.filePath) {
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
      } catch {}
    }
    return event;
  }

  recent(limit = 50) {
    return this.events.slice(-limit).reverse();
  }
}

const eventStore = new EventStore(EVENTS_FILE);

function parseServiceChecks(value) {
  const entries = String(value || '').split(/[;\n]+|,(?=(?:[^,=;]+[=])?(?:process|tcp|http):)/).map((entry) => entry.trim()).filter(Boolean);
  return entries.map((entry, index) => {
    const equals = entry.indexOf('=');
    const label = equals > 0 ? entry.slice(0, equals).trim() : '';
    const definition = equals > 0 ? entry.slice(equals + 1).trim() : entry;
    const separator = definition.indexOf(':');
    const type = definition.slice(0, separator).toLowerCase();
    const target = definition.slice(separator + 1).trim();
    if (!['process', 'tcp', 'http'].includes(type) || !target || target.length > 512) return null;
    if (type === 'process' && !/^[\w .@+_-]{1,128}$/.test(target)) return null;
    if (type === 'tcp' && !/^\[[0-9a-f:]+\]:\d{1,5}$|^[\w.-]+:\d{1,5}$/i.test(target)) return null;
    if (type === 'http') {
      try {
        const url = new URL(target);
        if (!['http:', 'https:'].includes(url.protocol)) return null;
      } catch { return null; }
    }
    return { id: crypto.createHash('sha256').update(`${type}:${target}`).digest('hex').slice(0, 12), name: (label || `${type} ${index + 1}`).slice(0, 64), type, target };
  }).filter(Boolean);
}

class ServiceMonitor {
  constructor(checks) {
    this.checks = checks;
    this.results = checks.map((check) => ({ ...check, status: 'pending', latencyMs: null, checkedAt: null }));
    this.running = false;
  }

  processRunning(target) {
    try {
      return fs.readdirSync(HOST_PROC).filter((entry) => /^\d+$/.test(entry)).some((pid) => {
        const name = readText(path.join(HOST_PROC, pid, 'comm'));
        const command = readText(path.join(HOST_PROC, pid, 'cmdline')).replace(/\0/g, ' ');
        return name === target || command.split(/\s+/)[0]?.endsWith(`/${target}`);
      });
    } catch { return false; }
  }

  checkNetwork(check) {
    const startedAt = Date.now();
    if (check.type === 'tcp') return new Promise((resolve) => {
      const match = check.target.match(/^\[?(.+?)\]?:(\d+)$/);
      const socket = net.createConnection({ host: match[1], port: Number(match[2]), timeout: 3000 });
      const finish = (up, detail) => { socket.destroy(); resolve({ up, detail, latencyMs: Date.now() - startedAt }); };
      socket.once('connect', () => finish(true, 'Connected'));
      socket.once('timeout', () => finish(false, 'Timed out'));
      socket.once('error', (error) => finish(false, error.code || 'Connection failed'));
    });
    return new Promise((resolve) => {
      const target = new URL(check.target);
      const client = target.protocol === 'https:' ? https : http;
      const request = client.request(target, { method: 'GET', timeout: 5000, headers: { 'User-Agent': 'Nodelight-monitor' } }, (response) => {
        response.resume();
        resolve({ up: response.statusCode >= 200 && response.statusCode < 400, detail: `HTTP ${response.statusCode}`, latencyMs: Date.now() - startedAt });
      });
      request.once('timeout', () => { request.destroy(); resolve({ up: false, detail: 'Timed out', latencyMs: Date.now() - startedAt }); });
      request.once('error', (error) => resolve({ up: false, detail: error.code || 'Request failed', latencyMs: Date.now() - startedAt }));
      request.end();
    });
  }

  async refresh() {
    if (this.running) return;
    this.running = true;
    try {
      this.results = await Promise.all(this.checks.map(async (check) => {
        const result = check.type === 'process'
          ? { up: this.processRunning(check.target), detail: 'Process lookup', latencyMs: 0 }
          : await this.checkNetwork(check);
        return { ...check, status: result.up ? 'up' : 'down', detail: result.detail, latencyMs: result.latencyMs, checkedAt: new Date().toISOString() };
      }));
    } finally { this.running = false; }
  }
}

const serviceMonitor = new ServiceMonitor(parseServiceChecks(process.env.SERVICE_CHECKS));
const alertState = new Map();
const notificationCooldown = new Map();

function sendWebhook(alert) {
  const configuredUrl = process.env.ALERT_WEBHOOK_URL || '';
  if (!configuredUrl) return;
  let target;
  try { target = new URL(configuredUrl); } catch { return; }
  if (!['http:', 'https:'].includes(target.protocol)) return;
  const cooldown = Math.max(1, Number(process.env.ALERT_COOLDOWN_MINUTES) || 30) * 60 * 1000;
  if (Date.now() - (notificationCooldown.get(alert.key) || 0) < cooldown) return;
  notificationCooldown.set(alert.key, Date.now());
  const type = String(process.env.ALERT_WEBHOOK_TYPE || 'generic').toLowerCase();
  const text = `[${alert.severity.toUpperCase()}] ${alert.title}: ${alert.message}`;
  const body = JSON.stringify(type === 'discord' ? { content: text } : type === 'slack' ? { text } : { event: 'nodelight.alert', alert });
  const client = target.protocol === 'https:' ? https : http;
  const request = client.request(target, { method: 'POST', timeout: 5000, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (response) => response.resume());
  request.on('error', () => {});
  request.on('timeout', () => request.destroy());
  request.end(body);
}

function evaluateAlerts(snapshot) {
  const candidates = [];
  if (snapshot.cpu.usage >= 90) candidates.push({ key: 'cpu', severity: 'warning', title: 'High CPU usage', message: `CPU usage is ${Math.round(snapshot.cpu.usage)}%.` });
  if (snapshot.memory.usage >= 90) candidates.push({ key: 'memory', severity: 'warning', title: 'High memory usage', message: `Memory usage is ${Math.round(snapshot.memory.usage)}%.` });
  if (snapshot.temperature.celsius >= 85) candidates.push({ key: 'temperature', severity: 'critical', title: 'High temperature', message: `Temperature is ${snapshot.temperature.celsius} C.` });
  for (const mount of snapshot.mounts.filter((entry) => entry.status !== 'normal')) candidates.push({ key: `mount:${mount.mount}`, severity: mount.status, title: 'Low disk space', message: `${mount.mount} is ${Math.round(mount.usage)}% full.` });
  for (const disk of snapshot.physicalDisks) {
    const smart = disk.smart || {};
    const rawAttribute = (id) => {
      const raw = smart.attributes?.find((attribute) => attribute.id === id)?.raw;
      const match = String(raw ?? '').match(/\d+/);
      return match ? Number(match[0]) : 0;
    };
    if (smart.healthPassed === false) candidates.push({ key: `smart:${disk.name}`, severity: 'critical', title: 'SMART health failure', message: `${disk.name} reports a failed SMART health check.` });
    if (Number(smart.temperatureCelsius) >= 55) candidates.push({ key: `smart-temp:${disk.name}`, severity: 'critical', title: 'High disk temperature', message: `${disk.name} is ${smart.temperatureCelsius} C.` });
    if (rawAttribute(197) > 0 || rawAttribute(198) > 0 || Number(smart.grownDefects) > 0 || Number(smart.mediaErrors) > 0) {
      candidates.push({ key: `smart-media:${disk.name}`, severity: 'warning', title: 'SMART media errors', message: `${disk.name} has pending, uncorrectable, or recorded media errors.` });
    }
    if (Number(smart.percentageUsed) >= 90 || (smart.availableSpare !== null && Number(smart.availableSpare) < 10)) {
      candidates.push({ key: `smart-wear:${disk.name}`, severity: 'warning', title: 'Drive endurance warning', message: `${disk.name} reports low remaining endurance or spare capacity.` });
    }
  }
  for (const service of snapshot.services.filter((entry) => entry.status === 'down')) candidates.push({ key: `service:${service.id}`, severity: 'warning', title: 'Service unavailable', message: `${service.name} is down.` });
  const activeKeys = new Set(candidates.map((entry) => entry.key));
  for (const alert of candidates) {
    if (!alertState.has(alert.key)) {
      const event = eventStore.add('alert', alert.severity, alert.title, alert.message, { alertKey: alert.key });
      sendWebhook({ ...alert, timestamp: event.timestamp });
    }
    alertState.set(alert.key, alert);
  }
  for (const key of [...alertState.keys()]) {
    if (!activeKeys.has(key)) {
      const resolved = alertState.get(key);
      const event = eventStore.add('recovery', 'info', `${resolved.title} resolved`, resolved.message, { alertKey: key });
      sendWebhook({ key: `recovery:${key}`, severity: 'info', title: `${resolved.title} resolved`, message: resolved.message, timestamp: event.timestamp });
      alertState.delete(key);
    }
  }
  return { active: [...alertState.values()], webhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL), cooldownMinutes: Math.max(1, Number(process.env.ALERT_COOLDOWN_MINUTES) || 30) };
}

let versionState = { current: APPLICATION_VERSION, latest: null, updateAvailable: false, repository: GITHUB_REPOSITORY, checkedAt: null, error: null };

function parseSemanticVersion(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] ? match[4].split('.') : [] };
}

function compareSemanticVersions(left, right) {
  const a = parseSemanticVersion(left);
  const b = parseSemanticVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return Math.sign(a.numbers[index] - b.numbers[index]);
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length ? -1 : b.prerelease.length ? 1 : 0;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    if (a.prerelease[index] === undefined) return -1;
    if (b.prerelease[index] === undefined) return 1;
    if (a.prerelease[index] === b.prerelease[index]) continue;
    const aNumber = /^\d+$/.test(a.prerelease[index]) ? Number(a.prerelease[index]) : null;
    const bNumber = /^\d+$/.test(b.prerelease[index]) ? Number(b.prerelease[index]) : null;
    if (aNumber !== null && bNumber !== null) return Math.sign(aNumber - bNumber);
    if (aNumber !== null) return -1;
    if (bNumber !== null) return 1;
    return a.prerelease[index].localeCompare(b.prerelease[index]);
  }
  return 0;
}

function checkLatestVersion() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY)) return;
  const request = https.get(`https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/latest`, { timeout: 5000, headers: { 'User-Agent': 'Nodelight-monitor', Accept: 'application/vnd.github+json' } }, (response) => {
    let body = '';
    response.on('data', (chunk) => { if (body.length < 65536) body += chunk; });
    response.on('end', () => {
      try {
        const release = JSON.parse(body);
        const latest = String(release.tag_name || '').replace(/^v/, '') || null;
        const comparison = latest ? compareSemanticVersions(APPLICATION_VERSION, latest) : null;
        versionState = { current: APPLICATION_VERSION, latest, updateAvailable: comparison !== null && comparison < 0, repository: GITHUB_REPOSITORY, releaseUrl: release.html_url || null, checkedAt: new Date().toISOString(), error: null };
      } catch { versionState = { ...versionState, checkedAt: new Date().toISOString(), error: 'Version check failed.' }; }
    });
  });
  request.on('error', () => { versionState = { ...versionState, checkedAt: new Date().toISOString(), error: 'Version check failed.' }; });
  request.on('timeout', () => request.destroy());
}

function listPhysicalDiskNames() {
  try {
    return fs.readdirSync(path.join(HOST_SYS, 'block')).filter(isPhysicalDiskName);
  } catch { return []; }
}

function runSmartTest(name, type) {
  if (!SMART_ENABLED) return { ok: false, status: 503, error: 'SMART monitoring is disabled.' };
  if (!isPhysicalDiskName(name) || !listPhysicalDiskNames().includes(name)) return { ok: false, status: 400, error: 'Unknown disk device.' };
  if (!['short', 'long'].includes(type)) return { ok: false, status: 400, error: 'SMART test type must be short or long.' };
  const device = smartDevicePath(name);
  const execution = childProcess.spawnSync(SMARTCTL_PATH, ['-t', type, '-j', device], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  let response = null;
  try { if (String(execution.stdout || '').trim()) response = JSON.parse(execution.stdout); } catch {}
  const messages = Array.isArray(response?.messages) ? response.messages.map((message) => message.string).filter(Boolean).join(' ') : '';
  const exitStatus = Number(response?.smartctl?.exit_status ?? execution.status ?? 0);
  const failed = Boolean(execution.error) || !response || Boolean(exitStatus & 0b111);
  if (failed) return { ok: false, status: 502, error: execution.error?.code === 'ENOENT' ? 'smartctl is not installed.' : messages || 'Unable to start SMART test.' };
  smartCache.delete(name);
  const result = { ok: true, device: name, type, message: messages || `${type} SMART self-test requested.`, requestedAt: new Date().toISOString() };
  eventStore.add('smart-test', 'info', 'SMART self-test started', `${type} test started on ${name}.`, { device: name, testType: type });
  return result;
}

function scheduleKey(rule, type, date) {
  if (!rule.enabled || date.getHours() !== rule.hour || date.getMinutes() !== rule.minute) return null;
  const day = date.toISOString().slice(0, 10);
  if (type === 'short' && rule.frequency === 'daily') return `short:${day}`;
  if (type === 'short' && rule.frequency === 'weekly' && date.getDay() === rule.dayOfWeek) return `short:${day}`;
  if (type === 'long' && rule.frequency === 'monthly' && date.getDate() === rule.dayOfMonth) return `long:${day}`;
  return null;
}

function runScheduledSmartTests(now = new Date()) {
  if (!SMART_ENABLED) return;
  for (const type of ['short', 'long']) {
    const key = scheduleKey(settings.smartSchedule[type], type, now);
    if (!key || settings.smartLastRun[type] === key) continue;
    settings.smartLastRun[type] = key;
    saveSettings();
    for (const name of listPhysicalDiskNames()) runSmartTest(name, type);
  }
}

function scanSystemLogs() {
  const seen = new Set(Array.isArray(settings.logEventHashes) ? settings.logEventHashes : []);
  const found = [];
  for (const filename of ['kern.log', 'syslog', 'messages']) {
    const filePath = path.join(HOST_VAR_LOG, filename);
    try {
      const stat = fs.statSync(filePath);
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const descriptor = fs.openSync(filePath, 'r');
      fs.readSync(descriptor, buffer, 0, length, stat.size - length);
      fs.closeSync(descriptor);
      for (const line of buffer.toString('utf8').split(/\r?\n/).filter((entry) => /out of memory|oom-killer|failed with result|entered failed state/i.test(entry)).slice(-10)) {
        const hash = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);
        if (seen.has(hash)) continue;
        seen.add(hash);
        found.push({ line, hash });
      }
    } catch {}
  }
  for (const entry of found) eventStore.add('system-log', 'warning', /oom|out of memory/i.test(entry.line) ? 'Out-of-memory event' : 'Service failure', entry.line);
  settings.logEventHashes = [...seen].slice(-100);
  if (found.length) saveSettings();
}

function redactSnapshot(snapshot, enabled = DEMO_MODE) {
  if (!enabled) return { ...snapshot, privacyMode: false };
  const result = structuredClone(snapshot);
  result.privacyMode = true;
  result.dashboardName = 'Demo Server';
  result.machine.hostname = 'hidden';
  result.system.topProcesses = result.system.topProcesses.map((entry) => ({ ...entry, name: 'hidden' }));
  result.mounts = result.mounts.map((entry, index) => ({ ...entry, mount: entry.mount === '/' ? '/' : `/drive-${index + 1}`, path: entry.mount === '/' ? '/' : `/drive-${index + 1}`, source: 'hidden' }));
  result.physicalDisks = result.physicalDisks.map((entry, index) => ({
    ...entry,
    name: `disk${index + 1}`,
    device: `/dev/disk${index + 1}`,
    serial: null,
    mounts: entry.mounts.map((mount, mountIndex) => ({ ...mount, mount: mount.mount === '/' ? '/' : `/drive-${mountIndex + 1}` })),
  }));
  result.network.interfaces = result.network.interfaces.map((entry, index) => ({ ...entry, name: `interface-${index + 1}` }));
  result.network.addresses = [];
  result.network.interfaces = result.network.interfaces.map((entry) => ({ ...entry, macAddress: entry.macAddress ? 'hidden' : null }));
  result.services = result.services.map((entry, index) => ({ ...entry, name: `Service ${index + 1}`, target: 'hidden' }));
  result.events = result.events.map((entry) => ({ ...entry, message: entry.title, device: undefined, service: undefined }));
  if (Array.isArray(result.alerts?.active)) {
    result.alerts.active = result.alerts.active.map((entry, index) => ({ ...entry, key: `alert-${index + 1}`, message: 'Alert details hidden in privacy mode.' }));
  }
  return result;
}

function thermalStats() {
  const thermalRoot = path.join(HOST_SYS, 'class', 'thermal');
  try {
    const sensors = fs.readdirSync(thermalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('thermal_zone'))
      .map((entry) => {
        const root = path.join(thermalRoot, entry.name);
        const raw = Number.parseFloat(readText(path.join(root, 'temp')));
        const celsius = raw > 1000 ? raw / 1000 : raw;
        return {
          name: readText(path.join(root, 'type')) || entry.name,
          celsius: Number.isFinite(celsius) ? Math.round(celsius * 10) / 10 : null,
        };
      })
      .filter((sensor) => sensor.celsius !== null && sensor.celsius > -50 && sensor.celsius < 200);
    return {
      celsius: sensors.length ? Math.max(...sensors.map((sensor) => sensor.celsius)) : null,
      sensors,
    };
  } catch {
    return { celsius: null, sensors: [] };
  }
}

function processStats(now) {
  if (now - processCache.at < 10000) return processCache;
  try {
    const pids = fs.readdirSync(HOST_PROC).filter((entry) => /^\d+$/.test(entry));
    const top = [];
    for (const pid of pids) {
      const status = parseKeyValues(readText(path.join(HOST_PROC, pid, 'status')));
      if (!status.Name) continue;
      const rssKb = Number.parseInt(status.VmRSS || '0', 10);
      top.push({ pid: Number(pid), name: status.Name.slice(0, 32), memoryBytes: rssKb * 1024 });
    }
    top.sort((a, b) => b.memoryBytes - a.memoryBytes);
    processCache = { at: now, count: pids.length, top: top.slice(0, 5) };
  } catch {
    processCache = { at: now, count: 0, top: [] };
  }
  return processCache;
}

function osRelease() {
  const entries = parseKeyValues(readText(path.join(HOST_ETC, 'os-release')), '=');
  return {
    name: entries.PRETTY_NAME || `${os.type()} ${os.release()}`,
    version: entries.VERSION_ID || '',
  };
}

function cpuInfo() {
  const text = readText(path.join(HOST_PROC, 'cpuinfo'));
  const model = text.match(/^(?:model name|Hardware)\s*:\s*(.+)$/m)?.[1]?.trim();
  const cores = (text.match(/^processor\s*:/gm) || []).length;
  return {
    model: model || os.cpus()[0]?.model || 'Unknown processor',
    cores: cores || os.cpus().length || 1,
  };
}

function systemUptime() {
  const uptime = Number.parseFloat(readText(path.join(HOST_PROC, 'uptime')).split(/\s+/)[0]);
  return Number.isFinite(uptime) ? uptime : os.uptime();
}

function loadAverage() {
  const values = readText(path.join(HOST_PROC, 'loadavg')).split(/\s+/).slice(0, 3).map(Number);
  if (values.length === 3 && values.every(Number.isFinite)) return values;
  return os.loadavg();
}

function collectSnapshot(includeHistory = true) {
  const now = Date.now();
  const rawCpu = parseCpuTimes(readText(path.join(HOST_PROC, 'stat'))) || fallbackCpuTimes();
  const usage = cpuUsage(rawCpu, previousCpu);
  previousCpu = rawCpu;

  const memoryText = readText(path.join(HOST_PROC, 'meminfo'));
  const memory = memoryText ? parseMemInfo(memoryText) : fallbackMemory();
  const rawNetwork = parseNetwork(hostNetworkText('dev'));
  const network = networkWithRate(rawNetwork.interfaces.length ? rawNetwork : fallbackNetwork(), now);
  network.addresses = [
    ...parseIpv4Addresses(hostNetworkText('fib_trie')),
    ...parseIpv6Addresses(hostNetworkText('if_inet6')),
  ];
  network.connections = parseSocketStats(
    hostNetworkText('tcp'),
    hostNetworkText('tcp6'),
    hostNetworkText('udp'),
    hostNetworkText('udp6'),
  );
  const uptimeSeconds = systemUptime();
  const release = osRelease();
  const cpu = cpuInfo();
  const processes = processStats(now);
  const loads = loadAverage();
  const hostName = readText(path.join(HOST_ETC, 'hostname')) || os.hostname();
  const kernel = readText(path.join(HOST_PROC, 'sys', 'kernel', 'osrelease')) || os.release();
  const mounts = mountedFilesystems();
  const disks = physicalDisks(mounts, now);

  const snapshot = {
    timestamp: new Date(now).toISOString(),
    privacyMode: false,
    dashboardName: process.env.DASHBOARD_NAME || 'Home Server',
    machine: {
      hostname: hostName,
      operatingSystem: release.name,
      osVersion: release.version,
      kernel,
      architecture: os.arch(),
      cpuModel: cpu.model,
      cpuCores: cpu.cores,
    },
    cpu: { usage, load1: loads[0] || 0, load5: loads[1] || 0, load15: loads[2] || 0 },
    memory,
    disk: diskStats(),
    mounts,
    physicalDisks: disks,
    network,
    temperature: thermalStats(),
    services: serviceMonitor.results,
    system: {
      uptimeSeconds,
      bootedAt: new Date(now - uptimeSeconds * 1000).toISOString(),
      processCount: processes.count,
      topProcesses: processes.top,
      monitorUptimeSeconds: Math.floor((now - STARTED_AT) / 1000),
    },
    events: [],
    alerts: { active: [], webhookConfigured: Boolean(process.env.ALERT_WEBHOOK_URL) },
    version: versionState,
    smartSchedule: {
      ...settings.smartSchedule,
      smartEnabled: SMART_ENABLED,
      canManage: Boolean(process.env.DASHBOARD_PASSWORD) && !DEMO_MODE,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    ...(includeHistory ? { history: historyStore.summary(now) } : {}),
  };
  snapshot.alerts = evaluateAlerts(snapshot);
  snapshot.events = eventStore.recent();
  return redactSnapshot(snapshot);
}

function recordHistorySample() {
  try {
    historyStore.record(collectSnapshot(false));
  } catch (error) {
    console.error('Unable to record metrics history:', error);
  }
}

function secureEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || '');
  const expectedBuffer = Buffer.from(expected || '');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(request) {
  const expectedPassword = process.env.DASHBOARD_PASSWORD || '';
  if (!expectedPassword) return true;
  const expectedUsername = process.env.DASHBOARD_USERNAME || 'admin';
  const header = request.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    return separator >= 0
      && secureEqual(decoded.slice(0, separator), expectedUsername)
      && secureEqual(decoded.slice(separator + 1), expectedPassword);
  } catch {
    return false;
  }
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) return false;
  try { return new URL(origin).host.toLowerCase() === String(host).toLowerCase(); } catch { return false; }
}

function readJsonBody(request, limit = JSON_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Request body is too large.');
        error.status = 413;
        reject(error);
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > limit) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch {
        const error = new Error('Request body must contain valid JSON.');
        error.status = 400;
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.ico': ['favicon.ico', 'image/x-icon'],
  '/favicon-32.png': ['favicon-32.png', 'image/png'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/site.webmanifest': ['site.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/assets/nodelight-logo.png': ['assets/nodelight-logo.png', 'image/png'],
};

function send(response, status, body, type, cache = 'no-store') {
  response.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function requestHandler(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host || 'localhost'}`).pathname;

  if (pathname === '/health') {
    send(response, 200, JSON.stringify({ status: 'ok' }), 'application/json; charset=utf-8');
    return;
  }

  if (!isAuthorized(request)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Nodelight", charset="UTF-8"');
    send(response, 401, 'Authentication required', 'text/plain; charset=utf-8');
    return;
  }

  if (pathname === '/api/stats') {
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      send(response, 405, JSON.stringify({ error: 'Method not allowed.' }), 'application/json; charset=utf-8');
      return;
    }
    try {
      send(response, 200, JSON.stringify(collectSnapshot()), 'application/json; charset=utf-8');
    } catch (error) {
      console.error('Unable to collect metrics:', error);
      send(response, 500, JSON.stringify({ error: 'Metrics are temporarily unavailable.' }), 'application/json; charset=utf-8');
    }
    return;
  }

  if (pathname === '/api/smart-schedule' || pathname === '/api/smart-test') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      send(response, 405, JSON.stringify({ error: 'Method not allowed.' }), 'application/json; charset=utf-8');
      return;
    }
    if (!process.env.DASHBOARD_PASSWORD || DEMO_MODE) {
      send(response, 403, JSON.stringify({ error: 'A protected, non-demo dashboard is required for SMART changes.' }), 'application/json; charset=utf-8');
      return;
    }
    if (!isSameOrigin(request)) {
      send(response, 403, JSON.stringify({ error: 'Cross-origin request rejected.' }), 'application/json; charset=utf-8');
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      send(response, 415, JSON.stringify({ error: 'Content-Type must be application/json.' }), 'application/json; charset=utf-8');
      return;
    }
    readJsonBody(request).then((body) => {
      if (pathname === '/api/smart-schedule') {
        try {
          settings.smartSchedule = validateSmartSchedule(body);
          saveSettings();
          eventStore.add('settings', 'info', 'SMART schedule updated', 'The SMART self-test schedule was updated.');
          send(response, 200, JSON.stringify({ ok: true, smartSchedule: settings.smartSchedule }), 'application/json; charset=utf-8');
        } catch (error) {
          send(response, 400, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
        }
        return;
      }
      const result = runSmartTest(body.device, body.type);
      send(response, result.status || 200, JSON.stringify(result.ok ? result : { error: result.error }), 'application/json; charset=utf-8');
    }).catch((error) => {
      if (!response.headersSent) send(response, error.status || 400, JSON.stringify({ error: error.message }), 'application/json; charset=utf-8');
    });
    return;
  }

  const staticFile = staticFiles[pathname];
  if (staticFile) {
    try {
      const body = fs.readFileSync(path.join(WEB_ROOT, staticFile[0]));
      send(response, 200, body, staticFile[1], 'public, max-age=300');
    } catch {
      send(response, 500, 'Unable to load the dashboard.', 'text/plain; charset=utf-8');
    }
    return;
  }

  send(response, 404, 'Not found', 'text/plain; charset=utf-8');
}

function startServer() {
  const server = http.createServer(requestHandler);
  const bootId = readText(path.join(HOST_SYS, 'kernel', 'random', 'boot_id'));
  if (settings.runtimeActive) eventStore.add('system', 'warning', 'Unexpected monitor shutdown', 'The previous monitor session did not shut down cleanly.');
  if (bootId && settings.lastBootId !== bootId) eventStore.add('boot', 'info', 'Host boot detected', 'A new host boot was detected.');
  const startEvent = eventStore.add('monitor', 'info', 'Monitor started', 'Nodelight monitoring started.');
  sendWebhook({ key: 'monitor-started', severity: 'info', title: 'Monitor started', message: 'Nodelight monitoring started.', timestamp: startEvent.timestamp });
  settings.runtimeActive = true;
  if (bootId) settings.lastBootId = bootId;
  saveSettings();
  serviceMonitor.refresh();
  checkLatestVersion();
  scanSystemLogs();
  runScheduledSmartTests();
  recordHistorySample();
  const historyTimer = setInterval(recordHistorySample, HISTORY_SAMPLE_INTERVAL_MS);
  const serviceTimer = setInterval(() => serviceMonitor.refresh(), SERVICE_CHECK_INTERVAL_MS);
  const smartTimer = setInterval(runScheduledSmartTests, 30 * 1000);
  const versionTimer = setInterval(checkLatestVersion, VERSION_CHECK_INTERVAL_MS);
  const logTimer = setInterval(scanSystemLogs, 5 * 60 * 1000);
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Nodelight is listening on port ${PORT}`);
    if (!process.env.DASHBOARD_PASSWORD) {
      console.warn('DASHBOARD_PASSWORD is empty; the dashboard is not password protected.');
    }
  });

  const shutdown = () => {
    clearInterval(historyTimer);
    clearInterval(serviceTimer);
    clearInterval(smartTimer);
    clearInterval(versionTimer);
    clearInterval(logTimer);
    settings.runtimeActive = false;
    saveSettings();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) startServer();

module.exports = {
  baseDiskName,
  compareSemanticVersions,
  collectSnapshot,
  cpuUsage,
  HistoryStore,
  isPhysicalDiskName,
  parseDiskStats,
  parseCpuTimes,
  parseIpv4Addresses,
  parseMemInfo,
  parseMountTable,
  parseNetwork,
  parseServiceChecks,
  parseSocketStats,
  parseSmartctlJson,
  redactSnapshot,
  requestHandler,
  scheduleKey,
  startServer,
  validateSmartSchedule,
};
