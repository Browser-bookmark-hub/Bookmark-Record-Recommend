// Minimal background for Bookmark Record & Recommend extension (MV3)

import {
  initialize as initializeActiveTimeTracker,
  setupEventListeners as setupActiveTimeTrackerListeners,
  setTrackingEnabled,
  isTrackingEnabled,
  noteAutoBookmarkNavigation,
  getCurrentActiveSessions,
  getSessionsByTimeRange,
  getTrackingStats,
  clearTrackingDisplayData,
  clearCurrentTrackingSessions,
  clearTrackingStatsByRange,
  syncTrackingData,
  restoreActiveSessionsFromStorage
} from './active_time_tracker/index.js';
import { upsertRepoFile } from './github/repo-api.js';

const browserAPI = (function () {
  if (typeof chrome !== 'undefined') return chrome;
  if (typeof browser !== 'undefined') return browser;
  throw new Error('Unsupported browser');
})();

async function getCurrentLang() {
  try {
    const { currentLang, preferredLang } = await browserAPI.storage.local.get(['currentLang', 'preferredLang']);
    return currentLang || preferredLang || 'zh_CN';
  } catch (_) {
    return 'zh_CN';
  }
}

function getExportRootFolderByLang(lang) {
  return lang === 'zh_CN' ? '书签记录 & 推荐' : 'Bookmark Records & Recommendations';
}

function getRecordsFolderByLang(lang) {
  return lang === 'zh_CN' ? '书签记录' : 'Records';
}

function getClickHistoryFolderByLang(lang) {
  return lang === 'zh_CN' ? '点击记录' : 'Click History';
}

function resolveExportSubFolderByKey(folderKey, lang) {
  const key = String(folderKey || '').trim();
  switch (key) {
    case 'records':
      return getRecordsFolderByLang(lang);
    case 'click_history':
      return getClickHistoryFolderByLang(lang);
    default:
      return getRecordsFolderByLang(lang);
  }
}

function safeBase64(str) {
  try {
    return btoa(str);
  } catch (_) {
    return btoa(unescape(encodeURIComponent(str)));
  }
}

