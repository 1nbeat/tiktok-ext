import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export function createLibrary(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS works (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT NOT NULL, source TEXT NOT NULL, id TEXT NOT NULL,
      title TEXT NOT NULL, author TEXT NOT NULL, created TEXT NOT NULL,
      likes INTEGER NOT NULL, duration INTEGER NOT NULL, media_type TEXT NOT NULL,
      data TEXT NOT NULL, generation TEXT NOT NULL DEFAULT '', UNIQUE(account, source, id)
    );
    CREATE INDEX IF NOT EXISTS works_account_source ON works(account, source, seq);
    CREATE TABLE IF NOT EXISTS checkpoints (
      account TEXT NOT NULL, source TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '0',
      pages INTEGER NOT NULL DEFAULT 0, complete INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(account, source)
    );
    CREATE TABLE IF NOT EXISTS sync_runs (account TEXT PRIMARY KEY, generation TEXT NOT NULL);
  `);
  const insert = db.prepare(`INSERT INTO works (account,source,id,title,author,created,likes,duration,media_type,data,generation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account,source,id) DO UPDATE SET
    seq=CASE WHEN works.generation=excluded.generation THEN works.seq ELSE excluded.seq END,
    title=excluded.title, author=excluded.author, created=excluded.created,
    likes=excluded.likes, duration=excluded.duration, media_type=excluded.media_type, data=excluded.data, generation=excluded.generation`);
  const checkpoint = db.prepare(`INSERT INTO checkpoints (account,source,cursor,pages,complete) VALUES (?,?,?,?,?)
    ON CONFLICT(account,source) DO UPDATE SET cursor=excluded.cursor,pages=excluded.pages,complete=excluded.complete`);

  function checkpoints(account) {
    const result = { like: { cursor: '0', pages: 0, complete: false }, collect: { cursor: '0', pages: 0, complete: false } };
    for (const row of db.prepare('SELECT source,cursor,pages,complete FROM checkpoints WHERE account=?').all(account)) {
      if (result[row.source]) result[row.source] = { cursor: row.cursor, pages: row.pages, complete: Boolean(row.complete) };
    }
    return result;
  }

  function savePage(account, source, items, state) {
    if (!['like', 'collect'].includes(source) || !Array.isArray(items)) throw new Error('无效的同步数据');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO sync_runs (account,generation) VALUES (?,?) ON CONFLICT(account) DO NOTHING').run(account, randomUUID());
      const generation = db.prepare('SELECT generation FROM sync_runs WHERE account=?').get(account).generation;
      for (const item of items) {
        if (!item?.id) continue;
        insert.run(account, source, String(item.id), String(item.title || ''), String(item.author || ''), String(item.createdAt || ''), Number(item.likes) || 0, Number(item.duration) || 0, item.mediaType === 'image' ? 'image' : 'video', JSON.stringify({ ...item, source }), generation);
      }
      if (state) {
        checkpoint.run(account, source, String(state.cursor), Number(state.pages) || 0, state.complete ? 1 : 0);
        if (state.complete) db.prepare('DELETE FROM works WHERE account=? AND source=? AND generation<>?').run(account, source, generation);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function begin(account) {
    const state = checkpoints(account);
    if (state.like.complete && state.collect.complete) {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM checkpoints WHERE account=?').run(account);
        db.prepare('INSERT INTO sync_runs (account,generation) VALUES (?,?) ON CONFLICT(account) DO UPDATE SET generation=excluded.generation').run(account, randomUUID());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return checkpoints(account);
    }
    return state;
  }

  function list(account, source, { page = 1, pageSize = 24, query = '', sort = 'saved' } = {}) {
    const orders = { saved: 'seq ASC', newest: 'created DESC, seq ASC', oldest: 'created ASC, seq ASC', likes: 'likes DESC, seq ASC', duration: 'duration DESC, seq ASC' };
    const order = Object.hasOwn(orders, sort) ? orders[sort] : orders.saved;
    const search = `%${String(query).replace(/[\\%_]/g, '\\$&')}%`;
    const where = "account=? AND source=? AND (LOWER(title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(author) LIKE LOWER(?) ESCAPE '\\')";
    const params = [account, source, search, search];
    const total = db.prepare(`SELECT count(*) AS n FROM works WHERE ${where}`).get(...params).n;
    const stats = db.prepare('SELECT count(*) AS total, coalesce(sum(media_type=\'image\'),0) AS images FROM works WHERE account=? AND source=?').get(account, source);
    const safeSize = Math.min(100, Math.max(1, Math.trunc(Number(pageSize)) || 24));
    const requested = Number(page);
    const current = Math.min(Math.max(1, Number.isFinite(requested) ? Math.trunc(requested) : 1), Math.max(1, Math.ceil(total / safeSize)));
    const items = db.prepare(`SELECT data FROM works WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params, safeSize, (current - 1) * safeSize).map(row => JSON.parse(row.data));
    return { items, total, page: current, totalItems: stats.total, imageCount: stats.images, videoCount: stats.total - stats.images };
  }

  return {
    begin, checkpoints, savePage, list,
    all: (account, source) => db.prepare('SELECT data FROM works WHERE account=? AND source=? ORDER BY seq').all(account, source).map(row => JSON.parse(row.data)),
    find: (account, id) => { const row = db.prepare('SELECT data FROM works WHERE account=? AND id=? ORDER BY seq LIMIT 1').get(account, id); return row ? JSON.parse(row.data) : null; },
    clear: account => {
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM works WHERE account=?').run(account);
        db.prepare('DELETE FROM checkpoints WHERE account=?').run(account);
        db.prepare('DELETE FROM sync_runs WHERE account=?').run(account);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close()
  };
}
