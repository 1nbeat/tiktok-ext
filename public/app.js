// 每页展示固定数量，避免内容过多时一次性渲染造成卡顿。
const PAGE_SIZE = 24;
const $ = selector => document.querySelector(selector);

let actionConfirmResolver = null;
function confirmAction(title, message) {
  const modal = $('#action-confirm-modal');
  if (actionConfirmResolver || modal.open) return Promise.resolve(false);
  $('#action-confirm-title').textContent = title;
  $('#action-confirm-message').textContent = message;
  modal.returnValue = '';
  return new Promise(resolve => {
    actionConfirmResolver = resolve;
    modal.showModal();
  });
}
$('#action-confirm-accept').addEventListener('click', () => $('#action-confirm-modal').close('confirm'));
$('#action-confirm-cancel').addEventListener('click', () => $('#action-confirm-modal').close());
$('#action-confirm-close').addEventListener('click', () => $('#action-confirm-modal').close());
$('#action-confirm-modal').addEventListener('close', () => {
  const resolve = actionConfirmResolver;
  actionConfirmResolver = null;
  resolve?.($('#action-confirm-modal').returnValue === 'confirm');
});

function showView(view) {
  if (!['library', 'user', 'downloads', 'account'].includes(view)) return;
  document.querySelectorAll('.workspace-view').forEach(section => { section.hidden = section.id !== `view-${view}`; });
  document.querySelectorAll('.nav-item').forEach(button => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const workView = view === 'library' || view === 'user';
  $('#work-content').hidden = !workView;
  if (workView) {
    const source = view === 'user' ? 'user' : lastLibrarySource;
    $('.tabs').hidden = view === 'user';
    $('#work-title').textContent = view === 'user' ? '用户作品列表' : '我的作品集';
    if (state.source !== source) {
      const previousView = state.source === 'user' ? 'user' : 'library';
      workFilters[previousView] = { query: state.query, sort: state.sort, page: state.page };
      state.source = source;
      Object.assign(state, workFilters[view]);
      $('#search').value = state.query;
      $('#sort').value = state.sort;
      render();
      if (source !== 'user') loadLibrary();
    }
  }
  if (view === 'downloads') refreshDownloadedFiles();
}
$('.main-nav').addEventListener('click', event => {
  const button = event.target.closest('[data-view]');
  if (button) showView(button.dataset.view);
});
$('#sidebar-account').addEventListener('click', () => showView('account'));

function renderSidebarAccount(profile, status) {
  const avatar = $('#sidebar-avatar');
  avatar.hidden = !profile?.avatar;
  $('#sidebar-avatar-placeholder').hidden = Boolean(profile?.avatar);
  if (profile?.avatar && avatar.getAttribute('src') !== profile.avatar) avatar.src = profile.avatar;
  $('#sidebar-account-name').textContent = profile?.nickname || '抖音账号';
  $('#sidebar-account-status').textContent = status === 'logged_in' ? '已登录' : status === 'loading' ? '正在检查登录状态' : '未登录';
  $('#sidebar-account').classList.toggle('is-logged-in', status === 'logged_in');
}

function renderAccountProfile(profile, status) {
  const loading = status === 'loading' || (status === 'logged_in' && !profile);
  renderSidebarAccount(profile, loading ? 'loading' : status);
  $('#account-profile').hidden = !profile;
  $('#account-loading').hidden = !loading;
  $('#account-loading strong').textContent = '正在加载账号信息';
  $('#account-empty').hidden = loading || status === 'logged_in';
  $('#login-open').hidden = loading || status === 'logged_in';
  if (!profile) return;
  $('#account-name').textContent = profile.nickname;
  $('#account-signature').textContent = profile.signature || '暂无签名';
  for (const [id, value] of [['account-following', profile.following], ['account-followers', profile.followers], ['account-likes', profile.likes]]) {
    $(`#${id}`).textContent = value == null ? '--' : formatCount(Number(value));
  }
  const avatar = $('#account-avatar');
  avatar.hidden = !profile.avatar;
  if (profile.avatar && avatar.getAttribute('src') !== profile.avatar) avatar.src = profile.avatar;
}

let loginPollTimer;
let loginPolling = false;
let initialLoginCheck = true;
let loggingOut = false;
let loginLoadingSince = 0;
let switchingAccount = false;
let currentAccountId = '';
let accountGeneration = 0;
let addingAccount = false;
let pendingReady = false;
let pendingLoginTimer;
let pendingLoginRequest = null;
async function refreshAccounts() {
  const response = await fetch('/api/accounts');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '无法加载账号');
  currentAccountId = data.activeAccountId;
  $('#account-list').innerHTML = data.accounts.map(account => `<div class="account-row"><span class="account-row-avatar">${account.avatar ? `<img src="${escapeHtml(account.avatar)}" alt="">` : '人'}</span><span class="account-row-name">${escapeHtml(account.name || '未登录账号')}${account.signedOut ? '（已退出）' : ''}</span>${account.id === data.activeAccountId ? '<span class="account-current">当前账号</span>' : `<button type="button" class="secondary account-switch" data-account-id="${escapeHtml(account.id)}">切换</button>`}<button type="button" class="secondary account-delete" data-delete-account="${escapeHtml(account.id)}" aria-label="删除 ${escapeHtml(account.name || '账号')}">删除</button></div>`).join('');
}

async function resetAccountView() {
  state.like = []; state.collect = []; state.user = []; state.page = 1;
  libraryCounts = { like: 0, collect: 0 }; libraryStats = { like: null, collect: null }; libraryTotal = 0; lastSyncVersion = -1;
  $('#sync-status').hidden = true;
  $('#user-sync-status').hidden = true;
  renderAccountProfile(null, 'loading');
  render();
  await loadLibrary();
  await refreshAccounts();
  initialLoginCheck = true;
}

