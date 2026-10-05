// 每页展示固定数量，避免内容过多时一次性渲染造成卡顿。
const PAGE_SIZE = 24;
// saved 表示保持抖音原页面顺序，其余选项是用户主动选择的排序方式。
const state = { source: 'like', like: [], collect: [], user: [], query: '', sort: 'saved', page: 1 };
const $ = selector => document.querySelector(selector);
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
  const totalPages = Math.max(1, Math.ceil(getItems().length / PAGE_SIZE));
  state.page = Math.min(totalPages, Math.max(1, page));
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  return true;
}

// 根据当前标签、搜索条件和页码刷新卡片区域。
function render() {
  const items = getItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  state.page = Math.min(state.page, totalPages);
  $('#like-count').textContent = state.like.length;
  $('#collect-count').textContent = state.collect.length;
  $('#user-count').textContent = state.user.length;
  const sourceItems = Array.isArray(state[state.source]) ? state[state.source] : [];
  const workCount = sourceItems.length;
  $('#download-all').disabled = workCount === 0 || ['running', 'pending'].includes(downloadJob?.status);
  $('#download-all').textContent = workCount ? `下载全部作品（${workCount}）` : '下载全部作品';
  const grid = $('#grid');
  if (!items.length) {
    grid.innerHTML = '<div class="empty">暂无已同步内容</div>';
    renderPagination(0);
    return;
  }
  const pageItems = items.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
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
  $('#download-all').disabled = sourceItems.length === 0 || ['running', 'pending'].includes(job?.status);
  const panel = $('#download-status');
  panel.hidden = !job || isDismissedDownloadJob(job);
  if (!job) return;
  const finished = Number(job.completed || 0) + Number(job.skipped || 0);
  const progress = job.total ? Math.round(finished * 100 / job.total) : 0;
  if (job.concurrency) $('#download-concurrency').value = String(Math.min(10, Math.max(1, job.concurrency)));
  if (job.quality) $('#download-quality').value = job.quality === 'standard' ? 'standard' : 'highest';
  const label = job.status === 'completed' ? '批量下载完成' : job.status === 'completed_with_errors' ? '批量下载完成（有失败项）' : job.status === 'failed' ? '批量下载失败' : job.status === 'cancelled' ? '批量下载已取消' : '批量下载';
  $('#download-title').textContent = label;
  const activeConcurrency = Number(job.activeConcurrency || 0);
  $('#download-summary').textContent = `${finished}/${job.total} 个作品 · 成功 ${job.completed} · 跳过 ${job.skipped} · 失败 ${job.failed} · 实际并发 ${activeConcurrency}/${job.concurrency}`;
  $('#download-progress-value').style.width = `${progress}%`;
  $('#download-detail').textContent = job.error || `并发 ${job.concurrency}（当前 ${activeConcurrency}） · 保存到 ${job.directory}`;
  const activeItems = Array.isArray(job.activeItems) ? job.activeItems : [];
  $('#download-active-list').innerHTML = activeItems.map(item => {
    const percent = item.totalBytes ? Math.min(100, Math.round(item.bytes * 100 / item.totalBytes)) : 0;
    const type = item.mediaType === 'image' ? '图集' : '视频';
    return `<div class="download-active-item"><div class="download-active-heading"><span class="download-active-name" title="${escapeHtml(item.title || item.id)}">${escapeHtml(item.title || item.id)}</span><span>${type} · ${formatBytes(item.bytes)} / ${item.totalBytes ? formatBytes(item.totalBytes) : '未知'} · ${formatSpeed(item.speedBps)}</span></div><div class="download-active-track"><div style="width:${percent}%"></div></div></div>`;
  }).join('');
  const running = job.status === 'running';
  $('#download-quality').disabled = running || job.status === 'pending';
  $('#download-concurrency').disabled = running || job.status === 'pending';
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
    const response = await fetch(`/api/download/jobs/${encodeURIComponent(id)}`);
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || '获取下载任务失败');
    renderDownloadJob(job);
    if (['running', 'pending'].includes(job.status)) downloadPollTimer = setTimeout(() => pollDownloadJob(id), 700);
  } catch (error) { $('#download-detail').textContent = error.message; }
}

