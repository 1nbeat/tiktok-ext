import fs from 'node:fs/promises';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const maxAge = 7 * 24 * 60 * 60;
const cookieName = 'douyin_access';

export async function createAccessControl(configPath) {
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (error) { throw new Error(`无法读取访问配置 ${configPath}：${error.message}`); }
  if (typeof config.password !== 'string' || !config.password.trim()) throw new Error('请在 config.json 中设置非空的 password');
  const passwordHash = createHash('sha256').update(config.password).digest();
  const secret = randomBytes(32);
  const failures = new Map();
  const gate = await fs.readFile(new URL('./public/access.html', import.meta.url));
  const sign = value => createHmac('sha256', secret).update(value).digest('hex');
  const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);

  function authorized(req) {
    const cookies = (req.headers.cookie || '').split(';');
    const token = cookies.map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
    const match = /^(\d{10})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
    if (!match) return false;
    const expiry = Number(match[1]);
    return expiry > Math.floor(Date.now() / 1000) && expiry <= Math.floor(Date.now() / 1000) + maxAge && equal(Buffer.from(match[3], 'hex'), Buffer.from(sign(`${match[1]}.${match[2]}`), 'hex'));
  }

  return async function access(req, res, url) {
    if (url.pathname === '/access/login' && req.method === 'POST') {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      for (const [key, item] of failures) if (item.until <= now) failures.delete(key);
      const failure = failures.get(ip);
      if (failure && failure.count >= 10) { res.writeHead(429, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(Math.ceil((failure.until - now) / 1000)) }); res.end('尝试次数过多，请稍后重试'); return true; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return true; } }
      const password = new URLSearchParams(body).get('password') || '';
      if (!equal(createHash('sha256').update(password).digest(), passwordHash)) {
        failures.set(ip, { count: (failure?.count || 0) + 1, until: failure?.until || now + 15 * 60 * 1000 });
        res.writeHead(303, { location: '/access?error=1', 'cache-control': 'no-store' }); res.end(); return true;
      }
      failures.delete(ip);
      const value = `${Math.floor(now / 1000) + maxAge}.${randomBytes(16).toString('hex')}`;
      const secure = req.socket.encrypted || String(req.headers['x-forwarded-proto'] || req.headers['x-scheme'] || '').split(',')[0].trim() === 'https';
      res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'set-cookie': `${cookieName}=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}` });
      res.end(); return true;
    }
    if (url.pathname === '/access' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(gate); return true;
    }
    if (authorized(req)) return false;
    if (url.pathname.startsWith('/api/')) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: '请先输入访问密码' }));
    } else { res.writeHead(303, { location: '/access', 'cache-control': 'no-store' }); res.end(); }
    return true;
  };
}