async function changeAccount(id) {
  if (switchingAccount || loggingOut) return;
  switchingAccount = true;
  accountGeneration++;
  loggingOut = true;
  clearTimeout(loginPollTimer);
  const error = $('#account-list-error');
  error.hidden = true;
  $('#account-add').disabled = true;
  document.querySelectorAll('.account-switch').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/api/accounts/switch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '切换账号失败');
    await resetAccountView();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    switchingAccount = false;
    loggingOut = false;
    $('#account-add').disabled = false;
    document.querySelectorAll('.account-switch').forEach(button => { button.disabled = false; });
    clearTimeout(loginPollTimer);
    loginPollTimer = setTimeout(pollLogin, 500);
  }
}
$('#account-add').addEventListener('click', async () => {
  if (switchingAccount || loggingOut || addingAccount) return;
  addingAccount = true;
  accountGeneration++;
  clearTimeout(loginPollTimer);
  $('#account-add').disabled = true;
  $('#account-list-error').hidden = true;
  $('#login-status').textContent = '正在准备登录';
  $('#login-qr').hidden = true;
  $('#login-verification').hidden = true;
  $('#login-modal').showModal();
  try {
    const response = await fetch('/api/accounts', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法添加账号');
    pendingReady = true;
    if (!$('#login-modal').open) { await finishPendingLogin(); return; }
    pollPendingLogin();
  } catch (error) {
    addingAccount = false;
    $('#account-add').disabled = false;
    $('#login-modal').close();
    $('#account-list-error').textContent = error.message;
    $('#account-list-error').hidden = false;
    loginPollTimer = setTimeout(pollLogin, 500);
  }
});
$('#account-list').addEventListener('click', event => {
  const button = event.target.closest('[data-account-id]');
  if (button) changeAccount(button.dataset.accountId);
  const remove = event.target.closest('[data-delete-account]');
  if (remove) deleteAccount(remove.dataset.deleteAccount);
});

async function deleteAccount(id) {
  if (switchingAccount || loggingOut || addingAccount) return;
  if (!await confirmAction('删除账号', '删除此账号及其本地同步记录和登录信息？已下载文件会保留。')) return;
  if (switchingAccount || loggingOut || addingAccount) return;
  switchingAccount = true;
  accountGeneration++;
  clearTimeout(loginPollTimer);
  try {
    const response = await fetch('/api/accounts', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '删除账号失败');
    if (id === currentAccountId) await resetAccountView();
    else await refreshAccounts();
  } catch (error) { $('#account-list-error').textContent = error.message; $('#account-list-error').hidden = false; }
  finally { switchingAccount = false; loginPollTimer = setTimeout(pollLogin, 500); }
}

async function pollPendingLogin() {
  if (!addingAccount || pendingLoginRequest) return;
  pendingLoginRequest = (async () => {
    const response = await fetch('/api/accounts/pending/status');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法检查登录状态');
    if (result.added) {
      addingAccount = false;
      pendingReady = false;
      $('#account-add').disabled = false;
      await resetAccountView();
      renderAccountProfile(result.profile, 'logged_in');
      $('#login-modal').close();
      loginPollTimer = setTimeout(pollLogin, 500);
      return;
    }
    $('#login-qr').hidden = !result.qrCode || result.expired;
    if (result.qrCode) $('#login-qr').src = result.qrCode;
    $('#login-verification').hidden = result.status !== 'verification';
    if (result.image) $('#login-verification').src = result.image;
    $('#login-status').textContent = result.error || (result.status === 'verification' ? '请完成身份验证' : result.status === 'confirm_phone' ? '已扫码，请在手机上确认登录' : result.expired ? '二维码已过期，请刷新' : result.qrCode ? '请使用抖音 App 扫码登录' : '正在加载登录页面');
    if (!['duplicate', 'identity_error'].includes(result.status) && addingAccount) pendingLoginTimer = setTimeout(pollPendingLogin, 2000);
  })();
  try { await pendingLoginRequest; } catch (error) { $('#login-status').textContent = error.message; if (addingAccount) pendingLoginTimer = setTimeout(pollPendingLogin, 3000); }
  finally { pendingLoginRequest = null; }
}

async function finishPendingLogin() {
  clearTimeout(pendingLoginTimer);
  if (pendingLoginRequest) await pendingLoginRequest.catch(() => {});
  if (!addingAccount) return;
  try {
    const response = await fetch('/api/accounts/pending', { method: 'DELETE' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '取消登录失败');
    addingAccount = false;
    pendingReady = false;
    $('#account-add').disabled = false;
    loginPollTimer = setTimeout(pollLogin, 500);
  } catch (error) {
    $('#account-list-error').textContent = error.message;
    $('#account-list-error').hidden = false;
    if (!$('#login-modal').open) $('#login-modal').showModal();
    $('#login-status').textContent = error.message;
  }
}
async function pollLogin() {
  if (loginPolling || loggingOut || addingAccount || switchingAccount) return;
  clearTimeout(loginPollTimer);
  loginPolling = true;
  const generation = accountGeneration;
  let nextDelay = 30000;
  try {
    const response = await fetch('/api/login/status');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法检查登录状态');
    if (loggingOut || generation !== accountGeneration) return;
    const waitingForQr = (result.status === 'login' && !result.qrCode && !result.expired) || result.status === 'loading';
    if (waitingForQr) loginLoadingSince ||= Date.now();
    else loginLoadingSince = 0;
    if (initialLoginCheck && ['login', 'verification', 'confirm_phone'].includes(result.status) && !$('#login-modal').open) $('#login-modal').showModal();
    if (result.status !== 'loading') initialLoginCheck = false;
    if (result.status === 'loading' || (result.status === 'logged_in' && !result.profile)) nextDelay = 2000;
    const profile = result.status === 'logged_in' ? result.profile : null;
    renderAccountProfile(profile, result.status);
    if (profile) {
      refreshAccounts().catch(() => {});
    }
    const qr = $('#login-qr');
    qr.hidden = !result.qrCode || result.expired;
    if (result.qrCode) qr.src = result.qrCode;
    const verification = $('#login-verification');
    verification.hidden = result.status !== 'verification';
    if (result.image) verification.src = result.image;
    $('#login-status').textContent = result.status === 'logged_in' ? '已登录' : result.status === 'verification' ? '抖音需要身份验证，请在下方选择验证方式' : result.status === 'confirm_phone' ? '已扫码，请在手机上确认登录' : result.expired ? '二维码已过期，请刷新' : result.qrCode ? '请使用抖音 App 扫码登录' : loginLoadingSince && Date.now() - loginLoadingSince > 15000 ? '二维码加载失败，请刷新二维码后重试' : '正在加载登录页面';
    $('#login-open').textContent = result.status === 'logged_in' ? '抖音已登录' : '抖音登录';
    if (result.status === 'logged_in' && $('#login-modal').open) $('#login-modal').close();
  } catch (error) {
    $('#login-status').textContent = error.message;
    $('#sidebar-account-status').textContent = '连接失败';
    if (!$('#account-loading').hidden) $('#account-loading strong').textContent = '账号信息加载失败，正在重试';
    nextDelay = 5000;
    $('#login-qr').hidden = true;
    $('#login-verification').hidden = true;
  } finally {
    loginPolling = false;
    loginPollTimer = setTimeout(pollLogin, $('#login-modal').open ? 2000 : nextDelay);
  }
}

$('#login-open').addEventListener('click', () => { $('#login-modal').showModal(); pollLogin(); });
$('#account-logout').addEventListener('click', async () => {
  if (loggingOut) return;
  loggingOut = true;
  clearTimeout(loginPollTimer);
  const button = $('#account-logout');
  const error = $('#account-logout-error');
  button.disabled = true;
  button.textContent = '正在退出';
  error.hidden = true;
  try {
    const response = await fetch('/api/login/logout', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '退出登录失败');
    state.like = []; state.collect = []; state.user = []; state.page = 1;
    libraryCounts = { like: 0, collect: 0 }; libraryStats = { like: null, collect: null }; libraryTotal = 0; lastSyncVersion = -1;
    renderAccountProfile(null, 'login');
    $('#sync-status').hidden = true;
    $('#user-sync-status').hidden = true;
    render();
    refreshAccounts().catch(() => {});
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    loggingOut = false;
    button.disabled = false;
    button.textContent = '退出登录';
    clearTimeout(loginPollTimer);
    loginPollTimer = setTimeout(pollLogin, 500);
  }
});
$('#login-close').addEventListener('click', () => $('#login-modal').close());
let verificationInputQueue = Promise.resolve();
function queueVerificationInput(path, body) {
  const accountId = currentAccountId;
  const pending = addingAccount;
  verificationInputQueue = verificationInputQueue.then(async () => {
    const target = pending ? path.replace('/api/login/', '/api/accounts/pending/') : path;
    const response = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, accountId }) });
    if (!response.ok) throw new Error((await response.json()).error || '验证操作失败');
    clearTimeout(loginPollTimer);
    if (pending) { clearTimeout(pendingLoginTimer); pendingLoginTimer = setTimeout(pollPendingLogin, 300); }
    else loginPollTimer = setTimeout(pollLogin, 300);
  }).catch(error => { $('#login-status').textContent = error.message; });
}
$('#login-verification').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.focus();
  queueVerificationInput('/api/login/verification/click', { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
});
$('#login-verification').addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    queueVerificationInput('/api/login/verification/type', { selectAll: true });
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) {
    event.preventDefault();
    queueVerificationInput('/api/login/verification/type', { key: event.key });
  } else if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
    event.preventDefault();
    queueVerificationInput('/api/login/verification/type', { text: event.key });
  }
});
$('#login-verification').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain');
  if (text) {
    event.preventDefault();
    queueVerificationInput('/api/login/verification/type', { text });
  }
});
$('#login-modal').addEventListener('close', () => {
  if (addingAccount) { if (pendingReady) finishPendingLogin(); return; }
  clearTimeout(loginPollTimer);
  if (!loginPolling) loginPollTimer = setTimeout(pollLogin, 500);
});
$('#login-refresh').addEventListener('click', async () => {
  clearTimeout(loginPollTimer);
  loginLoadingSince = Date.now();
  $('#login-qr').hidden = true;
  $('#login-verification').hidden = true;
  $('#login-status').textContent = '正在刷新登录页面';
  try {
    const response = await fetch(addingAccount ? '/api/accounts/pending/refresh' : '/api/login/refresh', { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || '刷新失败');
  } catch (error) { $('#login-status').textContent = error.message; }
  if (addingAccount) { clearTimeout(pendingLoginTimer); pendingLoginTimer = setTimeout(pollPendingLogin, 1500); }
  else loginPollTimer = setTimeout(pollLogin, 1500);
});
// saved 表示保持抖音原页面顺序，其余选项是用户主动选择的排序方式。
const state = { source: 'like', like: [], collect: [], user: [], query: '', sort: 'saved', page: 1 };
let lastLibrarySource = 'like';
const workFilters = {
  library: { query: '', sort: 'saved', page: 1 },
  user: { query: '', sort: 'saved', page: 1 }
};
let libraryRequest = 0;
let libraryCounts = { like: 0, collect: 0 };
let libraryStats = { like: null, collect: null };
let libraryTotal = 0;
let lastSyncVersion = -1;

async function loadLibrary() {
  if (!['like', 'collect'].includes(state.source)) return;
  const source = state.source;
  const request = ++libraryRequest;
  const generation = accountGeneration;
  const params = new URLSearchParams({ source, page: String(state.page), query: state.query, sort: state.sort });
  try {
    const response = await fetch(`/api/library?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '加载作品失败');
    if (request !== libraryRequest || generation !== accountGeneration || source !== state.source) return;
    state[source] = data.items;
    state.page = data.page;
    libraryTotal = data.total;
    libraryCounts = data.counts;
    libraryStats[source] = data;
    render();
  } catch (error) {
    if (request === libraryRequest && generation === accountGeneration && source === state.source) {
      $('#status').textContent = error.message;
      $('#status').classList.add('error');
      $('#sync-status').hidden = false;
    }
  }
}
let modalRequestId = 0;
let downloadJob = null;
let downloadPollTimer = null;
let downloadConfirmResolver = null;
let selectedDetail = null;
let selectedQuality = null;
let playerSourceId = 0;
let imageUrls = [];
let imageIndex = 0;
let lightboxScale = 1;
let lightboxOffsetX = 0;
let lightboxOffsetY = 0;
let lightboxDrag = null;
const LIGHTBOX_MIN_SCALE = 0.5;
const LIGHTBOX_MAX_SCALE = 4;
const DISMISSED_DOWNLOAD_JOB_KEY = 'douyin-dismissed-download-job';

function isDismissedDownloadJob(job) {
  try { return Boolean(job?.id) && localStorage.getItem(DISMISSED_DOWNLOAD_JOB_KEY) === job.id; } catch { return false; }
}

function rememberDismissedDownloadJob(job) {
  try { if (job?.id) localStorage.setItem(DISMISSED_DOWNLOAD_JOB_KEY, job.id); } catch { /* 忽略浏览器存储限制 */ }
}

function clearDismissedDownloadJob() {
  try { localStorage.removeItem(DISMISSED_DOWNLOAD_JOB_KEY); } catch { /* 忽略浏览器存储限制 */ }
}

// 图集没有单一视频时长，用图片数量标识，避免和 0 秒视频混淆。
const formatDuration = seconds => {
  seconds = Number(seconds) || 0;
  return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '图集';
};
const formatMediaLabel = item => {
  if (item.mediaType !== 'image') return formatDuration(item.duration);
  const count = Number(item.imageCount || item.images?.length || 0);
  if (item.livePhotoCount) return `实况 · ${count || 1}张`;
  return count > 1 ? `图集 · ${count}张` : '图集';
};
const formatCount = count => {
  count = Number(count) || 0;
  return count >= 10000 ? `${(count / 10000).toFixed(count >= 100000 ? 0 : 1)}万` : String(count);
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

// 先筛选，再按工具栏选择排序；默认 sort 不改变数组顺序。
function getItems() {
  if (state.source !== 'user') return state[state.source];
  return state[state.source]
    .filter(item => `${item.title} ${item.author}`.toLowerCase().includes(state.query.toLowerCase()))
    .sort((a, b) => {
      if (state.sort === 'saved') return 0;
      if (state.sort === 'likes') return b.likes - a.likes;
      if (state.sort === 'duration') return b.duration - a.duration;
      if (state.sort === 'oldest') return (a.createdAt || '').localeCompare(b.createdAt || '');
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });
}

// 只显示当前页附近的页码，列表很长时分页控件仍保持紧凑。
function renderPagination(totalPages) {
  const nav = $('#pagination');
  if (totalPages <= 1) { nav.innerHTML = ''; return; }
  const pages = new Set([1, totalPages, state.page - 1, state.page, state.page + 1].filter(page => page >= 1 && page <= totalPages));
  const sorted = [...pages].sort((a, b) => a - b);
  const buttons = [`<button class="page-button" data-page="${state.page - 1}" aria-label="上一页" ${state.page === 1 ? 'disabled' : ''}>&lt;</button>`];
  for (let index = 0; index < sorted.length; index += 1) {
    const page = sorted[index];
    if (index && page - sorted[index - 1] > 1) buttons.push('<span class="page-gap">...</span>');
    buttons.push(`<button class="page-button ${page === state.page ? 'active' : ''}" data-page="${page}" ${page === state.page ? 'aria-current="page"' : ''}>${page}</button>`);
  }
  buttons.push(`<button class="page-button" data-page="${state.page + 1}" aria-label="下一页" ${state.page === totalPages ? 'disabled' : ''}>&gt;</button>`);
  // 页数较多时允许直接输入目标页码，避免连续点击页码按钮。
  buttons.push(`<form class="pagination-jump" aria-label="页码跳转"><label for="page-input">第</label><input id="page-input" class="page-input" type="number" inputmode="numeric" min="1" max="${totalPages}" value="${state.page}" aria-label="页码"><span>页 / 共 ${totalPages} 页</span><button class="page-jump-button" type="submit">跳转</button></form>`);
  nav.innerHTML = buttons.join('');
}

// 统一处理分页按钮和手动输入，超出范围的页码会自动限制在有效区间内。
function goToPage(value) {
  const page = Number.parseInt(value, 10);
  if (!Number.isFinite(page)) return false;
  const totalPages = Math.max(1, Math.ceil((state.source === 'user' ? getItems().length : libraryTotal) / PAGE_SIZE));
  state.page = Math.min(totalPages, Math.max(1, page));
  if (state.source === 'user') render(); else loadLibrary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

// 根据当前标签、搜索条件和页码刷新卡片区域。
function render() {
  const items = getItems();
  const totalPages = Math.max(1, Math.ceil((state.source === 'user' ? items.length : libraryTotal) / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  $('#like-count').textContent = libraryCounts.like;
  $('#collect-count').textContent = libraryCounts.collect;
  const sourceItems = Array.isArray(state[state.source]) ? state[state.source] : [];
  const workCount = state.source === 'user' ? sourceItems.length : libraryCounts[state.source];
  const checkpoint = libraryStats[state.source]?.checkpoint;
  $('#library-state').textContent = state.source === 'user' ? '用户作品' : workCount && !checkpoint?.complete ? '已保存部分作品，尚未完整同步' : '作品列表';
  $('#download-all').disabled = workCount === 0 || ['running', 'pending'].includes(downloadJob?.status);
  $('#download-specified').disabled = ['running', 'pending'].includes(downloadJob?.status);
  $('#download-all').textContent = workCount ? `批量下载当前列表（${workCount}）` : '批量下载当前列表';
  const grid = $('#grid');
  if (!items.length) {
    grid.innerHTML = '<div class="empty">暂无已同步内容</div>';
    renderPagination(0);
    return;
  }
  const pageItems = state.source === 'user' ? items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE) : items;
  // 卡片不再保留原页面链接，普通点击统一打开本地详情弹窗。
  grid.innerHTML = pageItems.map(item => `<article class="card" data-id="${escapeHtml(item.id)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(item.title)}"><div class="thumb"><img loading="lazy" src="${escapeHtml(item.cover)}" alt=""><span class="duration">${escapeHtml(formatMediaLabel(item))}</span></div><div class="content"><div class="title">${escapeHtml(item.title)}</div><div class="author">@${escapeHtml(item.author)}</div><div class="meta"><span>赞 ${formatCount(item.likes)}</span><span>评 ${formatCount(item.comments)}</span></div></div></article>`).join('');
  renderPagination(totalPages);
}

function formatBytes(value) {
  // 将字节数转换为适合进度列表展示的可读单位。
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

let downloadFilesRequestId = 0;
let downloadFilesRefreshTimer = null;
let downloadFilesVersion = null;
async function refreshDownloadedFiles() {
  const requestId = ++downloadFilesRequestId;
  const message = $('#download-files-message');
  try {
    const response = await fetch('/api/download/files');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法读取下载文件');
    if (requestId !== downloadFilesRequestId) return;
    $('#download-files-list').innerHTML = result.files.map(file => `<div class="file-row"><span class="file-name" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span><span class="file-size">${formatBytes(file.size)}</span><a class="file-download" href="/api/download/file?path=${encodeURIComponent(file.path)}" download>下载</a><button type="button" class="file-delete" data-file-path="${escapeHtml(file.path)}" aria-label="删除 ${escapeHtml(file.path)}">删除</button></div>`).join('');
    $('#download-files-delete-all').disabled = !result.files.length;
    message.textContent = result.files.length ? (result.truncated ? '仅显示前 2000 个文件' : '') : '暂无已下载文件';
  } catch (error) { if (requestId === downloadFilesRequestId) message.textContent = error.message; }
}
$('#download-files-refresh').addEventListener('click', refreshDownloadedFiles);

let deletingFiles = false;
async function deleteDownloadedFiles(path) {
  if (deletingFiles) return;
  const all = path == null;
  const prompt = all ? '删除所有已下载文件？未完成的下载文件会保留。' : `删除已下载文件“${path}”？`;
  if (!await confirmAction(all ? '删除全部已下载文件' : '删除已下载文件', prompt)) return;
  if (deletingFiles) return;
  deletingFiles = true;
  $('#download-files-refresh').disabled = true;
  $('#download-files-delete-all').disabled = true;
  document.querySelectorAll('.file-delete').forEach(button => { button.disabled = true; });
  try {
    const response = await fetch('/api/download/files', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify(all ? { all: true } : { path }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '删除文件失败');
    await refreshDownloadedFiles();
    $('#download-files-message').textContent = `已删除 ${result.deleted} 个文件`;
  } catch (error) {
    await refreshDownloadedFiles();
    $('#download-files-message').textContent = error.message;
  } finally {
    deletingFiles = false;
    $('#download-files-refresh').disabled = false;
    document.querySelectorAll('.file-delete').forEach(button => { button.disabled = false; });
  }
}
$('#download-files-delete-all').addEventListener('click', () => deleteDownloadedFiles());
$('#download-files-list').addEventListener('click', event => {
  const button = event.target.closest('[data-file-path]');
  if (button) deleteDownloadedFiles(button.dataset.filePath);
});

function formatSpeed(value) {
  // 将下载速度统一显示为每秒字节数、KB、MB 或 GB。
  const speed = Number(value) || 0;
  if (speed < 1024) return `${speed.toFixed(0)} B/s`;
  if (speed < 1024 ** 2) return `${(speed / 1024).toFixed(1)} KB/s`;
  if (speed < 1024 ** 3) return `${(speed / 1024 ** 2).toFixed(1)} MB/s`;
  return `${(speed / 1024 ** 3).toFixed(2)} GB/s`;
}

function renderDownloadJob(job) {
  // 根据后台任务快照刷新总进度、并发状态和当前下载明细。
  downloadJob = job;
  const sourceItems = Array.isArray(state[state.source]) ? state[state.source] : [];
  const workCount = state.source === 'user' ? sourceItems.length : libraryCounts[state.source];
  $('#download-all').disabled = workCount === 0 || ['running', 'pending'].includes(job?.status);
  $('#download-specified').disabled = ['running', 'pending'].includes(job?.status);
  const panel = $('#download-status');
  panel.hidden = !job || isDismissedDownloadJob(job);
  $('#download-empty').hidden = !panel.hidden;
  $('#nav-download-indicator').hidden = !job || !['running', 'pending'].includes(job.status);
  if (!job) return;
  const fileVersion = Number(job.fileVersion) || 0;
  if (downloadFilesVersion?.id === job.id && downloadFilesVersion.version !== fileVersion && !$('#view-downloads').hidden && !deletingFiles && !downloadFilesRefreshTimer) {
    downloadFilesRefreshTimer = setTimeout(() => {
      downloadFilesRefreshTimer = null;
      if (!$('#view-downloads').hidden && !deletingFiles) refreshDownloadedFiles();
    }, 300);
  }
  downloadFilesVersion = { id: job.id, version: fileVersion };
  const finished = Number(job.completed || 0) + Number(job.skipped || 0);
  const progress = job.total ? Math.round(finished * 100 / job.total) : 0;
  if (job.concurrency) $('#download-concurrency').value = String(Math.min(10, Math.max(1, job.concurrency)));
  if (job.quality) $('#download-quality').value = job.quality === 'standard' ? 'standard' : 'highest';
  $('#download-album-mode').value = job.albumMode === 'flat' ? 'flat' : 'folder';
  const taskLabel = job.source === 'specified' ? '作品下载' : '批量下载';
  const label = job.status === 'completed' ? `${taskLabel}完成` : job.status === 'completed_with_errors' ? `${taskLabel}完成（有失败项）` : job.status === 'failed' ? `${taskLabel}失败` : job.status === 'cancelled' ? `${taskLabel}已取消` : taskLabel;
  $('#download-title').textContent = label;
  const activeConcurrency = Number(job.activeConcurrency || 0);
  const activeItems = Array.isArray(job.activeItems) ? job.activeItems : [];
  const totalSpeed = job.status === 'running' ? activeItems.reduce((sum, item) => sum + (Number(item.speedBps) || 0), 0) : 0;
  $('#download-summary').textContent = `总速度 ${formatSpeed(totalSpeed)} · ${finished}/${job.total} 个作品 · 成功 ${job.completed} · 跳过 ${job.skipped} · 失败 ${job.failed} · 实际并发 ${activeConcurrency}/${job.concurrency}`;
  $('#download-progress-value').style.width = `${progress}%`;
  $('#download-detail').textContent = job.error || `并发 ${job.concurrency}（当前 ${activeConcurrency}） · 保存到 ${job.directory}`;
  $('#download-active-list').innerHTML = activeItems.map(item => {
    const percent = item.totalBytes ? Math.min(100, Math.round(item.bytes * 100 / item.totalBytes)) : 0;
    const type = item.mediaType === 'image' ? `${item.livePhotoCount ? '实况图集' : '图集'}${item.totalImages ? ` ${item.completedImages || 0}/${item.totalImages} 张` : ''}` : '视频';
    return `<div class="download-active-item"><div class="download-active-heading"><span class="download-active-name" title="${escapeHtml(item.title || item.id)}">${escapeHtml(item.title || item.id)}</span><span>${type} · ${formatBytes(item.bytes)} / ${item.totalBytes ? formatBytes(item.totalBytes) : '未知'} · ${formatSpeed(item.speedBps)}</span></div><div class="download-active-track"><div style="width:${percent}%"></div></div></div>`;
  }).join('');
  const running = job.status === 'running';
  $('#download-quality').disabled = running || job.status === 'pending';
  $('#download-concurrency').disabled = running || job.status === 'pending';
  $('#download-album-mode').disabled = running || job.status === 'pending';
  $('#download-pause').hidden = !running;
  $('#download-resume').hidden = !['paused', 'failed', 'completed_with_errors'].includes(job.status);
  $('#download-retry').hidden = job.failed === 0;
  $('#download-cancel').hidden = !running && !['paused', 'pending'].includes(job.status);
  $('#download-status-close').hidden = ['running', 'pending'].includes(job.status);
}

async function pollDownloadJob(id) {
  // 任务运行期间定时拉取服务端状态，完成后停止轮询。
  clearTimeout(downloadPollTimer);
  try {
    const response = await fetch(`/api/download/jobs/${encodeURIComponent(id)}?summary=1`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || '获取下载任务失败');
    renderDownloadJob(job);
    if (['running', 'pending'].includes(job.status)) downloadPollTimer = setTimeout(() => pollDownloadJob(id), 700);
  } catch (error) { $('#download-detail').textContent = error.message; }
}

async function createDownloadJob({ detail } = {}) {
  // 列表和指定作品共用下载设置、后台任务和进度面板。
  const source = detail ? 'specified' : ['like', 'collect', 'user'].includes(state.source) ? state.source : 'like';
  const works = detail ? [detail] : Array.isArray(state[source]) ? state[source] : [];
  const stats = !detail && ['like', 'collect'].includes(source) ? libraryStats[source] : null;
  if (!works.length && !stats?.totalItems) return;
  const initialQuality = $('#download-quality').value === 'standard' ? 'standard' : 'highest';
  const initialConcurrency = Math.min(10, Math.max(1, Number($('#download-concurrency').value) || 2));
  const initialAlbumMode = $('#download-album-mode').value === 'flat' ? 'flat' : 'folder';
  const confirmed = await requestDownloadConfirmation(source, works, initialQuality, initialConcurrency, initialAlbumMode, stats);
  if (!confirmed) return;
  const quality = $('#download-quality').value === 'standard' ? 'standard' : 'highest';
  const concurrency = Math.min(10, Math.max(1, Number($('#download-concurrency').value) || 2));
  const albumMode = $('#download-album-mode').value === 'flat' ? 'flat' : 'folder';
  clearDismissedDownloadJob();
  const response = await fetch('/api/download/jobs?summary=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, id: detail?.id, quality, concurrency, albumMode, skipExisting: true }) });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || '创建下载任务失败');
  renderDownloadJob(job);
  render();
  showView('downloads');
  pollDownloadJob(job.id);
}

function requestDownloadConfirmation(source, works, quality, concurrency, albumMode, stats = null) {
  // 打开自定义确认弹窗，并等待用户明确选择开始或取消。
  const modal = $('#download-confirm-modal');
  const videoCount = stats ? stats.videoCount : works.filter(item => item.mediaType !== 'image').length;
  const imageCount = stats ? stats.imageCount : works.filter(item => item.mediaType === 'image').length;
  const sourceLabel = source === 'specified' ? '指定作品' : source === 'user' ? '用户作品' : source === 'collect' ? '收藏作品' : '喜欢的作品';
  $('#download-confirm-title').textContent = `准备下载${sourceLabel}`;
  $('#download-quality').value = quality;
  $('#download-concurrency').value = String(concurrency);
  $('#download-album-mode').value = albumMode;
  $('#download-quality').disabled = false;
  $('#download-concurrency').disabled = false;
  $('#download-album-mode').disabled = false;
  updateDownloadConfirmationOptions();
  $('#download-confirm-video-count').textContent = videoCount;
  $('#download-confirm-image-count').textContent = imageCount;
  if (!modal.open) modal.showModal();
  return new Promise(resolve => { downloadConfirmResolver = resolve; });
}

function updateDownloadConfirmationOptions() {
  const quality = $('#download-quality').value === 'standard' ? 'standard' : 'highest';
  const concurrency = Math.min(10, Math.max(1, Number($('#download-concurrency').value) || 2));
  const albumMode = $('#download-album-mode').value === 'flat' ? 'flat' : 'folder';
  $('#download-confirm-quality').textContent = quality === 'standard' ? '标准画质' : '最高画质';
  $('#download-confirm-concurrency').textContent = `${concurrency} 个`;
  $('#download-confirm-directory').textContent = albumMode === 'flat'
    ? '保存位置：项目目录 / downloads（图集图片与视频同目录）'
    : '保存位置：项目目录 / downloads（图集图片使用独立文件夹）';
}

['download-quality', 'download-concurrency', 'download-album-mode'].forEach(id => {
  $(`#${id}`).addEventListener('change', updateDownloadConfirmationOptions);
});

function closeDownloadConfirmation(confirmed) {
  // 关闭确认弹窗，同时结算等待中的 Promise。
  const modal = $('#download-confirm-modal');
  if (modal.open) modal.close();
  if (downloadConfirmResolver) {
    const resolve = downloadConfirmResolver;
    downloadConfirmResolver = null;
    resolve(confirmed);
  }
}

async function downloadJobAction(action) {
  // 统一处理暂停、继续、重试和取消等后台任务操作。
  if (!downloadJob) return;
  const response = await fetch(`/api/download/jobs/${encodeURIComponent(downloadJob.id)}/${action}?summary=1`, { method: 'POST' });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || '下载任务操作失败');
  renderDownloadJob(job);
  render();
  if (['running', 'pending'].includes(job.status)) pollDownloadJob(job.id);
}

// 搜索、切换标签或同步完成后回到第一页。
function resetPageAndRender() { state.page = 1; if (state.source === 'user') render(); else loadLibrary(); }

// 统一生成本地媒体地址；下载参数由服务端转成附件响应。
function buildStreamUrl(url, { download = false, id = '', index } = {}) {
  const params = new URLSearchParams({ url });
  if (download) params.set('download', '1');
  if (id) params.set('id', id);
  if (index !== undefined) params.set('index', String(index + 1));
  return `/api/video/stream?${params.toString()}`;
}

// 图集下载同样经过本地代理，避免直接访问抖音图片 CDN 时被浏览器当成跨域资源。
function buildImageUrl(url, { download = false, id = '', index = 0 } = {}) {
  const params = new URLSearchParams({ url, kind: 'image', id: String(id), index: String(index + 1) });
  if (download) params.set('download', '1');
  return `/api/video/stream?${params.toString()}`;
}

// 放大层中的图片单独维护缩放和位移，避免改变弹窗尺寸时图片发生变形。
function updateLightboxZoomLabel() {
  const reset = $('#image-lightbox-zoom-reset');
  if (reset) reset.textContent = `${Math.round(lightboxScale * 100)}%`;
}

function clampLightboxOffset() {
  if (lightboxScale <= 1) {
    lightboxOffsetX = 0;
    lightboxOffsetY = 0;
    return;
  }
  const lightbox = $('#image-lightbox');
  if (!lightbox) return;
  const styles = getComputedStyle(lightbox);
  const contentWidth = Math.max(0, lightbox.clientWidth - parseFloat(styles.paddingLeft) - parseFloat(styles.paddingRight));
  const contentHeight = Math.max(0, lightbox.clientHeight - parseFloat(styles.paddingTop) - parseFloat(styles.paddingBottom));
  // 以内容区为上限，确保放大后仍至少有一部分图片留在可视区域内。
  const maxX = contentWidth * (lightboxScale - 1) / 2;
  const maxY = contentHeight * (lightboxScale - 1) / 2;
  lightboxOffsetX = Math.min(maxX, Math.max(-maxX, lightboxOffsetX));
  lightboxOffsetY = Math.min(maxY, Math.max(-maxY, lightboxOffsetY));
}

function applyLightboxTransform() {
  const image = $('#image-lightbox-image');
  if (!image) return;
  clampLightboxOffset();
  image.style.transform = `translate3d(${lightboxOffsetX}px, ${lightboxOffsetY}px, 0) scale(${lightboxScale})`;
  image.classList.toggle('is-zoomed', lightboxScale > 1);
  updateLightboxZoomLabel();
}

function resetLightboxZoom() {
  lightboxScale = 1;
  lightboxOffsetX = 0;
  lightboxOffsetY = 0;
  lightboxDrag = null;
  const image = $('#image-lightbox-image');
  if (image) {
    image.style.transform = '';
    image.classList.remove('is-zoomed', 'is-dragging');
  }
  updateLightboxZoomLabel();
}

// 限制放大层缩放范围，避免图片缩放后失去操作边界。
function setLightboxScale(value) {
  const next = Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, Number(value) || 1));
  lightboxScale = Math.round(next * 100) / 100;
  applyLightboxTransform();
}