async function createDownloadJob() {
  // 使用当前标签的全部作品创建批量下载任务。
  const source = ['like', 'collect', 'user'].includes(state.source) ? state.source : 'like';
  const works = Array.isArray(state[source]) ? state[source] : [];
  if (!works.length) return;
  const quality = $('#download-quality').value === 'standard' ? 'standard' : 'highest';
  const concurrency = Math.min(10, Math.max(1, Number($('#download-concurrency').value) || 2));
  const confirmed = await requestDownloadConfirmation(source, quality, concurrency);
  if (!confirmed) return;
  clearDismissedDownloadJob();
  const response = await fetch('/api/download/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source, quality, concurrency, skipExisting: true }) });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || '创建下载任务失败');
  renderDownloadJob(job);
  render();
  pollDownloadJob(job.id);
}

function requestDownloadConfirmation(source, quality, concurrency) {
  // 打开自定义确认弹窗，并等待用户明确选择开始或取消。
  const modal = $('#download-confirm-modal');
  const works = Array.isArray(state[source]) ? state[source] : [];
  const videoCount = works.filter(item => item.mediaType !== 'image').length;
  const imageCount = works.filter(item => item.mediaType === 'image').length;
  const sourceLabel = source === 'user' ? '用户作品' : source === 'collect' ? '收藏作品' : '喜欢的作品';
  $('#download-confirm-title').textContent = `准备下载${sourceLabel}`;
  $('#download-confirm-video-count').textContent = videoCount;
  $('#download-confirm-image-count').textContent = imageCount;
  $('#download-confirm-quality').textContent = quality === 'standard' ? '标准' : '最高';
  $('#download-confirm-concurrency').textContent = concurrency;
  $('#download-confirm-directory').textContent = '保存位置：项目目录 / downloads';
  if (!modal.open) modal.showModal();
  return new Promise(resolve => { downloadConfirmResolver = resolve; });
}

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
  const response = await fetch(`/api/download/jobs/${encodeURIComponent(downloadJob.id)}/${action}`, { method: 'POST' });
  const job = await response.json();
  if (!response.ok) throw new Error(job.error || '下载任务操作失败');
  renderDownloadJob(job);
  render();
  if (['running', 'pending'].includes(job.status)) pollDownloadJob(job.id);
}

// 搜索、切换标签或同步完成后回到第一页。
function resetPageAndRender() { state.page = 1; render(); }

