import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createAccessControl } from './access.mjs';
import { createLibrary } from './library.mjs';

// 静态页面目录和本地服务端口；服务只在本机提供访问。
const root = path.resolve('public');
const port = Number(process.env.PORT || 9001);
const host = process.env.HOST || '127.0.0.1';
const access = await createAccessControl(path.resolve(process.env.ACCESS_CONFIG || 'config.json'));
const library = createLibrary(path.resolve('library.sqlite'));
const downloadRoot = path.resolve('downloads');
const downloadStatePath = path.resolve('download-state.json');
const DOWNLOAD_CONCURRENCY = 2;
const MAX_DOWNLOAD_CONCURRENCY = 10;
const DOWNLOAD_RETRIES = 3;
const accountsPath = path.resolve('accounts.json');
const profilesRoot = path.resolve('.chrome-accounts');
let accounts = [{ id: 'default', name: '默认账号', avatar: '' }];
let activeAccountId = 'default';
let activeCdp = 'http://127.0.0.1:9222';
let accountSwitching = false;
let pendingAccount = null;
let accountSave = Promise.resolve();

function saveAccounts() {
  const payload = JSON.stringify({ activeAccountId, accounts }, null, 2);
  accountSave = accountSave.catch(() => {}).then(async () => {
    await fs.writeFile(`${accountsPath}.tmp`, payload, 'utf8');
    await fs.rename(`${accountsPath}.tmp`, accountsPath);
  });
  return accountSave;
}

async function loadAccounts() {
  try {
    const data = JSON.parse(await fs.readFile(accountsPath, 'utf8'));
    const stored = Array.isArray(data.accounts) ? data.accounts.filter(a => a && (a.id === 'default' || /^[a-f0-9-]{36}$/.test(a.id))) : [];
    accounts = stored.length ? stored : [{ id: 'default', name: '默认账号', avatar: '' }];
    if (accounts.some(a => a.id === data.activeAccountId)) activeAccountId = data.activeAccountId;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function accountProfile(id) {
  return id === 'default' ? path.resolve('.chrome-debug-profile') : path.join(profilesRoot, id);
}

async function existingAccountEndpoint(id) {
  try {
    const [portText, browserPath] = (await fs.readFile(path.join(accountProfile(id), 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
    if (!/^\d+$/.test(portText) || !/^\/devtools\/browser\//.test(browserPath)) return null;
    const endpoint = `http://127.0.0.1:${Number(portText)}`;
    const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) })).json();
    return new URL(version.webSocketDebuggerUrl).pathname === browserPath ? endpoint : null;
  } catch { return null; }
}

async function closeAccountBrowser(id, endpoint) {
  // 9222 may be a browser supplied by the user; only close verified dedicated profiles.
  if (!endpoint || endpoint === 'http://127.0.0.1:9222' || await existingAccountEndpoint(id) !== endpoint) return false;
  const version = await (await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  const ws = await connectCdp(version.webSocketDebuggerUrl);
  try { await cdpCall(ws, 'Browser.close', {}, 3000); } catch { /* Chrome may close the socket before replying. */ }
  finally { ws.close(); }
  for (let i = 0; i < 40; i++) {
    if (!await existingAccountEndpoint(id)) return true;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('旧账号浏览器未能关闭，请检查 Chrome 进程后重试');
}

async function accountEndpoint(id) {
  const profile = accountProfile(id);
  if (id === 'default') {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(1000) })).json();
      if (tabs.some(tab => tab.type === 'page' && /^https:\/\/www\.douyin\.com\/user\/self(?:[/?#]|$)/.test(tab.url))) return 'http://127.0.0.1:9222';
    } catch { /* 没有现成的默认浏览器时启动专用会话。 */ }
  }
  const existing = await existingAccountEndpoint(id);
  if (existing) return existing;
  const platformCandidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'), process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe')]
    : ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  const chromeCandidates = [process.env.CHROME_PATH, process.env.CHROME, ...platformCandidates].filter(Boolean);
  let chrome;
  for (const candidate of chromeCandidates) { try { await fs.access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK); chrome = candidate; break; } catch {} }
  if (!chrome) throw new Error('未找到 Chrome，请设置 CHROME_PATH');
  await fs.mkdir(profile, { recursive: true });
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'https://www.douyin.com/user/self'], { detached: true, stdio: 'ignore', windowsHide: true });
  let spawnError;
  let exitCode;
  child.on('error', error => { spawnError = error; });
  child.on('exit', code => { exitCode = code; });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (spawnError) throw spawnError;
    const endpoint = await existingAccountEndpoint(id);
    if (endpoint) return endpoint;
    if (exitCode != null && exitCode !== 0) throw new Error(`Chrome 启动失败（退出代码 ${exitCode}），请检查浏览器依赖和运行用户`);
  }
  if (exitCode == null) child.kill();
  throw new Error('账号浏览器启动失败，请检查 Chrome 和账号目录');
}

// 统一返回 JSON 或静态资源，并禁止浏览器使用过期的同步结果。
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

async function readJsonBody(req) {
  // 读取并解析 JSON 请求体，同时限制单次请求大小。
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8 * 1024 * 1024) throw new Error('请求内容过大');
  }
  return body ? JSON.parse(body) : {};
}

async function listDownloadedFiles() {
  const files = [];
  let truncated = false;
  async function visit(directory, relative = '') {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' && !relative) return; throw error; }
    for (const entry of entries) {
      if (files.length >= 2000) { truncated = true; return; }
      const name = path.join(relative, entry.name);
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath, name);
      else if (entry.isFile() && !/\.(part|tmp)$/i.test(entry.name)) {
        const stat = await fs.stat(fullPath);
        files.push({ path: name.split(path.sep).join('/'), size: stat.size, modifiedAt: stat.mtime.toISOString() });
      }
    }
  }
  await visit(downloadRoot);
  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return { files, truncated };
}

async function sendDownloadedFile(res, name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || /\.(part|tmp)$/i.test(name)) {
    return send(res, 400, JSON.stringify({ error: '无效的文件路径' }));
  }
  let rootPath, filePath, stat;
  try {
    rootPath = await fs.realpath(downloadRoot);
    filePath = await fs.realpath(path.resolve(downloadRoot, ...name.split('/')));
    if (!filePath.startsWith(rootPath + path.sep)) return send(res, 403, JSON.stringify({ error: '无效的文件路径' }));
    stat = await fs.stat(filePath);
    if (!stat.isFile()) return send(res, 404, JSON.stringify({ error: '文件不存在' }));
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return send(res, 404, JSON.stringify({ error: '文件不存在' }));
    throw error;
  }
  const filename = encodeURIComponent(path.basename(filePath)).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': stat.size, 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${filename}`, 'cache-control': 'no-store' });
  try { await pipeline(createReadStream(filePath), res); } catch { res.destroy(); }
}

let deletingDownloadedFiles = false;

async function deleteDownloadedFile(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') || /\.(part|tmp)$/i.test(name)) {
    const error = new Error('无效的文件路径'); error.status = 400; throw error;
  }
  const rootPath = await fs.realpath(downloadRoot);
  const requested = path.resolve(downloadRoot, ...name.split('/'));
  const entry = await fs.lstat(requested);
  if (!entry.isFile()) { const error = new Error('文件不存在'); error.status = 404; throw error; }
  const filePath = await fs.realpath(requested);
  if (!filePath.startsWith(rootPath + path.sep)) { const error = new Error('无效的文件路径'); error.status = 403; throw error; }
  await fs.unlink(filePath);
}

async function deleteAllDownloadedFiles() {
  let deleted = 0;
  async function visit(directory) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filePath);
      else if (entry.isFile() && !/\.(part|tmp)$/i.test(entry.name)) {
        await fs.unlink(filePath);
        deleted++;
      }
    }
  }
  await visit(downloadRoot);
  return deleted;
}

async function cdpCall(ws, method, params = {}, timeoutMs = 20000) {
  // 通过 WebSocket 向 Chrome 发送 CDP 命令，并等待对应响应。
  const id = ++ws.nextId;
  return new Promise((resolve, reject) => {
    const timer = timeoutMs ? setTimeout(() => { ws.pending.delete(id); reject(new Error(`浏览器请求超时：${method}`)); }, timeoutMs) : null;
    const finish = callback => value => { if (timer) clearTimeout(timer); callback(value); };
    ws.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
    try { ws.send(JSON.stringify({ id, method, params })); }
    catch (error) { ws.pending.delete(id); if (timer) clearTimeout(timer); reject(error); }
  });
}

async function evaluateSyncScript(ws, expression) {
  let timer;
  let rejectIdle;
  const idle = new Promise((_, reject) => { rejectIdle = reject; });
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { ws.send(JSON.stringify({ id: ++ws.nextId, method: 'Runtime.terminateExecution' })); } catch {}
      rejectIdle(new Error('浏览器同步超过 60 秒没有进展，请重试；如果持续出现，请检查服务器负载和浏览器状态'));
    }, 60000);
  };
  ws.syncActivity = reset;
  reset();
  try {
    return await Promise.race([cdpCall(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, 0), idle]);
  } finally { clearTimeout(timer); ws.syncActivity = null; }
}

// 建立 Chrome DevTools Protocol 连接，同时保存响应事件和待处理请求。
async function connectCdp(url) {
  const ws = new WebSocket(url);
  ws.nextId = 0;
  ws.pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && ws.pending.has(message.id)) {
      const pending = ws.pending.get(message.id);
      ws.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    } else if (message.method) {
      ws.onEvent?.(message);
    }
  });
  ws.addEventListener('close', () => {
    for (const pending of ws.pending.values()) pending.reject(new Error('浏览器连接已关闭'));
    ws.pending.clear();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('连接浏览器超时')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('无法连接浏览器')); }, { once: true });
  });
  return ws;
}

// 列表脚本和详情解析共用图片提取逻辑，保留实况图 images[n].video 的动态资源。
function imageMediaFromAweme(item, isMediaUrl) {
  const sources = [item?.images, item?.image_list, item?.image_infos];
  const entries = sources.find(images => Array.isArray(images) && images.length) || [];
  const media = [];
  const keys = new Set();
  for (const image of entries) {
    const imageUrl = typeof image === 'string' ? image : image?.url_list?.[0] || image?.download_url_list?.[0] || image?.url || '';
    const key = String(image?.uri || imageUrl);
    if (!imageUrl || keys.has(key)) continue;
    keys.add(key);
    const video = image?.video || {};
    const rates = [...(video.bit_rate || [])].sort((a, b) => Number(b?.bit_rate || 0) - Number(a?.bit_rate || 0));
    // 优先 H.264，保证浏览器和常用播放器能播放实况片段。
    const videoUrls = [...new Set([
      ...(video.play_addr_h264?.url_list || []),
      ...rates.flatMap(rate => rate?.play_addr?.url_list || []),
      ...(video.play_addr?.url_list || []),
      ...(video.download_addr?.url_list || [])
    ].filter(isMediaUrl))];
    media.push({ imageUrl, videoUrl: videoUrls[0] || '', videoUrls,
      isLivePhoto: Number(image?.live_photo_type) > 0 || videoUrls.length > 0 });
  }
  return media;
}