function sanitizeGitHubRepoPathPart(part) {
  let s = String(part == null ? '' : part);
  s = s.replace(/[\x00-\x1F\x7F]/g, '');
  s = s.replace(/[\\/]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function buildGitHubRepoFilePath({ basePath, lang, folderKey, fileName }) {
  const baseRaw = String(basePath || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  const baseParts = baseRaw
    ? baseRaw.split('/').filter(Boolean).map(sanitizeGitHubRepoPathPart).filter(Boolean)
    : [];
  const root = sanitizeGitHubRepoPathPart(getExportRootFolderByLang(lang));
  const sub = sanitizeGitHubRepoPathPart(resolveExportSubFolderByKey(folderKey, lang));
  const leaf = sanitizeGitHubRepoPathPart(String(fileName || '').split('/').pop());
  const joined = [...baseParts, root, sub, leaf].filter(Boolean).join('/');
  return joined || 'export.txt';
}

function arrayBufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function textToBase64(text) {
  const encoder = new TextEncoder();
  const buf = encoder.encode(String(text ?? '')).buffer;
  return arrayBufferToBase64(buf);
}

const POPUP_FAVICON_CACHE_KEY = 'popup_favicon_cache_v1';
const POPUP_FAVICON_CACHE_MAX = 200;
const POPUP_FAVICON_CACHE_TTL_MS = 120 * 24 * 60 * 60 * 1000; // 120 days
let popupFaviconCache = null; // Map<domain, { dataUrl, time }>
let popupFaviconCacheLoading = null;
let popupFaviconSaveTimer = null;

function normalizeFaviconDomain(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const hostname = new URL(url).hostname || '';
    return hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

async function loadPopupFaviconCache() {
  if (popupFaviconCache) return popupFaviconCache;
  if (popupFaviconCacheLoading) return popupFaviconCacheLoading;
  popupFaviconCacheLoading = (async () => {
    try {
      const result = await browserAPI.storage.local.get([POPUP_FAVICON_CACHE_KEY]);
      const raw = result[POPUP_FAVICON_CACHE_KEY] || {};
      const now = Date.now();
      const map = new Map();
      for (const [domain, entry] of Object.entries(raw)) {
        const time = entry?.time || 0;
        const dataUrl = entry?.dataUrl || '';
        if (!dataUrl) continue;
        if (time && now - time > POPUP_FAVICON_CACHE_TTL_MS) continue;
        map.set(domain, { dataUrl, time: time || now });
      }
      popupFaviconCache = map;
      return popupFaviconCache;
    } catch (_) {
      popupFaviconCache = new Map();
      return popupFaviconCache;
    } finally {
      popupFaviconCacheLoading = null;
    }
  })();
  return popupFaviconCacheLoading;
}

function prunePopupFaviconCache(map) {
  if (map.size <= POPUP_FAVICON_CACHE_MAX) return map;
  const entries = Array.from(map.entries());
  entries.sort((a, b) => (a[1]?.time || 0) - (b[1]?.time || 0));
  const keep = entries.slice(entries.length - POPUP_FAVICON_CACHE_MAX);
  return new Map(keep);
}

function schedulePopupFaviconCacheSave() {
  if (popupFaviconSaveTimer) return;
  popupFaviconSaveTimer = setTimeout(async () => {
    popupFaviconSaveTimer = null;
    try {
      const map = await loadPopupFaviconCache();
      const pruned = prunePopupFaviconCache(map);
      popupFaviconCache = pruned;
      const obj = {};
      for (const [domain, entry] of pruned.entries()) {
        obj[domain] = { dataUrl: entry.dataUrl, time: entry.time };
      }
      await browserAPI.storage.local.set({ [POPUP_FAVICON_CACHE_KEY]: obj });
    } catch (_) { }
  }, 400);
}

async function getPopupFaviconFromCache(url) {
  const domain = normalizeFaviconDomain(url);
  if (!domain) return null;
  const cache = await loadPopupFaviconCache();
  const entry = cache.get(domain);
  if (!entry || !entry.dataUrl) return null;
  return entry.dataUrl;
}

async function savePopupFaviconToCache(url, dataUrl) {
  const domain = normalizeFaviconDomain(url);
  if (!domain || !dataUrl) return;
  const cache = await loadPopupFaviconCache();
  cache.set(domain, { dataUrl, time: Date.now() });
  popupFaviconCache = prunePopupFaviconCache(cache);
  schedulePopupFaviconCacheSave();
}

async function fetchFaviconDataUrl(url) {
  const domain = normalizeFaviconDomain(url);
  if (!domain) return null;
  const sources = [
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
  ];

  for (const src of sources) {
    try {
      const response = await fetch(src, { cache: 'force-cache' });
      if (!response.ok) continue;
      const contentType = response.headers.get('content-type') || 'image/png';
      const arrayBuffer = await response.arrayBuffer();
      if (!arrayBuffer || arrayBuffer.byteLength === 0) continue;
      const base64 = arrayBufferToBase64(arrayBuffer);
      return `data:${contentType};base64,${base64}`;
    } catch (_) {
      continue;
    }
  }
  return null;
}

async function fetchImageAsDataUrl(imageUrl) {
  try {
    if (!imageUrl) return null;
    if (imageUrl.startsWith('data:')) return imageUrl;
    const response = await fetch(imageUrl, { cache: 'force-cache' });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || 'image/png';
    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) return null;
    const base64 = arrayBufferToBase64(arrayBuffer);
    return `data:${contentType};base64,${base64}`;
  } catch (_) {
    return null;
  }
}

async function getOrFetchPopupFavicon(url) {
  const cached = await getPopupFaviconFromCache(url);
  if (cached) return cached;
  const dataUrl = await fetchFaviconDataUrl(url);
  if (dataUrl) {
    await savePopupFaviconToCache(url, dataUrl);
  }
  return dataUrl;
}

async function prefetchPopupFavicons(urls) {
  if (!Array.isArray(urls) || urls.length === 0) return;
  const unique = [];
  const seen = new Set();
  for (const url of urls) {
    const domain = normalizeFaviconDomain(url);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    unique.push(url);
    if (unique.length >= 12) break;
  }

  for (const url of unique) {
    try {
      const cached = await getPopupFaviconFromCache(url);
      if (cached) continue;
      await getOrFetchPopupFavicon(url);
    } catch (_) { }
  }
}

const processedPopupFavicons = new Map();
const POPUP_FAVICON_UPDATE_COOLDOWN = 5000;

if (browserAPI.tabs && browserAPI.tabs.onUpdated) {
  browserAPI.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    try {
      if (!changeInfo?.favIconUrl || !tab?.url) return;
      if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) return;

      const now = Date.now();
      const last = processedPopupFavicons.get(tab.url);
      if (last && (now - last) < POPUP_FAVICON_UPDATE_COOLDOWN) return;
      processedPopupFavicons.set(tab.url, now);

      if (processedPopupFavicons.size > 1000) {
        const entries = Array.from(processedPopupFavicons.entries());
        entries.sort((a, b) => a[1] - b[1]);
        entries.slice(0, 500).forEach(([url]) => processedPopupFavicons.delete(url));
      }

      const dataUrl = await fetchImageAsDataUrl(changeInfo.favIconUrl || tab.favIconUrl);
      if (dataUrl) {
        await savePopupFaviconToCache(tab.url, dataUrl);
        try {
          browserAPI.runtime.sendMessage({
            action: 'updateFaviconFromTab',
            url: tab.url,
            favIconUrl: dataUrl
          }).catch(() => {});
        } catch (_) {}
      }
    } catch (_) { }
  });
}

async function ensureWebDAVCollectionExists(url, authHeader, errorPrefix) {
  const checkResponse = await fetch(url, {
    method: 'PROPFIND',
    headers: {
      'Authorization': authHeader,
      'Depth': '0',
      'Content-Type': 'application/xml'
    },
    body: '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>'
  });

  if (checkResponse.status === 401) {
    throw new Error('WebDAV认证失败，请检查账号密码是否正确');
  }

  if (checkResponse.status === 404) {
    const mkcolResponse = await fetch(url, {
      method: 'MKCOL',
      headers: { 'Authorization': authHeader }
    });
    if (!mkcolResponse.ok && mkcolResponse.status !== 405) {
      throw new Error(`${errorPrefix}: ${mkcolResponse.status} - ${mkcolResponse.statusText}`);
    }
    return;
  }

  if (!checkResponse.ok) {
    throw new Error(`${errorPrefix}: ${checkResponse.status} - ${checkResponse.statusText}`);
  }
}

