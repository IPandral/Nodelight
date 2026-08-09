'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const PORT = Number.parseInt(process.env.PORT || '8080', 10);
const HOST_PROC = process.env.HOST_PROC || '/proc';
const HOST_SYS = process.env.HOST_SYS || '/sys';
const HOST_ETC = process.env.HOST_ETC || '/etc';
const HOST_ROOT = process.env.HOST_ROOT || path.parse(process.cwd()).root;
const WEB_ROOT = path.join(__dirname, 'web');
const STARTED_AT = Date.now();

let previousCpu = null;
let previousNetwork = null;
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
    interfaces.push({ name, rxBytes: received, txBytes: sent });
  }

  return { rxBytes, txBytes, interfaces };
}

function fallbackNetwork() {
  const interfaces = Object.entries(os.networkInterfaces())
    .filter(([name]) => !/loopback/i.test(name))
    .map(([name]) => ({ name, rxBytes: 0, txBytes: 0 }));
  return { rxBytes: 0, txBytes: 0, interfaces };
}

function networkWithRate(current, now) {
  const elapsed = previousNetwork ? Math.max((now - previousNetwork.at) / 1000, 0.001) : 0;
  const result = {
    ...current,
    rxBytesPerSecond: elapsed ? Math.max(0, (current.rxBytes - previousNetwork.rxBytes) / elapsed) : 0,
    txBytesPerSecond: elapsed ? Math.max(0, (current.txBytes - previousNetwork.txBytes) / elapsed) : 0,
  };
  previousNetwork = { at: now, rxBytes: current.rxBytes, txBytes: current.txBytes };
  return result;
}

function diskStats() {
  try {
    const stats = fs.statfsSync(HOST_ROOT, { bigint: true });
    const blockSize = stats.bsize;
    const total = stats.blocks * blockSize;
    const available = stats.bavail * blockSize;
    const free = stats.bfree * blockSize;
    const used = total - free;
    return {
      totalBytes: Number(total),
      availableBytes: Number(available),
      usedBytes: Number(used),
      usage: total ? Number((used * 10000n) / total) / 100 : 0,
      path: '/',
    };
  } catch {
    return { totalBytes: 0, availableBytes: 0, usedBytes: 0, usage: 0, path: '/' };
  }
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

function collectSnapshot() {
  const now = Date.now();
  const rawCpu = parseCpuTimes(readText(path.join(HOST_PROC, 'stat'))) || fallbackCpuTimes();
  const usage = cpuUsage(rawCpu, previousCpu);
  previousCpu = rawCpu;

  const memoryText = readText(path.join(HOST_PROC, 'meminfo'));
  const memory = memoryText ? parseMemInfo(memoryText) : fallbackMemory();
  const rawNetwork = parseNetwork(readText(path.join(HOST_PROC, 'net', 'dev')));
  const network = networkWithRate(rawNetwork.interfaces.length ? rawNetwork : fallbackNetwork(), now);
  const uptimeSeconds = systemUptime();
  const release = osRelease();
  const cpu = cpuInfo();
  const processes = processStats(now);
  const loads = loadAverage();
  const hostName = readText(path.join(HOST_ETC, 'hostname')) || os.hostname();
  const kernel = readText(path.join(HOST_PROC, 'sys', 'kernel', 'osrelease')) || os.release();

  return {
    timestamp: new Date(now).toISOString(),
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
    network,
    temperature: thermalStats(),
    system: {
      uptimeSeconds,
      bootedAt: new Date(now - uptimeSeconds * 1000).toISOString(),
      processCount: processes.count,
      topProcesses: processes.top,
      monitorUptimeSeconds: Math.floor((now - STARTED_AT) / 1000),
    },
  };
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

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
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
    try {
      send(response, 200, JSON.stringify(collectSnapshot()), 'application/json; charset=utf-8');
    } catch (error) {
      console.error('Unable to collect metrics:', error);
      send(response, 500, JSON.stringify({ error: 'Metrics are temporarily unavailable.' }), 'application/json; charset=utf-8');
    }
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
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Nodelight is listening on port ${PORT}`);
    if (!process.env.DASHBOARD_PASSWORD) {
      console.warn('DASHBOARD_PASSWORD is empty; the dashboard is not password protected.');
    }
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return server;
}

if (require.main === module) startServer();

module.exports = {
  collectSnapshot,
  cpuUsage,
  parseCpuTimes,
  parseMemInfo,
  parseNetwork,
  requestHandler,
  startServer,
};