function zoomLightbox(step) {
  setLightboxScale(lightboxScale + step * 0.25);
}

function handleLightboxWheel(event) {
  if (!$('#image-lightbox').open) return;
  event.preventDefault();
  zoomLightbox(event.deltaY < 0 ? 1 : -1);
}

// 图片放大后支持拖动查看局部内容，未放大时不拦截普通点击。
function startLightboxDrag(event) {
  if (lightboxScale <= 1 || event.button !== 0) return;
  const image = $('#image-lightbox-image');
  lightboxDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: lightboxOffsetX,
    originY: lightboxOffsetY
  };
  image.setPointerCapture(event.pointerId);
  image.classList.add('is-dragging');
  event.preventDefault();
}

function moveLightboxDrag(event) {
  if (!lightboxDrag || event.pointerId !== lightboxDrag.pointerId) return;
  lightboxOffsetX = lightboxDrag.originX + event.clientX - lightboxDrag.startX;
  lightboxOffsetY = lightboxDrag.originY + event.clientY - lightboxDrag.startY;
  applyLightboxTransform();
  event.preventDefault();
}

function endLightboxDrag(event) {
  if (!lightboxDrag || event.pointerId !== lightboxDrag.pointerId) return;
  const image = $('#image-lightbox-image');
  if (image.hasPointerCapture(event.pointerId)) image.releasePointerCapture(event.pointerId);
  image.classList.remove('is-dragging');
  lightboxDrag = null;
}

