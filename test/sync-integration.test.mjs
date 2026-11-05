import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('sync exposes saved pages during a run and resumes after restart', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-sync-test-'));
  const id = '12345678-1234-1234-1234-123456789abc';
  const profile = path.join(dir, '.chrome-accounts', id);
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ password: 'test-password' }));
  await writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ activeAccountId: id, accounts: [{ id }] }));
  let runs = 0;
  let resumeExpression = '';
  let firstSocket;
  const browser = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    const port = browser.address().port;
    res.end(JSON.stringify(req.url === '/json/list' ? [{ type: 'page', url: 'https://www.douyin.com/user/self', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/test` }] : { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test` }));
  });
  browser.on('upgrade', (req, socket) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = message => {
      const body = Buffer.from(JSON.stringify(message));
      const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    const batch = (phase, items, checkpoint) => send({ method: 'Runtime.consoleAPICalled', params: { args: ['__DY_SYNC_BATCH__', phase, JSON.stringify(items), JSON.stringify(checkpoint)].map(value => ({ value })) } });
    let buffer = Buffer.alloc(0);
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15;
        let length = buffer[1] & 127, offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const masked = Boolean(buffer[1] & 128);
        const maskSize = masked ? 4 : 0;
        if (buffer.length < offset + maskSize + length) return;
        const mask = buffer.subarray(offset, offset + maskSize);
        const body = Buffer.from(buffer.subarray(offset + maskSize, offset + maskSize + length));
        buffer = buffer.subarray(offset + maskSize + length);
        if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const message = JSON.parse(body.toString());
        if (message.method !== 'Runtime.evaluate') { send({ id: message.id, result: {} }); continue; }
        runs++;
        if (runs === 1) {
          firstSocket = socket;
          batch('like', [{ id: '1', title: 'first', author: 'A', mediaType: 'video' }], { cursor: '55', pages: 1, complete: false });
        } else {
          resumeExpression = message.params.expression;
          batch('like', [{ id: '2', title: 'second', author: 'B', mediaType: 'image' }], { cursor: '55', pages: 2, complete: true });
          batch('collect', [{ id: '3', title: 'third', author: 'C', mediaType: 'video' }], { cursor: '0', pages: 1, complete: true });
          send({ id: message.id, result: { result: { value: { api: { like: true, collect: true } } } } });
        }
      }
    });
  });
  await new Promise(resolve => browser.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(profile, 'DevToolsActivePort'), `${browser.address().port}\n/devtools/browser/test\n`);
  const portServer = http.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function stop() {
    if (child && child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
  }
  t.after(async () => { firstSocket?.destroy(); await stop(); await new Promise(resolve => browser.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, [serverPath], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/access`)).ok) break; } catch {} await sleep(50); }
    const login = await fetch(`${base}/access/login`, { method: 'POST', body: new URLSearchParams({ password: 'test-password' }), redirect: 'manual' });
    return { cookie: login.headers.get('set-cookie').split(';')[0] };
  }
  async function waitFor(check) {
    for (let i = 0; i < 100; i++) { const result = await check(); if (result) return result; await sleep(50); }
    throw new Error('timed out waiting for sync');
  }
  let headers = await start();
  await fetch(`${base}/api/sync/start`, { method: 'POST', headers });
  const partial = await waitFor(async () => { const result = await (await fetch(`${base}/api/library?source=like`, { headers })).json(); return result.totalItems === 1 && result; });
  assert.equal(partial.items[0].id, '1');
  assert.equal(partial.checkpoint.cursor, '55');
  assert.equal((await (await fetch(`${base}/api/sync/status`, { headers })).json()).running, true);
  firstSocket.destroy();
  await waitFor(async () => !(await (await fetch(`${base}/api/sync/status`, { headers })).json()).running);
  await stop();
  headers = await start();
  const restored = await (await fetch(`${base}/api/library?source=like`, { headers })).json();
  assert.equal(restored.totalItems, 1);
  await fetch(`${base}/api/sync/start`, { method: 'POST', headers });
  const done = await waitFor(async () => { const status = await (await fetch(`${base}/api/sync/status`, { headers })).json(); return !status.running && status; });
  assert.equal(done.phase, 'done');
  assert.match(resumeExpression, /"cursor":"55","pages":1/);
  const page = await (await fetch(`${base}/api/library?source=like&page=1`, { headers })).json();
  assert.deepEqual(page.items.map(item => item.id), ['1', '2']);
  assert.equal(page.counts.collect, 1);
});