async function uploadExportFileToWebDAV({ lang, folderKey, fileName, content, contentArrayBuffer, contentType }) {
  const config = await browserAPI.storage.local.get(['serverAddress', 'username', 'password', 'webDAVEnabled']);
  if (!config.serverAddress || !config.username || !config.password) {
    return { success: false, skipped: true, error: 'WebDAV 配置不完整' };
  }
  if (config.webDAVEnabled === false) {
    return { success: false, skipped: true, error: 'WebDAV 已禁用' };
  }

  const serverAddress = config.serverAddress.replace(/\/+$/, '/');
  const exportRootFolder = getExportRootFolderByLang(lang);
  const exportSubFolder = resolveExportSubFolderByKey(folderKey, lang);
  const folderPath = `${exportRootFolder}/${exportSubFolder}/`;

  const fullUrl = `${serverAddress}${folderPath}${fileName}`;
  const folderUrl = `${serverAddress}${folderPath}`;
  const parentFolderUrl = `${serverAddress}${exportRootFolder}/`;

  const authHeader = 'Basic ' + safeBase64(`${config.username}:${config.password}`);

  try {
    await ensureWebDAVCollectionExists(parentFolderUrl, authHeader, '创建父文件夹失败');
    await ensureWebDAVCollectionExists(folderUrl, authHeader, '创建导出文件夹失败');

    const response = await fetch(fullUrl, {
      method: 'PUT',
      headers: {
        'Authorization': authHeader,
        'Content-Type': contentType || 'text/plain;charset=utf-8',
        'Overwrite': 'T'
      },
      body: contentArrayBuffer ? contentArrayBuffer : String(content ?? '')
    });

    if (!response.ok) {
      throw new Error(`上传失败: ${response.status} - ${response.statusText}`);
    }

    return { success: true };
  } catch (error) {
    if (String(error?.message || '').includes('Failed to fetch')) {
      return { success: false, error: '无法连接到WebDAV服务器，请检查地址是否正确或网络是否正常' };
    }
    return { success: false, error: error?.message || '上传到WebDAV失败' };
  }
}

async function uploadExportFileToGitHubRepo({ lang, folderKey, fileName, content, contentArrayBuffer }) {
  const config = await browserAPI.storage.local.get([
    'githubRepoToken',
    'githubRepoOwner',
    'githubRepoName',
    'githubRepoBranch',
    'githubRepoBasePath',
    'githubRepoEnabled'
  ]);

  if (!config.githubRepoToken) {
    return { success: false, skipped: true, error: 'GitHub Token 未配置' };
  }
  if (!config.githubRepoOwner || !config.githubRepoName) {
    return { success: false, skipped: true, error: '仓库未配置' };
  }
  if (config.githubRepoEnabled === false) {
    return { success: false, skipped: true, error: 'GitHub 仓库已禁用' };
  }

  const filePath = buildGitHubRepoFilePath({ basePath: config.githubRepoBasePath, lang, folderKey, fileName });
  const leaf = String(fileName || '').split('/').pop() || 'export';
  const commitMessage = `Bookmark Records: export ${folderKey} ${leaf}`;
  const contentBase64 = contentArrayBuffer ? arrayBufferToBase64(contentArrayBuffer) : textToBase64(content);

  try {
    const result = await upsertRepoFile({
      token: config.githubRepoToken,
      owner: config.githubRepoOwner,
      repo: config.githubRepoName,
      branch: config.githubRepoBranch,
      path: filePath,
      message: commitMessage,
      contentBase64
    });

    if (result && result.success === true) {
      return { success: true, path: result.path || filePath, htmlUrl: result.htmlUrl || null };
    }

    return { success: false, error: result?.error || '上传到 GitHub 仓库失败' };
  } catch (error) {
    return { success: false, error: error?.message || '上传到 GitHub 仓库失败' };
  }
}

function openView(view) {
  const safeView = view === 'recommend' ? 'recommend' : 'additions';
  try {
    browserAPI.storage.local.set({
      historyRequestedView: { view: safeView, time: Date.now() }
    }, () => {});
  } catch (_) {}
  const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
  const url = `${baseUrl}?view=${safeView}`;
  browserAPI.tabs.create({ url });
}

if (browserAPI.commands && browserAPI.commands.onCommand) {
  browserAPI.commands.onCommand.addListener((command) => {
    if (command === 'open_additions_view') openView('additions');
    if (command === 'open_recommend_view') openView('recommend');
  });
}

// Initialize active time tracker
(async () => {
  try {
    await initializeActiveTimeTracker();
    setupActiveTimeTrackerListeners();
    try {
      await restoreActiveSessionsFromStorage();
    } catch (_) {}
  } catch (e) {
    console.warn('[ActiveTime] init failed:', e);
  }
})();

// Auto-bookmark attribution (auto_bookmark transition)
const PENDING_AUTO_BOOKMARK_CLICKS_KEY = 'bb_pending_auto_bookmark_clicks_v1';
const PENDING_AUTO_BOOKMARK_CLICKS_MAX = 5000;
const PENDING_AUTO_BOOKMARK_CLICKS_KEEP_MS = 400 * 24 * 60 * 60 * 1000; // ~400 days

async function appendPendingAutoBookmarkClick(event) {
  try {
    const result = await browserAPI.storage.local.get([PENDING_AUTO_BOOKMARK_CLICKS_KEY]);
    const existing = result[PENDING_AUTO_BOOKMARK_CLICKS_KEY];
    const list = Array.isArray(existing) ? existing : [];

    list.push(event);

    const now = Date.now();
    const cutoff = now - PENDING_AUTO_BOOKMARK_CLICKS_KEEP_MS;
    const pruned = list
      .filter(e => e && typeof e.visitTime === 'number' && e.visitTime >= cutoff)
      .slice(-PENDING_AUTO_BOOKMARK_CLICKS_MAX);

    await browserAPI.storage.local.set({ [PENDING_AUTO_BOOKMARK_CLICKS_KEY]: pruned });
  } catch (error) {
    console.warn('[AutoBookmarkOpen] failed to write pending clicks:', error);
  }
}