// 兼容旧缓存或接口未返回码率档位的作品，至少保留一个默认清晰度选项。
function getQualityOptions(item) {
  const options = Array.isArray(item.qualities)
    ? item.qualities.filter(option => option?.url)
    : [];
  if (options.length) return options;
  return item.playUrl ? [{ url: item.playUrl, label: '默认清晰度', width: item.width, height: item.height }] : [];
}

// 把清晰度、分辨率和码率组合成下拉选项文本。
function qualityLabel(option) {
  const label = option.label || '清晰度';
  const size = option.width && option.height ? `${option.width} × ${option.height}` : '';
  const bitRate = option.bitRate ? `${Math.round(Number(option.bitRate) / 1000)}K` : '';
  return [label, size, bitRate].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
}

// 原作品入口只接受抖音 HTTPS 地址；详情缺少分享链接时使用作品 ID 回退地址。
function getOriginalWorkUrl(item) {
  const fallback = item?.id ? `https://www.douyin.com/video/${encodeURIComponent(item.id)}` : '';
  try {
    const url = new URL(item?.url || fallback);
    return url.protocol === 'https:' && /(^|\.)douyin\.com$|(^|\.)iesdouyin\.com$/i.test(url.hostname) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

// 填充弹窗右侧的作品元数据，详情接口返回的新数据会覆盖列表快照。
function renderModalInfo(item) {
  const avatar = $('#modal-author-avatar');
  avatar.src = item.authorAvatar || '';
  avatar.hidden = !item.authorAvatar;
  const authorName = $('#modal-author-name');
  authorName.textContent = item.author || '未知作者';
  const profile = item.authorProfile || {};
  const authorSecUid = profile.secUid || item.authorSecUid || '';
  const authorUrl = authorSecUid ? `https://www.douyin.com/user/${encodeURIComponent(authorSecUid)}` : '';
  if (authorUrl) authorName.href = authorUrl;
  else authorName.removeAttribute('href');
  const handle = item.authorUniqueId || item.authorShortId || item.authorId;
  $('#modal-author').textContent = handle ? `抖音号 ${handle}` : '';
  const authorStats = [
    ['粉丝', item.authorFollowers],
    ['获赞', item.authorTotalFavorited],
    ['关注', item.authorFollowing],
    ['作品', item.authorAwemeCount]
  ].filter(([, value]) => Number(value) > 0);
  $('#modal-author-stats').innerHTML = authorStats.map(([label, value]) => `<span><strong>${formatCount(value)}</strong><small>${label}</small></span>`).join('');
  $('#modal-author-signature').textContent = item.authorSignature || '';
  const extra = [];
  if (profile.uid) extra.push(`UID：${profile.uid}`);
  if (profile.displayId && profile.displayId !== handle) extra.push(`展示 ID：${profile.displayId}`);
  if (profile.verified || profile.verification) extra.push(`认证：${profile.verification || '已认证'}`);
  if (profile.gender === 1) extra.push('性别：男');
  else if (profile.gender === 2) extra.push('性别：女');
  else if (profile.genderText) extra.push(`性别：${profile.genderText}`);
  const birthday = profile.birthday ? new Date(profile.birthday) : null;
  const birthdayAge = birthday && !Number.isNaN(birthday.getTime()) ? Math.max(0, new Date().getFullYear() - birthday.getFullYear() - ((new Date().getMonth() < birthday.getMonth() || (new Date().getMonth() === birthday.getMonth() && new Date().getDate() < birthday.getDate())) ? 1 : 0)) : 0;
  const age = Number(profile.age) || birthdayAge;
  if (age > 0) extra.push(`年龄：${age}岁`);
  const location = [profile.ipLocation, profile.country, profile.province, profile.city, profile.district, profile.location].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ');
  if (location) extra.push(`所在地：${location}`);
  if (profile.birthday) extra.push(`生日：${profile.birthday}`);
  if (profile.school) extra.push(`学校：${profile.school}`);
  $('#modal-author-extra').textContent = extra.join('\n');
  $('#modal-title').textContent = item.title || '未命名视频';
  // 互动数据按固定顺序排列，缺失字段不会让时长或其他信息跳位。
  const meta = [
    ['like', `点赞 ${formatCount(item.likes)}`],
    ['comment', `评论 ${formatCount(item.comments)}`],
    ['share', `转发 ${formatCount(item.shares)}`]
  ];
  if (item.plays) meta.push(['play', `播放 ${formatCount(item.plays)}`]);
  if (item.collects) meta.push(['collect', `收藏 ${formatCount(item.collects)}`]);
  if (item.recommends) meta.push(['recommend', `推荐 ${formatCount(item.recommends)}`]);
  meta.push(item.mediaType === 'image'
    ? ['album', `图集 ${Number(item.imageCount || item.images?.length || 1)} 张${item.livePhotoCount ? ` · 实况 ${item.livePhotoCount} 张` : ''}`]
    : item.duration ? ['duration', `时长 ${formatDuration(item.duration)}`] : ['album', '图集']);
  $('#modal-meta').innerHTML = meta.map(([icon, value]) => `<span class="modal-meta-item modal-meta-${icon}"><i class="modal-meta-icon" aria-hidden="true"></i>${escapeHtml(value)}</span>`).join('');
  const originalLink = $('#modal-original-link');
  const originalUrl = getOriginalWorkUrl(item);
  originalLink.hidden = !originalUrl;
  if (originalUrl) originalLink.href = originalUrl;
  else originalLink.removeAttribute('href');
  $('#modal-date').textContent = item.createdAt ? `发布于 ${new Date(item.createdAt).toLocaleString('zh-CN')}` : '';
  const music = item.music?.title ? `音乐：${item.music.title}${item.music.author ? ` · ${item.music.author}` : ''}` : '';
  $('#modal-music').textContent = music;
  $('#modal-tags').textContent = item.tags?.length ? `#${item.tags.join(' #')}` : '';
  $('#modal-location').textContent = item.location ? `位置：${item.location}` : '';
  const size = item.width && item.height ? `${item.width} × ${item.height}` : '';
  const technical = [size, item.ratio ? `比例 ${item.ratio}` : '', item.downloads ? `下载 ${formatCount(item.downloads)}` : ''].filter(Boolean);
  $('#modal-technical').textContent = technical.join(' · ');
}

// 清理上一次播放器状态，避免旧视频在新作品加载时继续播放。
function resetModalPlayer() {
  const video = $('#modal-video');
  const audio = $('#modal-audio');
  const liveVideo = $('#modal-live-video');
  playerSourceId += 1;
  selectedDetail = null;
  selectedQuality = null;
  imageUrls = [];
  imageIndex = 0;
  video.pause();
  video.removeAttribute('src');
  video.removeAttribute('poster');
  video.load();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.hidden = true;
  video.hidden = true;
  liveVideo.pause();
  liveVideo.removeAttribute('src');
  liveVideo.removeAttribute('poster');
  liveVideo.load();
  liveVideo.hidden = true;
  $('#modal-image').hidden = false;
  $('#modal-image-live-toggle').hidden = true;
  $('#modal-images').hidden = true;
  $('#modal-image').removeAttribute('src');
  $('#modal-image').alt = '';
  $('#modal-image-count').textContent = '';
  $('#modal-image-prev').hidden = true;
  $('#modal-image-next').hidden = true;
  $('#modal-image-download-current').hidden = true;
  $('#modal-image-download-all').hidden = true;
  const lightbox = $('#image-lightbox');
  if (lightbox.open) lightbox.close();
  $('#image-lightbox-image').removeAttribute('src');
  resetLightboxZoom();
  $('#modal-loading').hidden = false;
  $('#modal-loading').textContent = '正在获取视频...';
  $('#modal-error').textContent = '';
  $('#modal-actions').hidden = true;
  $('#modal-quality').disabled = true;
  $('#modal-quality').innerHTML = '<option>获取中...</option>';
  $('#modal-download').disabled = true;
}

// 图集只显示当前图片，通过按钮或键盘切换，避免多个 CDN 地址重复占用弹窗空间。
function updateImageGallery(title = '') {
  if (!imageUrls.length) return;
  const image = $('#modal-image');
  image.src = imageUrls[imageIndex];
  image.alt = title || '图集图片';
  const media = selectedDetail?.imageMedia?.find(entry => entry.imageUrl === imageUrls[imageIndex]);
  const liveVideo = $('#modal-live-video');
  liveVideo.pause();
  liveVideo.removeAttribute('src');
  liveVideo.removeAttribute('poster');
  if (media?.videoUrl) {
    liveVideo.src = buildStreamUrl(media.videoUrl, { id: selectedDetail.id });
    liveVideo.poster = imageUrls[imageIndex];
  }
  liveVideo.load();
  $('#modal-image-live-toggle').hidden = !media?.videoUrl;
  showLivePhoto(Boolean(media?.videoUrl));
  $('#modal-image-count').textContent = `${imageIndex + 1} / ${imageUrls.length}${media?.isLivePhoto ? ' · 实况' : ''}`;
  const hasMultiple = imageUrls.length > 1;
  $('#modal-image-prev').hidden = !hasMultiple;
  $('#modal-image-next').hidden = !hasMultiple;
  $('#modal-image-download-current').hidden = false;
  $('#modal-image-download-current').textContent = media?.isLivePhoto ? '下载实况' : '下载当前';
  $('#modal-image-download-current').title = media?.isLivePhoto ? '保存静态图片和 MP4 动态片段' : '保存当前图片';
  $('#modal-image-download-all').hidden = false;
  const lightbox = $('#image-lightbox');
  if (lightbox.open) {
    const lightboxImage = $('#image-lightbox-image');
    lightboxImage.src = imageUrls[imageIndex];
    lightboxImage.alt = image.alt;
    resetLightboxZoom();
  }
}

function showLivePhoto(show) {
  const video = $('#modal-live-video');
  video.hidden = !show;
  $('#modal-image').hidden = show;
  $('#modal-image-live-toggle').textContent = show ? '查看静态' : '播放实况';
  if (show) video.play().catch(() => { /* 保留控件，供用户手动播放。 */ });
  else video.pause();
}

// 规范化图集图片地址并初始化当前图片索引。
function renderImageGallery(detail) {
  selectedDetail = detail;
  imageUrls = [...new Set((detail.images || []).filter(Boolean))];
  if (!imageUrls.length && detail.cover) imageUrls = [detail.cover];
  imageIndex = 0;
  $('#modal-images').hidden = !imageUrls.length;
  updateImageGallery(detail.title || '');
  return imageUrls.length > 0;
}

// 在图片区域点击时打开独立放大层，原图仍保持在详情弹窗中可继续切换。
function openImageLightbox() {
  if (!imageUrls.length) return;
  const lightbox = $('#image-lightbox');
  const image = $('#image-lightbox-image');
  image.src = imageUrls[imageIndex];
  image.alt = $('#modal-title').textContent || '图集图片';
  resetLightboxZoom();
  if (!lightbox.open) lightbox.showModal();
}

// 保存实况图的图片和动态片段，使用相同作品 ID 和序号对应两份文件。
function imageDownloadAssets(index) {
  if (!selectedDetail || !imageUrls[index]) return [];
  const id = selectedDetail.id;
  const media = selectedDetail.imageMedia?.find(entry => entry.imageUrl === imageUrls[index]);
  const assets = [{ href: buildImageUrl(imageUrls[index], { download: true, id, index }), filename: `douyin-${id}-${index + 1}` }];
  if (media?.isLivePhoto && !media.videoUrl) {
    $('#modal-error').textContent = '该实况图缺少动态地址，请重新打开作品后下载';
    return [];
  }
  if (media?.videoUrl) assets.push({ href: buildStreamUrl(media.videoUrl, { download: true, id, index }), filename: `douyin-${id}-${index + 1}.mp4` });
  return assets;
}

function downloadImageAssets(assets) {
  // 预先固定地址，切换图片或关闭弹窗不会把尚未触发的下载替换为其他作品。
  assets.forEach((asset, index) => setTimeout(() => {
    const link = document.createElement('a');
    link.href = asset.href;
    link.download = asset.filename;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  }, index * 180));
}

function downloadImage(index) {
  downloadImageAssets(imageDownloadAssets(index));
}

// 浏览器可能限制批量下载权限，因此每张图片间隔触发，避免请求瞬间拥塞。
function downloadAllImages() {
  downloadImageAssets(imageUrls.flatMap((_, index) => imageDownloadAssets(index)));
}

// 设置当前清晰度，切换时尽量恢复原来的播放位置和播放状态。
function setVideoQuality(option, { autoplay = false, preservePosition = true } = {}) {
  const video = $('#modal-video');
  const requestId = ++playerSourceId;
  const currentTime = preservePosition && Number.isFinite(video.currentTime) ? video.currentTime : 0;
  const wasPlaying = !video.paused && !video.ended;
  selectedQuality = option;
  video.src = buildStreamUrl(option.url, { id: selectedDetail?.id || '' });
  video.hidden = false;
  $('#modal-loading').hidden = true;
  video.addEventListener('loadedmetadata', () => {
    if (requestId !== playerSourceId) return;
    if (currentTime > 0 && Number.isFinite(video.duration)) video.currentTime = Math.min(currentTime, Math.max(0, video.duration - 0.1));
    if (autoplay || wasPlaying) video.play().catch(() => { /* 浏览器禁止自动播放时保留控件供用户点击播放 */ });
  }, { once: true });
  video.load();
}

// 将接口返回的码率档位写入下拉框，并准备下载当前选项。
function renderQualityControls(detail, options) {
  // 接口返回顺序不固定，按码率和分辨率从高到低整理默认播放档位。
  const orderedOptions = options
    .map((option, index) => ({ option, index }))
    .sort((a, b) => {
      const bitRateDiff = Number(b.option.bitRate || 0) - Number(a.option.bitRate || 0);
      if (bitRateDiff) return bitRateDiff;
      const areaA = Number(a.option.width || 0) * Number(a.option.height || 0);
      const areaB = Number(b.option.width || 0) * Number(b.option.height || 0);
      return areaB - areaA || a.index - b.index;
    })
    .map(({ option }) => option);
  selectedDetail = { ...detail, qualities: orderedOptions };
  const select = $('#modal-quality');
  // 第一项为最高档位，详情打开后直接播放该清晰度。
  const selectedIndex = 0;
  select.innerHTML = orderedOptions.map((option, index) => `<option value="${index}">${escapeHtml(qualityLabel(option))}</option>`).join('');
  select.value = String(selectedIndex);
  select.disabled = orderedOptions.length < 2;
  $('#modal-actions').hidden = false;
  $('#modal-download').disabled = false;
  setVideoQuality(orderedOptions[selectedIndex], { autoplay: true, preservePosition: false });
}

// 点击卡片后实时请求详情和播放地址；请求期间弹窗保持打开并显示加载状态。
// 打开作品详情弹窗，并在弹窗内请求最新媒体地址。
async function openVideo(item) {
  const requestId = ++modalRequestId;
  const modal = $('#video-modal');
  if (!modal.open) modal.showModal();
  resetModalPlayer();
  renderModalInfo(item);
  try {
    const response = await fetch(`/api/video?id=${encodeURIComponent(item.id)}`);
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error || '获取视频详情失败');
    if (requestId !== modalRequestId) return;
    renderModalInfo(detail);
    const qualityOptions = getQualityOptions(detail);
    if (detail.mediaType === 'image' || (!qualityOptions.length && detail.images?.length)) {
      $('#modal-loading').hidden = true;
      $('#modal-actions').hidden = true;
      const audio = $('#modal-audio');
      if (detail.music?.url) {
        audio.src = buildStreamUrl(detail.music.url, { id: detail.id });
        audio.loop = true;
        audio.addEventListener('canplay', () => audio.play().catch(() => { /* 自动播放策略限制时忽略。 */ }), { once: true });
        audio.load();
        audio.play().catch(() => { /* 浏览器阻止自动播放时静默忽略，不影响图集浏览。 */ });
      }
      if (!renderImageGallery(detail)) throw new Error('该图集暂未获取到图片');
      return;
    }
    if (!qualityOptions.length) throw new Error('该作品暂未获取到可播放地址');
    $('#modal-video').poster = detail.cover || '';
    // 通过本地代理播放，代理会携带抖音来源信息并支持拖动进度。
    renderQualityControls(detail, qualityOptions);
  } catch (error) {
    if (requestId !== modalRequestId) return;
    $('#modal-loading').hidden = true;
    $('#modal-error').textContent = error.message;
  }
}

// 尝试从任意作品链接中提取数字 ID，不依赖固定域名或路径格式。
function extractDouyinWorkId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    const source = `${url.pathname} ${url.search} ${url.hash} ${url.href}`;
    const candidates = [...source.matchAll(/\d{10,}/g)].map(match => match[0]);
    return candidates.sort((a, b) => b.length - a.length)[0] || '';
  } catch {
    // 兼容用户直接粘贴数字 ID；其他无法解析的内容交给调用方提示错误。
    return /^\d{10,}$/.test(raw) ? raw : '';
  }
}

