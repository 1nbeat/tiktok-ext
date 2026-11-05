import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
const switchSource = source.slice(source.indexOf('async function switchAccount('), source.indexOf('// 后台启动同步'));

function setup({ failTarget = false } = {}) {
  const calls = [];
  const context = vm.createContext({
    accounts: [{ id: 'old' }, { id: 'new' }], activeAccountId: 'old', activeCdp: 'old-endpoint',
    accountSwitching: false, syncState: { running: false }, userSyncState: { running: false },
    detailRequests: new Map(), downloadJobs: new Map(), latestData: {},
    closeAccountBrowser: async (id, endpoint) => { calls.push(`close:${id}:${endpoint}`); return true; },
    accountEndpoint: async id => {
      calls.push(`start:${id}`);
      if (id === 'new' && failTarget) throw new Error('startup failed');
      return `${id}-endpoint`;
    },
    fetch: async () => ({ ok: true }), AbortSignal,
    saveAccounts: async () => { calls.push('save'); }
  });
  vm.runInContext(switchSource, context);
  return { context, calls };
}

test('switch closes the old browser before starting the next account', async () => {
  const { context, calls } = setup();
  await context.switchAccount('new');
  assert.deepEqual(calls, ['close:old:old-endpoint', 'start:new', 'save']);
  assert.equal(context.activeAccountId, 'new');
  assert.equal(context.activeCdp, 'new-endpoint');
});

test('failed switch restores the previous account browser', async () => {
  const { context, calls } = setup({ failTarget: true });
  await assert.rejects(context.switchAccount('new'), /startup failed/);
  assert.deepEqual(calls, ['close:old:old-endpoint', 'start:new', 'start:old']);
  assert.equal(context.activeAccountId, 'old');
  assert.equal(context.activeCdp, 'old-endpoint');
  assert.equal(context.accountSwitching, false);
});

const pendingSource = source.slice(source.indexOf('async function pendingAccountStatus('), source.indexOf('async function deleteAccount('));

function pendingSetup(identity) {
  const context = vm.createContext({
    pendingAccount: { id: 'new', endpoint: 'new-endpoint' },
    accounts: [{ id: 'old', name: 'old', identity: 'existing' }],
    activeAccountId: 'old', activeCdp: 'old-endpoint',
    loginPageStatus: async () => ({ status: 'logged_in', profile: { nickname: 'name', identity } }),
    saveAccounts: async () => {}, latestData: {}, syncState: {}, userSyncState: {}
  });
  vm.runInContext(pendingSource, context);
  return context;
}

test('a duplicate login keeps the current account and is not added', async () => {
  const context = pendingSetup('existing');
  const result = await context.pendingAccountStatus();
  assert.equal(result.status, 'duplicate');
  assert.equal(context.activeAccountId, 'old');
  assert.equal(context.accounts.length, 1);
});

test('a unique login becomes current only after identity is confirmed', async () => {
  const context = pendingSetup('unique');
  const result = await context.pendingAccountStatus();
  assert.equal(result.added, true);
  assert.equal(context.activeAccountId, 'new');
  assert.equal(context.accounts.length, 2);
  assert.equal(context.pendingAccount, null);
});

test('a login without an identity is not added', async () => {
  const context = pendingSetup('');
  assert.equal((await context.pendingAccountStatus()).status, 'identity_error');
  assert.equal(context.activeAccountId, 'old');
  assert.equal(context.accounts.length, 1);
});

test('cancelling a pending login closes it and restores the previous browser', async () => {
  const calls = [];
  const context = vm.createContext({
    pendingAccount: { id: 'new', endpoint: 'new-endpoint', previousId: 'old', previousClosed: true },
    activeCdp: 'old-endpoint',
    closeAccountBrowser: async id => { calls.push(`close:${id}`); },
    accountEndpoint: async id => { calls.push(`start:${id}`); return 'restored-endpoint'; },
    accountProfile: id => id,
    fs: { rm: async id => { calls.push(`remove:${id}`); } }
  });
  vm.runInContext(source.slice(source.indexOf('async function cancelPendingAccount('), source.indexOf('async function pendingAccountStatus(')), context);
  await context.cancelPendingAccount();
  assert.deepEqual(calls, ['close:new', 'start:old', 'remove:new']);
  assert.equal(context.activeCdp, 'restored-endpoint');
  assert.equal(context.pendingAccount, null);
});

test('deleting an inactive account removes its library and browser profile', async () => {
  const calls = [];
  const context = vm.createContext({
    accounts: [{ id: 'old' }, { id: 'new' }], activeAccountId: 'old', pendingAccount: null,
    accountBusy: () => false, existingAccountEndpoint: async () => null,
    saveAccounts: async () => calls.push('save'), library: { clear: id => calls.push(`clear:${id}`) },
    accountProfile: id => id, fs: { rm: async id => calls.push(`remove:${id}`) }
  });
  vm.runInContext(source.slice(source.indexOf('async function deleteAccount('), source.indexOf('// 后台启动同步')), context);
  await context.deleteAccount('new');
  assert.deepEqual(calls, ['save', 'clear:new', 'remove:new']);
  assert.equal(context.accounts.length, 1);
  assert.equal(context.activeAccountId, 'old');
});