function setupAutoBookmarkOpenMonitoring() {
  try {
    if (!browserAPI.webNavigation || !browserAPI.webNavigation.onCommitted) return;

    browserAPI.webNavigation.onCommitted.addListener(async (details) => {
      try {
        if (!details || details.frameId !== 0) return;
        if (details.transitionType !== 'auto_bookmark') return;

        const url = details.url;
        if (!url || (typeof url !== 'string')) return;
        if (!url.startsWith('http://') && !url.startsWith('https://')) return;

        let bookmarkId = null;
        let bookmarkTitle = '';

        try {
          const matches = await browserAPI.bookmarks.search({ url });
          if (Array.isArray(matches) && matches.length > 0) {
            bookmarkId = matches[0].id || null;
            bookmarkTitle = matches[0].title || '';
          }
        } catch (_) {}

        if (!bookmarkTitle) {
          try {
            const tab = await browserAPI.tabs.get(details.tabId);
            bookmarkTitle = tab?.title || '';
          } catch (_) {}
        }

        noteAutoBookmarkNavigation({
          tabId: details.tabId,
          bookmarkUrl: url,
          bookmarkId,
          bookmarkTitle,
          timeStamp: typeof details.timeStamp === 'number' ? details.timeStamp : Date.now(),
          source: 'browser_auto_bookmark'
        });
      } catch (error) {
        console.warn('[AutoBookmarkOpen] failed to handle event:', error);
      }
    });
  } catch (error) {
    console.warn('[AutoBookmarkOpen] init failed:', error);
  }
}

setupAutoBookmarkOpenMonitoring();

// =================================================================================
// Bookmark Recommend S-score system
// =================================================================================

let isComputingScores = false;
let isBookmarkImporting = false;
let isBookmarkBulkChanging = false;
let bookmarkBulkWindowStart = 0;
let bookmarkBulkEventCount = 0;
let bookmarkBulkExitTimer = null;
let scheduledRecomputeTimer = null;
let lastBulkReason = '';
let scoreCacheMode = null;

const BOOKMARK_BULK_WINDOW_MS = 800;
const BOOKMARK_BULK_THRESHOLD = 8;
const BOOKMARK_BULK_QUIET_MS = 5000;

const SCORE_CACHE_MODE_KEY = 'recommend_scores_cache_mode';
const SCORE_CACHE_MODE_FULL = 'full';
const SCORE_CACHE_MODE_COMPACT = 'compact';
const SCORE_CACHE_COMPACT_THRESHOLD = 8000;

async function invalidateRecommendCaches(reason = '') {
  try {
    await browserAPI.storage.local.set({
      recommend_scores_cache: {},
      recommend_scores_time: 0,
      [SCORE_CACHE_MODE_KEY]: SCORE_CACHE_MODE_COMPACT,
      recommendScoresStaleMeta: {
        staleAt: Date.now(),
        reason: reason || 'unknown'
      }
    });
  } catch (_) { }
  scoreCacheMode = SCORE_CACHE_MODE_COMPACT;

  // 推荐卡片状态依赖 bookmarkId：批量导入/删除/移动后可能大量失效
  try {
    await browserAPI.storage.local.remove(['popupCurrentCards']);
  } catch (_) { }
}

function scheduleBookmarkBulkExit() {
  if (bookmarkBulkExitTimer) {
    clearTimeout(bookmarkBulkExitTimer);
  }
  bookmarkBulkExitTimer = setTimeout(() => {
    bookmarkBulkExitTimer = null;
    exitBookmarkBulkChangeMode().catch(() => { });
  }, BOOKMARK_BULK_QUIET_MS);
}

function scheduleRecomputeAllScoresSoon(reason = '') {
  if (scheduledRecomputeTimer) clearTimeout(scheduledRecomputeTimer);
  scheduledRecomputeTimer = setTimeout(() => {
    scheduledRecomputeTimer = null;
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    computeAllBookmarkScores()
      .then(() => {
        try {
          browserAPI.storage.local.set({
            recommendScoresStaleMeta: { staleAt: 0, reason: reason || '' }
          });
        } catch (_) { }
      })
      .catch(() => { });
  }, 800);
}

async function getScoreCacheMode() {
  if (scoreCacheMode === SCORE_CACHE_MODE_FULL || scoreCacheMode === SCORE_CACHE_MODE_COMPACT) {
    return scoreCacheMode;
  }
  try {
    const result = await browserAPI.storage.local.get([SCORE_CACHE_MODE_KEY]);
    const mode = result?.[SCORE_CACHE_MODE_KEY];
    scoreCacheMode = mode === SCORE_CACHE_MODE_FULL ? SCORE_CACHE_MODE_FULL : SCORE_CACHE_MODE_COMPACT;
    return scoreCacheMode;
  } catch (_) {
    scoreCacheMode = SCORE_CACHE_MODE_COMPACT;
    return scoreCacheMode;
  }
}

async function enterBookmarkBulkChangeMode(reason = '') {
  if (isBookmarkBulkChanging) {
    scheduleBookmarkBulkExit();
    return;
  }

  isBookmarkBulkChanging = true;
  lastBulkReason = reason || 'unknown';
  try { await browserAPI.storage.local.set({ bookmarkBulkChangeFlag: true }); } catch (_) { }
  await invalidateRecommendCaches(`bulk:${reason || 'unknown'}`);
  scheduleBookmarkBulkExit();
}

async function exitBookmarkBulkChangeMode() {
  if (!isBookmarkBulkChanging) return;

  isBookmarkBulkChanging = false;
  bookmarkBulkWindowStart = 0;
  bookmarkBulkEventCount = 0;
  try { await browserAPI.storage.local.set({ bookmarkBulkChangeFlag: false }); } catch (_) { }

  // 导入场景：不要自动全量重算，避免导入结束“立刻重算”再次拉跨浏览器；交给 UI 按需触发。
  const reason = String(lastBulkReason || '');
  if (!reason.startsWith('import')) {
    scheduleRecomputeAllScoresSoon('bulk-exit');
  }
}

