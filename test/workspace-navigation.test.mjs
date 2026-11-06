import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('work views keep their own source and filters across navigation', () => {
  const elements = Object.fromEntries(['work-content', 'work-title', 'search', 'sort'].map(id => [`#${id}`, {}]));
  elements['.tabs'] = {};
  const sections = ['library', 'user', 'downloads', 'account'].map(view => ({ id: `view-${view}` }));
  const buttons = ['library', 'user', 'downloads', 'account'].map(view => ({
    dataset: { view }, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {}
  }));
  let libraryLoads = 0;
  const context = vm.createContext({
    $: selector => elements[selector],
    document: { querySelectorAll: selector => selector === '.workspace-view' ? sections : buttons },
    state: { source: 'collect', query: 'saved query', sort: 'likes', page: 3 },
    lastLibrarySource: 'collect',
    workFilters: { library: {}, user: { query: '', sort: 'saved', page: 1 } },
    render() {}, loadLibrary() { libraryLoads++; }, refreshDownloadedFiles() {}
  });
  vm.runInContext(source.slice(source.indexOf('function showView('), source.indexOf("$('.main-nav')")), context);
  context.showView('user');
  assert.equal(context.state.source, 'user');
  assert.equal(context.state.query, '');
  assert.equal(elements['.tabs'].hidden, true);
  assert.equal(sections.find(section => section.id === 'view-user').hidden, false);
  context.state.query = 'user query';
  context.showView('downloads');
  assert.equal(elements['#work-content'].hidden, true);
  context.showView('library');
  assert.equal(context.state.source, 'collect');
  assert.equal(context.state.query, 'saved query');
  assert.equal(context.state.page, 3);
  assert.equal(elements['.tabs'].hidden, false);
  assert.equal(libraryLoads, 1);
  context.showView('user');
  assert.equal(context.state.query, 'user query');
});

test('completed user loading does not switch away from the current work view', async () => {
  const elements = new Map();
  const $ = selector => {
    if (!elements.has(selector)) elements.set(selector, { style: {}, classList: { add() {} } });
    return elements.get(selector);
  };
  let renders = 0;
  const context = vm.createContext({
    $, state: { source: 'like', user: [] },
    fetch: async () => ({ ok: true, json: async () => ({ running: false, data: [{ id: '1' }] }) }),
    resetPageAndRender: () => { renders++; }
  });
  vm.runInContext(source.slice(source.indexOf('async function pollUserSync('), source.indexOf('// 卡片点击和键盘确认')), context);
  await context.pollUserSync();
  assert.equal(context.state.source, 'like');
  assert.equal(context.state.user.length, 1);
  assert.equal(renders, 0);
});
