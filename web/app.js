'use strict';

const POLL_MS = 3000;
const MAX_HISTORY = 40;
const history = [];
let pollTimer = null;
let isPaused = false;
let inFlight = false;
let toastTimer = null;

const byId = (id) => document.getElementById(id);
const setText = (id, value) => { byId(id).textContent = value; };
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));

function formatBytes(bytes, rate = false) {
  const value = Math.max(0, Number(bytes) || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const index = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const amount = value / (1024 ** index);
  const decimals = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(decimals)} ${units[index]}${rate ? '/s' : ''}`;
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusFor(snapshot) {
  const temperature = snapshot.temperature.celsius;
  const values = [snapshot.cpu.usage, snapshot.memory.usage, snapshot.disk.usage];
  if (values.some((value) => value >= 95) || (temperature !== null && temperature >= 90)) return ['Needs attention', 'critical'];
  if (values.some((value) => value >= 80) || (temperature !== null && temperature >= 78)) return ['Running warm', 'warning'];
  return ['Everything looks good', ''];
}

function resourceStatus(value) {
  if (value >= 95) return ['Critical', 'critical'];
  if (value >= 80) return ['Elevated', 'warning'];
  return ['Normal', ''];
}

function setBar(id, value) {
  byId(id).style.width = `${clamp(value)}%`;
}

function updateProcesses(processes) {
  setText('processCount', processes.processCount || 0);
  const table = byId('processTable');
  if (!processes.topProcesses?.length) {
    table.innerHTML = '<tr><td colspan="3" class="empty-row">Process details are not exposed by this host.</td></tr>';
    return;
  }
  table.replaceChildren(...processes.topProcesses.map((process) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const pid = document.createElement('td');
    const memory = document.createElement('td');
    name.textContent = process.name;
    name.title = process.name;
    pid.textContent = process.pid;
    memory.textContent = formatBytes(process.memoryBytes);
    row.append(name, pid, memory);
    return row;
  }));
}

function updateDashboard(snapshot) {
  const cpu = clamp(snapshot.cpu.usage);
  const memory = clamp(snapshot.memory.usage);
  const disk = clamp(snapshot.disk.usage);
  const [healthLabel, healthClass] = statusFor(snapshot);
  const [cpuLabel, cpuClass] = resourceStatus(cpu);

  document.title = `${snapshot.dashboardName} · Nodelight`;
  setText('serverIdentity', `${snapshot.dashboardName} · ${snapshot.machine.hostname}`);
  setText('healthState', healthLabel);
  byId('healthState').className = `health-state ${healthClass}`.trim();
  setText('heroUptime', formatDuration(snapshot.system.uptimeSeconds));
  setText('lastUpdated', new Date(snapshot.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));

  setText('cpuValue', Math.round(cpu));
  byId('cpuRing').style.setProperty('--value', cpu.toFixed(1));
  setText('cpuModel', snapshot.machine.cpuModel);
  setText('loadOne', snapshot.cpu.load1.toFixed(2));
  setText('cpuCores', snapshot.machine.cpuCores);
  setText('cpuStatus', cpuLabel);
  byId('cpuStatus').className = `micro-status ${cpuClass}`.trim();

  setText('memoryValue', Math.round(memory));
  setText('memoryUsed', formatBytes(snapshot.memory.usedBytes));
  setText('memoryTotal', formatBytes(snapshot.memory.totalBytes));
  setText('memoryAvailable', formatBytes(snapshot.memory.availableBytes));
  setText('swapUsed', snapshot.memory.swapTotalBytes ? formatBytes(snapshot.memory.swapUsedBytes) : 'Not configured');
  setBar('memoryBar', memory);

  setText('diskValue', Math.round(disk));
  setText('diskUsed', formatBytes(snapshot.disk.usedBytes));
  setText('diskTotal', formatBytes(snapshot.disk.totalBytes));
  setText('diskAvailable', formatBytes(snapshot.disk.availableBytes));
  setBar('diskBar', disk);

  setText('networkDown', formatBytes(snapshot.network.rxBytesPerSecond, true));
  setText('networkUp', formatBytes(snapshot.network.txBytesPerSecond, true));
  setText('networkTotal', `${formatBytes(snapshot.network.rxBytes)} ↓ · ${formatBytes(snapshot.network.txBytes)} ↑`);

  setText('hostname', snapshot.machine.hostname);
  setText('operatingSystem', snapshot.machine.operatingSystem);
  setText('kernel', snapshot.machine.kernel);
  setText('architecture', snapshot.machine.architecture);
  setText('bootedAt', formatDate(snapshot.system.bootedAt));
  setText('temperature', snapshot.temperature.celsius === null ? 'Not exposed' : `${snapshot.temperature.celsius.toFixed(1)} °C`);
  updateProcesses(snapshot.system);

  history.push(cpu);
  if (history.length > MAX_HISTORY) history.shift();
  setText('cpuPeak', `Peak ${Math.round(Math.max(...history))}%`);
  drawChart();
  setText('footerMessage', `${snapshot.network.interfaces.length} network interface${snapshot.network.interfaces.length === 1 ? '' : 's'} · load ${snapshot.cpu.load5.toFixed(2)} / ${snapshot.cpu.load15.toFixed(2)}`);
  byId('heroStatusDot').parentElement.classList.remove('offline');
}

function drawChart() {
  const canvas = byId('cpuChart');
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);

  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);

  context.strokeStyle = 'rgba(255,255,255,0.055)';
  context.lineWidth = 1;
  for (let line = 1; line < 4; line += 1) {
    const y = (height / 4) * line;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }

  if (history.length < 2) return;
  const points = history.map((value, index) => ({
    x: (index / (MAX_HISTORY - 1)) * width,
    y: height - (clamp(value) / 100) * (height - 8) - 4,
  }));
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, 'rgba(186,248,107,0.28)');
  gradient.addColorStop(1, 'rgba(186,248,107,0)');

  context.beginPath();
  context.moveTo(points[0].x, height);
  points.forEach((point) => context.lineTo(point.x, point.y));
  context.lineTo(points.at(-1).x, height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();

  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.strokeStyle = '#baf86b';
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = 'rgba(186,248,107,0.28)';
  context.shadowBlur = 8;
  context.stroke();
  context.shadowBlur = 0;
}

function showError(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  byId('heroStatusDot').parentElement.classList.add('offline');
  setText('healthState', 'Connection lost');
  byId('healthState').className = 'health-state critical';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  byId('refreshButton').disabled = true;
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    updateDashboard(await response.json());
  } catch {
    showError('Could not reach the monitor. Nodelight will keep trying.');
  } finally {
    inFlight = false;
    byId('refreshButton').disabled = false;
  }
}

function togglePolling() {
  isPaused = !isPaused;
  byId('pollButton').setAttribute('aria-pressed', String(isPaused));
  setText('pollLabel', isPaused ? 'Paused' : 'Live · 3s');
  if (isPaused) {
    clearInterval(pollTimer);
    pollTimer = null;
  } else {
    refresh();
    pollTimer = setInterval(refresh, POLL_MS);
  }
}

byId('refreshButton').addEventListener('click', refresh);
byId('pollButton').addEventListener('click', togglePolling);
window.addEventListener('resize', drawChart);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isPaused) refresh();
});

refresh();
pollTimer = setInterval(refresh, POLL_MS);
