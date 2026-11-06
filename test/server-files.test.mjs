import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverPath = fileURLToPath(new URL('../server.mjs', import.meta.url));

test('download files stay inside the download directory', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'douyin-server-test-'));
  const downloads = path.join(dir, 'downloads');
  await mkdir(path.join(downloads, 'album'), { recursive: true });
  await mkdir(path.join(dir, '.chrome-accounts', '12345678-1234-1234-1234-123456789abc'), { recursive: true });
  await writeFile(path.join(downloads, 'album', 'test.txt'), 'content');
  await writeFile(path.join(downloads, 'partial.part'), 'unfinished');
  await writeFile(path.join(dir, 'outside.txt'), 'secret');
  let symlinkAvailable = true;
  try { await symlink(path.join(dir, 'outside.txt'), path.join(downloads, 'link.txt')); } catch { symlinkAvailable = false; }
  const fakeChrome = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1/devtools/browser/test' }));
  });
  await new Promise(resolve => fakeChrome.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => fakeChrome.close(resolve)));
  const fakePort = fakeChrome.address().port;
  const profile = path.join(dir, '.chrome-accounts', '12345678-1234-1234-1234-123456789abc');
  await writeFile(path.join(profile, 'DevToolsActivePort'), `${fakePort}\n/devtools/browser/test\n`);
  await writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ activeAccountId: '12345678-1234-1234-1234-123456789abc', accounts: [{ id: '12345678-1234-1234-1234-123456789abc' }] }));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ password: 'test-password' }));
  await writeFile(path.join(dir, 'download-state.json'), JSON.stringify({ jobs: [{ id: 'busy', status: 'pending', items: [{ id: '1', status: 'pending' }] }] }));
  const portServer = http.createServer();
  await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const child = spawn(process.execPath, [serverPath], { cwd: dir, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) }, stdio: 'ignore' });
  t.after(async () => { if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; } await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/access`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'server starts using the stored browser endpoint');
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).status, 303);
  assert.equal((await fetch(`${base}/api/download/files`)).status, 401);
  const wrong = await fetch(`${base}/access/login`, { method: 'POST', body: new URLSearchParams({ password: 'wrong' }), redirect: 'manual' });
  assert.equal(wrong.headers.get('location'), '/access?error=1');
  const login = await fetch(`${base}/access/login`, { method: 'POST', body: new URLSearchParams({ password: 'test-password' }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  const auth = { headers: { cookie } };
  const library = await (await fetch(`${base}/api/library?source=like&page=1`, auth)).json();
  assert.deepEqual(library.items, []);
  assert.equal(library.total, 0);
  assert.equal(library.checkpoint.complete, false);
  assert.equal((await fetch(`${base}/api/library?source=invalid`, auth)).status, 400);
  const listing = await (await fetch(`${base}/api/download/files`, auth)).json();
  assert.deepEqual(listing.files.map(file => file.path), ['album/test.txt']);
  const file = await fetch(`${base}/api/download/file?path=${encodeURIComponent('album/test.txt')}`, auth);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'content');
  assert.equal((await fetch(`${base}/api/download/file?path=${encodeURIComponent('../outside.txt')}`, auth)).status, 400);
  assert.equal((await fetch(`${base}/api/download/file?path=${encodeURIComponent('partial.part')}`, auth)).status, 400);
  if (symlinkAvailable) assert.equal((await fetch(`${base}/api/download/file?path=link.txt`, auth)).status, 403);

  const removeFile = body => fetch(`${base}/api/download/files`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${base}/api/download/files`, { method: 'DELETE', body: '{}' })).status, 401);
  assert.equal((await removeFile({ all: true })).status, 409);
  assert.equal((await fetch(`${base}/api/download/jobs/busy/cancel`, { method: 'POST', headers: { cookie } })).status, 200);
  assert.equal((await removeFile({ path: '../outside.txt' })).status, 400);
  assert.equal((await removeFile({ path: 'partial.part' })).status, 400);
  if (symlinkAvailable) assert.equal((await removeFile({ path: 'link.txt' })).status, 404);
  assert.equal((await removeFile({ path: 'album/test.txt' })).status, 200);
  assert.equal((await removeFile({ path: 'album/test.txt' })).status, 404);
  await writeFile(path.join(downloads, 'album', 'one.jpg'), 'image');
  await writeFile(path.join(downloads, 'video.mp4'), 'video');
  await writeFile(path.join(downloads, 'album', 'partial.tmp'), 'unfinished');
  const removed = await removeFile({ all: true });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).deleted, 2);
  assert.deepEqual((await (await fetch(`${base}/api/download/files`, auth)).json()).files, []);
  assert.equal(await readFile(path.join(downloads, 'partial.part'), 'utf8'), 'unfinished');
  assert.equal(await readFile(path.join(downloads, 'album', 'partial.tmp'), 'utf8'), 'unfinished');
  assert.equal(await readFile(path.join(dir, 'outside.txt'), 'utf8'), 'secret');
});