const pageScript = checkpoints => `(async () => {
  const checkpoints = ${JSON.stringify(checkpoints)};
  const imageMediaFromAweme = ${imageMediaFromAweme.toString()};
  const isDouyinMediaUrl = ${isDouyinMediaUrl.toString()};
  // 这段脚本在抖音页面内执行：优先调用列表接口分页，失败时再使用页面滚动兜底。
  const result = { api: { like: false, collect: false }, order: { like: [], collect: [] } };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = text => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === text);
    if (el) { el.click(); return true; }
    return false;
  };
  const compactItem = (item, source) => {
    // 只把展示需要的字段带回服务端，避免几百个完整 aweme JSON 挤满 Chrome 响应缓存。
    const video = item?.video || {};
    const imageMedia = imageMediaFromAweme(item, isDouyinMediaUrl);
    const images = imageMedia.map(image => image.imageUrl);
    const durationMs = Number(video.duration ?? item?.duration ?? 0);
    const isImage = Number(item?.aweme_type) === 68 || (images.length > 0 && durationMs <= 0);
    const author = item?.author || item?.author_info || {};
    const stats = item?.statistics || {};
    const id = String(item?.aweme_id || item?.group_id || '');
    return {
      id,
      source,
      mediaType: isImage ? 'image' : 'video',
      imageCount: isImage ? images.length : 0,
      title: item?.desc || (isImage ? '未命名图集' : '未命名视频'),
      author: author.nickname || author.unique_id || '未知作者',
      authorId: String(author.uid || author.sec_uid || ''),
      authorAvatar: author?.avatar_thumb?.url_list?.[0] || author?.avatar_larger?.url_list?.[0] || '',
      authorUniqueId: author.unique_id || '',
      authorShortId: author.short_id || '',
      authorSignature: author.signature || '',
      authorFollowers: Number(author.follower_count || 0),
      authorFollowing: Number(author.following_count || 0),
      authorTotalFavorited: Number(author.total_favorited || 0),
      authorAwemeCount: Number(author.aweme_count || 0),
      authorProfile: {
        uid: String(author.uid || ''),
        secUid: String(author.sec_uid || ''),
        uniqueId: author.unique_id || '',
        shortId: author.short_id || '',
        nickname: author.nickname || '',
        signature: author.signature || '',
        gender: typeof author.gender === 'number' ? author.gender : (/^(男|male|m|1)$/i.test(String(author.gender || '')) ? 1 : /^(女|female|f|2)$/i.test(String(author.gender || '')) ? 2 : 0),
        genderText: author.gender_name || author.gender_text || (typeof author.gender === 'string' ? author.gender : ''),
        age: Number(author.age || author.user_age || item?.author_age || item?.user_age || item?.age || 0),
        birthday: author.birthday || '',
        country: author.country || '',
        province: author.province || '',
        city: author.city || '',
        district: author.district || author.county || author.district_name || '',
        location: author.location || author.region || author.region_name || '',
        ipLocation: author.ip_location || author.ip_location_text || author.ip_location_name || author.ip_label || item?.ip_label || item?.ip_location || item?.ip_location_text || '',
        school: author.school_name || author.school_poi_name || '',
        verification: author.custom_verify || author.enterprise_verify_reason || '',
        verificationType: Number(author.verification_type || 0),
        verified: Boolean(author.is_verified),
        displayId: author.display_id || '',
        followerCount: Number(author.follower_count || 0),
        followingCount: Number(author.following_count || 0),
        favoritingCount: Number(author.favoriting_count || 0),
        totalFavorited: Number(author.total_favorited || 0),
        awemeCount: Number(author.aweme_count || 0),
        followStatus: Number(author.follow_status || 0),
        cover: author?.cover_url?.url_list?.[0] || '',
        avatar: author?.avatar_larger?.url_list?.[0] || author?.avatar_medium?.url_list?.[0] || ''
      },
      duration: Math.round(durationMs / 1000),
      cover: isImage ? (images[0] || video?.cover?.url_list?.[0] || video?.origin_cover?.url_list?.[0] || '') : (video?.cover?.url_list?.[0] || video?.origin_cover?.url_list?.[0] || images[0] || ''),
      images,
      imageMedia,
      livePhotoCount: imageMedia.filter(image => image.isLivePhoto).length,
      playUrl: video?.play_addr?.url_list?.[0] || video?.download_addr?.url_list?.[0] || '',
      likes: Number(stats.digg_count || 0),
      comments: Number(stats.comment_count || 0),
      shares: Number(stats.share_count || 0),
      plays: Number(stats.play_count || 0),
      collects: Number(stats.collect_count || 0),
      recommends: Number(stats.recommend_count || 0),
      downloads: Number(stats.download_count || 0),
      createdAt: item?.create_time ? new Date(Number(item.create_time) * 1000).toISOString() : '',
      url: item?.share_url || 'https://www.douyin.com/video/' + id
    };
  };
  const addIds = (phase, items) => {
    const known = new Set();
    const batch = [];
    for (const item of items || []) {
      const id = String(item?.aweme_id || item?.group_id || '');
      if (id && !known.has(id)) {
        known.add(id);
        batch.push(compactItem(item, phase));
      }
    }
    return batch;
  };
  const recordOrder = phase => {
    // 列表可能是虚拟列表，每轮只保留当前可见卡片；按首次出现顺序去重即可还原原页面顺序。
    const known = new Set(result.order[phase]);
    const cards = [...document.querySelectorAll('[data-e2e="scroll-list"] > li a[href], [data-e2e="scroll-list"] a[href*="/video/"], [data-e2e="scroll-list"] a[href*="/note/"]')];
    for (const card of cards) {
      const match = card.getAttribute('href')?.match(/\\/(?:video|note)\\/(\\d+)/);
      if (match && !known.has(match[1])) {
        known.add(match[1]);
        result.order[phase].push(match[1]);
      }
    }
  };
  const makeDeviceQuery = () => new URLSearchParams({
    device_platform: 'webapp',
    aid: '6383',
    channel: 'channel_pc_web',
    publish_video_strategy_type: '2',
    pc_client_type: '1',
    pc_libra_divert: /Linux/i.test(navigator.userAgent) ? 'Linux' : 'Windows',
    update_version_code: '170400',
    support_h265: '1',
    support_dash: '1',
    version_code: '170400',
    version_name: '17.4.0',
    cookie_enabled: 'true',
    screen_width: String(screen.width || 0),
    screen_height: String(screen.height || 0),
    browser_language: navigator.language || 'zh-CN',
    browser_platform: navigator.platform || 'Win32',
    browser_name: 'Chrome',
    browser_version: navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] || '',
    browser_online: 'true',
    engine_name: 'Blink',
    engine_version: navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] || '',
    os_name: /Linux/i.test(navigator.userAgent) ? 'Linux' : 'Windows',
    os_version: /Linux/i.test(navigator.userAgent) ? '' : '10',
    cpu_core_num: String(navigator.hardwareConcurrency || 4),
    device_memory: String(navigator.deviceMemory || 8),
    platform: 'PC',
    downlink: String(navigator.connection?.downlink || 10),
    effective_type: navigator.connection?.effectiveType || '4g',
    round_trip_time: String(navigator.connection?.rtt || 50)
  });
  const fetchJson = async (url, options = {}) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { credentials: 'include', cache: 'no-store', ...options, signal: controller.signal });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('接口返回了无法解析的数据'); }
      if (!response.ok) throw new Error('接口请求失败（' + response.status + '）');
      const status = Number(data?.status_code);
      if (Number.isFinite(status) && status !== 0 && data?.aweme_list == null) {
        throw new Error(data?.status_msg || ('接口状态码：' + status));
      }
      if (data?.aweme_list == null) data.aweme_list = [];
      return data;
    } finally {
      clearTimeout(timeout);
    }
  };
  const fetchPage = async (url, options) => {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { return await fetchJson(url, options); }
      catch (error) {
        lastError = error;
        if (attempt < 2) await sleep(500 * (attempt + 1));
      }
    }
    throw lastError;
  };
  const loadByApi = async phase => {
    // 喜欢接口每页最多 50 条；收藏接口按抖音实际限制使用 10 条。
    const pageSize = phase === 'like' ? 50 : 10;
    const maxPages = 220;
    const progressPages = 20;
    const previous = checkpoints[phase] || { cursor: '0', pages: 0, complete: false };
    if (previous.complete) { result.api[phase] = true; return true; }
    let cursor = previous.cursor || '0';
    const seenCursors = new Set([String(cursor)]);
    let reachedEnd = false;
    for (let page = 0; page < maxPages; page += 1) {
      const query = makeDeviceQuery();
      let data;
      if (phase === 'like') {
        query.set('count', String(pageSize));
        query.set('max_cursor', String(cursor));
        query.set('min_cursor', '0');
        query.set('whale_cut_token', '');
        query.set('cut_version', '1');
        data = await fetchPage('/aweme/v1/web/aweme/favorite/?' + query.toString());
      } else {
        data = await fetchPage('/aweme/v1/web/aweme/listcollection/?' + query.toString(), {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: 'count=' + pageSize + '&cursor=' + encodeURIComponent(String(cursor))
        });
      }
      const items = Array.isArray(data.aweme_list) ? data.aweme_list : [];
      const batch = addIds(phase, items);
      const more = Boolean(data.has_more);
      const nextCursor = more ? String(phase === 'like' ? data.max_cursor ?? '' : data.cursor ?? '') : String(cursor);
      const validCursor = !more || (items.length > 0 && /^\\d+$/.test(nextCursor) && !seenCursors.has(nextCursor));
      console.log('__DY_SYNC_BATCH__', phase, JSON.stringify(batch), JSON.stringify(validCursor ? { cursor: nextCursor, pages: previous.pages + page + 1, complete: !more } : null));
      // 总页数未知，20 页只用于让进度条持续反馈；完成时服务端会统一置为 100%。
      console.log('__DY_SYNC_PROGRESS__', phase, previous.pages + page + 1, progressPages, result.order[phase].length);
      if (!more) {
        reachedEnd = true;
        break;
      }
      if (!items.length) throw new Error('接口返回空页，无法确认列表是否完整');
      if (!validCursor) throw new Error('接口游标异常，无法继续分页');
      seenCursors.add(nextCursor);
      cursor = nextCursor;
      await sleep(40);
    }
    if (!reachedEnd) throw new Error('接口分页超过安全上限');
    result.api[phase] = true;
    return true;
  };
  const scrollContainers = () => {
    const found = [];
    let el = document.querySelector('[data-e2e="scroll-list"]');
    while (el) {
      if (el.scrollHeight - el.clientHeight > 300) found.push(el);
      el = el.parentElement;
    }
    const root = document.scrollingElement;
    if (root && !found.includes(root) && root.scrollHeight - root.clientHeight > 300) found.push(root);
    return found;
  };
  const resetScroll = () => {
    for (const scroller of scrollContainers()) scroller.scrollTop = 0;
    window.scrollTo(0, 0);
  };
  const scrollHeight = () => scrollContainers()
    .reduce((max, el) => Math.max(max, el.scrollHeight), 0);
  const waitForListUpdate = async (phase, count, height) => {
    // 网络响应通常不到 1 秒；检测到列表变化后立即进入下一轮，避免固定长等待。
    for (let attempt = 0; attempt < 24; attempt += 1) {
      recordOrder(phase);
      if (result.order[phase].length > count || scrollHeight() > height + 20) return true;
      await sleep(60);
    }
    return false;
  };
  const loadAllVisiblePages = async phase => {
    // 接口分页失败时保留原页面滚动逻辑，连续 5 轮没有新增卡片才停止。
    resetScroll();
    await sleep(600);
    recordOrder(phase);
    let stableRounds = 0;
    let previousCount = result.order[phase].length;
    const maxPages = 220;
    for (let page = 0; page < maxPages; page += 1) {
      const scrollers = scrollContainers().sort((a, b) => b.scrollHeight - a.scrollHeight);
      const beforeHeight = scrollHeight();
      for (const scroller of scrollers) {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
      window.scrollTo(0, document.body.scrollHeight);
      await waitForListUpdate(phase, previousCount, beforeHeight);
      recordOrder(phase);
      const currentCount = result.order[phase].length;
      if (currentCount === previousCount) stableRounds += 1;
      else stableRounds = 0;
      previousCount = currentCount;
      console.log('__DY_SYNC_PROGRESS__', phase, page + 1, maxPages, currentCount, 'scroll');
      if (stableRounds >= 5) break;
    }
  };
  try { await loadByApi('like'); } catch (error) {
    console.warn('喜欢接口分页失败，回退页面滚动：' + error.message);
    console.log('__DY_SYNC_FALLBACK__', 'like', String(error.message || error));
    click('收藏');
    await sleep(120);
    click('喜欢');
    await sleep(120);
    await loadAllVisiblePages('like');
  }
  try { await loadByApi('collect'); } catch (error) {
    console.warn('收藏接口分页失败，回退页面滚动：' + error.message);
    console.log('__DY_SYNC_FALLBACK__', 'collect', String(error.message || error));
    click('收藏');
    await sleep(120);
    click('视频');
    await sleep(120);
    await loadAllVisiblePages('collect');
  }
  return { api: result.api };
})()`;

// 在已经打开的抖音用户主页中滚动作品列表。作品数据由 CDP Network 事件读取，
// 这里主要负责触发虚拟列表加载，并通过控制台事件报告进度。
const userPageScript = `(async () => {
  const imageMediaFromAweme = ${imageMediaFromAweme.toString()};
  const isDouyinMediaUrl = ${isDouyinMediaUrl.toString()};
  const result = { items: [], api: false };
  const itemIds = new Set();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const click = text => {
    const el = [...document.querySelectorAll('*')].find(e => e.children.length === 0 && e.textContent.trim() === text);
    if (el) { el.click(); return true; }
    return false;
  };
  const firstUrl = value => typeof value === 'string' ? value : value?.url_list?.[0] || value?.download_url_list?.[0] || value?.url || '';
  const compactItem = item => {
    const video = item?.video || {};
    const imageMedia = imageMediaFromAweme(item, isDouyinMediaUrl);
    const images = imageMedia.map(image => image.imageUrl);
    const durationMs = Number(video.duration ?? item?.duration ?? 0);
    const isImage = Number(item?.aweme_type) === 68 || (images.length > 0 && durationMs <= 0);
    const author = item?.author || item?.author_info || {};
    const stats = item?.statistics || {};
    const id = String(item?.aweme_id || item?.group_id || '');
    return {
      id, source: 'user', mediaType: isImage ? 'image' : 'video', imageCount: isImage ? images.length : 0,
      title: item?.desc || (isImage ? '鏈懡鍚嶅浘闆�' : '鏈懡鍚嶈棰�'),
      author: author.nickname || author.unique_id || '鏈煡浣滃��', authorId: String(author.uid || author.sec_uid || ''),
      authorAvatar: firstUrl(author?.avatar_thumb) || firstUrl(author?.avatar_larger), authorUniqueId: author.unique_id || '',
      authorShortId: author.short_id || '', authorSignature: author.signature || '',
      authorFollowers: Number(author.follower_count || 0), authorFollowing: Number(author.following_count || 0),
      authorTotalFavorited: Number(author.total_favorited || 0), authorAwemeCount: Number(author.aweme_count || 0),
      authorProfile: {
        uid: String(author.uid || ''), secUid: String(author.sec_user_id || author.sec_uid || ''), uniqueId: author.unique_id || '',
        shortId: author.short_id || '', nickname: author.nickname || '', signature: author.signature || '',
        gender: typeof author.gender === 'number' ? author.gender : 0, genderText: author.gender_name || author.gender_text || '',
        age: Number(author.age || author.user_age || item?.author_age || item?.user_age || item?.age || 0), birthday: author.birthday || '',
        country: author.country || '', province: author.province || '', city: author.city || '', district: author.district || author.county || '',
        location: author.location || author.region || '', ipLocation: author.ip_location || author.ip_location_text || item?.ip_label || '',
        school: author.school_name || '', verification: author.custom_verify || author.enterprise_verify_reason || '',
        verificationType: Number(author.verification_type || 0), verified: Boolean(author.is_verified), displayId: author.display_id || '',
        followerCount: Number(author.follower_count || 0), followingCount: Number(author.following_count || 0),
        favoritingCount: Number(author.favoriting_count || 0), totalFavorited: Number(author.total_favorited || 0),
        awemeCount: Number(author.aweme_count || 0), followStatus: Number(author.follow_status || 0), cover: firstUrl(author?.cover_url),
        avatar: firstUrl(author?.avatar_larger) || firstUrl(author?.avatar_medium)
      },
      duration: Math.round(durationMs / 1000),
      cover: isImage ? (images[0] || firstUrl(video?.cover) || firstUrl(video?.origin_cover)) : (firstUrl(video?.cover) || firstUrl(video?.origin_cover) || images[0] || ''),
      images, imageMedia, livePhotoCount: imageMedia.filter(image => image.isLivePhoto).length,
      playUrl: firstUrl(video?.play_addr) || firstUrl(video?.download_addr),
      playUrls: [...new Set([...(video?.play_addr?.url_list || []), ...(video?.download_addr?.url_list || [])])],
      qualities: [], likes: Number(stats.digg_count || 0), comments: Number(stats.comment_count || 0),
      shares: Number(stats.share_count || 0), plays: Number(stats.play_count || 0), collects: Number(stats.collect_count || 0),
      recommends: Number(stats.recommend_count || 0), downloads: Number(stats.download_count || 0),
      createdAt: item?.create_time ? new Date(Number(item.create_time) * 1000).toISOString() : '',
      url: item?.share_url || 'https://www.douyin.com/video/' + id
    };
  };
  // 首先主动请求用户作品分页，确保首屏已经加载完成时仍能捕获作品数据。
  const loadApiPages = async () => {
    const secUserId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '');
    if (!secUserId) return;
    let cursor = 0;
    const seen = new Set(['0']);
    for (let page = 0; page < 220; page += 1) {
      const query = new URLSearchParams({
        device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
        // 与抖音主页一致，缺少该策略参数时接口会过滤部分实况图作品。
        publish_video_strategy_type: '2',
        sec_user_id: secUserId, count: '18', max_cursor: String(cursor),
        locate_query: 'false', publish_time: '0', show_live_replay_strategy: '1'
      });
      const response = await fetch('/aweme/v1/web/aweme/post/?' + query.toString(), {
        credentials: 'include', cache: 'no-store', headers: { 'x-dy-sync-api': 'direct' }
      });
      if (!response.ok) throw new Error('用户作品接口请求失败（' + response.status + '）');
      const data = await response.json();
      for (const item of data?.aweme_list || []) {
        const normalized = compactItem(item);
        if (normalized.id && !itemIds.has(normalized.id)) { itemIds.add(normalized.id); result.items.push(normalized); }
      }
      if (!Array.isArray(data?.aweme_list)) throw new Error('用户作品接口返回格式异常');
      console.log('__DY_PROFILE_PROGRESS__', page + 1, 220, result.items.length);
      if (!data.has_more) return;
      const next = Number(data.max_cursor);
      if (!Number.isFinite(next) || seen.has(String(next))) throw new Error('用户作品接口游标异常');
      seen.add(String(next));
      cursor = next;
      await sleep(50);
    }
  };
  const findScrollable = () => [...document.querySelectorAll('*')]
    .filter(el => el.scrollHeight - el.clientHeight > 300)
    .sort((a, b) => b.scrollHeight - a.scrollHeight);
  click('作品');
  await sleep(120);
  let apiLoaded = false;
  try { await loadApiPages(); apiLoaded = true; } catch (error) { console.warn('用户作品接口分页失败：' + error.message); }
  if (apiLoaded) { result.api = true; return result; }
  let stableRounds = 0;
  let previousHeight = 0;
  for (let page = 0; page < 240; page += 1) {
    const scrollers = findScrollable();
    const beforeHeight = Math.max(document.body.scrollHeight, ...scrollers.map(el => el.scrollHeight), 0);
    for (const scroller of scrollers) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    }
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(260);
    const afterHeight = Math.max(document.body.scrollHeight, ...findScrollable().map(el => el.scrollHeight), 0);
    const count = document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]').length;
    console.log('__DY_PROFILE_PROGRESS__', page + 1, 240, count);
    if (afterHeight <= beforeHeight + 20 && afterHeight <= previousHeight + 20) stableRounds += 1;
    else stableRounds = 0;
    previousHeight = afterHeight;
    if (stableRounds >= 6) break;
  }
  return { ok: true };
})()`;