// 选择不同清晰度时只替换视频源，不重新请求作品详情。
$('#modal-quality').addEventListener('change', event => {
  const index = Number(event.target.value);
  const option = selectedDetail?.qualities?.[index];
  if (option) setVideoQuality(option);
});

// 下载当前选中的清晰度，地址仍由本地代理短期校验并转发。
$('#modal-download').addEventListener('click', () => {
  if (!selectedDetail || !selectedQuality) return;
  const link = document.createElement('a');
  link.href = buildStreamUrl(selectedQuality.url, { download: true, id: selectedDetail.id });
  link.download = `douyin-${selectedDetail.id}.mp4`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
});

// 轮询同步任务状态，直到服务端报告完成或失败。
async function pollSync() {
  try {
    const response = await fetch('/api/sync/status');
    const sync = await response.json();
    if (!response.ok) throw new Error(sync.error || '获取同步状态失败');
    $('#status').textContent = sync.error || sync.message;
    $('#progress-value').style.width = `${sync.progress || 0}%`;
    $('#progress-detail').textContent = sync.running ? `${sync.progress || 0}% · 喜欢 ${sync.likePages} 页 · 收藏 ${sync.collectPages} 页${sync.fallbackPhase === sync.phase && sync.fallbackReason ? ` · 接口失败：${sync.fallbackReason}` : ''}` : '';
    $('#sync-status-close').hidden = sync.running;
    const checkpoints = Object.values(sync.checkpoints || {});
    const resumable = checkpoints.some(item => item.pages > 0) && checkpoints.some(item => !item.complete);
    $('#sync').textContent = resumable ? '继续同步' : '同步喜欢与收藏';
    if ((sync.version ?? -1) !== lastSyncVersion || !sync.running) {
      lastSyncVersion = sync.version ?? -1;
      await loadLibrary();
    }
    if (sync.running) return setTimeout(pollSync, 1000);
    $('#sync').disabled = false;
    if (sync.error) $('#status').classList.add('error');
  } catch (error) {
    $('#sync').disabled = false;
    $('#status').textContent = error.message;
    $('#status').classList.add('error');
    $('#sync-status-close').hidden = false;
  }
}

