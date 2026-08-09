'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { cpuUsage, parseCpuTimes, parseMemInfo, parseNetwork } = require('../server');

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
