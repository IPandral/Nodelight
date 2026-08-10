'use strict';

const POLL_MS = 3000;
const MAX_HISTORY = 40;
const history = [];
let pollTimer = null;
let isPaused = false;
let inFlight = false;
let toastTimer = null;
let historicalMetrics = null;
let historyRange = 'day';
let scheduleDirty = false;
let scheduleLoaded = false;
let scheduleSaving = false;
let smartAvailable = false;

const byId = (id) => document.getElementById(id);
const setText = (id, value) => { byId(id).textContent = value; };
const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value) || 0));
const makeElement = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== '') element.textContent = text;
  return element;
};

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

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? new Intl.NumberFormat().format(Math.max(0, Math.round(number))) : '—';
}

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${clamp(number).toFixed(number < 10 ? 1 : 0)}%` : '—';
}

function formatPowerHours(value) {
  const hours = Number(value);
  if (!Number.isFinite(hours)) return '—';
  if (hours < 48) return `${Math.round(hours)} h`;
  return `${Math.round(hours).toLocaleString()} h · ${Math.floor(hours / 8766)}y`;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function statusClass(value) {
  const status = String(value || '').toLowerCase();
  if (['failed', 'failing', 'critical', 'error', 'down', 'offline', 'inactive', 'unhealthy'].some((word) => status.includes(word))) return 'critical';
  if (['warning', 'warn', 'degraded', 'unknown', 'pending'].some((word) => status.includes(word))) return 'warning';
  if (['healthy', 'running', 'active', 'online', 'up', 'ok', 'passed'].some((word) => status.includes(word))) return '';
  return 'unknown';
}

function statusFor(snapshot) {
  const temperature = snapshot.temperature?.celsius;
  const mountUsage = (snapshot.mounts?.length ? snapshot.mounts : [snapshot.disk]).map((mount) => mount.usage);
  const values = [snapshot.cpu.usage, snapshot.memory.usage, ...mountUsage].filter(Number.isFinite);
  const smartFailure = snapshot.physicalDisks?.some((disk) => disk.smart?.available && smartPassed(disk.smart) === false);
  const serviceFailure = snapshot.services?.some((service) => statusClass(service.status) === 'critical');
  const activeAlerts = Number(snapshot.alerts?.activeCount ?? snapshot.alerts?.active?.length) || 0;
  if (smartFailure || serviceFailure || activeAlerts || values.some((value) => value >= 95) || (temperature !== null && temperature >= 90)) return ['Needs attention', 'critical'];
  const serviceWarning = snapshot.services?.some((service) => statusClass(service.status) === 'warning');
  if (serviceWarning || values.some((value) => value >= 80) || (temperature !== null && temperature >= 78)) return ['Running warm', 'warning'];
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

function updateProcesses(processes, privacyMode = false) {
  setText('processCount', processes.processCount || 0);
  const table = byId('processTable');
  if (!processes.topProcesses?.length) {
    table.innerHTML = '<tr><td colspan="3" class="empty-row">Process details are not exposed by this host.</td></tr>';
    return;
  }
  table.replaceChildren(...processes.topProcesses.map((process, index) => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const pid = document.createElement('td');
    const memory = document.createElement('td');
    name.textContent = privacyMode ? `Process ${index + 1}` : process.name;
    name.title = name.textContent;
    pid.textContent = process.pid;
    memory.textContent = formatBytes(process.memoryBytes);
    row.append(name, pid, memory);
    return row;
  }));
}

function mountStatus(status) {
  if (status === 'critical') return ['Critical', 'critical'];
  if (status === 'warning') return ['Watch', 'warning'];
  return ['Healthy', ''];
}

function updateMounts(mounts, privacyMode = false) {
  const list = byId('mountList');
  const records = Array.isArray(mounts) ? mounts : [];
  const critical = records.filter((mount) => mount.status === 'critical').length;
  const warning = records.filter((mount) => mount.status === 'warning').length;

  if (!records.length) {
    list.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'mount-empty',
      textContent: 'No host filesystems were available to inspect.',
    }));
    setText('mountSummary', 'No mounts found');
    byId('mountSummary').className = 'mount-summary';
    return;
  }

  const [summary, summaryClass] = critical
    ? [`${critical} critical mount${critical === 1 ? '' : 's'}`, 'critical']
    : warning
      ? [`${warning} mount${warning === 1 ? '' : 's'} to watch`, 'warning']
      : [`${records.length} healthy mount${records.length === 1 ? '' : 's'}`, ''];
  setText('mountSummary', summary);
  byId('mountSummary').className = `mount-summary ${summaryClass}`.trim();

  list.replaceChildren(...records.map((mount, index) => {
    const usage = clamp(mount.usage);
    const [label, statusClass] = mountStatus(mount.status);
    const card = document.createElement('article');
    card.className = `mount-card ${statusClass}`.trim();

    const top = document.createElement('div');
    top.className = 'mount-card-top';
    const details = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = privacyMode ? `Mount ${index + 1}` : mount.mount || mount.path || '/';
    name.title = name.textContent;
    const source = document.createElement('p');
    const parts = privacyMode ? ['Source hidden', mount.filesystem].filter(Boolean) : [mount.source, mount.filesystem].filter(Boolean);
    source.textContent = parts.join(' · ') || 'Host filesystem';
    source.title = source.textContent;
    details.append(name, source);
    const state = document.createElement('span');
    state.className = `mount-state ${statusClass}`.trim();
    state.textContent = label;
    top.append(details, state);

    const capacity = document.createElement('div');
    capacity.className = 'mount-capacity';
    const available = document.createElement('strong');
    available.textContent = formatBytes(mount.availableBytes);
    const used = document.createElement('span');
    used.textContent = `${Math.round(usage)}% used of ${formatBytes(mount.totalBytes)}`;
    capacity.append(available, used);

    const meter = document.createElement('div');
    meter.className = 'mount-meter';
    meter.setAttribute('aria-label', `${Math.round(usage)}% used`);
    const fill = document.createElement('i');
    fill.style.width = `${usage}%`;
    meter.append(fill);
    card.append(top, capacity, meter);
    return card;
  }));
}

const SMART_ATTRIBUTES = [
  ['reallocatedSectors', 'Reallocated', (value) => value > 0, ''],
  ['pendingSectors', 'Pending sectors', (value) => value > 0, ''],
  ['offlineUncorrectable', 'Uncorrectable', (value) => value > 0, ''],
  ['crcErrors', 'CRC errors', (value) => value > 0, ''],
  ['percentageUsed', 'Wear used', (value) => value >= 80, '%'],
  ['availableSpare', 'Available spare', (value) => value < 20, '%'],
  ['mediaErrors', 'Media errors', (value) => value > 0, ''],
  ['unsafeShutdowns', 'Unsafe shutdowns', (value) => value > 0, ''],
];

function smartTemperature(smart) {
  const value = smart?.temperatureC ?? smart?.temperatureCelsius;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function smartPassed(smart) {
  if (typeof smart?.passed === 'boolean') return smart.passed;
  return typeof smart?.healthPassed === 'boolean' ? smart.healthPassed : null;
}

function smartAttributeValues(smart = {}) {
  const source = smart.attributes && !Array.isArray(smart.attributes) ? smart.attributes : {};
  const values = {
    ...source,
    percentageUsed: source.percentageUsed ?? smart.percentageUsed,
    availableSpare: source.availableSpare ?? smart.availableSpare,
    mediaErrors: source.mediaErrors ?? smart.mediaErrors,
    unsafeShutdowns: source.unsafeShutdowns ?? smart.unsafeShutdowns,
    offlineUncorrectable: source.offlineUncorrectable ?? smart.grownDefects,
  };
  if (Array.isArray(smart.attributes)) {
    const rawValue = (id) => {
      const raw = smart.attributes.find((attribute) => Number(attribute.id) === id)?.raw;
      const match = String(raw ?? '').match(/\d+/);
      return match ? Number(match[0]) : undefined;
    };
    values.reallocatedSectors ??= rawValue(5);
    values.pendingSectors ??= rawValue(197);
    values.offlineUncorrectable ??= rawValue(198);
    values.crcErrors ??= rawValue(199);
  }
  return values;
}

function smartSelfTestText(selfTest) {
  if (!selfTest) return 'No recent test';
  if (typeof selfTest === 'string') return selfTest;
  return [selfTest.type, selfTest.status || selfTest.result, selfTest.remainingPercent === undefined ? '' : `${selfTest.remainingPercent}% remaining`]
    .filter(Boolean)
    .join(' · ') || 'No recent test';
}

function diskHealth(disk) {
  const smart = disk.smart || {};
  const attributes = smartAttributeValues(smart);
  const temperature = smartTemperature(smart);
  const hasWarning = SMART_ATTRIBUTES.some(([key, , warning]) => Number.isFinite(Number(attributes[key])) && warning(Number(attributes[key])));
  if (!smart.available) return ['SMART unavailable', 'unavailable'];
  if (smartPassed(smart) === false || statusClass(smart.status) === 'critical') return ['SMART failing', 'critical'];
  if (temperature !== null && temperature >= 55) return ['Too hot', 'critical'];
  if (hasWarning || (temperature !== null && temperature >= 45)) return ['Needs review', 'warning'];
  return [smart.status || 'SMART healthy', ''];
}

function updatePhysicalDisks(disks, privacyMode = false, canManage = true) {
  const list = byId('physicalDiskList');
  const records = Array.isArray(disks) ? disks : [];
  const availableCount = records.filter((disk) => disk.smart?.available).length;
  const criticalCount = records.filter((disk) => diskHealth(disk)[1] === 'critical').length;
  const warningCount = records.filter((disk) => diskHealth(disk)[1] === 'warning').length;
  const issueCount = criticalCount + warningCount;

  if (!records.length) {
    list.replaceChildren(makeElement('div', 'mount-empty', 'No physical disks were reported by the host.'));
    setText('diskSummary', 'No disks found');
    byId('diskSummary').className = 'mount-summary';
    return false;
  }

  setText('diskSummary', issueCount
    ? `${issueCount} disk${issueCount === 1 ? '' : 's'} need review`
    : `${records.length} disk${records.length === 1 ? '' : 's'} · ${availableCount} with SMART`);
  byId('diskSummary').className = `mount-summary ${criticalCount ? 'critical' : issueCount ? 'warning' : ''}`.trim();

  list.replaceChildren(...records.map((disk, diskIndex) => {
    const smart = disk.smart || {};
    const attributes = smartAttributeValues(smart);
    const io = disk.io || {};
    const device = String(disk.device || disk.name || disk.path || `disk-${diskIndex + 1}`);
    const requestDevice = device.replace(/^\/dev\//, '');
    const model = [disk.vendor, disk.model].filter(Boolean).join(' ') || `Physical disk ${diskIndex + 1}`;
    const [healthLabel, healthClass] = diskHealth(disk);
    const card = makeElement('article', `disk-card ${healthClass}`.trim());

    const head = makeElement('div', 'disk-card-head');
    const title = makeElement('div', 'disk-title');
    const heading = makeElement('h3', '', model);
    heading.title = model;
    const meta = makeElement('div', 'disk-meta');
    const path = makeElement('span', 'device-tag', privacyMode ? `Disk ${diskIndex + 1}` : disk.path || `/dev/${requestDevice}`);
    const size = makeElement('span', '', formatBytes(disk.sizeBytes));
    const mediaType = makeElement('span', '', String(disk.type || (disk.rotational ? 'HDD' : 'SSD')).toUpperCase());
    const serial = makeElement('span', '', privacyMode ? 'Serial hidden' : disk.serial ? `S/N ${disk.serial}` : 'No serial reported');
    meta.append(path, size, mediaType, serial);
    title.append(heading, meta);
    const health = makeElement('span', `smart-pill ${healthClass}`.trim(), healthLabel);
    head.append(title, health);

    const mounts = makeElement('div', 'disk-mounts');
    const mountRecords = Array.isArray(disk.mounts) ? disk.mounts : [];
    if (!mountRecords.length) {
      mounts.append(makeElement('span', '', 'Not mounted'));
    } else {
      mountRecords.forEach((mount, mountIndex) => {
        const label = typeof mount === 'string' ? mount : mount.mount || mount.path || mount.name || 'Mounted';
        mounts.append(makeElement('span', '', privacyMode ? `Mount ${mountIndex + 1}` : label));
      });
    }

    const body = makeElement('div', 'disk-body');
    const smartPanel = makeElement('div', 'disk-subpanel');
    smartPanel.append(makeElement('h4', '', 'SMART health'));
    const smartKpis = makeElement('div', 'disk-kpis');
    [
      ['Temperature', smartTemperature(smart) === null ? '—' : `${smartTemperature(smart).toFixed(0)} °C`],
      ['Power-on time', formatPowerHours(smart.powerOnHours)],
      ['Power cycles', formatNumber(smart.powerCycles)],
      ['Self-test', smartSelfTestText(smart.selfTest)],
    ].forEach(([label, value]) => {
      const item = makeElement('div');
      item.append(makeElement('span', '', label), makeElement('strong', '', value));
      smartKpis.append(item);
    });
    smartPanel.append(smartKpis);

    const attributeGrid = makeElement('div', 'smart-attributes');
    let attributeCount = 0;
    SMART_ATTRIBUTES.forEach(([key, label, warning, suffix]) => {
      const value = Number(attributes[key]);
      if (!Number.isFinite(value)) return;
      attributeCount += 1;
      const attribute = makeElement('div', `smart-attribute ${warning(value) ? 'attention' : ''}`.trim());
      attribute.append(makeElement('span', '', label), makeElement('strong', '', `${formatNumber(value)}${suffix}`));
      attributeGrid.append(attribute);
    });
    if (attributeCount) smartPanel.append(attributeGrid);
    const noteClass = healthClass === 'critical' ? 'critical' : healthClass === 'warning' ? 'warning' : '';
    const note = smart.error || smart.reason
      ? String(smart.error || smart.reason)
      : !smart.available
        ? 'Install or expose smartmontools to read health data for this drive.'
        : attributeCount
          ? 'Highlighted counters should be reviewed; a non-zero value is not always an immediate failure.'
          : 'No SMART warning counters were reported.';
    smartPanel.append(makeElement('p', `smart-note ${noteClass}`.trim(), note));

    const ioPanel = makeElement('div', 'disk-subpanel');
    ioPanel.append(makeElement('h4', '', 'Live disk activity'));
    const ioGrid = makeElement('div', 'io-grid');
    [
      ['Read', formatBytes(io.readBytesPerSecond, true)],
      ['Write', formatBytes(io.writeBytesPerSecond, true)],
      ['Read IOPS', formatNumber(io.readIops)],
      ['Write IOPS', formatNumber(io.writeIops)],
      ['Busy', formatPercent(io.busyPercent)],
      ['Media', disk.rotational ? 'Rotational' : 'Solid state'],
    ].forEach(([label, value]) => {
      const item = makeElement('div');
      item.append(makeElement('span', '', label), makeElement('strong', '', value));
      ioGrid.append(item);
    });
    ioPanel.append(ioGrid);
    body.append(smartPanel, ioPanel);

    const actions = makeElement('div', 'disk-actions');
    const buttons = makeElement('div', 'test-buttons');
    const canTest = canManage && smart.available && smart.enabled !== false;
    [['short', 'Start short test', ''], ['long', 'Start extended test', 'dangerous']].forEach(([type, label, className]) => {
      const button = makeElement('button', `action-button ${className}`.trim(), label);
      button.type = 'button';
      button.disabled = !canTest;
      button.setAttribute('aria-label', `${label} on ${model}`);
      button.title = canTest ? `${label} on ${device}` : smart.available ? 'SMART is disabled on this drive.' : 'SMART data is unavailable for this drive.';
      button.addEventListener('click', () => runSmartTest(button, requestDevice, type, model));
      buttons.append(button);
    });
    const hint = makeElement('span', 'test-hint', canTest
      ? 'Tests run inside the drive and survive closing this page.'
      : !canManage ? 'Set a dashboard password to enable test controls.'
        : smart.available ? 'Enable SMART on this drive before starting a test.' : 'Manual tests are disabled because SMART is unavailable.');
    actions.append(buttons, hint);
    card.append(head, mounts, body, actions);
    return card;
  }));

  return availableCount > 0;
}

function scheduleTime(hour, minute) {
  const safeHour = clamp(hour, 0, 23);
  const safeMinute = clamp(minute, 0, 59);
  return `${String(Math.round(safeHour)).padStart(2, '0')}:${String(Math.round(safeMinute)).padStart(2, '0')}`;
}

function readScheduleTime(id) {
  const [hour = '0', minute = '0'] = byId(id).value.split(':');
  return { hour: clamp(Number(hour), 0, 23), minute: clamp(Number(minute), 0, 59) };
}

function syncScheduleControls() {
  const globallyDisabled = !smartAvailable || scheduleSaving;
  const shortEnabled = byId('shortScheduleEnabled').checked;
  const shortWeekly = byId('shortScheduleFrequency').value === 'weekly';
  const longEnabled = byId('longScheduleEnabled').checked;
  byId('shortScheduleEnabled').disabled = globallyDisabled;
  byId('shortScheduleFrequency').disabled = globallyDisabled || !shortEnabled;
  byId('shortScheduleDay').disabled = globallyDisabled || !shortEnabled || !shortWeekly;
  byId('shortScheduleTime').disabled = globallyDisabled || !shortEnabled;
  byId('longScheduleEnabled').disabled = globallyDisabled;
  byId('longScheduleDay').disabled = globallyDisabled || !longEnabled;
  byId('longScheduleTime').disabled = globallyDisabled || !longEnabled;
  byId('smartScheduleSave').disabled = globallyDisabled;
  byId('shortScheduleDayLabel').hidden = !shortWeekly;
}

function populateSchedule(schedule = {}) {
  const short = schedule.short || {};
  const long = schedule.long || {};
  byId('shortScheduleEnabled').checked = Boolean(short.enabled);
  byId('shortScheduleFrequency').value = short.frequency === 'weekly' ? 'weekly' : 'daily';
  byId('shortScheduleDay').value = String(clamp(short.dayOfWeek ?? 0, 0, 6));
  byId('shortScheduleTime').value = scheduleTime(short.hour ?? 2, short.minute ?? 0);
  byId('longScheduleEnabled').checked = Boolean(long.enabled);
  byId('longScheduleDay').value = String(clamp(long.dayOfMonth ?? 1, 1, 28));
  byId('longScheduleTime').value = scheduleTime(long.hour ?? 3, long.minute ?? 0);
  setText('scheduleTimezone', schedule.timezone ? `Server · ${schedule.timezone}` : 'Server local time');
  scheduleLoaded = true;
  scheduleDirty = false;
}

function updateSmartSchedule(schedule, canSchedule) {
  const canManage = schedule?.canManage !== false;
  smartAvailable = canSchedule && canManage;
  if (!scheduleDirty && !scheduleSaving && (!scheduleLoaded || schedule)) populateSchedule(schedule || {});
  syncScheduleControls();
  if (canSchedule && !canManage) {
    setText('scheduleMessage', 'Set a dashboard password to enable schedule changes.');
  } else if (!smartAvailable) {
    setText('scheduleMessage', 'Scheduling is unavailable because no drive exposes SMART controls.');
  } else if (scheduleDirty) {
    setText('scheduleMessage', 'You have unsaved schedule changes.');
  } else {
    setText('scheduleMessage', 'Saved schedules run against every compatible physical disk.');
  }
}

function updateServices(services, privacyMode = false) {
  const list = byId('serviceList');
  const records = Array.isArray(services) ? services : [];
  if (!records.length) {
    list.replaceChildren(makeElement('div', 'mount-empty', 'No service checks are configured.'));
    setText('serviceSummary', 'No checks configured');
    byId('serviceSummary').className = 'mount-summary';
    return;
  }
  const issues = records.filter((service) => ['warning', 'critical'].includes(statusClass(service.status))).length;
  setText('serviceSummary', issues ? `${issues} need attention` : `${records.length} healthy`);
  byId('serviceSummary').className = `mount-summary ${issues ? 'warning' : ''}`.trim();
  list.replaceChildren(...records.map((service) => {
    const stateClass = statusClass(service.status);
    const item = makeElement('article', 'service-item');
    const head = makeElement('div', 'service-item-head');
    const copy = makeElement('div');
    copy.append(makeElement('h3', '', service.name || service.target || 'Service check'));
    const target = privacyMode ? 'Target hidden in demo mode' : [service.type, service.target].filter(Boolean).join(' · ') || 'Host service';
    const targetText = makeElement('p', '', target);
    targetText.title = target;
    copy.append(targetText);
    head.append(copy, makeElement('span', `service-state ${stateClass}`.trim(), service.status || 'Unknown'));
    const meta = makeElement('div', 'service-meta');
    meta.append(makeElement('span', '', service.message || service.detail || 'No additional details'));
    const latency = makeElement('strong', '', Number.isFinite(Number(service.latencyMs)) ? `${Math.round(Number(service.latencyMs))} ms` : '—');
    meta.append(latency);
    item.append(head, meta);
    return item;
  }));
}

function interfaceMetric(record, ...keys) {
  for (const key of keys) {
    if (Number.isFinite(Number(record[key]))) return Number(record[key]);
  }
  return 0;
}

function updateInterfaces(interfaces) {
  const list = byId('interfaceList');
  const records = Array.isArray(interfaces) ? interfaces : [];
  if (!records.length) {
    list.replaceChildren(makeElement('div', 'mount-empty', 'No network interfaces were reported.'));
    setText('interfaceSummary', 'No links found');
    return;
  }
  const totalErrors = records.reduce((total, record) => total + interfaceMetric(record, 'rxErrors') + interfaceMetric(record, 'txErrors') + interfaceMetric(record, 'rxDropped', 'rxDrops') + interfaceMetric(record, 'txDropped', 'txDrops'), 0);
  setText('interfaceSummary', totalErrors ? `${formatNumber(totalErrors)} errors / drops` : `${records.length} link${records.length === 1 ? '' : 's'} clean`);
  byId('interfaceSummary').className = `mount-summary ${totalErrors ? 'warning' : ''}`.trim();
  list.replaceChildren(...records.map((record) => {
    const errors = interfaceMetric(record, 'rxErrors') + interfaceMetric(record, 'txErrors');
    const dropped = interfaceMetric(record, 'rxDropped', 'rxDrops') + interfaceMetric(record, 'txDropped', 'txDrops');
    const packets = interfaceMetric(record, 'rxPackets') + interfaceMetric(record, 'txPackets');
    const isDown = record.up === false || String(record.status || record.state || '').toLowerCase() === 'down';
    const stateClass = isDown ? 'critical' : errors || dropped ? 'warning' : '';
    const item = makeElement('article', 'interface-item');
    const head = makeElement('div', 'interface-item-head');
    const copy = makeElement('div');
    copy.append(makeElement('h3', '', record.name || record.interface || 'Network interface'));
    copy.append(makeElement('p', '', `${formatBytes(record.rxBytes)} received · ${formatBytes(record.txBytes)} sent`));
    head.append(copy, makeElement('span', `interface-state ${stateClass}`.trim(), isDown ? 'Down' : 'Active'));
    const rates = makeElement('div', 'interface-rate-grid');
    [['↓ Receive', formatBytes(record.rxBytesPerSecond, true)], ['↑ Send', formatBytes(record.txBytesPerSecond, true)]].forEach(([label, value]) => {
      const rate = makeElement('div', 'interface-rate');
      rate.append(makeElement('span', '', label), makeElement('strong', '', value));
      rates.append(rate);
    });
    const counters = makeElement('div', 'interface-counters');
    [['Packets', packets, false], ['Errors', errors, errors > 0], ['Dropped', dropped, dropped > 0]].forEach(([label, value, attention]) => {
      const counter = makeElement('div', attention ? 'attention' : '');
      counter.append(makeElement('span', '', label), makeElement('strong', '', formatNumber(value)));
      counters.append(counter);
    });
    item.append(head, rates, counters);
    return item;
  }));
}

function updateNetworkDetails(network, privacyMode = false) {
  const addresses = Array.isArray(network?.addresses) ? network.addresses : [];
  setText('networkAddresses', privacyMode ? 'Hidden in privacy demo' : addresses.length ? addresses.join(' / ') : 'Not exposed');
  const connections = network?.connections || {};
  const established = Number(connections.established) || 0;
  const listening = Number(connections.listening) || 0;
  setText('networkConnections', `${formatNumber(established)} established / ${formatNumber(listening)} listening`);
}

function updateActivity(events, alerts, privacyMode = false) {
  const activeCount = Number(alerts?.activeCount ?? alerts?.active?.length) || 0;
  setText('alertSummary', activeCount ? `${activeCount} active alert${activeCount === 1 ? '' : 's'}` : 'No active alerts');
  byId('alertSummary').className = `alert-summary ${activeCount ? 'critical' : ''}`.trim();
  setText('notificationState', alerts?.webhookConfigured
    ? 'Alert delivery is configured. New warnings can be sent to your webhook.'
    : 'No webhook is configured; alerts currently stay inside this dashboard.');
  byId('notificationState').className = `notification-state ${alerts?.webhookConfigured ? 'configured' : ''}`.trim();

  const list = byId('eventList');
  const records = Array.isArray(events) ? events.slice(0, 20) : [];
  if (!records.length) {
    list.replaceChildren(makeElement('li', 'mount-empty', 'No recent system or alert events.'));
    return;
  }
  list.replaceChildren(...records.map((event) => {
    const severity = String(event.severity || '').toLowerCase();
    const level = ['critical', 'error', 'high'].includes(severity) ? 'critical' : ['warning', 'warn', 'medium'].includes(severity) ? 'warning' : '';
    const item = makeElement('li', `event-item ${level}`.trim());
    item.append(makeElement('span', 'event-dot'));
    const copy = makeElement('div', 'event-copy');
    copy.append(makeElement('strong', '', event.title || event.type || event.severity || 'System event'));
    copy.append(makeElement('p', '', privacyMode ? 'Event details hidden in privacy demo mode.' : event.message || 'No event details supplied.'));
    const time = makeElement('time', '', formatDate(event.timestamp));
    if (event.timestamp) time.dateTime = event.timestamp;
    item.append(copy, time);
    return item;
  }));
}

function updateVersion(version = {}) {
  setText('currentVersion', version.current || 'Unknown');
  setText('latestVersion', version.latest || 'Not checked');
  setText('versionCheckedAt', version.checkedAt ? formatDate(version.checkedAt) : 'Not checked');
  const badge = byId('updateBadge');
  const releaseBuild = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(version.current || ''));
  badge.textContent = version.updateAvailable ? 'Update ready' : version.latest && releaseBuild ? 'Up to date' : version.latest ? 'Development build' : 'Unavailable';
  badge.className = `update-badge ${version.updateAvailable ? 'update' : version.latest && releaseBuild ? 'current' : ''}`.trim();
  const releaseLink = byId('releaseLink');
  const url = safeHttpUrl(version.releaseUrl);
  releaseLink.hidden = !(version.updateAvailable && url);
  if (url) releaseLink.href = url;
  else releaseLink.removeAttribute('href');
}

function updatePrivacyMode(enabled) {
  const privacy = Boolean(enabled);
  byId('privacyBadge').hidden = !privacy;
  document.body.classList.toggle('privacy-mode', privacy);
}

function updateDashboard(snapshot) {
  const cpu = clamp(snapshot.cpu.usage);
  const memory = clamp(snapshot.memory.usage);
  const disk = clamp(snapshot.disk.usage);
  const privacyMode = Boolean(snapshot.privacyMode);
  const [healthLabel, healthClass] = statusFor(snapshot);
  const [cpuLabel, cpuClass] = resourceStatus(cpu);

  document.title = `${snapshot.dashboardName} · Nodelight`;
  setText('serverIdentity', privacyMode ? `${snapshot.dashboardName} · Privacy demo` : `${snapshot.dashboardName} · ${snapshot.machine.hostname}`);
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

  setText('hostname', privacyMode ? 'Hidden in privacy mode' : snapshot.machine.hostname);
  setText('operatingSystem', snapshot.machine.operatingSystem);
  setText('kernel', snapshot.machine.kernel);
  setText('architecture', snapshot.machine.architecture);
  setText('bootedAt', formatDate(snapshot.system.bootedAt));
  setText('temperature', snapshot.temperature.celsius === null ? 'Not exposed' : `${snapshot.temperature.celsius.toFixed(1)} °C`);
  updateProcesses(snapshot.system, privacyMode);
  updateMounts(snapshot.mounts?.length ? snapshot.mounts : [snapshot.disk], privacyMode);
  const canManageSmart = snapshot.smartSchedule?.canManage !== false;
  const canScheduleSmart = updatePhysicalDisks(snapshot.physicalDisks, privacyMode, canManageSmart);
  updateSmartSchedule(snapshot.smartSchedule, canScheduleSmart);
  updateServices(snapshot.services, privacyMode);
  updateInterfaces(snapshot.network.interfaces);
  updateNetworkDetails(snapshot.network, privacyMode);
  updateActivity(snapshot.events, snapshot.alerts, privacyMode);
  updateVersion(snapshot.version);
  updatePrivacyMode(privacyMode);
  updateHistoricalCharts(snapshot.history);

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

function prepareCanvas(id) {
  const canvas = byId(id);
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * ratio));
  canvas.height = Math.max(1, Math.floor(rect.height * ratio));
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}

function drawHistoryGrid(context, width, height) {
  context.strokeStyle = 'rgba(255,255,255,0.055)';
  context.lineWidth = 1;
  for (let line = 1; line < 4; line += 1) {
    const y = (height / 4) * line;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
}

function historyPoints(samples, field, width, height, maximum) {
  const inset = 4;
  const count = Math.max(samples.length - 1, 1);
  return samples.map((sample, index) => ({
    x: (index / count) * width,
    y: height - (clamp(Number(sample[field]) / maximum * 100) / 100) * (height - inset * 2) - inset,
  }));
}

function drawHistoryLine(context, points, color, height, fill = true) {
  if (points.length < 2) return;
  if (fill) {
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, `${color}45`);
    gradient.addColorStop(1, `${color}00`);
    context.beginPath();
    context.moveTo(points[0].x, height);
    points.forEach((point) => context.lineTo(point.x, point.y));
    context.lineTo(points.at(-1).x, height);
    context.closePath();
    context.fillStyle = gradient;
    context.fill();
  }

  context.beginPath();
  points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.stroke();
}

function drawUsageHistory(canvasId, samples, field, color) {
  const { context, width, height } = prepareCanvas(canvasId);
  drawHistoryGrid(context, width, height);
  drawHistoryLine(context, historyPoints(samples, field, width, height, 100), color, height);
}

function drawNetworkHistory(samples) {
  const { context, width, height } = prepareCanvas('historyNetworkChart');
  drawHistoryGrid(context, width, height);
  const peak = Math.max(1, ...samples.flatMap((sample) => [
    Number(sample.rxBytesPerSecond) || 0,
    Number(sample.txBytesPerSecond) || 0,
  ]));
  drawHistoryLine(context, historyPoints(samples, 'rxBytesPerSecond', width, height, peak), '#70e9eb', height, false);
  drawHistoryLine(context, historyPoints(samples, 'txBytesPerSecond', width, height, peak), '#c3a8ff', height, false);
}

function updateHistoricalCharts(nextHistory) {
  if (nextHistory) historicalMetrics = nextHistory;
  const historyData = historicalMetrics || {};
  const samples = historyRange === 'month' ? historyData.last30Days || [] : historyData.last24Hours || [];
  const coverage = byId('historyCoverage');
  if (!historyData.recordingSince) {
    coverage.textContent = 'Collecting the first sample…';
  } else {
    const persistence = historyData.persistent ? 'saved on this server' : 'in memory only';
    coverage.textContent = `Since ${formatDate(historyData.recordingSince)} · ${persistence}`;
  }
  drawUsageHistory('historyCpuChart', samples, 'cpuUsage', '#baf86b');
  drawUsageHistory('historyMemoryChart', samples, 'memoryUsage', '#70e9eb');
  drawUsageHistory('historyDiskChart', samples, 'diskUsage', '#ffbd63');
  drawNetworkHistory(samples);
}

function selectHistoryRange(range) {
  historyRange = range;
  document.querySelectorAll('[data-history-range]').forEach((button) => {
    const selected = button.dataset.historyRange === range;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateHistoricalCharts();
}

function showToast(message, tone = 'error') {
  const toast = byId('toast');
  toast.textContent = message;
  toast.className = `toast visible ${tone}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 5000);
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json') ? await response.json() : { message: await response.text() };
  if (!response.ok) throw new Error(result.error || result.message || `Server returned ${response.status}`);
  return result;
}