async function pollUserSync() {
  try {
    const response = await fetch('/api/profile/sync/status');
    const sync = await response.json();
    if (!response.ok) throw new Error(sync.error || '获取用户作品加载状态失败');
    $('#user-status').textContent = sync.error || sync.message;
    $('#user-progress-value').style.width = `${sync.progress || 0}%`;
    $('#user-progress-detail').textContent = sync.running ? `${sync.progress || 0}% · 已发现 ${sync.count || 0} 条作品` : '';
    $('#user-sync-status-close').hidden = sync.running;
    if (sync.running) return setTimeout(pollUserSync, 500);
    $('#profile-sync-start').disabled = false;
    if (sync.error) { $('#user-status').classList.add('error'); return; }
    if (Array.isArray(sync.data)) {
      state.user = sync.data;
      if (state.source === 'user') resetPageAndRender();
      $('#user-status').textContent = `用户作品加载完成：${state.user.length} 条`;
    }
  } catch (error) {
    $('#profile-sync-start').disabled = false;
    $('#user-status').textContent = error.message;
    $('#user-status').classList.add('error');
    $('#user-sync-status-close').hidden = false;
  }
}

// 卡片点击和键盘确认都进入同一个本地弹窗流程。
$('#grid').addEventListener('click', event => {
  const card = event.target.closest('.card');
  if (!card) return;
  const item = state[state.source].find(entry => entry.id === card.dataset.id);
  if (item) openVideo(item);
});
$('#grid').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('.card');
  if (!card) return;
  event.preventDefault();
  const item = state[state.source].find(entry => entry.id === card.dataset.id);
  if (item) openVideo(item);
});