// 统一生成本地媒体地址；下载参数由服务端转成附件响应。
function buildStreamUrl(url, { download = false, id = '' } = {}) {
  const params = new URLSearchParams({ url });
  if (download) params.set('download', '1');
  if (id) params.set('id', id);
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
    ? ['album', `图集 ${Number(item.imageCount || item.images?.length || 1)} 张`]
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
  $('#modal-image-count').textContent = `${imageIndex + 1} / ${imageUrls.length}`;
  const hasMultiple = imageUrls.length > 1;
  $('#modal-image-prev').hidden = !hasMultiple;
  $('#modal-image-next').hidden = !hasMultiple;
  $('#modal-image-download-current').hidden = false;
  $('#modal-image-download-all').hidden = false;
  const lightbox = $('#image-lightbox');
  if (lightbox.open) {
    const lightboxImage = $('#image-lightbox-image');
    lightboxImage.src = imageUrls[imageIndex];
    lightboxImage.alt = image.alt;
    resetLightboxZoom();
  }
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

// 通过本地媒体代理触发单张图片下载，避免跨域限制。
function downloadImage(index) {
  if (!selectedDetail || !imageUrls[index]) return;
  const link = document.createElement('a');
  link.href = buildImageUrl(imageUrls[index], { download: true, id: selectedDetail.id, index });
  link.download = `douyin-${selectedDetail.id}-${index + 1}`;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
}

// 浏览器可能限制批量下载权限，因此每张图片间隔触发，避免请求瞬间拥塞。
function downloadAllImages() {
  imageUrls.forEach((_, index) => setTimeout(() => downloadImage(index), index * 180));
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
  const response = await fetch('/api/sync/status');
  const sync = await response.json();
  $('#status').textContent = sync.error || sync.message;
  $('#progress-value').style.width = `${sync.progress || 0}%`;
  $('#progress-detail').textContent = sync.running ? `${sync.progress || 0}% · 喜欢接口 ${sync.likePages} 页 · 收藏接口 ${sync.collectPages} 页` : '';
  $('#sync-status-close').hidden = sync.running;
  if (sync.running) return setTimeout(pollSync, 500);
  $('#sync').disabled = false;
  if (sync.error) { $('#status').classList.add('error'); return; }
  if (sync.data) {
    state.like = sync.data.like || [];
    state.collect = sync.data.collect || [];
    $('#status').textContent = `同步完成：喜欢 ${state.like.length} 条，收藏 ${state.collect.length} 条（${new Date(sync.data.syncedAt).toLocaleString()}）`;
    resetPageAndRender();
  }
}

async function pollUserSync() {
  const response = await fetch('/api/profile/sync/status');
  const sync = await response.json();
  $('#status').textContent = sync.error || sync.message;
  $('#progress-value').style.width = `${sync.progress || 0}%`;
  $('#progress-detail').textContent = sync.running ? `${sync.progress || 0}% · 已发现 ${sync.count || 0} 条作品` : '';
  $('#sync-status-close').hidden = sync.running;
  if (sync.running) return setTimeout(pollUserSync, 500);
  $('#profile-sync-start').disabled = false;
  if (sync.error) { $('#status').classList.add('error'); return; }
  if (Array.isArray(sync.data)) {
    state.user = sync.data;
    state.source = 'user';
    document.querySelectorAll('.tab').forEach(tab => tab.classList.toggle('active', tab.dataset.source === 'user'));
    resetPageAndRender();
    $('#status').textContent = `用户作品加载完成：${state.user.length} 条`;
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

// 喜欢/收藏标签切换只改变本地视图，不会重新请求抖音。
$('.tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  state.source = tab.dataset.source;
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  resetPageAndRender();
});
// 搜索和排序只作用于当前标签的数据。
$('#search').addEventListener('input', event => { state.query = event.target.value; resetPageAndRender(); });
$('#sort').addEventListener('change', event => { state.sort = event.target.value; resetPageAndRender(); });
// 指定下载只负责解析链接，详情展示和播放继续复用现有作品弹窗。
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
  const id = extractDouyinWorkId(input.value);
  if (!id) {
    $('#specified-download-error').textContent = '无法从该内容解析作品 ID，请检查链接后重试';
    input.focus();
    return;
  }
  button.disabled = true;
  $('#specified-download-error').textContent = '';
  $('#specified-download-modal').close();
  try {
    await openVideo({ id, title: '指定作品', author: '', mediaType: 'video' });
  } finally {
    button.disabled = false;
  }
});
$('#specified-download-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('#specified-download-open').click();
});
$('#download-all').addEventListener('click', () => {
  createDownloadJob().catch(error => { $('#download-status').hidden = false; $('#download-detail').textContent = error.message; });
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
  try {
    await fetch('/api/sync/start', { method: 'POST' });
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
  $('#sync-status').hidden = false;
  $('#progress-track').hidden = false;
  $('#progress-value').style.width = '0%';
  $('#sync-status-close').hidden = true;
  $('#status').classList.remove('error');
  try {
    const response = await fetch('/api/profile/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: url.href }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '启动用户作品加载失败');
    pollUserSync();
  } catch (error) {
    $('#status').textContent = error.message;
    $('#status').classList.add('error');
    button.disabled = false;
  }
});
$('#profile-sync-url').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('#profile-sync-start').click();
});
$('#sync-status-close').addEventListener('click', () => { $('#sync-status').hidden = true; });
$('#download-status-close').addEventListener('click', () => {
  rememberDismissedDownloadJob(downloadJob);
  $('#download-status').hidden = true;
});
// 页面刷新后恢复服务端内存中的最近一次同步结果。
async function restoreLatest() {
  try {
    const sync = await (await fetch('/api/sync/status')).json();
    if (sync.data) {
      state.like = sync.data.like || [];
      state.collect = sync.data.collect || [];
      state.user = sync.data.user || [];
      $('#status').textContent = `最近同步：喜欢 ${state.like.length} 条，收藏 ${state.collect.length} 条（${new Date(sync.data.syncedAt).toLocaleString()}）`;
      render();
    }
    const profileSync = await (await fetch('/api/profile/sync/status')).json();
    if (Array.isArray(profileSync.data) && profileSync.data.length) {
      state.user = profileSync.data;
      render();
    }
    if (profileSync.running) {
      $('#sync-status').hidden = false;
      $('#progress-track').hidden = false;
      pollUserSync();
    }
    const jobs = await (await fetch('/api/download/jobs')).json();
    const active = jobs.find(job => ['running', 'pending', 'paused', 'failed', 'completed_with_errors'].includes(job.status) && !isDismissedDownloadJob(job));
    if (active) {
      renderDownloadJob(active);
      if (['running', 'pending'].includes(active.status)) pollDownloadJob(active.id);
    }
  } catch { /* 本地服务重启期间保留空状态，页面仍可正常使用。 */ }
}
render();
restoreLatest();