function itemFromAweme(item, source) {
  // 将抖音接口的原始 aweme 结构压缩成前端展示所需的统一字段。
  const imageMedia = imageMediaFromAweme(item, isDouyinMediaUrl);
  const images = imageMedia.map(image => image.imageUrl);
  const durationMs = Number(item?.video?.duration ?? item?.duration ?? 0);
  const isImage = Number(item?.aweme_type) === 68 || (images.length > 0 && durationMs <= 0);
  const cover = isImage
    ? (images[0] || item?.video?.cover?.url_list?.[0] || item?.video?.origin_cover?.url_list?.[0] || '')
    : (item?.video?.cover?.url_list?.[0] || item?.video?.origin_cover?.url_list?.[0] || images[0] || '');
  const author = item?.author || item?.author_info || {};
  const stats = item?.statistics || {};
  const authorAvatar = author?.avatar_thumb?.url_list?.[0] || author?.avatar_larger?.url_list?.[0] || '';
  return {
    id: String(item?.aweme_id || item?.group_id || crypto.randomUUID()),
    source,
    mediaType: isImage ? 'image' : 'video',
    imageCount: isImage ? images.length : 0,
    title: item?.desc || (isImage ? '未命名图集' : '未命名视频'),
    author: author.nickname || author.unique_id || '未知作者',
    authorId: String(author.uid || author.sec_uid || ''),
    authorAvatar,
    authorUniqueId: author.unique_id || '',
    authorShortId: author.short_id || '',
    authorSignature: author.signature || '',
    authorFollowers: Number(author.follower_count || 0),
    authorFollowing: Number(author.following_count || 0),
    authorTotalFavorited: Number(author.total_favorited || 0),
    authorAwemeCount: Number(author.aweme_count || 0),
    authorProfile: {
      uid: String(author.uid || ''),
      secUid: String(author.sec_uid || ''),
      uniqueId: author.unique_id || '',
      shortId: author.short_id || '',
      nickname: author.nickname || '',
      signature: author.signature || '',
      gender: typeof author.gender === 'number' ? author.gender : (/^(男|male|m|1)$/i.test(String(author.gender || '')) ? 1 : /^(女|female|f|2)$/i.test(String(author.gender || '')) ? 2 : 0),
      genderText: author.gender_name || author.gender_text || (typeof author.gender === 'string' ? author.gender : ''),
      age: Number(author.age || author.user_age || item?.author_age || item?.user_age || item?.age || 0),
      birthday: author.birthday || '',
      country: author.country || '',
      province: author.province || '',
      city: author.city || '',
      district: author.district || author.county || author.district_name || '',
      location: author.location || author.region || author.region_name || '',
      ipLocation: author.ip_location || author.ip_location_text || author.ip_location_name || author.ip_label || item?.ip_label || item?.ip_location || item?.ip_location_text || '',
      school: author.school_name || author.school_poi_name || '',
      verification: author.custom_verify || author.enterprise_verify_reason || '',
      verificationType: Number(author.verification_type || 0),
      verified: Boolean(author.is_verified),
      displayId: author.display_id || '',
      followerCount: Number(author.follower_count || 0),
      followingCount: Number(author.following_count || 0),
      favoritingCount: Number(author.favoriting_count || 0),
      totalFavorited: Number(author.total_favorited || 0),
      awemeCount: Number(author.aweme_count || 0),
      followStatus: Number(author.follow_status || 0),
      cover: author?.cover_url?.url_list?.[0] || '',
      avatar: author?.avatar_larger?.url_list?.[0] || author?.avatar_medium?.url_list?.[0] || ''
    },
    duration: Math.round(durationMs / 1000),
    cover,
    images,
    imageMedia,
    livePhotoCount: imageMedia.filter(image => image.isLivePhoto).length,
    // 列表接口有时已经返回可播放地址；详情接口会在点击时实时刷新它。
    playUrl: item?.video?.play_addr?.url_list?.[0] || item?.video?.download_addr?.url_list?.[0] || '',
    playUrls: playUrlsFromAweme(item),
    qualities: qualityOptionsFromAweme(item),
    likes: Number(stats.digg_count || 0),
    comments: Number(stats.comment_count || 0),
    shares: Number(stats.share_count || 0),
    plays: Number(stats.play_count || 0),
    collects: Number(stats.collect_count || 0),
    recommends: Number(stats.recommend_count || 0),
    downloads: Number(stats.download_count || 0),
    createdAt: item?.create_time ? new Date(Number(item.create_time) * 1000).toISOString() : '',
    url: item?.share_url || `https://www.douyin.com/video/${item?.aweme_id || item?.group_id || ''}`
  };
}

// 从详情对象中提取所有可用播放地址，优先使用清晰度较高的码率地址。
function playUrlsFromAweme(item) {
  // 从作品详情中收集不同码率的播放地址，并按码率从高到低排序。
  const video = item?.video || {};
  const bitRates = [...(video.bit_rate || [])].sort((a, b) => Number(b?.bit_rate || 0) - Number(a?.bit_rate || 0));
  return [...new Set([
    ...bitRates.flatMap(rate => rate?.play_addr?.url_list || []),
    ...(video.play_addr?.url_list || []),
    ...(video.download_addr?.url_list || [])
  ].filter(isDouyinMediaUrl))];
}

// 将详情接口中的码率档位整理成前端可切换的清晰度选项。
function qualityOptionsFromAweme(item) {
  const video = item?.video || {};
  const bitRates = [...(video.bit_rate || [])].sort((a, b) => Number(b?.bit_rate || 0) - Number(a?.bit_rate || 0));
  const options = new Map();
  const addOption = (url, rate = {}) => {
    if (!url || !isDouyinMediaUrl(url)) return;
    const width = Number(rate?.width || video.width || 0);
    const height = Number(rate?.height || video.height || 0);
    const bitRate = Number(rate?.bit_rate || 0);
    const rawLabel = String(rate?.gear_name || rate?.quality || rate?.quality_type || '');
    const resolutionMatch = rawLabel.match(/(?:^|_)(\d{3,4})(?:_|p|$)/i);
    const resolution = resolutionMatch?.[1] || (width && height ? Math.min(width, height) : '');
    const label = resolution ? `${resolution}P` : bitRate ? `${Math.round(bitRate / 1000)}K` : '标准';
    const option = {
      url,
      label,
      width,
      height,
      bitRate,
      format: rate?.format || video.format || ''
    };
    const key = resolution || rawLabel || 'default';
    const existing = options.get(key);
    const optionScore = bitRate * 10 + (String(option.format).toLowerCase() === 'mp4' ? 1 : 0);
    const existingScore = existing ? existing.bitRate * 10 + (String(existing.format).toLowerCase() === 'mp4' ? 1 : 0) : -1;
    if (!existing || optionScore > existingScore) options.set(key, option);
  };
  for (const rate of bitRates) {
    const urls = [...(rate?.play_addr?.url_list || []), ...(rate?.download_addr?.url_list || [])];
    addOption(urls.find(isDouyinMediaUrl), rate);
  }
  // 有码率档位时已经覆盖清晰度，只有接口缺少 bit_rate 才使用通用播放地址兜底。
  if (!options.size) {
    for (const url of video.play_addr?.url_list || []) addOption(url, video);
    for (const url of video.download_addr?.url_list || []) addOption(url, video);
  }
  return [...options.values()];
}

// 详情接口返回的字段比列表接口更丰富，补充音乐、尺寸和标签等弹窗信息。
function detailFromAweme(item, fallbackId) {
  const normalized = itemFromAweme(item, 'detail');
  const qualities = qualityOptionsFromAweme(item);
  const playUrls = [...new Set(qualities.map(option => option.url).concat(playUrlsFromAweme(item)))].filter(isDouyinMediaUrl);
  const fallbackPlayUrl = isDouyinMediaUrl(normalized.playUrl) ? normalized.playUrl : '';
  const images = normalized.images || [];
  const music = item?.music || {};
  const tags = (item?.text_extra || [])
    .map(entry => entry?.hashtag_name || entry?.hashtag_name_str || '')
    .filter(Boolean);
  return {
    ...normalized,
    id: String(item?.aweme_id || fallbackId),
    mediaType: normalized.mediaType,
    imageCount: normalized.imageCount || images.length,
    playUrl: qualities[0]?.url || playUrls[0] || fallbackPlayUrl,
    playUrls,
    qualities,
    width: Number(item?.video?.width || 0),
    height: Number(item?.video?.height || 0),
    ratio: item?.video?.ratio || '',
    music: {
      title: music?.title || '',
      author: music?.author || '',
      url: music?.play_url?.url_list?.[0] || music?.play_url?.url || music?.play_url?.uri || music?.play_url_h264?.url_list?.[0] || ''
    },
    location: item?.poi_info?.poi_name || item?.poi_info?.name || '',
    tags,
    recommends: Number(item?.statistics?.recommend_count || 0),
    downloads: Number(item?.statistics?.download_count || 0)
  };
}

const detailRequests = new Map();
let detailFallbackQueue = Promise.resolve();

// 播放地址只在短时间内有效，保存到内存中供本地媒体代理校验使用。
const mediaUrls = new Map();

const downloadJobs = new Map();
let downloadRunsInFlight = 0;
const downloadProgressSavedAt = new WeakMap();
let downloadStateWrite = Promise.resolve();
let downloadStateTimer = null;
let downloadStateResolvers = [];

function queueDownloadStateSave() {
  // 合并短时间内的多次状态变更，避免下载过程中频繁写磁盘。
  const promise = new Promise(resolve => downloadStateResolvers.push(resolve));
  if (downloadStateTimer) return promise;
  downloadStateTimer = setTimeout(() => {
    downloadStateTimer = null;
    const resolvers = downloadStateResolvers;
    downloadStateResolvers = [];
    downloadStateWrite = downloadStateWrite.then(async () => {
      const jobs = [...downloadJobs.values()].map(({ runningPromise, runToken, ...job }) => job);
      const payload = JSON.stringify({ jobs }, null, 2);
      const tempPath = `${downloadStatePath}.tmp`;
      await fs.writeFile(tempPath, payload, 'utf8');
      await fs.rename(tempPath, downloadStatePath);
    }).catch(error => console.warn(`保存下载任务失败：${error.message}`)).finally(() => resolvers.forEach(resolve => resolve()));
  }, 300);
  return promise;
}

function publicDownloadJob(job, { includeItems = true } = {}) {
  // 只向前端暴露任务进度字段，隐藏运行时 Promise 和媒体地址缓存。
  const exposeItem = ({ rateAt, rateBytes, playUrl, qualities, images, imageMedia, ...item }) => ({ ...item, speedBps: Number(item.speedBps) || 0 });
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    source: job.source,
    quality: job.quality,
    albumMode: job.albumMode === 'flat' ? 'flat' : 'folder',
    concurrency: Math.min(MAX_DOWNLOAD_CONCURRENCY, Math.max(1, Number(job.concurrency) || DOWNLOAD_CONCURRENCY)),
    activeConcurrency: job.status === 'running' ? job.items.filter(item => item.status === 'downloading').length : 0,
    videoCount: job.items.filter(item => item.mediaType !== 'image').length,
    imageCount: job.items.filter(item => item.mediaType === 'image').length,
    directory: downloadRoot,
    total: job.items.length,
    fileVersion: Number(job.fileVersion) || 0,
    completed: job.items.filter(item => item.status === 'completed').length,
    skipped: job.items.filter(item => item.status === 'skipped').length,
    failed: job.items.filter(item => item.status === 'failed').length,
    pending: job.items.filter(item => item.status === 'pending').length,
    downloading: job.items.filter(item => item.status === 'downloading').length,
    bytes: job.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
    totalBytes: job.items.reduce((sum, item) => sum + (Number(item.totalBytes) || 0), 0),
    current: (() => { const item = job.items.find(candidate => candidate.status === 'downloading'); return item ? exposeItem(item) : null; })(),
    activeItems: job.items.filter(item => item.status === 'downloading').map(exposeItem),
    error: job.error || null,
    ...(includeItems ? { items: job.items.map(exposeItem) } : {})
  };
}