function noteBookmarkEventForBulkGuard(eventType = '') {
  // 导入本身有独立 flag：不需要通过计数进入 bulk
  // 重要：导入期间事件极多，频繁 clearTimeout/setTimeout 也会带来额外卡顿
  if (isBookmarkImporting) {
    return;
  }

  const now = Date.now();
  if (!bookmarkBulkWindowStart || now - bookmarkBulkWindowStart > BOOKMARK_BULK_WINDOW_MS) {
    bookmarkBulkWindowStart = now;
    bookmarkBulkEventCount = 0;
  }

  bookmarkBulkEventCount += 1;

  if (!isBookmarkBulkChanging && bookmarkBulkEventCount >= BOOKMARK_BULK_THRESHOLD) {
    enterBookmarkBulkChangeMode(eventType || 'events').catch(() => { });
    return;
  }

  if (isBookmarkBulkChanging) {
    scheduleBookmarkBulkExit();
  }
}

async function getFormulaConfig() {
  const result = await browserAPI.storage.local.get(['recommendFormulaConfig', 'trackingEnabled']);
  const config = result.recommendFormulaConfig || {
    weights: { freshness: 0.15, coldness: 0.25, shallowRead: 0.20, forgetting: 0.25, laterReview: 0.15 },
    thresholds: { freshness: 90, coldness: 10, shallowRead: 5, forgetting: 14 }
  };
  config.trackingEnabled = result.trackingEnabled !== false;
  return config;
}

async function getBlockedDataForScore() {
  const result = await browserAPI.storage.local.get(['blockedBookmarks', 'blockedDomains', 'blockedFolders']);
  return {
    bookmarks: new Set(result.blockedBookmarks || []),
    domains: new Set(result.blockedDomains || []),
    folders: new Set(result.blockedFolders || [])
  };
}

async function getScoresCache() {
  const result = await browserAPI.storage.local.get(['recommend_scores_cache']);
  return result.recommend_scores_cache || {};
}

async function saveScoresCache(cache) {
  try {
    await browserAPI.storage.local.set({ recommend_scores_cache: cache });
  } catch (error) {
    if (error.message && error.message.includes('QUOTA')) {
      console.warn('[S-score] storage quota reached, cleaning...');
      try {
        const keysToCheck = ['flippedBookmarks', 'thumbnailCache', 'recommend_postponed'];
        const data = await browserAPI.storage.local.get(keysToCheck);

        if (data.flippedBookmarks) {
          const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const filtered = {};
          for (const [id, time] of Object.entries(data.flippedBookmarks)) {
            if (time > oneWeekAgo) filtered[id] = time;
          }
          await browserAPI.storage.local.set({ flippedBookmarks: filtered });
        }

        if (data.thumbnailCache) {
          await browserAPI.storage.local.remove(['thumbnailCache']);
        }

        await browserAPI.storage.local.set({ recommend_scores_cache: cache });
      } catch (retryError) {
        console.error('[S-score] save after cleanup failed:', retryError);
      }
    } else {
      console.error('[S-score] save failed:', error);
    }
  }
}

async function getPostponedBookmarksForScore() {
  const result = await browserAPI.storage.local.get(['recommend_postponed']);
  return result.recommend_postponed || [];
}

async function getReviewDataForScore() {
  const result = await browserAPI.storage.local.get(['recommend_reviews']);
  return result.recommend_reviews || {};
}

async function getTrackingDataForScore() {
  try {
    const stats = await getTrackingStats();
    const byUrl = new Map();
    const byTitle = new Map();
    const byBookmarkId = new Map();

    for (const [key, stat] of Object.entries(stats)) {
      const data = {
        url: stat.url,
        title: stat.title || key,
        compositeMs: stat.totalCompositeMs || 0,
        bookmarkId: stat.bookmarkId || null
      };
      if (stat.url) byUrl.set(stat.url, data);
      if (stat.title) byTitle.set(stat.title, data);
      if (stat.bookmarkId) byBookmarkId.set(stat.bookmarkId, data);
    }

    return { byUrl, byTitle, byBookmarkId };
  } catch (e) {
    console.warn('[S-score] tracking stats failed:', e);
    return { byUrl: new Map(), byTitle: new Map(), byBookmarkId: new Map() };
  }
}

function calculateFactorValue(value, threshold, inverse = false) {
  if (value <= 0) return inverse ? 1 : 0;
  const safeThreshold = Math.max(1, threshold || 1);
  const decayed = 1 / (1 + Math.pow(value / safeThreshold, 0.7));
  return inverse ? decayed : (1 - decayed);
}

function calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData) {
  const now = Date.now();
  const thresholds = config.thresholds;

  let history = historyStats.get(bookmark.url);
  if (!history || history.visitCount === 0) {
    if (bookmark.title && historyStats.titleMap) {
      history = historyStats.titleMap.get(bookmark.title);
    }
  }
  history = history || { visitCount: 0, lastVisitTime: 0 };

  let compositeMs = 0;
  if (bookmark.id && trackingData.byBookmarkId && trackingData.byBookmarkId.has(bookmark.id)) {
    compositeMs = trackingData.byBookmarkId.get(bookmark.id).compositeMs;
  } else if (bookmark.url && trackingData.byUrl.has(bookmark.url)) {
    compositeMs = trackingData.byUrl.get(bookmark.url).compositeMs;
  } else if (bookmark.title && trackingData.byTitle && trackingData.byTitle.has(bookmark.title)) {
    const titleHit = trackingData.byTitle.get(bookmark.title);
    if (titleHit) {
      if (bookmark.id && titleHit.bookmarkId && titleHit.bookmarkId === bookmark.id) {
        compositeMs = titleHit.compositeMs;
      } else if (!bookmark.id && !titleHit.bookmarkId) {
        compositeMs = titleHit.compositeMs;
      }
    }
  }

  const daysSinceAdded = (now - (bookmark.dateAdded || now)) / (1000 * 60 * 60 * 24);
  const F = calculateFactorValue(daysSinceAdded, thresholds.freshness, true);

  const C = calculateFactorValue(history.visitCount, thresholds.coldness, true);

  const compositeMinutes = compositeMs / (1000 * 60);
  const T = calculateFactorValue(compositeMinutes, thresholds.shallowRead, true);

  let daysSinceLastVisit = thresholds.forgetting;
  if (history.lastVisitTime > 0) {
    daysSinceLastVisit = (now - history.lastVisitTime) / (1000 * 60 * 60 * 24);
  }
  const D = calculateFactorValue(daysSinceLastVisit, thresholds.forgetting, false);

  let L = 0;
  const postponeInfo = postponedList.find(p => p.bookmarkId === bookmark.id);
  if (postponeInfo && postponeInfo.manuallyAdded) {
    L = 1;
  }

  let R = 1;
  const review = reviewData[bookmark.id];
  if (review) {
    const daysSinceReview = (now - review.lastReview) / (1000 * 60 * 60 * 24);
    const reviewCount = review.reviewCount || 1;
    const stabilityTable = [3, 7, 14, 30, 60];
    const stability = stabilityTable[Math.min(reviewCount - 1, stabilityTable.length - 1)];
    const needReview = 1 - Math.pow(0.9, daysSinceReview / stability);
    R = 0.7 + 0.3 * needReview;
    R = Math.max(0.7, Math.min(1, R));
  }

  let w1 = config.weights.freshness || 0.15;
  let w2 = config.weights.coldness || 0.25;
  let w3 = config.weights.shallowRead || 0.20;
  let w4 = config.weights.forgetting || 0.25;
  let w5 = config.weights.laterReview || 0.15;

  if (!config.trackingEnabled) {
    const remaining = w1 + w2 + w4 + w5;
    if (remaining > 0) {
      w1 = w1 / remaining;
      w2 = w2 / remaining;
      w4 = w4 / remaining;
      w5 = w5 / remaining;
    }
    w3 = 0;
  }

  const basePriority = w1 * F + w2 * C + w3 * T + w4 * D + w5 * L;
  const priority = basePriority * R;
  const randomFactor = (Math.random() - 0.5) * 0.1;
  const S = Math.max(0, Math.min(1, priority + randomFactor));

  return { S, F, C, T, D, L, R };
}

async function getBatchHistoryDataWithTitle() {
  const urlMap = new Map();
  const titleMap = new Map();

  if (!browserAPI.history) return { urlMap, titleMap };

  try {
    const oneHundredEightyDaysAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const historyItems = await new Promise(resolve => {
      browserAPI.history.search({
        text: '',
        startTime: oneHundredEightyDaysAgo,
        maxResults: 50000
      }, resolve);
    });

    for (const item of historyItems) {
      if (!item.url) continue;
      const data = {
        visitCount: item.visitCount || 0,
        lastVisitTime: item.lastVisitTime || 0
      };

      urlMap.set(item.url, data);

      const title = item.title && item.title.trim();
      if (title) {
        if (!titleMap.has(title)) {
          titleMap.set(title, data);
        } else {
          const existing = titleMap.get(title);
          titleMap.set(title, {
            visitCount: existing.visitCount + data.visitCount,
            lastVisitTime: Math.max(existing.lastVisitTime, data.lastVisitTime)
          });
        }
      }
    }
  } catch (e) {
    console.warn('[S-score] batch history load failed:', e);
  }

  const result = urlMap;
  result.titleMap = titleMap;
  return result;
}

