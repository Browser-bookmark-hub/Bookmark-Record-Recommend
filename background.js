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
const browserAPI = (function () {
  if (typeof chrome !== 'undefined') return chrome;
  if (typeof browser !== 'undefined') return browser;
  throw new Error('Unsupported browser');
})();

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

const SCORE_ALGO_VERSION_KEY = 'recommend_scores_algo_version';
const SCORE_ALGO_VERSION = 6;

const SCORE_CACHE_MODE_KEY = 'recommend_scores_cache_mode';
const SCORE_CACHE_MODE_FULL = 'full';
const SCORE_CACHE_MODE_COMPACT = 'compact';
const SCORE_CACHE_COMPACT_THRESHOLD = 8000;

const SCORE_BOOTSTRAP_THRESHOLD = 1200;
const SCORE_BOOTSTRAP_LIMIT = 600;

// Tracking cold-start fairness
const TRACKING_WARMUP_MIN_MS = 30 * 60 * 1000; // 30 minutes
const TRACKING_WARMUP_MIN_COUNT = 30; // 30 tracked items
const TRACKING_NEUTRAL_T = 0.5;

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

async function ensureScoreAlgoVersion() {
  try {
    const result = await browserAPI.storage.local.get([SCORE_ALGO_VERSION_KEY]);
    if (result?.[SCORE_ALGO_VERSION_KEY] === SCORE_ALGO_VERSION) return;
    await invalidateRecommendCaches(`algo-v${SCORE_ALGO_VERSION}`);
    await browserAPI.storage.local.set({ [SCORE_ALGO_VERSION_KEY]: SCORE_ALGO_VERSION });
  } catch (_) { }
}

ensureScoreAlgoVersion().catch(() => { });

function scheduleBookmarkBulkExit() {
  if (bookmarkBulkExitTimer) {
    clearTimeout(bookmarkBulkExitTimer);
  }
  bookmarkBulkExitTimer = setTimeout(() => {
    bookmarkBulkExitTimer = null;
    exitBookmarkBulkChangeMode().catch(() => { });
  }, BOOKMARK_BULK_QUIET_MS);
}

