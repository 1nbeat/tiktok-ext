import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('confirmation resolves for confirm and dismiss, and displays text safely', async () => {
  const elements = new Map();
  function $(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      handlers: {}, returnValue: '', open: false,
      addEventListener(event, handler) { this.handlers[event] = handler; },
      showModal() { this.open = true; },
      close(value = '') { this.returnValue = value; this.open = false; this.handlers.close(); }
    });
    return elements.get(selector);
  }
  const context = vm.createContext({ $ });
  vm.runInContext(source.slice(source.indexOf('let actionConfirmResolver'), source.indexOf('function showView(')), context);
  const confirmed = context.confirmAction('删除文件', '<test>.mp4');
  assert.equal($('#action-confirm-message').textContent, '<test>.mp4');
  assert.equal(await context.confirmAction('重复请求', ''), false);
  $('#action-confirm-accept').handlers.click();
  assert.equal(await confirmed, true);
  const dismissed = context.confirmAction('删除账号', '确认删除？');
  $('#action-confirm-modal').close();
  assert.equal(await dismissed, false);
});
