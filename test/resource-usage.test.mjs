import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');

function profileContext({ fail = false, existing = false } = {}) {
  const calls = [];
  const browser = { close: () => calls.push('browser-disconnect') };
  const page = { close: () => calls.push('page-disconnect') };
  const targetTab = { type: 'page', id: 'target', url: 'https://www.douyin.com/user/test', webSocketDebuggerUrl: 'page' };
  let lists = 0;
  const context = vm.createContext({
    URL, AbortSignal, activeCdp: 'http://localhost', userPageScript: '',
    fetch: async url => ({ json: async () => url.endsWith('/json/version')
      ? { webSocketDebuggerUrl: 'browser' }
      : (++lists > 1 || existing ? [targetTab] : []) }),
    connectCdp: async url => url === 'browser' ? browser : page,
    cdpCall: async (socket, method) => {
      calls.push(method);
      if (method === 'Target.createTarget') return { targetId: 'target' };
      return {};
    },
    evaluateSyncScript: async () => {
      if (fail) throw new Error('evaluation failed');
      return { result: { value: { api: true, items: [{ id: '1' }] } } };
    }
  });
  vm.runInContext(source.slice(source.indexOf('async function syncUserFromChrome('), source.indexOf('// 指定用户作品暂存在内存')), context);
  return { context, calls };
}

test('user sync closes its temporary tab on success and failure', async () => {
  for (const fail of [false, true]) {
    const { context, calls } = profileContext({ fail });
    if (fail) await assert.rejects(context.syncUserFromChrome('https://www.douyin.com/user/test'), /evaluation failed/);
    else await context.syncUserFromChrome('https://www.douyin.com/user/test');
    assert.ok(calls.includes('Target.closeTarget'));
    assert.ok(calls.includes('browser-disconnect'));
    assert.ok(calls.includes('page-disconnect'));
  }
});

test('user sync preserves a tab that was already open', async () => {
  const { context, calls } = profileContext({ existing: true });
  await context.syncUserFromChrome('https://www.douyin.com/user/test');
  assert.ok(!calls.includes('Target.closeTarget'));
  assert.ok(calls.includes('page-disconnect'));
});

test('download summaries omit the item list while retaining progress', () => {
  const context = vm.createContext({ MAX_DOWNLOAD_CONCURRENCY: 10, DOWNLOAD_CONCURRENCY: 2, downloadRoot: '/downloads' });
  vm.runInContext(source.slice(source.indexOf('function publicDownloadJob('), source.indexOf('async function loadDownloadJobs(')), context);
  const job = { id: 'job', status: 'running', items: [{ id: '1', status: 'downloading', mediaType: 'video', bytes: 10 }] };
  const summary = context.publicDownloadJob(job, { includeItems: false });
  assert.equal(summary.total, 1);
  assert.equal(summary.bytes, 10);
  assert.equal(summary.activeItems.length, 1);
  assert.equal('items' in summary, false);
  assert.equal(context.publicDownloadJob(job).items.length, 1);
});

test('download progress limits state saves without delaying status changes', () => {
  let now = 10000;
  let saves = 0;
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const context = vm.createContext({ Date: FakeDate, downloadProgressSavedAt: new WeakMap(), queueDownloadStateSave: () => { saves++; } });
  vm.runInContext(source.slice(source.indexOf('function updateDownloadJob('), source.indexOf('function safeDownloadTitle(')), context);
  const job = {};
  context.updateDownloadJob(job, { progress: true });
  context.updateDownloadJob(job, { progress: true });
  assert.equal(saves, 1);
  context.updateDownloadJob(job);
  assert.equal(saves, 2);
  now += 2000;
  context.updateDownloadJob(job, { progress: true });
  assert.equal(saves, 3);
});