async function loadDownloadJobs() {
  // 服务重启后恢复任务；中断中的下载项重新排队而不是标记完成。
  try {
    const data = JSON.parse(await fs.readFile(downloadStatePath, 'utf8'));
    for (const job of data.jobs || []) {
      if (!job?.id || !Array.isArray(job.items)) continue;
      // 旧版本任务没有 fileBaseName，恢复时固定使用旧的 ID 文件名，避免断点文件路径改变。
      for (const item of job.items) {
        if (!item.fileBaseName) item.fileBaseName = `douyin-${String(item.id).replace(/[^0-9]/g, '') || 'media'}`;
      }
      for (const item of job.items) if (item.status === 'downloading') item.status = 'pending';
      if (job.status === 'running' || job.status === 'downloading') job.status = 'paused';
      job.runningPromise = null;
      job.runToken = 0;
      downloadJobs.set(job.id, job);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`读取下载任务失败：${error.message}`);
  }
}

function registerMediaUrls(detail) {
  // 登记详情接口返回的媒体地址，供本地代理进行短期白名单校验。
  if (isDouyinMediaUrl(detail.playUrl)) mediaUrls.set(detail.playUrl, Date.now() + 15 * 60 * 1000);
  for (const url of detail.playUrls || []) mediaUrls.set(url, Date.now() + 15 * 60 * 1000);
  for (const option of detail.qualities || []) if (isDouyinMediaUrl(option?.url)) mediaUrls.set(option.url, Date.now() + 15 * 60 * 1000);
  for (const url of detail.images || []) mediaUrls.set(url, Date.now() + 15 * 60 * 1000);
  for (const image of detail.imageMedia || []) {
    if (isDouyinMediaUrl(image.imageUrl)) mediaUrls.set(image.imageUrl, Date.now() + 15 * 60 * 1000);
    for (const url of [image.videoUrl, ...(image.videoUrls || [])]) {
      if (isDouyinMediaUrl(url)) mediaUrls.set(url, Date.now() + 15 * 60 * 1000);
    }
  }
  if (isDouyinMediaUrl(detail.music?.url)) mediaUrls.set(detail.music.url, Date.now() + 15 * 60 * 1000);
  for (const [url, expiresAt] of mediaUrls) if (expiresAt < Date.now()) mediaUrls.delete(url);
}

function isDouyinMediaUrl(value) {
  try {
    const url = new URL(value);
    // 抖音会按线路返回不同 CDN；地址仍必须来自详情响应登记，避免代理被当作开放代理使用。
    return url.protocol === 'https:' && [
      /(^|\.)douyin\.com$/i,
      /(^|\.)douyinvod\.com$/i,
      /(^|\.)douyinpic\.com$/i,
      /(^|\.)365yg\.com$/i,
      /(^|\.)amemv\.com$/i,
      /(^|\.)ibytedtos\.com$/i,
      /(^|\.)bytecdn\.cn$/i,
      /(^|\.)byteimg\.com$/i,
      /(^|\.)douyinstatic\.com$/i,
      /(^|\.)snssdk\.com$/i
    ].some(pattern => pattern.test(url.hostname));
  } catch { return false; }
}

// 抖音 CDN 会校验请求来源。本地代理只接受本次详情接口登记的短期媒体地址，并转发 Range 请求。
async function proxyMedia(req, res, value, { download = false, id = '', kind = 'video', index = '' } = {}) {
  const expiresAt = mediaUrls.get(value);
  if (!isDouyinMediaUrl(value) || !expiresAt || expiresAt < Date.now()) {
    return send(res, 403, JSON.stringify({ error: '播放地址无效或已过期，请重新打开作品' }));
  }
  const headers = {
    referer: 'https://www.douyin.com/',
    origin: 'https://www.douyin.com',
    'user-agent': 'Mozilla/5.0'
  };
  if (req.headers.range) headers.range = req.headers.range;
  const upstream = await fetch(value, { headers });
  const contentType = upstream.headers.get('content-type') || (kind === 'image' ? 'image/jpeg' : 'video/mp4');
  const responseHeaders = {
    'content-type': contentType,
    'cache-control': 'no-store',
    'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes'
  };
  for (const name of ['content-length', 'content-range']) {
    const header = upstream.headers.get(name);
    if (header) responseHeaders[name] = header;
  }
  if (download) {
    // 使用稳定的 ASCII 文件名，避免不同浏览器对中文文件名的编码处理不一致。
    const extension = kind === 'image' ? (contentType.split('/')[1] || 'jpg').split(';')[0].replace(/[^a-z0-9]/gi, '') || 'jpg' : 'mp4';
    const suffix = index ? `-${String(index).replace(/[^0-9]/g, '')}` : '';
    responseHeaders['content-disposition'] = `attachment; filename="douyin-${id || 'media'}${suffix}.${extension}"`;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (req.method === 'HEAD') { await upstream.body?.cancel(); return res.end(); }
  if (!upstream.body) return res.end();
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch { res.destroy(); }
}

function updateDownloadJob(job, { progress = false } = {}) {
  job.updatedAt = new Date().toISOString();
  if (progress) {
    const now = Date.now();
    if (now - (downloadProgressSavedAt.get(job) || 0) < 2000) return;
    downloadProgressSavedAt.set(job, now);
  }
  queueDownloadStateSave();
}

function safeDownloadTitle(title, id) {
  const fallback = `douyin-${String(id).replace(/[^0-9]/g, '') || 'media'}`;
  let value = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .replace(/[. ]+$/g, '');
  if (!value || /^\.+$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)) return fallback;
  return value;
}

function safeFileName(item) {
  return `${item.fileBaseName || safeDownloadTitle(item.title, item.id)}.mp4`;
}

function updateDownloadRate(item, bytesAdded) {
  // 用滑动加权方式计算下载速度，降低网络抖动造成的显示跳变。
  const now = Date.now();
  item.bytes = (Number(item.bytes) || 0) + bytesAdded;
  if (item.rateAt) {
    const elapsed = now - item.rateAt;
    if (elapsed >= 250) {
      const instant = (item.bytes - (Number(item.rateBytes) || 0)) * 1000 / elapsed;
      item.speedBps = Math.round((Number(item.speedBps) || instant) * 0.65 + instant * 0.35);
      item.rateAt = now;
      item.rateBytes = item.bytes;
    }
  } else {
    item.rateAt = now;
    item.rateBytes = item.bytes;
  }
}

function safeAlbumDirectory(id) {
  return `douyin-${String(id).replace(/[^0-9]/g, '') || 'album'}`;
}

function uniqueDownloadBaseName(item, albumMode, usedFiles) {
  const title = safeDownloadTitle(item.title, item.id);
  const fileKeys = base => {
    if (item.mediaType !== 'image') return [`${base}.mp4`.toLowerCase()];
    const directory = albumMode === 'flat' ? '' : `${safeAlbumDirectory(item.id)}/`;
    const count = Math.max(1, Number(item.imageCount) || item.imageMedia?.length || item.images?.length || 0);
    // 为每张图片预留动态片段文件名，避免平铺时与另一个视频的标题撞名。
    return Array.from({ length: count }, (_, index) => ['jpg', 'mp4']
      .map(extension => `${directory}${base}-${index + 1}.${extension}`.toLowerCase())).flat();
  };
  let base = title;
  let occurrence = 1;
  while (usedFiles.has(`title:${base.toLowerCase()}`) || fileKeys(base).some(key => usedFiles.has(key))) base = `${title}-${++occurrence}`;
  usedFiles.add(`title:${base.toLowerCase()}`);
  for (const key of fileKeys(base)) usedFiles.add(key);
  return base;
}

function albumFilesFromDetail(detail) {
  const media = detail.imageMedia?.length
    ? detail.imageMedia
    : (detail.images || []).map(imageUrl => ({ imageUrl }));
  return media.flatMap((image, index) => {
    if (!isDouyinMediaUrl(image.imageUrl)) throw new Error(`第 ${index + 1} 张图片地址无效`);
    const videoUrl = [image.videoUrl, ...(image.videoUrls || [])].find(isDouyinMediaUrl);
    if (image.isLivePhoto && !videoUrl) throw new Error(`第 ${index + 1} 张实况图缺少动态地址，请重新获取作品详情`);
    const files = [{ url: image.imageUrl, extension: 'jpg', imageIndex: index }];
    if (videoUrl) files.push({ url: videoUrl, extension: 'mp4', imageIndex: index });
    files[files.length - 1].endsImage = true;
    return files;
  });
}