async function computeAllBookmarkScores() {
  if (isComputingScores) {
    return false;
  }
  if (isBookmarkImporting) {
    return false;
  }
  isComputingScores = true;

  try {
    const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
    const allBookmarks = [];
    function traverse(nodes, ancestors = []) {
      for (const node of nodes) {
        if (node.url) allBookmarks.push({ ...node, ancestorFolderIds: ancestors });
        if (node.children) {
          const nextAncestors = node.url ? ancestors : [...ancestors, node.id];
          traverse(node.children, nextAncestors);
        }
      }
    }
    traverse(tree, []);

    if (allBookmarks.length === 0) {
      isComputingScores = false;
      return true;
    }

    const [blocked, config, historyStats, trackingData, postponedList, reviewData] = await Promise.all([
      getBlockedDataForScore(),
      getFormulaConfig(),
      getBatchHistoryDataWithTitle(),
      getTrackingDataForScore(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);

    const isBlockedDomain = (bookmark) => {
      if (blocked.domains.size === 0 || !bookmark.url) return false;
      try {
        const url = new URL(bookmark.url);
        return blocked.domains.has(url.hostname);
      } catch {
        return false;
      }
    };

    const isInBlockedFolder = (bookmark) => {
      if (blocked.folders.size === 0) return false;
      if (bookmark.parentId && blocked.folders.has(bookmark.parentId)) return true;
      const ancestorFolderIds = bookmark.ancestorFolderIds || [];
      for (const folderId of ancestorFolderIds) {
        if (blocked.folders.has(folderId)) return true;
      }
      return false;
    };

    const availableBookmarks = allBookmarks.filter(b =>
      !blocked.bookmarks.has(b.id) &&
      !isInBlockedFolder(b) &&
      !isBlockedDomain(b)
    );

    const totalCount = availableBookmarks.length;
    const nextMode = totalCount > SCORE_CACHE_COMPACT_THRESHOLD ? SCORE_CACHE_MODE_COMPACT : SCORE_CACHE_MODE_FULL;
    scoreCacheMode = nextMode;
    try { await browserAPI.storage.local.set({ [SCORE_CACHE_MODE_KEY]: nextMode }); } catch (_) { }

    let batchCount = 1;
    if (totalCount > 1000) {
      batchCount = 3;
    } else if (totalCount > 500) {
      batchCount = 2;
    }
    const batchSize = Math.ceil(totalCount / batchCount);

    const newCache = {};
    let computedCount = 0;
    for (let i = 0; i < batchCount; i++) {
      const start = i * batchSize;
      const end = Math.min(start + batchSize, totalCount);
      const batchBookmarks = availableBookmarks.slice(start, end);

      for (const bookmark of batchBookmarks) {
        const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
        newCache[bookmark.id] = nextMode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
        computedCount += 1;
        // 大量书签时让出事件循环，避免 service worker 长时间无响应
        if (computedCount % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      if (i < batchCount - 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }

    await saveScoresCache(newCache);
    isComputingScores = false;
    return true;
  } catch (error) {
    console.error('[S-score] compute failed:', error);
    isComputingScores = false;
    return false;
  }
}

async function updateSingleBookmarkScore(bookmarkId) {
  try {
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([bookmarkId], resolve));
    if (!bookmarks || bookmarks.length === 0) return;

    const bookmark = bookmarks[0];
    if (!bookmark || !bookmark.url) return;

    const historyStats = new Map();
    if (browserAPI.history && bookmark.url) {
      const visits = await new Promise(resolve => {
        browserAPI.history.getVisits({ url: bookmark.url }, resolve);
      });
      historyStats.set(bookmark.url, {
        visitCount: visits?.length || 0,
        lastVisitTime: visits?.length > 0 ? Math.max(...visits.map(v => v.visitTime)) : 0
      });

      if (bookmark.title) {
        historyStats.titleMap = new Map();
        try {
          const historyItems = await new Promise(resolve => {
            browserAPI.history.search({ text: bookmark.title, maxResults: 100 }, resolve);
          });
          for (const item of historyItems) {
            if (item.title?.trim() === bookmark.title.trim()) {
              const existing = historyStats.titleMap.get(bookmark.title) || { visitCount: 0, lastVisitTime: 0 };
              historyStats.titleMap.set(bookmark.title, {
                visitCount: existing.visitCount + (item.visitCount || 0),
                lastVisitTime: Math.max(existing.lastVisitTime, item.lastVisitTime || 0)
              });
            }
          }
        } catch (_) {}
      }
    }

    const [config, trackingData, postponedList, reviewData] = await Promise.all([
      getFormulaConfig(),
      getTrackingDataForScore(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);

    const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
    const mode = await getScoreCacheMode();
    const cache = await getScoresCache();
    cache[bookmarkId] = mode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
    await saveScoresCache(cache);
  } catch (e) {
    console.warn('[S-score] incremental update failed:', e);
  }
}

let pendingUrlUpdates = new Set();
let urlUpdateTimer = null;

async function scheduleScoreUpdateByUrl(url) {
  if (!url) return;
  pendingUrlUpdates.add(url);

  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);

  urlUpdateTimer = setTimeout(async () => {
    const urls = [...pendingUrlUpdates];
    pendingUrlUpdates.clear();
    urlUpdateTimer = null;

    try {
      const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
      const bookmarks = [];
      function traverse(nodes) {
        for (const node of nodes) {
          if (node.url && urls.includes(node.url)) bookmarks.push(node);
          if (node.children) traverse(node.children);
        }
      }
      traverse(tree);

      for (const bookmark of bookmarks) {
        await updateSingleBookmarkScore(bookmark.id);
      }
    } catch (e) {
      console.warn('[S-score] URL update failed:', e);
    }
  }, 1000);
}

if (browserAPI.history && browserAPI.history.onVisited) {
  browserAPI.history.onVisited.addListener((result) => {
    if (result && result.url) {
      scheduleScoreUpdateByUrl(result.url);
    }
  });
}

browserAPI.bookmarks.onCreated.addListener((id, bookmark) => {
  noteBookmarkEventForBulkGuard('created');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (bookmark.url) {
    setTimeout(() => updateSingleBookmarkScore(id), 500);
  }
});

browserAPI.bookmarks.onRemoved.addListener(async (id) => {
  noteBookmarkEventForBulkGuard('removed');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  const cache = await getScoresCache();
  if (cache[id]) {
    delete cache[id];
    await saveScoresCache(cache);
  }
});

browserAPI.bookmarks.onChanged.addListener(async (id, changeInfo) => {
  noteBookmarkEventForBulkGuard('changed');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (changeInfo.url || changeInfo.title) {
    await updateSingleBookmarkScore(id);
    if (changeInfo.url) {
      try {
        browserAPI.runtime.sendMessage({
          action: 'clearFaviconCache',
          url: changeInfo.url
        }).catch(() => {});
      } catch (_) {}
    }
  }
});

// 移动/重排不直接影响 S 值公式，但在大批量移动时会触发事件风暴：用 bulk guard 兜底降噪
if (browserAPI.bookmarks.onMoved) {
  browserAPI.bookmarks.onMoved.addListener(() => {
    noteBookmarkEventForBulkGuard('moved');
  });
}

// Chrome 书签管理器“导入书签”会触发 onImportBegan/onImportEnded（并伴随大量 onCreated/onMoved 等）
try {
  if (browserAPI.bookmarks.onImportBegan) {
    browserAPI.bookmarks.onImportBegan.addListener(() => {
      isBookmarkImporting = true;
      enterBookmarkBulkChangeMode('import').catch(() => { });
    });
  }
  if (browserAPI.bookmarks.onImportEnded) {
    browserAPI.bookmarks.onImportEnded.addListener(() => {
      isBookmarkImporting = false;
      scheduleBookmarkBulkExit();
    });
  }
} catch (_) { }

// =================================================================================
// Runtime message handler
// =================================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.action) {
    sendResponse({ success: false, error: 'Invalid message' });
    return;
  }

  const action = message.action;

  if (action === 'exportFileToClouds') {
    (async () => {
      try {
        const fileName = String(message.fileName || '').trim();
        const folderKey = String(message.folderKey || '').trim();
        const contentType = message.contentType;
        let contentArrayBuffer = message.contentArrayBuffer || null;

        if (!contentArrayBuffer && message.contentBase64Binary) {
          try {
            const base64 = message.contentBase64Binary;
            const binaryString = atob(base64);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            contentArrayBuffer = bytes.buffer;
          } catch (e) {
            console.error('[exportFileToClouds] Base64 解码失败:', e);
          }
        }

        const content = message.content;
        if (!fileName) throw new Error('缺少文件名');
        if (!folderKey) throw new Error('缺少导出类型');
        if (!contentArrayBuffer && (content == null || content === '')) throw new Error('缺少导出内容');

        const lang = message.lang || await getCurrentLang();

        const [webdav, githubRepo] = await Promise.all([
          uploadExportFileToWebDAV({
            lang,
            folderKey,
            fileName,
            content,
            contentArrayBuffer,
            contentType
          }),
          uploadExportFileToGitHubRepo({
            lang,
            folderKey,
            fileName,
            content,
            contentArrayBuffer
          })
        ]);

        const success =
          (webdav && webdav.success === true) || (githubRepo && githubRepo.success === true);

        sendResponse({ success, webdav, githubRepo });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || '导出到云端失败' });
      }
    })();

    return true;
  }

  if (action === 'extensionBookmarkOpen') {
    (async () => {
      try {
        const url = message.url;
        const tabId = typeof message.tabId === 'number' ? message.tabId : null;
        const title = typeof message.title === 'string' ? message.title : '';
        const bookmarkId = typeof message.bookmarkId === 'string' ? message.bookmarkId : null;

        if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          sendResponse({ success: false, error: 'Invalid URL' });
          return;
        }

        if (tabId != null) {
          noteAutoBookmarkNavigation({
            tabId,
            bookmarkUrl: url,
            bookmarkId,
            bookmarkTitle: title || '',
            timeStamp: Date.now(),
            source: 'extension'
          });
        }

        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'attributedBookmarkOpen') {
    (async () => {
      try {
        const url = message.url;
        const title = typeof message.title === 'string' ? message.title : '';
        const transition = typeof message.transition === 'string' ? message.transition : 'attributed';

        if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          sendResponse({ success: false, error: 'Invalid URL' });
          return;
        }

        await appendPendingAutoBookmarkClick({
          id: `attributed-${Math.floor(Date.now())}`,
          title: title || url,
          url,
          visitTime: Date.now(),
          transition
        });
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'isTrackingEnabled') {
    (async () => {
      try {
        const enabled = await isTrackingEnabled();
        sendResponse({ success: true, enabled });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setTrackingEnabled') {
    (async () => {
      try {
        await setTrackingEnabled(!!message.enabled);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getCurrentActiveSessions') {
    (async () => {
      try {
        const sessions = await getCurrentActiveSessions();
        sendResponse({ success: true, sessions });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getActiveSessions') {
    (async () => {
      try {
        const startTime = Number(message.startTime || 0);
        const endTime = Number(message.endTime || Date.now());
        const sessions = await getSessionsByTimeRange(startTime, endTime);
        sendResponse({ success: true, sessions });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getTrackingStats') {
    (async () => {
      try {
        const stats = await getTrackingStats();
        sendResponse({ success: true, stats });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearTrackingDisplayData') {
    (async () => {
      try {
        await clearTrackingDisplayData();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearCurrentTrackingSessions') {
    (async () => {
      try {
        await clearCurrentTrackingSessions();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'clearTrackingStatsByRange') {
    (async () => {
      try {
        const range = message.range || 'all';
        const result = await clearTrackingStatsByRange(range);
        sendResponse({ success: true, cleared: result?.cleared || 0 });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'syncTrackingData') {
    (async () => {
      try {
        const result = await syncTrackingData();
        sendResponse({ success: true, result });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'computeBookmarkScores') {
    (async () => {
      try {
        const ok = await computeAllBookmarkScores();
        sendResponse({ success: true, computed: ok });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScore') {
    (async () => {
      try {
        if (message.bookmarkId) {
          await updateSingleBookmarkScore(message.bookmarkId);
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoreByUrl') {
    (async () => {
      try {
        if (message.url) {
          await scheduleScoreUpdateByUrl(message.url);
        }
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getPopupFavicon') {
    (async () => {
      try {
        const url = message.url;
        if (!url) {
          sendResponse({ success: false, error: 'Missing URL' });
          return;
        }
        const dataUrl = await getOrFetchPopupFavicon(url);
        sendResponse({ success: true, dataUrl: dataUrl || null });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'prefetchPopupFavicons') {
    (async () => {
      try {
        await prefetchPopupFavicons(message.urls || []);
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'trackingDataUpdated') {
    if (message.url) {
      scheduleScoreUpdateByUrl(message.url);
    }
    return false;
  }

  sendResponse({ success: false, error: 'Unsupported action' });
});