async function runSmartTest(button, device, type, model) {
  if (type === 'long' && !window.confirm(`Start an extended SMART test on ${model}? Large disks can take many hours to finish.`)) return;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Starting…';
  try {
    const result = await postJson('/api/smart-test', { device, type });
    showToast(result.message || `${type === 'long' ? 'Extended' : 'Short'} SMART test started on ${model}.`, 'success');
    setTimeout(refresh, 800);
  } catch (error) {
    showToast(error.message || 'The SMART test could not be started.');
  } finally {
    button.removeAttribute('aria-busy');
    button.textContent = originalLabel;
    button.disabled = false;
  }
}

async function saveSmartSchedule(event) {
  event.preventDefault();
  if (!smartAvailable || scheduleSaving) return;
  const shortTime = readScheduleTime('shortScheduleTime');
  const longTime = readScheduleTime('longScheduleTime');
  const frequency = byId('shortScheduleFrequency').value === 'weekly' ? 'weekly' : 'daily';
  const payload = {
    short: {
      enabled: byId('shortScheduleEnabled').checked,
      frequency,
      ...(frequency === 'weekly' ? { dayOfWeek: clamp(Number(byId('shortScheduleDay').value), 0, 6) } : {}),
      ...shortTime,
    },
    long: {
      enabled: byId('longScheduleEnabled').checked,
      frequency: 'monthly',
      dayOfMonth: clamp(Number(byId('longScheduleDay').value), 1, 28),
      ...longTime,
    },
  };

  scheduleSaving = true;
  syncScheduleControls();
  setText('scheduleMessage', 'Saving SMART test schedule…');
  try {
    const result = await postJson('/api/smart-schedule', payload);
    populateSchedule(result.smartSchedule || result.schedule || payload);
    showToast('SMART test schedule saved.', 'success');
    setText('scheduleMessage', 'Schedule saved. Tests will use server local time.');
  } catch (error) {
    scheduleDirty = true;
    setText('scheduleMessage', error.message || 'The schedule could not be saved.');
    showToast(error.message || 'The SMART schedule could not be saved.');
  } finally {
    scheduleSaving = false;
    syncScheduleControls();
  }
}

function showError(message) {
  showToast(message);
  byId('heroStatusDot').parentElement.classList.add('offline');
  setText('healthState', 'Connection lost');
  byId('healthState').className = 'health-state critical';
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
byId('smartScheduleForm').addEventListener('submit', saveSmartSchedule);
byId('smartScheduleForm').addEventListener('input', () => {
  scheduleDirty = true;
  syncScheduleControls();
  setText('scheduleMessage', 'You have unsaved schedule changes.');
});
document.querySelectorAll('[data-history-range]').forEach((button) => {
  button.addEventListener('click', () => selectHistoryRange(button.dataset.historyRange));
});
window.addEventListener('resize', () => {
  drawChart();
  updateHistoricalCharts();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isPaused) refresh();
});

syncScheduleControls();
refresh();
pollTimer = setInterval(refresh, POLL_MS);
