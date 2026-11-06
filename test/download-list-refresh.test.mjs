import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('file completion refreshes the visible list and coalesces updates', () => {
  const elements = new Map();
  function $(selector) {
    if (!elements.has(selector)) elements.set(selector, { hidden: false, style: {} });
    return elements.get(selector);
  }
  const timers = [];
  let refreshes = 0;
  const context = vm.createContext({
    $, state: { source: 'like', like: [] }, libraryCounts: { like: 0 }, downloadJob: null,
    downloadFilesVersion: null, downloadFilesRefreshTimer: null, deletingFiles: false,
    isDismissedDownloadJob: () => false, formatSpeed: String, formatBytes: String, escapeHtml: String,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    refreshDownloadedFiles: () => { refreshes++; }
  });
  vm.runInContext(source.slice(source.indexOf('function renderDownloadJob('), source.indexOf('async function pollDownloadJob(')), context);
  const job = { id: 'job', status: 'running', fileVersion: 0, total: 1, completed: 0, skipped: 0, failed: 0, activeItems: [], concurrency: 1 };
  context.renderDownloadJob(job);
  context.renderDownloadJob({ ...job, fileVersion: 1 });
  context.renderDownloadJob({ ...job, fileVersion: 2 });
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(refreshes, 1);
  context.renderDownloadJob({ ...job, fileVersion: 3, status: 'completed', completed: 1 });
  assert.equal(timers.length, 1);
  timers.shift()();
  assert.equal(refreshes, 2);
  $('#view-downloads').hidden = true;
  context.renderDownloadJob({ ...job, fileVersion: 4 });
  assert.equal(timers.length, 0);
});