function scheduleRecomputeAllScoresSoon(reason = '', options = {}) {
  const forceFull = options && options.forceFull === true;
  if (scheduledRecomputeTimer) clearTimeout(scheduledRecomputeTimer);
  scheduledRecomputeTimer = setTimeout(() => {
    scheduledRecomputeTimer = null;
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    computeAllBookmarkScores({ forceFull })
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
  clearBookmarkUrlIndex();
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
    scheduleRecomputeAllScoresSoon('bulk-exit', { forceFull: true });
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

function pickBootstrapBookmarks(bookmarks, limit) {
  if (!Array.isArray(bookmarks) || bookmarks.length === 0) return [];
  const maxCount = Number.isFinite(limit) ? Math.max(1, limit) : SCORE_BOOTSTRAP_LIMIT;
  const list = bookmarks.slice();
  list.sort((a, b) => {
    const diff = (b?.dateAdded || 0) - (a?.dateAdded || 0);
    if (diff !== 0) return diff;
    const aTitle = String(a?.title || a?.name || '').toLowerCase();
    const bTitle = String(b?.title || b?.name || '').toLowerCase();
    if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
  return list.slice(0, maxCount);
}

async function getFormulaConfig() {
  const DEFAULT_CONFIG = {
    weights: { freshness: 0.15, coldness: 0.15, shallowRead: 0.30, forgetting: 0.20, laterReview: 0.20 },
    thresholds: { freshness: 30, coldness: 10, shallowRead: 5, forgetting: 14 }
  };

  const result = await browserAPI.storage.local.get(['recommendFormulaConfig', 'trackingEnabled']);
  const stored = result.recommendFormulaConfig || null;
  const config = {
    ...DEFAULT_CONFIG,
    ...(stored || {}),
    weights: {
      ...DEFAULT_CONFIG.weights,
      ...((stored && stored.weights) ? stored.weights : {})
    },
    thresholds: {
      ...DEFAULT_CONFIG.thresholds,
      ...((stored && stored.thresholds) ? stored.thresholds : {})
    }
  };

  if (!stored) {
    try {
      await browserAPI.storage.local.set({ recommendFormulaConfig: config });
    } catch (_) { }
    // 之前可能已经按旧默认值计算过缓存：确保公式默认值与 UI 一致后，清空旧缓存避免“显示公式”和“实际分数”不一致。
    await invalidateRecommendCaches('init-default-formula');
  }

  config.trackingEnabled = result.trackingEnabled !== false;
  return config;
}

function normalizeBlockedDomain(domain) {
  if (!domain) return '';
  return String(domain).toLowerCase().replace(/^www\./, '');
}

function normalizeScoreUrlKey(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return String(url);
    u.hash = '';
    let pathname = u.pathname || '';
    if (pathname === '/') pathname = '';
    return `${u.origin}${pathname}${u.search || ''}`;
  } catch (_) {
    return String(url);
  }
}

let bookmarkUrlIndexReady = false;
let bookmarkUrlIndexBuilding = null;
let bookmarkUrlIndexStale = false;
const bookmarkUrlIndex = new Map(); // urlKey -> Set<bookmarkId>
const bookmarkIdToUrlKey = new Map();

function clearBookmarkUrlIndex() {
  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  bookmarkUrlIndexReady = false;
  bookmarkUrlIndexStale = true;
}

function addBookmarkToUrlIndex(bookmark) {
  if (!bookmark || !bookmark.id || !bookmark.url) return;
  const key = normalizeScoreUrlKey(bookmark.url);
  if (!key) return;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(bookmark.id);
  bookmarkIdToUrlKey.set(bookmark.id, key);
}

function removeBookmarkFromUrlIndex(bookmarkId) {
  if (!bookmarkId) return;
  const key = bookmarkIdToUrlKey.get(bookmarkId);
  if (!key) return;
  const set = bookmarkUrlIndex.get(key);
  if (set) {
    set.delete(bookmarkId);
    if (set.size === 0) {
      bookmarkUrlIndex.delete(key);
    }
  }
  bookmarkIdToUrlKey.delete(bookmarkId);
}

function updateBookmarkUrlIndex(bookmarkId, newUrl) {
  removeBookmarkFromUrlIndex(bookmarkId);
  if (!newUrl) return;
  const key = normalizeScoreUrlKey(newUrl);
  if (!key) return;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(bookmarkId);
  bookmarkIdToUrlKey.set(bookmarkId, key);
}

async function buildBookmarkUrlIndex() {
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  const nextIndex = new Map();
  const nextIdMap = new Map();

  function traverse(nodes) {
    for (const node of nodes) {
      if (node.url) {
        const key = normalizeScoreUrlKey(node.url);
        if (key) {
          let set = nextIndex.get(key);
          if (!set) {
            set = new Set();
            nextIndex.set(key, set);
          }
          set.add(node.id);
          nextIdMap.set(node.id, key);
        }
      }
      if (node.children) traverse(node.children);
    }
  }

  traverse(tree);

  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  for (const [key, set] of nextIndex.entries()) {
    bookmarkUrlIndex.set(key, set);
  }
  for (const [id, key] of nextIdMap.entries()) {
    bookmarkIdToUrlKey.set(id, key);
  }
  bookmarkUrlIndexReady = true;
  bookmarkUrlIndexStale = false;
}

async function ensureBookmarkUrlIndex() {
  if (bookmarkUrlIndexReady && !bookmarkUrlIndexStale) return true;
  if (bookmarkUrlIndexBuilding) return bookmarkUrlIndexBuilding;
  if (isBookmarkImporting || isBookmarkBulkChanging) return false;
  bookmarkUrlIndexBuilding = buildBookmarkUrlIndex()
    .then(() => true)
    .catch(() => false)
    .finally(() => {
      bookmarkUrlIndexBuilding = null;
    });
  return bookmarkUrlIndexBuilding;
}

async function getBlockedDataForScore() {
  const result = await browserAPI.storage.local.get(['recommend_blocked']);
  const blocked = result.recommend_blocked || { bookmarks: [], folders: [], domains: [] };
  return {
    bookmarks: new Set(blocked.bookmarks || []),
    domains: new Set((blocked.domains || []).map(normalizeBlockedDomain).filter(Boolean)),
    folders: new Set(blocked.folders || [])
  };
}

async function getScoresCache() {
  const result = await browserAPI.storage.local.get(['recommend_scores_cache']);
  return result.recommend_scores_cache || {};
}

async function saveScoresCache(cache) {
  try {
    await browserAPI.storage.local.set({ recommend_scores_cache: cache, recommend_scores_time: Date.now() });
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

        await browserAPI.storage.local.set({ recommend_scores_cache: cache, recommend_scores_time: Date.now() });
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
    let totalMs = 0;
    let totalCount = 0;

    for (const [key, stat] of Object.entries(stats)) {
      const data = {
        url: stat.url,
        title: stat.title || key,
        compositeMs: stat.totalCompositeMs || 0,
        bookmarkId: stat.bookmarkId || null
      };
      totalMs += data.compositeMs || 0;
      totalCount += 1;
      if (stat.url) {
        const urlKey = normalizeScoreUrlKey(stat.url);
        if (urlKey) byUrl.set(urlKey, data);
      }
      if (stat.title) byTitle.set(stat.title, data);
      if (stat.bookmarkId) byBookmarkId.set(stat.bookmarkId, data);
    }

    return { byUrl, byTitle, byBookmarkId, totalMs, totalCount };
  } catch (e) {
    console.warn('[S-score] tracking stats failed:', e);
    return { byUrl: new Map(), byTitle: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
  }
}

function calculateFactorValue(value, threshold, inverse = false) {
  if (value <= 0) return inverse ? 1 : 0;
  const safeThreshold = Math.max(1, threshold || 1);
  const decayed = 1 / (1 + Math.pow(value / safeThreshold, 0.7));
  return inverse ? decayed : (1 - decayed);
}

function resolveHistoryForScore(bookmark, historyStats) {
  const empty = { visitCount: 0, lastVisitTime: 0 };
  const result = {
    matchType: 'none',
    matchKey: null,
    history: empty
  };

  if (!historyStats || !bookmark?.url) return result;

  const urlKey = normalizeScoreUrlKey(bookmark.url);
  if (!urlKey) return result;

  let history = historyStats.get(urlKey);
  if (history && history.visitCount > 0) {
    return { matchType: 'url', matchKey: urlKey, history };
  }

  if (bookmark.title && historyStats.titleMap) {
    history = historyStats.titleMap.get(bookmark.title);
    if (history && history.visitCount > 0) {
      return { matchType: 'title', matchKey: bookmark.title, history };
    }
  }

  try {
    if (bookmark.url && historyStats.domainMap) {
      const domain = normalizeBlockedDomain(new URL(bookmark.url).hostname);
      history = historyStats.domainMap.get(domain);
      if (history && history.visitCount > 0) {
        return { matchType: 'domain', matchKey: domain, history };
      }
    }
  } catch (_) { }

  return result;
}

function resolveTrackingForScore(bookmark, trackingData) {
  const result = {
    matchType: 'none',
    matchKey: null,
    compositeMs: 0,
    ignoredTitleHit: false
  };

  if (!trackingData || !bookmark) return result;

  if (bookmark.id && trackingData.byBookmarkId && trackingData.byBookmarkId.has(bookmark.id)) {
    const hit = trackingData.byBookmarkId.get(bookmark.id);
    return { matchType: 'bookmarkId', matchKey: bookmark.id, compositeMs: hit?.compositeMs || 0, ignoredTitleHit: false };
  }

  if (bookmark.url && trackingData.byUrl) {
    const urlKey = normalizeScoreUrlKey(bookmark.url);
    if (urlKey && trackingData.byUrl.has(urlKey)) {
      const hit = trackingData.byUrl.get(urlKey);
      return { matchType: 'url', matchKey: urlKey, compositeMs: hit?.compositeMs || 0, ignoredTitleHit: false };
    }
  }

  if (bookmark.title && trackingData.byTitle && trackingData.byTitle.has(bookmark.title)) {
    const titleHit = trackingData.byTitle.get(bookmark.title);
    if (titleHit) {
      if (bookmark.id && titleHit.bookmarkId && titleHit.bookmarkId === bookmark.id) {
        return { matchType: 'title', matchKey: bookmark.title, compositeMs: titleHit.compositeMs || 0, ignoredTitleHit: false };
      }
      if (!bookmark.id && !titleHit.bookmarkId) {
        return { matchType: 'title', matchKey: bookmark.title, compositeMs: titleHit.compositeMs || 0, ignoredTitleHit: false };
      }
      result.ignoredTitleHit = true;
    }
  }

  return result;
}

function resolveLaterFactorForScore(bookmarkId, postponedList) {
  const result = { L: 0, postponeInfo: null };
  if (!bookmarkId || !Array.isArray(postponedList) || postponedList.length === 0) return result;
  const postponeInfo = postponedList.find(p => p.bookmarkId === bookmarkId) || null;
  if (postponeInfo && postponeInfo.manuallyAdded) {
    return { L: 1, postponeInfo };
  }
  return { L: 0, postponeInfo };
}

function resolveReviewFactorForScore(bookmarkId, reviewData, now) {
  const result = {
    R: 1,
    review: null,
    daysSinceReview: null,
    stability: null,
    needReview: null
  };
  if (!bookmarkId || !reviewData) return result;
  const review = reviewData[bookmarkId];
  if (!review) return result;

  const safeNow = typeof now === 'number' ? now : Date.now();
  const daysSinceReview = (safeNow - review.lastReview) / (1000 * 60 * 60 * 24);
  const reviewCount = review.reviewCount || 1;
  const stabilityTable = [3, 7, 14, 30, 60];
  const stability = stabilityTable[Math.min(reviewCount - 1, stabilityTable.length - 1)];
  const needReview = 1 - Math.pow(0.9, daysSinceReview / stability);
  let R = 0.7 + 0.3 * needReview;
  R = Math.max(0.7, Math.min(1, R));
  return { R, review, daysSinceReview, stability, needReview };
}

function calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData) {
  const now = Date.now();
  const thresholds = config.thresholds;

  const historyResult = resolveHistoryForScore(bookmark, historyStats);
  const history = historyResult.history || { visitCount: 0, lastVisitTime: 0 };

  const trackingResult = resolveTrackingForScore(bookmark, trackingData);
  const compositeMs = trackingResult.compositeMs || 0;

  const daysSinceAdded = (now - (bookmark.dateAdded || now)) / (1000 * 60 * 60 * 24);
  const F = calculateFactorValue(daysSinceAdded, thresholds.freshness, true);

  const C = calculateFactorValue(history.visitCount, thresholds.coldness, true);

  const compositeMinutes = compositeMs / (1000 * 60);
  const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
    || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;
  const trackingHit = trackingResult.matchType !== 'none';
  const T = trackingHit
    ? calculateFactorValue(compositeMinutes, thresholds.shallowRead, true)
    : TRACKING_NEUTRAL_T;

  let daysSinceLastVisit = thresholds.forgetting;
  if (history.lastVisitTime > 0) {
    daysSinceLastVisit = (now - history.lastVisitTime) / (1000 * 60 * 60 * 24);
  } else {
    // 从未访问过：用“加入时间”作为 proxy，避免 D 永远固定在阈值处（0.5）导致分数扎堆。
    daysSinceLastVisit = Math.max(daysSinceAdded, thresholds.forgetting);
  }
  const D = calculateFactorValue(daysSinceLastVisit, thresholds.forgetting, false);

  const laterResult = resolveLaterFactorForScore(bookmark.id, postponedList);
  const L = laterResult.L;

  const reviewResult = resolveReviewFactorForScore(bookmark.id, reviewData, now);
  const R = reviewResult.R;

  const weights = config.weights || {};
  let w1 = weights.freshness ?? 0.15;
  let w2 = weights.coldness ?? 0.15;
  let w3 = weights.shallowRead ?? 0.30;
  let w4 = weights.forgetting ?? 0.20;
  let w5 = weights.laterReview ?? 0.20;

  if (!config.trackingEnabled || !trackingWarm) {
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
  // 注意：S 值缓存必须可复现（不含随机项），否则每次重算都会抡动推荐结果/数值，用户会感知“闪”“漂”。
  const S = Math.max(0, Math.min(1, priority));

  return { S, F, C, T, D, L, R };
}

const SCORE_DEBUG_CONTEXT_TTL_MS = 60 * 1000;
let scoreDebugHistoryStatsCache = { loadedAt: 0, stats: null };

function invalidateScoreDebugHistoryStatsCache() {
  scoreDebugHistoryStatsCache = { loadedAt: 0, stats: null };
}

async function getHistoryStatsForScoreDebug() {
  try {
    const now = Date.now();
    if (scoreDebugHistoryStatsCache.stats && (now - (scoreDebugHistoryStatsCache.loadedAt || 0)) < SCORE_DEBUG_CONTEXT_TTL_MS) {
      return scoreDebugHistoryStatsCache.stats;
    }
    const stats = await getBatchHistoryDataWithTitle();
    scoreDebugHistoryStatsCache = { loadedAt: now, stats };
    return stats;
  } catch (_) {
    return new Map();
  }
}

function calculateBookmarkScoreDebug(bookmark, historyStats, trackingData, config, postponedList, reviewData) {
  const now = Date.now();
  const thresholds = config.thresholds;

  const historyResult = resolveHistoryForScore(bookmark, historyStats);
  const history = historyResult.history || { visitCount: 0, lastVisitTime: 0 };

  const trackingResult = resolveTrackingForScore(bookmark, trackingData);
  const compositeMs = trackingResult.compositeMs || 0;

  const daysSinceAdded = (now - (bookmark.dateAdded || now)) / (1000 * 60 * 60 * 24);
  const compositeMinutes = compositeMs / (1000 * 60);
  const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
    || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;

  let daysSinceLastVisit = thresholds.forgetting;
  if (history.lastVisitTime > 0) {
    daysSinceLastVisit = (now - history.lastVisitTime) / (1000 * 60 * 60 * 24);
  } else {
    daysSinceLastVisit = Math.max(daysSinceAdded, thresholds.forgetting);
  }

  const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
  const laterResult = resolveLaterFactorForScore(bookmark.id, postponedList);
  const reviewResult = resolveReviewFactorForScore(bookmark.id, reviewData, now);

  const weights = config.weights || {};
  let w1 = weights.freshness ?? 0.15;
  let w2 = weights.coldness ?? 0.15;
  let w3 = weights.shallowRead ?? 0.30;
  let w4 = weights.forgetting ?? 0.20;
  let w5 = weights.laterReview ?? 0.20;
  if (!config.trackingEnabled || !trackingWarm) {
    const remaining = w1 + w2 + w4 + w5;
    if (remaining > 0) {
      w1 = w1 / remaining;
      w2 = w2 / remaining;
      w4 = w4 / remaining;
      w5 = w5 / remaining;
    }
    w3 = 0;
  }

  return {
    now,
    bookmark: {
      id: bookmark.id,
      title: bookmark.title || '',
      url: bookmark.url || '',
      dateAdded: bookmark.dateAdded || 0,
      parentId: bookmark.parentId || null
    },
    config: {
      thresholds: { ...thresholds },
      weights: { ...weights },
      trackingEnabled: !!config.trackingEnabled
    },
    weightsUsed: { w1, w2, w3, w4, w5 },
    matches: {
      history: {
        type: historyResult.matchType,
        key: historyResult.matchKey,
        visitCount: history.visitCount || 0,
        lastVisitTime: history.lastVisitTime || 0
      },
      tracking: {
        type: trackingResult.matchType,
        key: trackingResult.matchKey,
        compositeMs,
        ignoredTitleHit: !!trackingResult.ignoredTitleHit
      }
    },
    raw: {
      daysSinceAdded,
      compositeMinutes,
      daysSinceLastVisit,
      postponeInfo: laterResult.postponeInfo,
      review: reviewResult.review,
      daysSinceReview: reviewResult.daysSinceReview,
      stability: reviewResult.stability,
      needReview: reviewResult.needReview
    },
    factors: scores
  };
}

async function getBatchHistoryDataWithTitle() {
  const urlMap = new Map();
  const titleMap = new Map();
  const domainMap = new Map();

  if (!browserAPI.history) {
    const result = urlMap;
    result.titleMap = titleMap;
    result.domainMap = domainMap;
    return result;
  }

  try {
    // 尽量覆盖更多历史（maxResults 兜底），避免导入大量书签后“无历史”比例过高导致分数扎堆。
    const historyStartTime = 0;
    const historyItems = await new Promise(resolve => {
      browserAPI.history.search({
        text: '',
        startTime: historyStartTime,
        maxResults: 50000
      }, resolve);
    });

    for (const item of historyItems) {
      if (!item.url) continue;
      const urlKey = normalizeScoreUrlKey(item.url);
      if (!urlKey) continue;
      const data = {
        visitCount: item.visitCount || 0,
        lastVisitTime: item.lastVisitTime || 0
      };

      if (!urlMap.has(urlKey)) {
        urlMap.set(urlKey, data);
      } else {
        const existing = urlMap.get(urlKey);
        urlMap.set(urlKey, {
          visitCount: (existing.visitCount || 0) + data.visitCount,
          lastVisitTime: Math.max(existing.lastVisitTime || 0, data.lastVisitTime || 0)
        });
      }

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

      try {
        const domain = normalizeBlockedDomain(new URL(item.url).hostname);
        if (domain) {
          if (!domainMap.has(domain)) {
            domainMap.set(domain, data);
          } else {
            const existing = domainMap.get(domain);
            domainMap.set(domain, {
              visitCount: existing.visitCount + data.visitCount,
              lastVisitTime: Math.max(existing.lastVisitTime, data.lastVisitTime)
            });
          }
        }
      } catch (_) { }
    }
  } catch (e) {
    console.warn('[S-score] batch history load failed:', e);
  }

  const result = urlMap;
  result.titleMap = titleMap;
  result.domainMap = domainMap;
  return result;
}

async function computeAllBookmarkScores(options = {}) {
  if (isComputingScores) {
    return false;
  }
  if (isBookmarkImporting) {
    return false;
  }
  isComputingScores = true;

  try {
    const forceFull = options && options.forceFull === true;
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

    const [blocked, config, postponedList, reviewData] = await Promise.all([
      getBlockedDataForScore(),
      getFormulaConfig(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);

    const isBlockedDomain = (bookmark) => {
      if (blocked.domains.size === 0 || !bookmark.url) return false;
      try {
        const url = new URL(bookmark.url);
        return blocked.domains.has(normalizeBlockedDomain(url.hostname));
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

    const existingCache = await getScoresCache();
    const existingCount = Object.keys(existingCache).length;
    const shouldBootstrap = !forceFull && existingCount === 0 && totalCount >= SCORE_BOOTSTRAP_THRESHOLD;

    if (shouldBootstrap) {
      const bootstrapBookmarks = pickBootstrapBookmarks(availableBookmarks, SCORE_BOOTSTRAP_LIMIT);
      const historyStats = new Map();
      const trackingData = { byUrl: new Map(), byTitle: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
      const newCache = {};
      let computedCount = 0;

      for (const bookmark of bootstrapBookmarks) {
        const scores = calculateBookmarkScore(bookmark, historyStats, trackingData, config, postponedList, reviewData);
        newCache[bookmark.id] = nextMode === SCORE_CACHE_MODE_FULL ? scores : { S: scores.S };
        computedCount += 1;
        if (computedCount % 50 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      await saveScoresCache(newCache);
      try {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: { staleAt: Date.now(), reason: 'bootstrap-partial' }
        });
      } catch (_) { }

      isComputingScores = false;
      scheduleRecomputeAllScoresSoon('bootstrap-full', { forceFull: true });
      return true;
    }

    const [historyStats, trackingData] = await Promise.all([
      getBatchHistoryDataWithTitle(),
      getTrackingDataForScore()
    ]);
    try {
      scoreDebugHistoryStatsCache = { loadedAt: Date.now(), stats: historyStats };
    } catch (_) { }

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
      const urlKey = normalizeScoreUrlKey(bookmark.url);
      if (urlKey) {
        let visits = await new Promise(resolve => {
          browserAPI.history.getVisits({ url: bookmark.url }, resolve);
        });
        if (!visits?.length) {
          try {
            const u = new URL(bookmark.url);
            u.hash = '';
            const canonicalUrl = u.href;
            if (canonicalUrl && canonicalUrl !== bookmark.url) {
              visits = await new Promise(resolve => {
                browserAPI.history.getVisits({ url: canonicalUrl }, resolve);
              });
            }
          } catch (_) { }
        }
        historyStats.set(urlKey, {
          visitCount: visits?.length || 0,
          lastVisitTime: visits?.length > 0 ? Math.max(...visits.map(v => v.visitTime)) : 0
        });
      }

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
  if (isBookmarkImporting || isBookmarkBulkChanging) return;
  if (!url) return;
  pendingUrlUpdates.add(url);

  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);

  urlUpdateTimer = setTimeout(async () => {
    const urls = [...pendingUrlUpdates];
    pendingUrlUpdates.clear();
    urlUpdateTimer = null;

    try {
      const urlKeySet = new Set(urls.map(normalizeScoreUrlKey).filter(Boolean));
      if (urlKeySet.size === 0) return;

      const indexReady = await ensureBookmarkUrlIndex();
      if (indexReady) {
        const idSet = new Set();
        for (const key of urlKeySet) {
          const ids = bookmarkUrlIndex.get(key);
          if (ids) {
            ids.forEach(id => idSet.add(id));
          }
        }
        if (idSet.size === 0) return;
        for (const bookmarkId of idSet) {
          await updateSingleBookmarkScore(bookmarkId);
        }
        return;
      }

      const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
      const bookmarks = [];
      function traverse(nodes) {
        for (const node of nodes) {
          if (node.url) {
            const key = normalizeScoreUrlKey(node.url);
            if (key && urlKeySet.has(key)) bookmarks.push(node);
          }
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
        invalidateScoreDebugHistoryStatsCache();
      }
    });
  }

browserAPI.bookmarks.onCreated.addListener((id, bookmark) => {
  noteBookmarkEventForBulkGuard('created');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (bookmark.url) {
    addBookmarkToUrlIndex(bookmark);
    setTimeout(() => updateSingleBookmarkScore(id), 500);
  }
});

browserAPI.bookmarks.onRemoved.addListener(async (id) => {
  noteBookmarkEventForBulkGuard('removed');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  removeBookmarkFromUrlIndex(id);
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
    if (changeInfo.url) {
      updateBookmarkUrlIndex(id, changeInfo.url);
    }
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
        // success 表示“本次确实完成了计算并写入缓存”
        sendResponse({ success: !!ok, computed: !!ok });
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

  if (action === 'getBookmarkScoreDebug') {
    (async () => {
      try {
        const bookmarkId = String(message.bookmarkId || '').trim();
        if (!bookmarkId) {
          sendResponse({ success: false, error: 'Missing bookmarkId' });
          return;
        }

        const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([bookmarkId], resolve));
        const bookmark = bookmarks?.[0] || null;
        if (!bookmark || !bookmark.url) {
          sendResponse({ success: false, error: 'Bookmark not found or not a URL bookmark' });
          return;
        }

        const [cache, mode, config, trackingData, postponedList, reviewData, meta] = await Promise.all([
          getScoresCache(),
          getScoreCacheMode(),
          getFormulaConfig(),
          getTrackingDataForScore(),
          getPostponedBookmarksForScore(),
          getReviewDataForScore(),
          browserAPI.storage.local.get(['recommendScoresStaleMeta', 'bookmarkBulkChangeFlag', 'recommend_scores_time', SCORE_ALGO_VERSION_KEY])
        ]);

        const cachedEntry = cache[bookmarkId] || null;
        const historyStats = await getHistoryStatsForScoreDebug();
        const debug = calculateBookmarkScoreDebug(bookmark, historyStats, trackingData, config, postponedList, reviewData);

        const cachedS = typeof cachedEntry?.S === 'number' ? cachedEntry.S : null;
        const computedS = typeof debug?.factors?.S === 'number' ? debug.factors.S : null;

        const notes = [];
        const trackingWarm = (trackingData?.totalMs || 0) >= TRACKING_WARMUP_MIN_MS
          || (trackingData?.totalCount || 0) >= TRACKING_WARMUP_MIN_COUNT;
        const trackingType = debug?.matches?.tracking?.type || 'none';
        if (isBookmarkImporting) notes.push('importing: score recompute paused');
        if (isBookmarkBulkChanging) notes.push('bulk-changing: score recompute paused');
        if (meta?.bookmarkBulkChangeFlag) notes.push('bookmarkBulkChangeFlag=true');
        if (!trackingWarm) notes.push('tracking cold-start: w3 disabled');
        if (trackingType === 'none') notes.push('tracking miss: T neutral=0.5');
        if (cachedEntry && cachedS != null && computedS != null && Math.abs(cachedS - computedS) > 0.02) {
          notes.push(`cache differs from recompute: cached=${cachedS.toFixed(3)} vs recompute=${computedS.toFixed(3)}`);
        }
        if (!cachedEntry) notes.push('no cache entry for this bookmarkId');
        if (cachedEntry && !('F' in cachedEntry)) notes.push('cache mode is compact (only S stored)');

        // 诊断计算后顺手做一次增量缓存更新
        let cacheUpdated = false;
        const canUpdateCache = !isBookmarkImporting && !isBookmarkBulkChanging;
        if (computedS != null && canUpdateCache) {
          const shouldUpdate = !cachedEntry || cachedS == null || Math.abs(cachedS - computedS) > 1e-6;
          if (shouldUpdate) {
            cache[bookmarkId] = mode === SCORE_CACHE_MODE_FULL ? debug.factors : { S: computedS };
            await saveScoresCache(cache);
            cacheUpdated = true;
          }
        } else if (computedS != null && !canUpdateCache) {
          notes.push('cache update skipped due to import/bulk');
        }
        if (cacheUpdated) notes.push('cache updated by debug');

        sendResponse({
          success: true,
          debug: {
            ...debug,
            storage: {
              cacheMode: mode,
              cachedEntry: cachedEntry && typeof cachedEntry === 'object' ? cachedEntry : null,
              recommendScoresTime: Number(meta?.recommend_scores_time || 0),
              staleMeta: meta?.recommendScoresStaleMeta || null,
              algoVersion: Number(meta?.[SCORE_ALGO_VERSION_KEY] || 0)
            },
            notes
          }
        });
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