async function downloadJobItem(job, item) {
  // 下载单个视频或将图集任务转交给图片下载流程。
  const runToken = job.runToken;
  const inactive = () => job.status !== 'running' || job.cancelRequested || job.runToken !== runToken;
  const stopIfInactive = () => {
    if (!inactive()) return false;
    if (item.status === 'downloading') {
      item.status = job.cancelRequested ? 'cancelled' : 'pending';
      updateDownloadJob(job);
    }
    return true;
  };
  if (stopIfInactive()) return;
  if (item.mediaType === 'image') return downloadImageAlbumItem(job, item);
  // 立即占用队列项，再执行磁盘检查，避免多个 worker 同时领取同一作品。
  item.status = 'downloading';
  const target = path.join(downloadRoot, safeFileName(item));
  const partial = `${target}.part`;
  item.path = target;
  if (job.skipExisting) {
    try {
      const stat = await fs.stat(target);
      if (stat.size > 0) {
        item.bytes = stat.size;
        item.totalBytes = stat.size;
        item.status = 'skipped';
        updateDownloadJob(job);
        return;
      }
    } catch { /* 文件不存在，继续下载 */ }
  }
  if (stopIfInactive()) return;
  item.error = null;
  item.speedBps = 0;
  item.rateAt = 0;
  item.rateBytes = item.bytes || 0;
  updateDownloadJob(job);
  await fs.mkdir(downloadRoot, { recursive: true });
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    if (stopIfInactive()) return;
    item.attempts = attempt;
    try {
      let detail = item;
      if (!item.qualities?.length) {
        try {
          detail = await getVideoDetail(item.id);
        } catch (error) {
          // 详情暂不可用时仍允许使用已有的播放地址。
          if (!isDouyinMediaUrl(item.playUrl)) throw error;
        }
      }
      const options = getQualityOptionsForServer(detail, job.quality);
      const url = options[0];
      if (!url || !isDouyinMediaUrl(url)) throw new Error('未获取到可下载的视频地址');
      registerMediaUrls({ playUrls: [url], images: [] });
      let offset = 0;
      try { offset = (await fs.stat(partial)).size; } catch { /* 无临时文件 */ }
      const headers = { referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com', 'user-agent': 'Mozilla/5.0' };
      if (offset > 0) headers.range = `bytes=${offset}-`;
      let response = await fetch(url, { headers });
      if (offset > 0 && response.status === 416) {
        await fs.rm(partial, { force: true });
        offset = 0;
        delete headers.range;
        response = await fetch(url, { headers });
      }
      if (!response.ok || !response.body) throw new Error(`下载请求失败（${response.status}）`);
      if (offset > 0 && response.status !== 206) {
        await fs.rm(partial, { force: true });
        offset = 0;
      }
      const contentLength = Number(response.headers.get('content-length') || 0);
      item.bytes = offset;
      item.totalBytes = (response.status === 206 ? offset : 0) + contentLength;
      const handle = await fs.open(partial, offset > 0 ? 'a' : 'w');
      const reader = response.body.getReader();
      try {
        while (true) {
          if (inactive()) break;
          const { done, value } = await reader.read();
          if (done) break;
          await handle.write(value);
          updateDownloadRate(item, value.byteLength);
          updateDownloadJob(job, { progress: true });
        }
      } finally {
        if (inactive()) await reader.cancel().catch(() => {});
        reader.releaseLock();
        await handle.close();
      }
      if (inactive()) {
        if (item.status === 'downloading' && !job.cancelRequested) item.status = 'pending';
        if (job.cancelRequested) item.status = 'cancelled';
        updateDownloadJob(job);
        return;
      }
      await fs.rename(partial, target);
      job.fileVersion = (Number(job.fileVersion) || 0) + 1;
      item.status = 'completed';
      item.totalBytes = item.bytes;
      updateDownloadJob(job);
      return;
    } catch (error) {
      item.error = error.message;
      item.playUrl = '';
      item.qualities = [];
      if (attempt < DOWNLOAD_RETRIES) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  item.status = 'failed';
  updateDownloadJob(job);
}

async function downloadImageAlbumItem(job, item) {
  // 实况图同时保存静态图片和动态 MP4，两份资源都完成才计为一张完成。
  const runToken = job.runToken;
  const inactive = () => job.status !== 'running' || job.cancelRequested || job.runToken !== runToken;
  const stopIfInactive = () => {
    if (!inactive()) return false;
    if (item.status === 'downloading') item.status = job.cancelRequested ? 'cancelled' : 'pending';
    updateDownloadJob(job);
    return true;
  };
  const root = downloadRoot;
  const useAlbumFolder = job.albumMode !== 'flat';
  const folder = useAlbumFolder ? path.join(root, safeAlbumDirectory(item.id)) : root;
  item.path = folder;
  item.status = 'downloading';
  item.speedBps = 0;
  item.rateAt = 0;
  item.rateBytes = item.bytes || 0;
  await fs.mkdir(folder, { recursive: true });
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    if (stopIfInactive()) return;
    item.attempts = attempt;
    try {
      // 旧任务仅缓存静态 URL，必须刷新详情，避免继续把实况图当作普通图片。
      const detail = item.imageMedia?.length ? item : await getVideoDetail(item.id);
      const files = albumFilesFromDetail(detail);
      if (!files.length) throw new Error('未获取到图集图片');
      item.imageMedia = detail.imageMedia;
      item.livePhotoCount = (detail.imageMedia || []).filter(image => image.isLivePhoto).length;
      item.totalImages = files.filter(file => file.endsImage).length;
      item.totalFiles = files.length;
      item.completedFiles = 0;
      item.completedImages = 0;
      item.bytes = 0;
      item.totalBytes = 0;
      item.rateAt = 0;
      item.rateBytes = 0;
      item.error = null;
      updateDownloadJob(job);
      for (const file of files) {
        if (stopIfInactive()) return;
        const url = file.url;
        const imageName = `${item.fileBaseName || safeDownloadTitle(item.title, item.id)}-${file.imageIndex + 1}.${file.extension}`;
        const target = path.join(folder, imageName);
        const partial = `${target}.part`;
        if (job.skipExisting) {
          try {
            const stat = await fs.stat(target);
            if (stat.size > 0) {
              item.bytes += stat.size;
              item.totalBytes += stat.size;
              item.completedFiles += 1;
              if (file.endsImage) item.completedImages += 1;
              updateDownloadJob(job);
              continue;
            }
          } catch { /* 文件不存在，继续下载 */ }
        }
        let offset = 0;
        try { offset = (await fs.stat(partial)).size; } catch { /* 没有临时文件 */ }
        const headers = { referer: 'https://www.douyin.com/', origin: 'https://www.douyin.com', 'user-agent': 'Mozilla/5.0' };
        if (offset > 0) headers.range = `bytes=${offset}-`;
        let response = await fetch(url, { headers });
        if (offset > 0 && response.status === 416) {
          await fs.rm(partial, { force: true });
          offset = 0;
          delete headers.range;
          response = await fetch(url, { headers });
        }
        if (!response.ok || !response.body) throw new Error(`${file.extension === 'mp4' ? '实况视频' : '图片'}下载失败（${response.status}）`);
        if (offset > 0 && response.status !== 206) {
          await fs.rm(partial, { force: true });
          offset = 0;
        }
        const contentLength = Number(response.headers.get('content-length') || 0);
        const completedBytes = item.totalBytes;
        item.bytes += offset;
        item.totalBytes = completedBytes + offset + contentLength;
        const handle = await fs.open(partial, offset > 0 ? 'a' : 'w');
        const reader = response.body.getReader();
        try {
          while (true) {
            if (stopIfInactive()) break;
            const { done, value } = await reader.read();
            if (done) break;
            await handle.write(value);
            updateDownloadRate(item, value.byteLength);
            updateDownloadJob(job, { progress: true });
          }
        } finally {
          if (inactive()) await reader.cancel().catch(() => {});
          reader.releaseLock();
          await handle.close();
        }
        if (stopIfInactive()) return;
        await fs.rename(partial, target);
        job.fileVersion = (Number(job.fileVersion) || 0) + 1;
        item.totalBytes = item.bytes;
        item.completedFiles += 1;
        if (file.endsImage) item.completedImages += 1;
        updateDownloadJob(job);
      }
      item.status = 'completed';
      updateDownloadJob(job);
      return;
    } catch (error) {
      item.error = error.message;
      item.images = [];
      delete item.imageMedia;
      if (attempt < DOWNLOAD_RETRIES) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  item.status = 'failed';
  updateDownloadJob(job);
}

function getQualityOptionsForServer(detail, quality) {
  // 根据任务清晰度偏好选择最高或标准码率地址。
  const options = Array.isArray(detail?.qualities) ? detail.qualities.filter(option => isDouyinMediaUrl(option?.url)) : [];
  if (!options.length && isDouyinMediaUrl(detail?.playUrl)) return [detail.playUrl];
  if (quality === 'standard' && options.length) return [options[options.length - 1].url];
  return options.map(option => option.url);
}

async function runDownloadJob(job, runToken) {
  // 独立 worker 持续取下一个待处理项，避免大文件阻塞整批任务。
  const worker = async () => {
    while (job.status === 'running' && !job.cancelRequested && job.runToken === runToken) {
      const item = job.items.find(candidate => candidate.status === 'pending');
      if (!item) return;
      await downloadJobItem(job, item);
    }
  };
  const concurrency = Math.min(MAX_DOWNLOAD_CONCURRENCY, Math.max(1, Number(job.concurrency) || DOWNLOAD_CONCURRENCY));
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (job.runToken !== runToken) return;
  if (job.cancelRequested) job.status = 'cancelled';
  else if (job.status === 'running') job.status = job.items.some(item => item.status === 'failed') ? 'completed_with_errors' : 'completed';
  updateDownloadJob(job);
}

function startDownloadJob(job) {
  // 为任务创建唯一运行令牌，防止旧 worker 在暂停或取消后继续写入。
  if (job.status === 'running' && job.runningPromise) return;
  job.status = 'running';
  job.cancelRequested = false;
  job.runToken = (Number(job.runToken) || 0) + 1;
  const runToken = job.runToken;
  updateDownloadJob(job);
  const previousRun = job.runningPromise || Promise.resolve();
  downloadRunsInFlight++;
  job.runningPromise = previousRun.catch(() => {}).then(() => runDownloadJob(job, runToken)).catch(error => {
    job.status = 'failed';
    job.error = error.message;
    updateDownloadJob(job);
  }).finally(() => { downloadRunsInFlight--; });
}

// 直接复用已登录的抖音个人页请求详情接口，避免重新加载完整视频页。
async function fetchVideoDetailFromCurrentPage(id) {
  const tabs = await (await fetch(`${activeCdp}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const tab = tabs.find(candidate => candidate.type === 'page' && /douyin\.com\/user\/self/.test(candidate.url));
  if (!tab) throw new Error('未找到可复用的抖音个人页');
  const pageWs = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    await cdpCall(pageWs, 'Runtime.enable');
    // 在抖音页面上下文中发起同源请求，自动携带当前登录态和必要 Cookie。
    const expression = `(async () => {
      const awemeId = ${JSON.stringify(String(id))};
      const browserVersion = navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] || '';
      const query = new URLSearchParams({
        device_platform: 'webapp',
        aid: '6383',
        channel: 'channel_pc_web',
        publish_video_strategy_type: '2',
        update_version_code: '170400',
        pc_client_type: '1',
        pc_libra_divert: /Linux/i.test(navigator.userAgent) ? 'Linux' : 'Windows',
        support_h265: '1',
        support_dash: '1',
        cpu_core_num: String(navigator.hardwareConcurrency || 4),
        version_code: '170400',
        version_name: '17.4.0',
        cookie_enabled: 'true',
        screen_width: String(screen.width || 0),
        screen_height: String(screen.height || 0),
        browser_language: navigator.language || 'zh-CN',
        browser_platform: navigator.platform || 'Win32',
        browser_name: 'Chrome',
        browser_version: browserVersion,
        browser_online: 'true',
        engine_name: 'Blink',
        engine_version: browserVersion,
        os_name: /Linux/i.test(navigator.userAgent) ? 'Linux' : 'Windows',
        os_version: /Linux/i.test(navigator.userAgent) ? '' : '10',
        device_memory: String(navigator.deviceMemory || 8),
        platform: 'PC',
        aweme_id: awemeId
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch('/aweme/v1/web/aweme/detail/?' + query.toString(), {
          credentials: 'include',
          cache: 'no-store',
          signal: controller.signal
        });
        const body = await response.text();
        let data;
        try { data = JSON.parse(body); } catch { return { error: '详情接口返回了无法解析的数据' }; }
        if (!response.ok) return { error: '详情接口请求失败（' + response.status + '）' };
        if (!data?.aweme_detail) return { error: data?.status_msg || '抖音没有返回该作品的详情' };
        let authorProfile = null;
        const secUserId = data.aweme_detail?.author?.sec_uid || data.aweme_detail?.author?.sec_user_id || '';
        if (secUserId) {
          try {
            const profileQuery = new URLSearchParams({
              device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web',
              publish_video_strategy_type: '2', sec_user_id: secUserId,
              browser_language: navigator.language || 'zh-CN'
            });
            const profileResponse = await fetch('/aweme/v1/web/user/profile/other/?' + profileQuery.toString(), { credentials: 'include', cache: 'no-store' });
            if (profileResponse.ok) {
              const profileData = await profileResponse.json();
              // 不同版本接口的用户对象层级不同，按常见结构逐级兼容提取。
              authorProfile = profileData?.user_info?.user
                || profileData?.user_info?.user_profile
                || profileData?.user_info
                || profileData?.user_profile
                || profileData?.user
                || profileData?.data?.user_info?.user
                || profileData?.data?.user_info?.user_profile
                || profileData?.data?.user_info
                || profileData?.data?.user_profile
                || profileData?.data?.user
                || null;
              if (authorProfile?.user_info) authorProfile = authorProfile.user_info;
            }
          } catch { /* 用户资料接口失败时继续使用作品详情中的作者字段 */ }
        }
        return { detail: data.aweme_detail, authorProfile };
      } catch (error) {
        return { error: error.name === 'AbortError' ? '详情接口响应超时' : error.message };
      } finally {
        clearTimeout(timeout);
      }
    })()`;
    const evaluation = await cdpCall(pageWs, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    const value = evaluation.result?.value;
    if (!value?.detail) throw new Error(value?.error || '抖音没有返回该作品的详情');
    const detail = value.authorProfile && value.detail?.author ? { ...value.detail, author: { ...value.detail.author, ...value.authorProfile } } : value.detail;
    const normalized = detailFromAweme(detail, id);
    registerMediaUrls(normalized);
    return normalized;
  } finally {
    try { pageWs.close(); } catch { /* 忽略详情请求连接关闭异常 */ }
  }
}

// 在独立的后台标签页打开作品详情，作为直接接口请求失败时的兼容回退路径。
async function fetchVideoDetailViaNewTab(id) {
  const version = await (await fetch(`${activeCdp}/json/version`)).json();
  const browser = await connectCdp(version.webSocketDebuggerUrl);
  let targetId;
  let pageWs;
  try {
    ({ targetId } = await cdpCall(browser, 'Target.createTarget', {
      url: 'about:blank',
      background: true
    }));
    let tab;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const tabs = await (await fetch(`${activeCdp}/json/list`)).json();
      tab = tabs.find(candidate => candidate.id === targetId);
      if (tab) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!tab) throw new Error('无法创建抖音详情页');
    pageWs = await connectCdp(tab.webSocketDebuggerUrl);
    pageWs.detailRequestIds = new Set();
    pageWs.detailBodies = [];
    pageWs.detailBodyPromises = [];
    pageWs.detailReady = new Promise(resolve => { pageWs.resolveDetailReady = resolve; });
    pageWs.onEvent = event => {
      if (event.method === 'Network.responseReceived' && /\/aweme\/v1\/web\/aweme\/detail\//.test(event.params.response.url)) {
        pageWs.detailRequestIds.add(event.params.requestId);
      }
      if (event.method === 'Network.loadingFinished' && pageWs.detailRequestIds.has(event.params.requestId)) {
        const requestId = event.params.requestId;
        const promise = cdpCall(pageWs, 'Network.getResponseBody', { requestId }).then(body => {
          try {
            const data = JSON.parse(body.body);
            pageWs.detailBodies.push(data);
            if (data?.aweme_detail) pageWs.resolveDetailReady();
          } catch { /* 忽略无法解析的详情响应 */ }
        }).catch(() => {});
        pageWs.detailBodyPromises.push(promise);
      }
    };
    await cdpCall(pageWs, 'Network.enable', { maxTotalBufferSize: 50 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 });
    await cdpCall(pageWs, 'Page.enable');
    await cdpCall(pageWs, 'Runtime.enable');
    await cdpCall(pageWs, 'Page.navigate', { url: `https://www.douyin.com/video/${id}` });
    // 收到详情响应后立即继续；风控或网络异常时最多等待 7 秒再走后续兜底。
    await Promise.race([
      pageWs.detailReady,
      new Promise(resolve => setTimeout(resolve, 7000))
    ]);
    await Promise.allSettled(pageWs.detailBodyPromises);
    for (const requestId of pageWs.detailRequestIds) {
      try {
        const body = await cdpCall(pageWs, 'Network.getResponseBody', { requestId });
        pageWs.detailBodies.push(JSON.parse(body.body));
      } catch { /* 响应体已经被 Chrome 回收时使用已缓存的响应 */ }
    }
    const detail = pageWs.detailBodies.find(body => body?.aweme_detail)?.aweme_detail;
    if (!detail) throw new Error('抖音没有返回该作品的详情');
    const normalized = detailFromAweme(detail, id);
    registerMediaUrls(normalized);
    return normalized;
  } finally {
    try { pageWs?.close(); } catch { /* 忽略详情页连接关闭异常 */ }
    if (targetId) {
      try { await cdpCall(browser, 'Target.closeTarget', { targetId }); } catch { /* 详情页可能已经自行关闭 */ }
    }
    browser.close();
  }
}

// 优先走同源接口，只有页面状态或风控导致失败时才加载独立详情页。
async function fetchVideoDetail(id) {
  // 先复用已登录页面请求详情，失败时再通过独立标签页回退。
  try {
    return await fetchVideoDetailFromCurrentPage(id);
  } catch (error) {
    console.warn(`直接请求作品 ${id} 详情失败，切换到详情页回退：${error.message}`);
    const request = detailFallbackQueue.then(() => fetchVideoDetailViaNewTab(id));
    detailFallbackQueue = request.catch(() => {});
    return request;
  }
}

// 相同作品的并发点击共享一次请求，避免重复创建 Chrome 标签页。
async function getVideoDetail(id) {
  if (!detailRequests.has(id)) {
    const request = fetchVideoDetail(id).finally(() => detailRequests.delete(id));
    detailRequests.set(id, request);
  }
  return detailRequests.get(id);
}

// 详情接口偶尔会省略作者或播放统计；仅用有效的新值覆盖列表快照，避免加速请求后信息变少。
function mergeVideoDetail(base, detail) {
  // 合并列表快照和详情结果，保留列表中已获取的展示字段。
  const merged = { ...base, ...detail };
  const isEmpty = value => value === undefined || value === null || value === '' ||
    (typeof value === 'number' && value === 0) || (Array.isArray(value) && value.length === 0);
  for (const [key, value] of Object.entries(base)) {
    if (isEmpty(detail[key]) && !isEmpty(value)) merged[key] = value;
  }
  return merged;
}

async function syncFromChrome(accountId, checkpoints, onProgress = () => {}) {
  // 通过 Chrome 调试协议执行页面脚本，同步喜欢和收藏列表。
  // 复用用户当前已登录的抖音页面，服务端不读取或保存 Cookie。
  const tabs = await (await fetch(`${activeCdp}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const tab = tabs.find(t => t.type === 'page' && /douyin\.com\/user\/self/.test(t.url));
  if (!tab) throw new Error('未找到抖音个人页。请使用带 --remote-debugging-port=9222 的 Chrome 打开页面。');
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    let batchError = null;
    // 响应体要在 loadingFinished 后立即读取，Chrome 可能很快回收旧响应。
    ws.responseUrls = new Map();
    ws.responseBodyPromises = [];
    ws.skipResponseBodies = new Set();
    ws.onEvent = event => {
      if (event.method === 'Runtime.consoleAPICalled') {
        const values = event.params.args.map(arg => arg.value);
        if (values[0] === '__DY_SYNC_BATCH__' && ['like', 'collect'].includes(values[1]) && !batchError) {
          try {
            const batch = JSON.parse(values[2]);
            if (!Array.isArray(batch)) throw new Error('invalid batch');
            library.savePage(accountId, values[1], batch, JSON.parse(values[3]));
            onProgress({ phase: values[1], dataChanged: true });
          } catch (error) {
            batchError = new Error(`同步数据保存失败：${error.message}`);
            try { ws.send(JSON.stringify({ id: ++ws.nextId, method: 'Runtime.terminateExecution' })); } catch {}
          }
        }
        if (values[0] === '__DY_SYNC_FALLBACK__' && ['like', 'collect'].includes(values[1])) {
          ws.syncActivity?.();
          onProgress({ phase: values[1], fallbackPhase: values[1], fallbackReason: String(values[2] || '接口不可用'), message: '接口分页失败，正在尝试页面滚动' });
        }
        if (values[0] === '__DY_SYNC_PROGRESS__') {
          ws.syncActivity?.();
          const [, phase, current, total] = values;
          const ratio = Math.min(1, Math.max(0, Number(current) / Number(total)));
          onProgress({
            phase,
            progress: Math.round(phase === 'like' ? ratio * 65 : 65 + ratio * 35),
            pages: Number(current) || 0,
            message: `正在${values[5] === 'scroll' ? '滚动加载' : '加载'}${phase === 'like' ? '喜欢' : '收藏'}列表（已保存 ${library.list(accountId, phase, { pageSize: 1 }).totalItems} 条）`
          });
        }
      }
      if (event.method === 'Network.requestWillBeSent' && /\/aweme\/v1\/web\/(?:aweme\/(favorite|listcollection)|collects\/video\/list)\//.test(event.params.request.url)) {
        const request = event.params.request;
        const query = new URL(request.url).searchParams;
        const directFavorite = /\/aweme\/favorite\//.test(request.url) && query.get('count') === '50';
        const directCollection = /\/aweme\/listcollection\//.test(request.url) && request.method === 'POST' && /(?:^|&)count=10(?:&|$)/.test(request.postData || '');
        if (directFavorite || directCollection) ws.skipResponseBodies.add(event.params.requestId);
      }
      // 只关注喜欢/收藏列表接口，并统计请求页数供进度条显示。
      if (event.method === 'Network.responseReceived' && /\/aweme\/v1\/web\/(?:aweme\/(favorite|listcollection)|collects\/video\/list)\//.test(event.params.response.url)) {
        ws.responseUrls.set(event.params.requestId, event.params.response.url);
        onProgress({ page: /\/aweme\/favorite\//.test(event.params.response.url) ? 'like' : 'collect' });
      }
      if (event.method === 'Network.loadingFinished' && ws.responseUrls.has(event.params.requestId) && !ws.skipResponseBodies.has(event.params.requestId)) {
        const requestId = event.params.requestId;
        const bodyPromise = cdpCall(ws, 'Network.getResponseBody', { requestId }).then(body => {
          let data;
          try { data = JSON.parse(body.body); } catch { return; }
          const source = /\/aweme\/favorite\//.test(ws.responseUrls.get(requestId)) ? 'like' : 'collect';
          if (!batchError && Array.isArray(data.aweme_list)) {
            try { library.savePage(accountId, source, data.aweme_list.map(item => itemFromAweme(item, source)), null); onProgress({ dataChanged: true }); }
            catch (error) { batchError = new Error(`同步数据保存失败：${error.message}`); }
          }
        }).catch(() => {});
        ws.responseBodyPromises.push(bodyPromise);
      }
    };
    await cdpCall(ws, 'Network.enable', { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024 });
    await cdpCall(ws, 'Runtime.enable');
    // 等待页面脚本完成，并取回它记录的 DOM 顺序。
    const evaluation = await evaluateSyncScript(ws, pageScript(checkpoints));
    if (batchError) throw batchError;
    if (evaluation.exceptionDetails) throw new Error(evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || '同步脚本执行失败');
    const pageResult = evaluation.result?.value || {};
    // 页面脚本已经等待接口返回；只留出短暂时间让最后一个 loadingFinished 事件入队。
    // 通过循环排空当前 Promise，避免固定等待数秒，也避免遗漏并发响应体。
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const pending = ws.responseBodyPromises.slice();
      await Promise.allSettled(pending);
      if (pending.length === ws.responseBodyPromises.length) {
        await new Promise(resolve => setTimeout(resolve, 80));
        if (pending.length === ws.responseBodyPromises.length) break;
      }
    }
    if (batchError) throw batchError;
    return { complete: Boolean(pageResult.api?.like && pageResult.api?.collect), syncedAt: new Date().toISOString() };
  } finally { ws.close(); }
}

// 抓取已经打开的指定用户主页。抖音用户主页的作品列表接口会随版本变化，
// 因此这里监听所有可能的用户作品接口，只接收其中包含 aweme_list 的响应。
async function syncUserFromChrome(profileUrl, onProgress = () => {}) {
  const target = new URL(profileUrl);
  const isDouyinHost = hostname => hostname === 'douyin.com' || hostname.endsWith('.douyin.com');
  if (!/^\/user\//.test(target.pathname) || !isDouyinHost(target.hostname)) throw new Error('请输入抖音用户主页链接');
  const tabs = await (await fetch(`${activeCdp}/json/list`, { signal: AbortSignal.timeout(10000) })).json();
  const targetPath = target.pathname.replace(/\/+$/, '');
  let tab = tabs.find(candidate => {
    if (candidate.type !== 'page' || !candidate.url) return false;
    try {
      const current = new URL(candidate.url);
      return isDouyinHost(current.hostname) && current.pathname.replace(/\/+$/, '') === targetPath;
    } catch { return false; }
  });
  let browser;
  let targetId;
  let ws;
  try {
  if (!tab) {
    // 输入链接可能在普通 Chrome 窗口中打开，无法出现在 9222 的标签列表里。
    // 此时复用当前调试 Chrome 的登录环境自动创建一个目标页，避免用户必须手动切换窗口。
    const version = await (await fetch(`${activeCdp}/json/version`)).json();
    browser = await connectCdp(version.webSocketDebuggerUrl);
    ({ targetId } = await cdpCall(browser, 'Target.createTarget', { url: target.href, background: false }));
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const currentTabs = await (await fetch(`${activeCdp}/json/list`)).json();
      tab = currentTabs.find(candidate => candidate.type === 'page' && candidate.id === targetId);
      if (tab) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  if (!tab) throw new Error('无法在调试 Chrome 中打开该用户主页，请确认 9222 端口可用。');
  ws = await connectCdp(tab.webSocketDebuggerUrl);
    ws.responseUrls = new Map();
    ws.responseItems = new Map();
    ws.responseBodyPromises = [];
    ws.skipResponseBodies = new Set();
    ws.onEvent = event => {
      if (event.method === 'Runtime.consoleAPICalled') {
        const values = event.params.args.map(arg => arg.value);
        if (values[0] === '__DY_PROFILE_PROGRESS__') {
          ws.syncActivity?.();
          const current = Number(values[1]) || 0;
          const total = Number(values[2]) || 240;
          const count = Number(values[3]) || 0;
          onProgress({ progress: Math.min(99, Math.round(current * 100 / total)), pages: current, count, message: `正在加载用户作品（已发现 ${count} 条）` });
        }
      }
      if (event.method === 'Network.requestWillBeSent' && /\/aweme\/v1\/web\/aweme\/post\//i.test(event.params.request.url)) {
        const headers = event.params.request.headers || {};
        if (headers['x-dy-sync-api'] === 'direct' || headers['X-Dy-Sync-Api'] === 'direct') ws.skipResponseBodies.add(event.params.requestId);
      }
      if (event.method === 'Network.responseReceived' && /\/aweme\/v1\/web\/aweme\/post\//i.test(event.params.response.url)) {
        ws.responseUrls.set(event.params.requestId, event.params.response.url);
      }
      if (event.method === 'Network.loadingFinished' && ws.responseUrls.has(event.params.requestId) && !ws.skipResponseBodies.has(event.params.requestId)) {
        const requestId = event.params.requestId;
        const bodyPromise = cdpCall(ws, 'Network.getResponseBody', { requestId }).then(body => {
          try {
            const data = JSON.parse(body.body);
            for (const item of data?.aweme_list || []) {
              const normalized = itemFromAweme(item, 'user');
              if (/^\d+$/.test(normalized.id) && !ws.responseItems.has(normalized.id)) ws.responseItems.set(normalized.id, normalized);
            }
          } catch { /* 忽略已经被 Chrome 回收或不是 JSON 的响应 */ }
        }).catch(() => {});
        ws.responseBodyPromises.push(bodyPromise);
      }
    };
    await cdpCall(ws, 'Network.enable', { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 5 * 1024 * 1024 });
    await cdpCall(ws, 'Runtime.enable');
    // 新建标签页仍处于导航阶段时，Runtime.evaluate 可能因为执行上下文被替换而失败。
    // 等待短暂稳定并重试，避免用户第一次加载必须手动再点一次。
    let evaluation = null;
    let lastEvaluationError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        evaluation = await evaluateSyncScript(ws, userPageScript);
        const exceptionText = evaluation?.exceptionDetails?.exception?.description
          || evaluation?.exceptionDetails?.text
          || '';
        if (!evaluation?.exceptionDetails) break;
        lastEvaluationError = new Error(exceptionText || '用户主页脚本执行失败');
        if (!/execution context was destroyed|cannot find context|context.*destroyed/i.test(exceptionText)) throw lastEvaluationError;
      } catch (error) {
        lastEvaluationError = error;
        if (!/execution context was destroyed|cannot find context|context.*destroyed/i.test(String(error?.message || error))) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    if (!evaluation || evaluation.exceptionDetails) throw lastEvaluationError || new Error('用户主页脚本执行失败');
    const pageResult = evaluation.result?.value || {};
    if (pageResult.api && Array.isArray(pageResult.items) && pageResult.items.length) {
      onProgress({ progress: 100, pages: 0, count: pageResult.items.length, message: 'User works loaded (' + pageResult.items.length + ')' });
      return { items: pageResult.items, profileUrl: target.href, syncedAt: new Date().toISOString() };
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const pending = ws.responseBodyPromises.slice();
      await Promise.allSettled(pending);
      if (pending.length === ws.responseBodyPromises.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (pending.length === ws.responseBodyPromises.length) break;
      }
    }
    const items = new Map();
    for (const item of pageResult.items || []) {
      if (item?.id && !items.has(item.id)) items.set(item.id, { ...item, source: 'user' });
    }
    for (const [id, item] of ws.responseItems) if (!items.has(id)) items.set(id, item);
    if (!items.size) throw new Error('没有从该用户主页获取到作品，请确认页面已加载完成且账号可以访问作品列表。');
    onProgress({ progress: 100, pages: 0, count: items.size, message: `用户作品加载完成：${items.size} 条` });
    return { items: [...items.values()], profileUrl: target.href, syncedAt: new Date().toISOString() };
  } finally {
    ws?.close();
    if (targetId && browser) {
      try { await cdpCall(browser, 'Target.closeTarget', { targetId }, 3000); } catch { /* 标签页可能已关闭。 */ }
    }
    browser?.close();
  }
}

// 指定用户作品暂存在内存；喜欢和收藏保存在 SQLite 中。
let latestData = { like: [], collect: [], user: [], syncedAt: null, userProfileUrl: '' };
let syncState = { running: false, progress: 0, phase: null, message: '等待同步', likePages: 0, collectPages: 0, error: null };
let userSyncState = { running: false, progress: 0, pages: 0, count: 0, message: '等待加载用户作品', profileUrl: '', error: null };

async function loginPageStatus(refresh = false, endpoint = activeCdp, currentAccountId = activeAccountId) {
  const tabs = await (await fetch(`${endpoint}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page' && /douyin\.com\/user\/self/.test(t.url));
  if (!tab) throw new Error('未找到抖音个人页，请检查无头 Chrome 是否已启动');
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    if (refresh) {
      await cdpCall(ws, 'Page.reload');
      return { status: 'loading' };
    }
    const result = await cdpCall(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const text = document.body?.innerText || '';
        const verification = document.querySelector('#uc-second-verify article');
        if (verification && verification.getClientRects().length) {
          const r = verification.getBoundingClientRect();
          return { status: 'verification', rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }
        const qr = [...document.querySelectorAll('#douyin_login_comp_scan_code_qrcode img, img[aria-label="二维码"]')].find(el => el.getClientRects().length);
        const src = qr?.getAttribute('src') || '';
        const qrCode = /^data:image\\/png;base64,/.test(src) ? src : '';
        if (!qr) {
          const otherAccount = [...document.querySelectorAll('p, button, a')].find(el =>
            el.getClientRects().length && el.textContent.trim() === '登录其他账号');
          if (otherAccount) {
            otherAccount.click();
            return { status: 'login', qrCode: '', expired: false };
          }
        }
        if (qr || text.includes('未登录') || text.includes('扫码登录')) {
          return { status: 'login', qrCode, expired: /二维码.{0,8}(过期|失效)|点击刷新/.test(text) };
        }
        if (text.includes('获赞') && text.includes('作品') && text.includes('喜欢')) {
          const user = window.userInfoStore?.curLoginUserInfo;
          const profile = user?.nickname ? {
            nickname: String(user.nickname), signature: String(user.desc || ''),
            identity: String(user.secUid || user.sec_uid || user.secUserId || user.sec_user_id || user.uid || user.userId || ''),
            avatar: String(user.avatar300Url || user.avatarUrl || ''),
            following: user.followingCount, followers: user.followerCount,
            likes: user.totalFavorited
          } : null;
          return { status: 'logged_in', profile };
        }
        return { status: 'loading' };
      })()`,
      returnByValue: true
    });
    if (result.exceptionDetails) throw new Error('无法读取抖音登录状态');
    const status = result.result?.value || { status: 'loading' };
    if (status.profile?.avatar) {
      const avatar = status.profile.avatar;
      if (isDouyinMediaUrl(avatar)) {
        mediaUrls.set(avatar, Date.now() + 15 * 60 * 1000);
        status.profile.avatar = `/api/video/stream?kind=image&url=${encodeURIComponent(avatar)}`;
      } else status.profile.avatar = '';
    }
    if (status.status === 'logged_in' && status.profile && currentAccountId === activeAccountId) {
      const account = accounts.find(item => item.id === currentAccountId);
      if (account && (account.name !== status.profile.nickname || account.avatar !== status.profile.avatar || account.identity !== status.profile.identity || account.signedOut || account.placeholder)) {
        account.name = status.profile.nickname;
        account.avatar = status.profile.avatar;
        account.signedOut = false;
        account.identity = status.profile.identity || account.identity;
        delete account.placeholder;
        await saveAccounts();
      }
    }
    if (status.status === 'verification') {
      const clip = { ...status.rect, scale: 1 };
      const screenshot = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png', clip });
      return { status: 'verification', image: `data:image/png;base64,${screenshot.data}` };
    }
    if (status.status === 'login' && !status.qrCode) {
      const pending = await cdpCall(ws, 'Runtime.evaluate', { expression: "document.body?.innerText.includes('需在手机上进行确认')", returnByValue: true });
      if (pending.result?.value) status.status = 'confirm_phone';
    }
    return status;
  } finally { ws.close(); }
}

async function clickLoginVerification(x, y, endpoint = activeCdp) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) throw new Error('无效的验证操作');
  const tabs = await (await fetch(`${endpoint}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page' && /douyin\.com\/user\/self/.test(t.url));
  if (!tab) throw new Error('未找到抖音个人页');
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    const result = await cdpCall(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const panel = document.querySelector('#uc-second-verify article');
        if (!panel || !panel.getClientRects().length) return false;
        const r = panel.getBoundingClientRect();
        const target = document.elementFromPoint(r.x + r.width * ${x}, r.y + r.height * ${y});
        if (!target || !panel.contains(target)) return false;
        const input = target.closest('input, textarea, [contenteditable="true"]');
        if (input) input.focus();
        let clickable = target;
        while (clickable && typeof clickable.click !== 'function') clickable = clickable.parentElement;
        if (!clickable || !panel.contains(clickable)) return false;
        clickable.click();
        return true;
      })()`,
      returnByValue: true
    });
    if (!result.result?.value) throw new Error('验证页面已变化，请重试');
  } finally { ws.close(); }
}

async function typeLoginVerification({ text, key, selectAll }, endpoint = activeCdp) {
  const allowedKeys = { Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, Enter: 13 };
  if (typeof text === 'string') {
    if (!text || text.length > 256 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('输入内容无效');
  } else if (selectAll !== true && !Object.hasOwn(allowedKeys, key)) {
    throw new Error('不支持的按键');
  }
  const tabs = await (await fetch(`${endpoint}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page' && /douyin\.com\/user\/self/.test(t.url));
  if (!tab) throw new Error('未找到抖音个人页');
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    const focused = await cdpCall(ws, 'Runtime.evaluate', {
      expression: `(() => { const el = document.activeElement; return !!(el?.closest('#uc-second-verify article') && (el.matches('input:not([type="hidden"]):not([disabled]), textarea:not([disabled])') || el.isContentEditable)); })()`,
      returnByValue: true
    });
    if (!focused.result?.value) throw new Error('请先点击验证页面中的输入框');
    if (typeof text === 'string') {
      await cdpCall(ws, 'Input.insertText', { text });
    } else {
      const params = selectAll ? { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 } : { key, windowsVirtualKeyCode: allowedKeys[key] };
      await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await cdpCall(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    }
  } finally { ws.close(); }
}

async function logoutFromChrome() {
  if (syncState.running || userSyncState.running || detailRequests.size || [...downloadJobs.values()].some(job => job.status === 'running' || job.runningPromise && job.items.some(item => item.status === 'downloading'))) {
    throw new Error('请先等待同步或下载完成，或暂停下载后再退出');
  }
  const tabs = await (await fetch(`${activeCdp}/json/list`)).json();
  const tab = tabs.find(t => t.type === 'page' && /douyin\.com\/user\/self/.test(t.url));
  if (!tab) throw new Error('未找到抖音个人页');
  const ws = await connectCdp(tab.webSocketDebuggerUrl);
  try {
    const result = await cdpCall(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const label = [...document.querySelectorAll('p, button, a')].find(el => el.textContent.trim() === '退出登录' && el.children.length === 0);
        if (!label) return false;
        (label.closest('button, a') || label.parentElement).click();
        return true;
      })()`,
      returnByValue: true
    });
    if (!result.result?.value) throw new Error('未找到抖音退出登录入口，请稍后重试');
    let confirmed = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        if (!confirmed) confirmed = Boolean((await cdpCall(ws, 'Runtime.evaluate', {
          expression: `(() => {
            const dialogs = [...document.querySelectorAll('[role="dialog"], dialog')].filter(el => el.getClientRects().length && /退出登录/.test(el.innerText));
            const button = dialogs.flatMap(el => [...el.querySelectorAll('button')]).find(el => /^(确认退出|确认|退出登录)$/.test(el.innerText.trim()));
            if (!button) return false;
            button.click();
            return true;
          })()`,
          returnByValue: true
        })).result?.value);
      } catch { /* 导航期间执行上下文可能暂时不可用。 */ }
      const status = await loginPageStatus().catch(() => null);
      if (status && ['login', 'confirm_phone', 'verification'].includes(status.status)) {
        const account = accounts.find(item => item.id === activeAccountId);
        if (account) { account.signedOut = true; await saveAccounts(); }
        library.clear(activeAccountId);
        latestData = { like: [], collect: [], user: [], syncedAt: null, userProfileUrl: '' };
        syncState = { running: false, progress: 0, phase: null, message: '等待同步', likePages: 0, collectPages: 0, error: null };
        userSyncState = { running: false, progress: 0, pages: 0, count: 0, message: '等待加载用户作品', profileUrl: '', error: null };
        return;
      }
    }
    throw new Error('未能确认退出登录，请重试');
  } finally { ws.close(); }
}

async function switchAccount(id) {
  if (accountSwitching) throw new Error('正在切换账号，请稍候');
  if (!accounts.some(account => account.id === id)) throw new Error('账号不存在');
  if (id === activeAccountId) return;
  if (syncState.running || userSyncState.running || detailRequests.size || [...downloadJobs.values()].some(job => job.status === 'running' || job.runningPromise && job.items.some(item => item.status === 'downloading'))) {
    throw new Error('请先等待同步、作品加载或下载完成，或暂停下载后再切换账号');
  }
  accountSwitching = true;
  const previousId = activeAccountId;
  const previousEndpoint = activeCdp;
  let closedPrevious = false;
  let endpoint;
  try {
    closedPrevious = await closeAccountBrowser(previousId, previousEndpoint);
    endpoint = await accountEndpoint(id);
    const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error('无法连接账号浏览器');
    activeAccountId = id;
    try { await saveAccounts(); } catch (error) { activeAccountId = previousId; throw error; }
    activeCdp = endpoint;
    latestData = { like: [], collect: [], user: [], syncedAt: null, userProfileUrl: '' };
    syncState = { running: false, progress: 0, phase: null, message: '等待同步', likePages: 0, collectPages: 0, error: null };
    userSyncState = { running: false, progress: 0, pages: 0, count: 0, message: '等待加载用户作品', profileUrl: '', error: null };
  } catch (error) {
    if (endpoint && endpoint !== previousEndpoint) await closeAccountBrowser(id, endpoint).catch(() => {});
    if (closedPrevious) {
      try { activeCdp = await accountEndpoint(previousId); }
      catch (restoreError) { error.message += `；恢复原账号浏览器失败：${restoreError.message}`; }
    }
    throw error;
  } finally { accountSwitching = false; }
}

function accountBusy() {
  return syncState.running || userSyncState.running || detailRequests.size || [...downloadJobs.values()].some(job => job.status === 'running' || job.runningPromise && job.items.some(item => item.status === 'downloading'));
}

async function startPendingAccount() {
  if (pendingAccount || accountBusy()) throw new Error('请先结束账号登录、同步或下载任务');
  const previousId = activeAccountId;
  let previousClosed = false;
  const candidate = { id: randomUUID(), endpoint: null, previousId, previousClosed: false };
  try {
    const currentStatus = await loginPageStatus().catch(() => null);
    const current = accounts.find(account => account.id === previousId);
    if (current && !current.identity && current.name === '默认账号' && currentStatus && currentStatus.status !== 'logged_in') current.placeholder = true;
    previousClosed = await closeAccountBrowser(previousId, activeCdp);
    candidate.previousClosed = previousClosed;
    for (const account of accounts) {
      if (account.id === previousId || account.identity || account.placeholder) continue;
      const endpoint = await accountEndpoint(account.id);
      try {
        const status = await loginPageStatus(false, endpoint, account.id);
        if (status.status === 'logged_in' && status.profile?.identity) {
          account.identity = status.profile.identity;
          await saveAccounts();
        }
      } finally { await closeAccountBrowser(account.id, endpoint); }
    }
    candidate.endpoint = await accountEndpoint(candidate.id);
    pendingAccount = candidate;
  } catch (error) {
    if (candidate.endpoint) await closeAccountBrowser(candidate.id, candidate.endpoint).catch(() => {});
    if (previousClosed) await accountEndpoint(previousId).then(endpoint => { activeCdp = endpoint; }).catch(restore => { error.message += `；恢复原账号失败：${restore.message}`; });
    throw error;
  }
}

async function cancelPendingAccount() {
  if (!pendingAccount) return;
  const pending = pendingAccount;
  await closeAccountBrowser(pending.id, pending.endpoint);
  if (pending.previousClosed) activeCdp = await accountEndpoint(pending.previousId);
  pendingAccount = null;
  await fs.rm(accountProfile(pending.id), { recursive: true, force: true });
}

async function pendingAccountStatus(refresh = false) {
  if (!pendingAccount) throw new Error('登录已结束，请重新添加账号');
  const pending = pendingAccount;
  const status = await loginPageStatus(refresh, pending.endpoint, pending.id);
  if (status.status !== 'logged_in' || !status.profile) return status;
  if (!status.profile.identity) return { status: 'identity_error', error: '无法获取抖音账号标识，请取消后重试' };
  const unknown = accounts.find(account => !account.identity && !account.placeholder);
  if (unknown) return { status: 'identity_error', error: `无法确认已有账号“${unknown.name || '未命名账号'}”的身份，请切换到该账号确认登录后重试` };
  if (accounts.some(account => account.identity === status.profile.identity)) return { status: 'duplicate', error: '该抖音账号已在列表中，请直接切换账号' };
  const account = { id: pending.id, name: status.profile.nickname, avatar: status.profile.avatar || '', identity: status.profile.identity };
  const previousId = activeAccountId;
  accounts.push(account);
  activeAccountId = account.id;
  try { await saveAccounts(); } catch (error) { accounts.pop(); activeAccountId = previousId; throw error; }
  activeCdp = pending.endpoint;
  pendingAccount = null;
  latestData = { like: [], collect: [], user: [], syncedAt: null, userProfileUrl: '' };
  syncState = { running: false, progress: 0, phase: null, message: '等待同步', likePages: 0, collectPages: 0, error: null };
  userSyncState = { running: false, progress: 0, pages: 0, count: 0, message: '等待加载用户作品', profileUrl: '', error: null };
  return { ...status, added: true };
}

async function deleteAccount(id) {
  const account = accounts.find(item => item.id === id);
  if (!account || account.placeholder) throw new Error('账号不存在');
  if (pendingAccount || accountBusy()) throw new Error('请先结束账号登录、同步或下载任务');
  if (id === 'default') {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(1000) })).json();
      if (tabs.some(tab => tab.type === 'page' && /douyin\.com\/user\/self/.test(tab.url))) throw new Error('默认账号浏览器由外部启动，请先关闭该浏览器后删除');
    } catch (error) { if (error.message.includes('外部启动')) throw error; }
  }
  if (id === activeAccountId) {
    if (activeCdp === 'http://127.0.0.1:9222') throw new Error('当前浏览器由外部启动，请先切换账号后删除');
    let next = accounts.find(item => item.id !== id);
    if (!next) {
      next = { id: randomUUID(), name: '默认账号', avatar: '', placeholder: true };
      accounts.push(next);
    }
    try { await switchAccount(next.id); } catch (error) { if (next.placeholder) accounts = accounts.filter(item => item !== next); throw error; }
  }
  const endpoint = await existingAccountEndpoint(id);
  if (endpoint) await closeAccountBrowser(id, endpoint);
  const previous = accounts;
  accounts = accounts.filter(item => item.id !== id);
  try { await saveAccounts(); } catch (error) { accounts = previous; throw error; }
  library.clear(id);
  await fs.rm(accountProfile(id), { recursive: true, force: true });
}

// 后台启动同步，避免 HTTP 请求一直等待页面滚动完成。
function startSync() {
  // 防止重复启动同步，并在后台任务完成后更新最新数据缓存。
  if (syncState.running) return;
  const accountId = activeAccountId;
  const checkpoints = library.begin(accountId);
  syncState = { running: true, progress: 0, phase: 'like', message: '正在连接抖音页面', likePages: checkpoints.like.pages, collectPages: checkpoints.collect.pages, version: 0, error: null };
  syncFromChrome(accountId, checkpoints, update => {
    if (update.dataChanged) { syncState.version++; delete update.dataChanged; }
    if (update.phase && Number.isFinite(update.pages) && update.pages > 0) {
      // 只采用页面脚本报告的分页数，避免页面自身的预加载请求污染进度。
      syncState[`${update.phase}Pages`] = update.pages;
    }
    if (update.phase) Object.assign(syncState, update);
  }).then(data => {
    syncState = { ...syncState, running: false, progress: data.complete ? 100 : syncState.progress, phase: data.complete ? 'done' : 'partial', partial: !data.complete, message: data.complete ? '同步完成' : '已保存部分作品，接口未完整同步，可再次尝试继续', syncedAt: data.syncedAt };
  }).catch(error => {
    syncState = { ...syncState, running: false, message: '同步失败', error: error.message };
  });
}

function startUserSync(profileUrl) {
  if (userSyncState.running) return;
  userSyncState = { running: true, progress: 0, pages: 0, count: 0, message: '正在连接用户主页', profileUrl, error: null };
  syncUserFromChrome(profileUrl, update => {
    userSyncState = { ...userSyncState, ...update };
  }).then(data => {
    latestData.user = data.items;
    latestData.userProfileUrl = data.profileUrl;
    userSyncState = { ...userSyncState, running: false, progress: 100, count: data.items.length, message: `用户作品加载完成：${data.items.length} 条` };
  }).catch(error => {
    userSyncState = { ...userSyncState, running: false, message: '用户作品加载失败', error: error.message };
  });
}

const server = http.createServer(async (req, res) => {
  try {
    // 启动和查询同步状态的 API；静态文件请求在下面统一处理。
    const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await access(req, res, requestUrl)) return;
    if (accountSwitching && requestUrl.pathname.startsWith('/api/')) return send(res, 409, JSON.stringify({ error: '正在处理账号，请稍候' }));
    if (pendingAccount && requestUrl.pathname.startsWith('/api/') && !requestUrl.pathname.startsWith('/api/accounts/pending') && requestUrl.pathname !== '/api/accounts' && !requestUrl.pathname.startsWith('/api/video/stream')) return send(res, 409, JSON.stringify({ error: '请先完成或取消添加账号' }));
    if (requestUrl.pathname === '/api/accounts' && req.method === 'GET') {
      for (const account of accounts) {
        if (account.avatar) {
          try { const value = new URL(account.avatar, 'http://localhost').searchParams.get('url'); if (isDouyinMediaUrl(value)) mediaUrls.set(value, Date.now() + 15 * 60 * 1000); } catch {}
        }
      }
      return send(res, 200, JSON.stringify({ activeAccountId, accounts: accounts.filter(account => !account.placeholder) }));
    }
    if (requestUrl.pathname === '/api/accounts' && req.method === 'POST') {
      accountSwitching = true;
      try { await startPendingAccount(); } finally { accountSwitching = false; }
      return send(res, 201, JSON.stringify({ pending: true }));
    }
    if (requestUrl.pathname === '/api/accounts/pending' && req.method === 'DELETE') {
      accountSwitching = true;
      try { await cancelPendingAccount(); } finally { accountSwitching = false; }
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (requestUrl.pathname === '/api/accounts/pending/status' && req.method === 'GET') {
      accountSwitching = true;
      try { return send(res, 200, JSON.stringify(await pendingAccountStatus())); } finally { accountSwitching = false; }
    }
    if (requestUrl.pathname === '/api/accounts/pending/refresh' && req.method === 'POST') {
      if (!pendingAccount) throw new Error('登录已结束，请重新添加账号');
      await loginPageStatus(true, pendingAccount.endpoint, pendingAccount.id);
      return send(res, 202, JSON.stringify({ status: 'loading' }));
    }
    if (requestUrl.pathname === '/api/accounts/pending/verification/click' && req.method === 'POST') {
      if (!pendingAccount) throw new Error('登录已结束，请重新添加账号');
      const { x, y } = await readJsonBody(req);
      await clickLoginVerification(x, y, pendingAccount.endpoint);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (requestUrl.pathname === '/api/accounts/pending/verification/type' && req.method === 'POST') {
      if (!pendingAccount) throw new Error('登录已结束，请重新添加账号');
      await typeLoginVerification(await readJsonBody(req), pendingAccount.endpoint);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (requestUrl.pathname === '/api/accounts' && req.method === 'DELETE') {
      const { id } = await readJsonBody(req);
      await deleteAccount(id);
      return send(res, 200, JSON.stringify({ activeAccountId }));
    }
    if (requestUrl.pathname === '/api/accounts/switch' && req.method === 'POST') {
      const { id } = await readJsonBody(req);
      await switchAccount(id);
      return send(res, 200, JSON.stringify({ activeAccountId, accounts }));
    }
    if (requestUrl.pathname === '/api/login/status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await loginPageStatus()));
    }
    if (requestUrl.pathname === '/api/login/logout' && req.method === 'POST') {
      accountSwitching = true;
      try { await logoutFromChrome(); } finally { accountSwitching = false; }
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (requestUrl.pathname === '/api/login/refresh' && req.method === 'POST') {
      await loginPageStatus(true);
      return send(res, 202, JSON.stringify({ status: 'loading' }));
    }
    if (requestUrl.pathname === '/api/login/verification/click' && req.method === 'POST') {
      const { x, y, accountId } = await readJsonBody(req);
      if (accountId && accountId !== activeAccountId) return send(res, 409, JSON.stringify({ error: '账号已切换，请重新操作' }));
      await clickLoginVerification(x, y);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (requestUrl.pathname === '/api/login/verification/type' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (body.accountId && body.accountId !== activeAccountId) return send(res, 409, JSON.stringify({ error: '账号已切换，请重新操作' }));
      await typeLoginVerification(body);
      return send(res, 200, JSON.stringify({ ok: true }));
    }
    if (req.url === '/api/sync/start' && req.method === 'POST') {
      startSync();
      return send(res, 202, JSON.stringify(syncState));
    }
    if (requestUrl.pathname === '/api/profile/sync' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let profileUrl;
      try { profileUrl = new URL(String(body.url || '')).href; } catch { return send(res, 400, JSON.stringify({ error: '请输入有效的用户主页链接' })); }
      const parsedProfileUrl = new URL(profileUrl);
      if (!/^\/user\//.test(parsedProfileUrl.pathname) || !(parsedProfileUrl.hostname === 'douyin.com' || parsedProfileUrl.hostname.endsWith('.douyin.com'))) return send(res, 400, JSON.stringify({ error: '链接必须是抖音用户主页地址' }));
      startUserSync(profileUrl);
      return send(res, 202, JSON.stringify(userSyncState));
    }
    if (requestUrl.pathname === '/api/profile/sync/status' && req.method === 'GET') {
      return send(res, 200, JSON.stringify({ ...userSyncState, data: userSyncState.running ? null : latestData.user, userProfileUrl: latestData.userProfileUrl }));
    }
    if (req.url === '/api/sync/status') return send(res, 200, JSON.stringify({ ...syncState, checkpoints: library.checkpoints(activeAccountId) }));
    if (requestUrl.pathname === '/api/library' && req.method === 'GET') {
      const source = requestUrl.searchParams.get('source');
      if (!['like', 'collect'].includes(source)) return send(res, 400, JSON.stringify({ error: '无效的作品类型' }));
      const data = library.list(activeAccountId, source, { page: requestUrl.searchParams.get('page'), pageSize: 24, query: (requestUrl.searchParams.get('query') || '').slice(0, 200), sort: requestUrl.searchParams.get('sort') });
      const counts = Object.fromEntries(['like', 'collect'].map(name => [name, library.list(activeAccountId, name, { pageSize: 1 }).totalItems]));
      return send(res, 200, JSON.stringify({ ...data, counts, checkpoint: library.checkpoints(activeAccountId)[source] }));
    }
    if (req.url === '/api/sync') return send(res, 410, JSON.stringify({ error: '作品列表已改为分页，请使用 /api/library' }));
    if (requestUrl.pathname === '/api/download/jobs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const source = ['like', 'collect', 'user', 'specified'].includes(body.source) ? body.source : 'like';
      const sourceLabels = { like: '喜欢', collect: '收藏', user: '用户', specified: '指定' };
      let sourceItems = ['like', 'collect'].includes(source) ? library.all(activeAccountId, source) : Array.isArray(latestData[source]) ? latestData[source] : [];
      if (source === 'specified') {
        const id = String(body.id || '');
        if (!/^\d+$/.test(id)) return send(res, 400, JSON.stringify({ error: '缺少有效的作品 ID' }));
        // 由服务端获取真实标题和媒体类型，再复用列表下载的命名及保存逻辑。
        sourceItems = [await getVideoDetail(id)];
      }
      const usedFiles = new Set();
      const items = sourceItems.filter(item => /^\d+$/.test(String(item.id)))
        .map(item => {
          const fileBaseName = uniqueDownloadBaseName(item, body.albumMode, usedFiles);
          return {
            id: String(item.id), title: item.title || '', author: item.author || '', fileBaseName,
            mediaType: item.mediaType === 'image' ? 'image' : 'video',
            playUrl: isDouyinMediaUrl(item.playUrl) ? item.playUrl : '',
            qualities: Array.isArray(item.qualities) ? item.qualities : [],
            images: Array.isArray(item.images) ? item.images.filter(isDouyinMediaUrl) : [],
            imageMedia: Array.isArray(item.imageMedia) ? item.imageMedia : undefined,
            livePhotoCount: Number(item.livePhotoCount) || 0,
            status: 'pending', bytes: 0, totalBytes: 0, attempts: 0, error: null, path: ''
          };
        });
      if (!items.length) return send(res, 400, JSON.stringify({ error: `没有可下载的${sourceLabels[source]}作品，请先完成同步` }));
      const job = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        accountId: activeAccountId,
        status: 'pending', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        source, quality: body.quality === 'standard' ? 'standard' : 'highest',
        albumMode: body.albumMode === 'flat' ? 'flat' : 'folder',
        concurrency: Math.min(MAX_DOWNLOAD_CONCURRENCY, Math.max(1, Math.round(Number(body.concurrency) || DOWNLOAD_CONCURRENCY))),
        skipExisting: body.skipExisting !== false, cancelRequested: false, error: null, items
      };
      if (deletingDownloadedFiles) return send(res, 409, JSON.stringify({ error: '正在删除文件，请稍候再开始下载' }));
      downloadJobs.set(job.id, job);
      await queueDownloadStateSave();
      startDownloadJob(job);
      return send(res, 202, JSON.stringify(publicDownloadJob(job, { includeItems: requestUrl.searchParams.get('summary') !== '1' })));
    }
    if (requestUrl.pathname === '/api/download/files' && req.method === 'GET') {
      return send(res, 200, JSON.stringify(await listDownloadedFiles()));
    }
    if (requestUrl.pathname === '/api/download/files' && req.method === 'DELETE') {
      if (deletingDownloadedFiles) return send(res, 409, JSON.stringify({ error: '正在删除文件，请稍候' }));
      if (downloadRunsInFlight || [...downloadJobs.values()].some(job => ['running', 'pending'].includes(job.status) || job.items.some(item => item.status === 'downloading'))) {
        return send(res, 409, JSON.stringify({ error: '请先暂停下载并等待当前文件停止后再删除' }));
      }
      deletingDownloadedFiles = true;
      try {
        const body = await readJsonBody(req);
        if (body.all === true) return send(res, 200, JSON.stringify({ deleted: await deleteAllDownloadedFiles() }));
        await deleteDownloadedFile(body.path);
        return send(res, 200, JSON.stringify({ deleted: 1 }));
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return send(res, 404, JSON.stringify({ error: '文件不存在' }));
        if (error.status) return send(res, error.status, JSON.stringify({ error: error.message }));
        throw error;
      } finally { deletingDownloadedFiles = false; }
    }
    if (requestUrl.pathname === '/api/download/file' && req.method === 'GET') {
      return sendDownloadedFile(res, requestUrl.searchParams.get('path'));
    }
    if (requestUrl.pathname === '/api/download/jobs' && req.method === 'GET') {
      const jobs = [...downloadJobs.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return send(res, 200, JSON.stringify(jobs.slice(0, 20).map(job => publicDownloadJob(job, { includeItems: requestUrl.searchParams.get('summary') !== '1' }))));
    }
    if (requestUrl.pathname.startsWith('/api/download/jobs/') && req.method === 'GET') {
      const id = requestUrl.pathname.split('/').pop();
      const job = downloadJobs.get(id);
      if (!job) return send(res, 404, JSON.stringify({ error: '下载任务不存在' }));
      return send(res, 200, JSON.stringify(publicDownloadJob(job, { includeItems: requestUrl.searchParams.get('summary') !== '1' })));
    }
    if (requestUrl.pathname.startsWith('/api/download/jobs/') && req.method === 'POST') {
      const match = requestUrl.pathname.match(/^\/api\/download\/jobs\/([^/]+)\/(pause|resume|cancel|retry-failed)$/);
      if (!match) return send(res, 404, JSON.stringify({ error: '不支持的任务操作' }));
      const [, id, action] = match;
      const job = downloadJobs.get(id);
      if (!job) return send(res, 404, JSON.stringify({ error: '下载任务不存在' }));
      if (deletingDownloadedFiles && ['resume', 'retry-failed'].includes(action)) return send(res, 409, JSON.stringify({ error: '正在删除文件，请稍候再继续下载' }));
      if (['resume', 'retry-failed'].includes(action) && (job.accountId || 'default') !== activeAccountId) return send(res, 409, JSON.stringify({ error: '请先切换到创建此任务的账号' }));
      if (action === 'pause') {
        if (job.status === 'running') job.status = 'paused';
      } else if (action === 'resume') {
        if (['paused', 'pending', 'failed', 'completed_with_errors'].includes(job.status)) {
          for (const item of job.items) if (item.status === 'failed') item.status = 'pending';
          startDownloadJob(job);
        }
      } else if (action === 'cancel') {
        job.cancelRequested = true;
        job.status = 'cancelled';
        for (const item of job.items) if (item.status === 'downloading' || item.status === 'pending') item.status = 'cancelled';
        updateDownloadJob(job);
      } else if (action === 'retry-failed') {
        for (const item of job.items) if (item.status === 'failed') item.status = 'pending';
        startDownloadJob(job);
      }
      updateDownloadJob(job);
      return send(res, 200, JSON.stringify(publicDownloadJob(job, { includeItems: requestUrl.searchParams.get('summary') !== '1' })));
    }
    if (requestUrl.pathname === '/api/video/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
      const streamId = requestUrl.searchParams.get('id') || '';
      return proxyMedia(req, res, requestUrl.searchParams.get('url') || '', {
        download: requestUrl.searchParams.get('download') === '1',
        id: /^\d+$/.test(streamId) ? streamId : '',
        kind: requestUrl.searchParams.get('kind') === 'image' ? 'image' : 'video',
        index: requestUrl.searchParams.get('index') || ''
      });
    }
    if (requestUrl.pathname === '/api/video' && req.method === 'GET') {
      const id = requestUrl.searchParams.get('id') || '';
      if (!/^\d+$/.test(id)) return send(res, 400, JSON.stringify({ error: '缺少有效的作品 ID' }));
      // 同步结果存在时沿用列表中的来源信息；即使服务刚重启，也允许按 ID 实时读取详情。
      const base = library.find(activeAccountId, id) || latestData.user.find(item => item.id === id) || { id, source: 'like' };
      // 视频同步结果通常已有播放地址，但性别、地区等作者资料需要详情接口补充。
      const hasVideoMedia = base.mediaType !== 'image'
        && isDouyinMediaUrl(base.playUrl)
        && Array.isArray(base.qualities)
        && base.qualities.length > 0;
      const profile = base.authorProfile || {};
      const hasAuthorDetails = Boolean(
        profile.gender || profile.genderText || profile.age || profile.birthday
        || profile.ipLocation || profile.country || profile.province || profile.city
        || profile.district || profile.location || profile.school || profile.verification
      );
      let detail = base;
      if (!hasVideoMedia || !hasAuthorDetails) {
        try {
          detail = await getVideoDetail(id);
        } catch (error) {
          // 详情请求失败时仍使用同步结果，保证已有播放地址的视频可以继续播放。
          if (!hasVideoMedia) throw error;
        }
      }
      registerMediaUrls(detail);
      const merged = mergeVideoDetail(base, detail);
      const streamUrl = merged.playUrl ? `/api/video/stream?url=${encodeURIComponent(merged.playUrl)}&id=${encodeURIComponent(id)}` : '';
      return send(res, 200, JSON.stringify({ ...merged, streamUrl, source: base.source }));
    }
    const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root)) return send(res, 403, 'Forbidden', 'text/plain');
    const data = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/css; charset=utf-8';
    send(res, 200, data, type);
  } catch (error) { send(res, 500, JSON.stringify({ error: error.message })); }
});
await loadAccounts();
for (const account of accounts) {
  if (account.id === activeAccountId) continue;
  const endpoint = await existingAccountEndpoint(account.id);
  if (endpoint) await closeAccountBrowser(account.id, endpoint).catch(error => console.error(`关闭闲置账号浏览器失败：${error.message}`));
}
activeCdp = await accountEndpoint(activeAccountId);
await loadDownloadJobs();
server.listen(port, host, () => console.log(`Douyin Library Viewer: http://${host}:${port}`));