// 关闭弹窗时停止播放并取消尚未完成的详情请求结果。
$('#modal-close').addEventListener('click', () => $('#video-modal').close());
$('#video-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$('#video-modal').addEventListener('close', () => {
  modalRequestId += 1;
  resetModalPlayer();
});

$('#modal-image').addEventListener('click', openImageLightbox);
$('#modal-image').addEventListener('keydown', event => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  openImageLightbox();
});
$('#image-lightbox-close').addEventListener('click', () => $('#image-lightbox').close());
$('#image-lightbox').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$('#image-lightbox-zoom-out').addEventListener('click', () => zoomLightbox(-1));
$('#image-lightbox-zoom-reset').addEventListener('click', () => resetLightboxZoom());
$('#image-lightbox-zoom-in').addEventListener('click', () => zoomLightbox(1));
$('#image-lightbox-image').addEventListener('wheel', handleLightboxWheel, { passive: false });
$('#image-lightbox-image').addEventListener('pointerdown', startLightboxDrag);
$('#image-lightbox-image').addEventListener('pointermove', moveLightboxDrag);
$('#image-lightbox-image').addEventListener('pointerup', endLightboxDrag);
$('#image-lightbox-image').addEventListener('pointercancel', endLightboxDrag);
$('#image-lightbox-image').addEventListener('dblclick', () => setLightboxScale(lightboxScale > 1 ? 1 : 2));
$('#modal-image-download-current').addEventListener('click', () => downloadImage(imageIndex));
$('#modal-image-download-all').addEventListener('click', downloadAllImages);
$('#modal-image-live-toggle').addEventListener('click', () => showLivePhoto($('#modal-live-video').hidden));

