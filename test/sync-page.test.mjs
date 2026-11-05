import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('sync streams deduplicated pages without loading page tabs when APIs succeed', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const template = source.match(/const pageScript = checkpoints => (`[\s\S]*?\}\)\(\)`);/);
  assert.ok(template, 'sync script exists');
  const expression = vm.runInNewContext(template[1], {
    checkpoints: {}, imageMediaFromAweme: () => [],
    isDouyinMediaUrl: () => true
  });
  const logs = [];
  const requests = [];
  const mockItem = id => ({ aweme_id: id, desc: `item ${id}`, author: { nickname: 'author' }, video: { duration: 1000 }, statistics: {} });
  const fetch = async (url, options) => {
    requests.push({ url, method: options.method || 'GET' });
    let data;
    if (url.includes('/favorite/')) {
      const cursor = new URL(url, 'https://www.douyin.com').searchParams.get('max_cursor');
      data = cursor === '0'
        ? { aweme_list: [mockItem('1'), mockItem('2')], has_more: 1, max_cursor: 10 }
        : { aweme_list: [mockItem('2'), mockItem('3')], has_more: 0 };
    } else data = { aweme_list: [mockItem('4')], has_more: 0 };
    return { ok: true, text: async () => JSON.stringify(data) };
  };
  const result = await vm.runInNewContext(expression, {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout, fetch,
    screen: { width: 800, height: 600 },
    navigator: { language: 'zh-CN', platform: 'Linux x86_64', userAgent: 'Chrome/130 Linux' },
    document: { querySelectorAll: () => { throw new Error('API path should not inspect page DOM'); } },
    console: { log: (...args) => logs.push(args), warn: () => {} }
  });
  assert.equal(result.api.like, true);
  assert.equal(result.api.collect, true);
  const batches = logs.filter(entry => entry[0] === '__DY_SYNC_BATCH__');
  assert.deepEqual(batches.map(entry => [entry[1], JSON.parse(entry[2]).map(item => item.id)]), [
    ['like', ['1', '2']], ['like', ['2', '3']], ['collect', ['4']]
  ]);
  assert.deepEqual(batches.map(entry => JSON.parse(entry[3])), [
    { cursor: '10', pages: 1, complete: false }, { cursor: '10', pages: 2, complete: true }, { cursor: '0', pages: 1, complete: true }
  ]);
  assert.equal(requests.length, 3);
  assert.equal(requests[2].method, 'POST');
});

test('sync retains streamed pages and falls back to page scrolling when an API fails', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const template = source.match(/const pageScript = checkpoints => (`[\s\S]*?\}\)\(\)`);/);
  assert.ok(template);
  const expression = vm.runInNewContext(template[1], { checkpoints: {}, imageMediaFromAweme: () => [], isDouyinMediaUrl: () => true });
  const logs = [];
  const clicks = [];
  const controls = ['收藏', '喜欢', '视频'].map(text => ({ children: [], textContent: text, scrollHeight: 0, clientHeight: 0, click: () => clicks.push(text) }));
  const document = { body: { scrollHeight: 0 }, querySelector: () => null, querySelectorAll: selector => selector === '*' ? controls : [] };
  const fetch = async url => {
    if (url.includes('/favorite/') && new URL(url, 'https://www.douyin.com').searchParams.get('max_cursor') === '0') {
      return { ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: '1', video: { duration: 1 } }], has_more: 1, max_cursor: 10 }) };
    }
    if (url.includes('/favorite/')) throw new Error('temporary failure');
    return { ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: '2', video: { duration: 1 } }], has_more: 0 }) };
  };
  const result = await vm.runInNewContext(expression, {
    URL, URLSearchParams, AbortController, setTimeout: callback => setTimeout(callback, 0), clearTimeout, fetch,
    screen: { width: 800, height: 600 }, navigator: { userAgent: 'Chrome/130 Linux' },
    document, window: { scrollTo: () => {} }, Event,
    console: { log: (...args) => logs.push(args), warn: () => {} }
  });
  assert.equal(result.api.like, false);
  assert.equal(result.api.collect, true);
  assert.deepEqual(clicks, ['收藏', '喜欢']);
  assert.deepEqual(logs.filter(entry => entry[0] === '__DY_SYNC_BATCH__').map(entry => entry[1]), ['like', 'collect']);
});

test('sync resumes at the saved cursor and skips a completed source', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  const template = source.match(/const pageScript = checkpoints => (`[\s\S]*?\}\)\(\)`);/);
  const checkpoints = { like: { cursor: '123', pages: 7, complete: false }, collect: { cursor: '0', pages: 3, complete: true } };
  const expression = vm.runInNewContext(template[1], { checkpoints, imageMediaFromAweme: () => [], isDouyinMediaUrl: () => true });
  const logs = [];
  const requests = [];
  const result = await vm.runInNewContext(expression, {
    URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    fetch: async url => { requests.push(url); return { ok: true, text: async () => JSON.stringify({ aweme_list: [{ aweme_id: '9', video: { duration: 1 } }], has_more: 0 }) }; },
    screen: { width: 800, height: 600 }, navigator: { userAgent: 'Chrome/130 Linux' },
    document: { querySelectorAll: () => { throw new Error('unexpected DOM access'); } },
    console: { log: (...args) => logs.push(args), warn: () => {} }
  });
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0], 'https://www.douyin.com').searchParams.get('max_cursor'), '123');
  assert.equal(result.api.like, true);
  assert.equal(result.api.collect, true);
  const batch = logs.find(entry => entry[0] === '__DY_SYNC_BATCH__');
  assert.deepEqual(JSON.parse(batch[3]), { cursor: '123', pages: 8, complete: true });
});
