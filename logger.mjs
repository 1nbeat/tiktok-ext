import fs from 'node:fs/promises';
import path from 'node:path';

export function createLogger(directory, { maxBytes = 2 * 1024 * 1024 } = {}) {
  const current = path.join(directory, 'system.log');
  const previous = path.join(directory, 'system.log.1');
  let pending = Promise.resolve();
  const clean = value => String(value ?? '')
    .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[URL]')
    .replace(/\b(cookie|authorization|password|token|sessionid|session_id)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ').slice(0, 800);
  function log(level, event, fields = {}) {
    const details = Object.entries(fields).map(([key, value]) => `${clean(key)}=${clean(value)}`).join(' ');
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${clean(event)}${details ? ` ${details}` : ''}\n`;
    pending = pending.then(async () => {
      await fs.mkdir(directory, { recursive: true });
      const size = await fs.stat(current).then(stat => stat.size, error => { if (error.code === 'ENOENT') return 0; throw error; });
      if (size && size + Buffer.byteLength(line) > maxBytes) {
        await fs.rm(previous, { force: true });
        await fs.rename(current, previous);
      }
      await fs.appendFile(current, line, 'utf8');
    }).catch(error => { console.error(`System log write failed: ${error.code || 'unknown'}`); });
  }
  async function read() {
    await pending;
    const readPart = filename => fs.readFile(filename, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    return (await readPart(previous)) + (await readPart(current));
  }
  return { log, read };
}