// 图集弹窗支持左右按钮和键盘方向键切换。
$('#modal-images').addEventListener('click', event => {
  const button = event.target.closest('.image-nav');
  if (!button || imageUrls.length < 2) return;
  imageIndex = (imageIndex + (button.id === 'modal-image-next' ? 1 : -1) + imageUrls.length) % imageUrls.length;
  updateImageGallery(selectedDetail?.title || $('#modal-title').textContent);
});
document.addEventListener('keydown', event => {
  if (!$('#video-modal').open || imageUrls.length < 2) return;
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  imageIndex = (imageIndex + (event.key === 'ArrowRight' ? 1 : -1) + imageUrls.length) % imageUrls.length;
  updateImageGallery(selectedDetail?.title || $('#modal-title').textContent);
});

// 切换标签时读取本地数据库，不会重新请求抖音。
$('.tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.source = tab.dataset.source;
  lastLibrarySource = state.source;
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  resetPageAndRender();
});
// 搜索和排序作用于当前数据源。
$('#search').addEventListener('input', event => { state.query = event.target.value; resetPageAndRender(); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; resetPageAndRender(); });
// 指定作品解析完成后，使用与批量下载相同的确认弹窗和服务端任务。
$('#download-specified').addEventListener('click', () => {
  const modal = $('#specified-download-modal');
  $('#specified-download-url').value = '';
  $('#specified-download-error').textContent = '';
  if (!modal.open) modal.showModal();
  setTimeout(() => $('#specified-download-url').focus(), 0);
});
$('#specified-download-close').addEventListener('click', () => $('#specified-download-modal').close());
$('#specified-download-cancel').addEventListener('click', () => $('#specified-download-modal').close());
$('#specified-download-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$('#specified-download-open').addEventListener('click', async () => {
  const input = $('#specified-download-url');
  const button = $('#specified-download-open');
  if (button.disabled) return;
  const id = extractDouyinWorkId(input.value);
  if (!id) {
    $('#specified-download-error').textContent = '无法从该内容解析作品 ID，请检查链接后重试';
    input.focus();
    return;
  }
  button.disabled = true;
  button.textContent = '正在解析...';
  $('#specified-download-error').textContent = '';
  try {
    const response = await fetch(`/api/video?id=${encodeURIComponent(id)}`);
    const detail = await response.json();
    if (!response.ok) throw new Error(detail.error || '解析作品失败');
    // 用户关闭输入窗口后，不再打开下载确认窗口。
    if (!$('#specified-download-modal').open) return;
    $('#specified-download-modal').close();
    await createDownloadJob({ detail });
  } catch (error) {
    if ($('#specified-download-modal').open) {
      $('#specified-download-error').textContent = error.message;
    } else {
      $('#download-status').hidden = false;
      $('#download-empty').hidden = true;
      $('#download-detail').textContent = error.message;
      showView('downloads');
    }
  } finally {
    button.disabled = false;
    button.textContent = '解析作品';
  }
});
$('#specified-download-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('#specified-download-open').click();
});
$('#download-all').addEventListener('click', () => {
  createDownloadJob().catch(error => { $('#download-status').hidden = false; $('#download-empty').hidden = true; $('#download-detail').textContent = error.message; showView('downloads'); });
});
$('#download-confirm-start').addEventListener('click', () => closeDownloadConfirmation(true));
$('#download-confirm-cancel').addEventListener('click', () => closeDownloadConfirmation(false));
$('#download-confirm-close').addEventListener('click', () => closeDownloadConfirmation(false));
$('#download-confirm-modal').addEventListener('cancel', event => { event.preventDefault(); closeDownloadConfirmation(false); });
$('#download-confirm-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeDownloadConfirmation(false);
});
$('#download-pause').addEventListener('click', () => downloadJobAction('pause').catch(error => { $('#download-detail').textContent = error.message; }));
$('#download-resume').addEventListener('click', () => downloadJobAction('resume').catch(error => { $('#download-detail').textContent = error.message; }));
$('#download-retry').addEventListener('click', () => downloadJobAction('retry-failed').catch(error => { $('#download-detail').textContent = error.message; }));
$('#download-cancel').addEventListener('click', () => downloadJobAction('cancel').catch(error => { $('#download-detail').textContent = error.message; }));
// 分页后回到页面顶部，方便用户连续浏览。
$('#pagination').addEventListener('click', event => {
  const button = event.target.closest('[data-page]');
  if (!button || button.disabled) return;
  goToPage(button.dataset.page);
});
// 支持按回车或点击按钮跳转到指定页码。
$('#pagination').addEventListener('submit', event => {
  const form = event.target.closest('.pagination-jump');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('.page-input');
  if (!goToPage(input.value)) input.value = String(state.page);
});
// 启动后台同步；按钮禁用期间避免重复触发多个 Chrome 会话。
$('#sync').addEventListener('click', async () => {
  const button = $('#sync');
  button.disabled = true;
  // 用户主动开始同步后才展开状态和进度区域；刷新页面时它保持默认隐藏。
  $('#sync-status').hidden = false;
  $('#progress-track').hidden = false;
  $('#progress-value').style.width = '0%';
  $('#progress-detail').textContent = '';
  $('#status').classList.remove('error');
  $('#sync-status-close').hidden = true;
  lastSyncVersion = -1;
  try {
    const response = await fetch('/api/sync/start', { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || '启动同步失败');
    pollSync();
  } catch (error) {
    $('#status').textContent = error.message;
    $('#status').classList.add('error');
    button.disabled = false;
  }
});

$('#profile-sync').addEventListener('click', () => {
  const modal = $('#profile-sync-modal');
  $('#profile-sync-url').value = '';
  $('#profile-sync-error').textContent = '';
  if (!modal.open) modal.showModal();
  setTimeout(() => $('#profile-sync-url').focus(), 0);
});
$('#profile-sync-close').addEventListener('click', () => $('#profile-sync-modal').close());
$('#profile-sync-cancel').addEventListener('click', () => $('#profile-sync-modal').close());
$('#profile-sync-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) event.currentTarget.close();
});
$('#profile-sync-start').addEventListener('click', async () => {
  const input = $('#profile-sync-url');
  const button = $('#profile-sync-start');
  const value = input.value.trim();
  let url;
  try { url = new URL(value); } catch { $('#profile-sync-error').textContent = '请输入有效的用户主页链接'; input.focus(); return; }
  if (!/^\/user\//.test(url.pathname)) { $('#profile-sync-error').textContent = '链接必须是抖音用户主页地址'; input.focus(); return; }
  button.disabled = true;
  $('#profile-sync-error').textContent = '';
  $('#profile-sync-modal').close();
  $('#user-sync-status').hidden = false;
  $('#user-progress-track').hidden = false;
  $('#user-progress-value').style.width = '0%';
  $('#user-progress-detail').textContent = '';
  $('#user-sync-status-close').hidden = true;
  $('#user-status').classList.remove('error');
  try {
    const response = await fetch('/api/profile/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.href }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '启动用户作品加载失败');
    pollUserSync();
  } catch (error) {
    $('#user-status').textContent = error.message;
    $('#user-status').classList.add('error');
    $('#user-sync-status-close').hidden = false;
    button.disabled = false;
  }
});
$('#profile-sync-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('#profile-sync-start').click();
});
$('#sync-status-close').addEventListener('click', () => { $('#sync-status').hidden = true; });
$('#user-sync-status-close').addEventListener('click', () => { $('#user-sync-status').hidden = true; });
$('#download-status-close').addEventListener('click', () => {
  rememberDismissedDownloadJob(downloadJob);
  $('#download-status').hidden = true;
  $('#download-empty').hidden = false;
});
// 页面刷新后恢复服务端内存中的最近一次同步结果。
async function restoreLatest() {
  try {
    const sync = await (await fetch('/api/sync/status')).json();
    await loadLibrary();
    if (sync.running) {
      $('#sync').disabled = true;
      $('#sync-status').hidden = false;
      $('#progress-track').hidden = false;
      pollSync();
    } else if (Object.values(sync.checkpoints || {}).some(item => item.pages > 0) && Object.values(sync.checkpoints || {}).some(item => !item.complete)) {
      $('#sync').textContent = '继续同步';
    }
    const profileSync = await (await fetch('/api/profile/sync/status')).json();
    if (Array.isArray(profileSync.data) && profileSync.data.length) {
      state.user = profileSync.data;
      render();
    }
    if (profileSync.running) {
      $('#profile-sync-start').disabled = true;
      $('#user-sync-status').hidden = false;
      $('#user-progress-track').hidden = false;
      pollUserSync();
    }
    const jobs = await (await fetch('/api/download/jobs?summary=1')).json();
    const active = jobs.find(job => ['running', 'pending', 'paused', 'failed', 'completed_with_errors'].includes(job.status) && !isDismissedDownloadJob(job));
    if (active) {
      renderDownloadJob(active);
      if (['running', 'pending'].includes(active.status)) pollDownloadJob(active.id);
    }
  } catch { /* 本地服务重启期间保留空状态，页面仍可正常使用。 */ }
}
render();
restoreLatest();
pollLogin();
refreshAccounts().catch(error => { $('#account-list-error').textContent = error.message; $('#account-list-error').hidden = false; });
