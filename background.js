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
  getTrackingRankingStatsByRange,
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

function normalizeHistoryPanelView(view, fallback = 'widgets') {
  if (view === 'widgets' || view === 'recommend' || view === 'additions') {
    return view;
  }
  return fallback;
}

function openView(view) {
  const safeView = normalizeHistoryPanelView(view, 'widgets');
  try {
    browserAPI.storage.local.set({
      historyRequestedView: { view: safeView, time: Date.now() }
    }, () => {});
  } catch (_) {}
  const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
  const url = `${baseUrl}?view=${safeView}`;
  browserAPI.tabs.create({ url });
}

const QUICK_REVIEW_OPEN_MODE_STORAGE_KEY = 'quickReviewOpenMode';
const QUICK_REVIEW_TAB_ID_STORAGE_KEY = 'quickReviewTabId';
const QUICK_REVIEW_RECOMMEND_BATCH_SIZE = 3;
let quickReviewCommandChain = Promise.resolve();

function runSerializedQuickReviewCommand(task) {
  const previous = quickReviewCommandChain;
  const next = previous
    .catch(() => {})
    .then(async () => task());

  quickReviewCommandChain = next.finally(() => {
    if (quickReviewCommandChain === next) {
      quickReviewCommandChain = Promise.resolve();
    }
  });

  return next;
}

function normalizeQuickReviewOpenMode(mode) {
  return String(mode || '').trim().toLowerCase() === 'new_tab' ? 'new_tab' : 'single_tab';
}

async function getQuickReviewOpenModeState() {
  try {
    const result = await browserAPI.storage.local.get([QUICK_REVIEW_OPEN_MODE_STORAGE_KEY]);
    return normalizeQuickReviewOpenMode(result?.[QUICK_REVIEW_OPEN_MODE_STORAGE_KEY]);
  } catch (_) {
    return 'single_tab';
  }
}

async function setQuickReviewOpenModeState(mode) {
  const normalized = normalizeQuickReviewOpenMode(mode);
  try {
    await browserAPI.storage.local.set({ [QUICK_REVIEW_OPEN_MODE_STORAGE_KEY]: normalized });
  } catch (_) {}
  return normalized;
}

async function getQuickReviewTabIdState() {
  try {
    const result = await browserAPI.storage.local.get([QUICK_REVIEW_TAB_ID_STORAGE_KEY]);
    const id = Number(result?.[QUICK_REVIEW_TAB_ID_STORAGE_KEY]);
    return Number.isFinite(id) ? id : null;
  } catch (_) {
    return null;
  }
}

async function saveQuickReviewTabIdState(tabId) {
  try {
    const payload = Number.isFinite(Number(tabId)) ? Number(tabId) : null;
    await browserAPI.storage.local.set({ [QUICK_REVIEW_TAB_ID_STORAGE_KEY]: payload });
  } catch (_) {}
}

async function getTabByIdSafe(tabId) {
  if (!browserAPI?.tabs?.get || !Number.isFinite(Number(tabId))) return null;
  return await new Promise((resolve) => {
    try {
      browserAPI.tabs.get(Number(tabId), (tab) => {
        if (browserAPI?.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function updateTabSafe(tabId, updateProperties) {
  if (!browserAPI?.tabs?.update || !Number.isFinite(Number(tabId))) return null;
  return await new Promise((resolve) => {
    try {
      browserAPI.tabs.update(Number(tabId), updateProperties || {}, (tab) => {
        if (browserAPI?.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function createTabSafe(createProperties) {
  if (!browserAPI?.tabs?.create) return null;
  return await new Promise((resolve) => {
    try {
      browserAPI.tabs.create(createProperties || {}, (tab) => {
        if (browserAPI?.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function focusWindowSafe(windowId) {
  if (!browserAPI?.windows?.update || !Number.isFinite(Number(windowId))) return;
  await new Promise((resolve) => {
    try {
      browserAPI.windows.update(Number(windowId), { focused: true }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

function noteQuickReviewBookmarkOpen({ tabId = null, url = '', title = '', bookmarkId = null } = {}) {
  if (!url || typeof url !== 'string') return;
  if (!Number.isFinite(Number(tabId))) return;

  try {
    noteAutoBookmarkNavigation({
      tabId: Number(tabId),
      bookmarkUrl: url,
      bookmarkId: bookmarkId ? String(bookmarkId) : null,
      bookmarkTitle: String(title || ''),
      timeStamp: Date.now(),
      source: 'quick_review'
    });
  } catch (_) {}
}

async function openInQuickReviewTabState(url, bookmark = {}) {
  if (!url) return { success: false, tabId: null, error: 'missing_url' };

  const safeBookmarkId = String(bookmark?.id || '').trim();
  const safeTitle = String(bookmark?.title || bookmark?.name || '').trim();

  try {
    let tabId = await getQuickReviewTabIdState();

    if (tabId != null) {
      const existing = await getTabByIdSafe(tabId);
      if (existing && Number.isFinite(Number(existing.id))) {
        const updatedTab = await updateTabSafe(existing.id, { url, active: true });
        if (updatedTab && Number.isFinite(Number(updatedTab.id))) {
          const targetTabId = Number(updatedTab.id);
          const targetWindowId = Number(updatedTab.windowId);
          if (Number.isFinite(targetWindowId)) {
            await focusWindowSafe(targetWindowId);
          }
          noteQuickReviewBookmarkOpen({
            tabId: targetTabId,
            url,
            title: safeTitle,
            bookmarkId: safeBookmarkId || null
          });
          await saveQuickReviewTabIdState(targetTabId);
          return {
            success: true,
            tabId: targetTabId,
            windowId: Number.isFinite(targetWindowId) ? targetWindowId : null,
            reused: true,
            openedAt: Date.now()
          };
        }
      }
      await saveQuickReviewTabIdState(null);
      tabId = null;
    }

    const createdTab = await createTabSafe({ url, active: true });
    const createdTabId = Number(createdTab?.id);
    const createdWindowId = Number(createdTab?.windowId);
    if (!Number.isFinite(createdTabId)) {
      return { success: false, tabId: null, error: 'create_tab_failed' };
    }

    await saveQuickReviewTabIdState(createdTabId);
    noteQuickReviewBookmarkOpen({
      tabId: createdTabId,
      url,
      title: safeTitle,
      bookmarkId: safeBookmarkId || null
    });

    if (Number.isFinite(createdWindowId)) {
      await focusWindowSafe(createdWindowId);
    }

    return {
      success: true,
      tabId: createdTabId,
      windowId: Number.isFinite(createdWindowId) ? createdWindowId : null,
      openedAt: Date.now()
    };
  } catch (error) {
    return { success: false, tabId: null, error: error?.message || String(error) };
  }
}

async function openInQuickReviewNewTabState(url, bookmark = {}) {
  if (!url) return { success: false, tabId: null, error: 'missing_url' };

  const safeBookmarkId = String(bookmark?.id || '').trim();
  const safeTitle = String(bookmark?.title || bookmark?.name || '').trim();

  try {
    const tab = await createTabSafe({ url, active: true });
    const tabId = Number(tab?.id);
    const windowId = Number(tab?.windowId);
    if (!Number.isFinite(tabId)) {
      return { success: false, tabId: null, error: 'create_tab_failed' };
    }

    noteQuickReviewBookmarkOpen({
      tabId,
      url,
      title: safeTitle,
      bookmarkId: safeBookmarkId || null
    });

    if (Number.isFinite(windowId)) {
      await focusWindowSafe(windowId);
    }

    return {
      success: true,
      tabId,
      windowId: Number.isFinite(windowId) ? windowId : null,
      openedAt: Date.now()
    };
  } catch (error) {
    return { success: false, tabId: null, error: error?.message || String(error) };
  }
}

function normalizeRecommendCardDataEntry(entry) {
  const id = String(entry?.id || '').trim();
  const url = String(entry?.url || '').trim();
  if (!id || !url) return null;

  const title = String(entry?.title || entry?.name || url).trim() || url;
  const priority = Number(entry?.priority);
  const forceDueAt = Number(entry?.forceDueAt || 0);
  const forceDueMovedAt = Number(entry?.forceDueMovedAt || 0);

  return {
    id,
    title,
    name: title,
    url,
    favicon: null,
    faviconUrl: null,
    priority: Number.isFinite(priority) ? priority : 0.5,
    forceDue: entry?.forceDue === true,
    forceDueAt: Number.isFinite(forceDueAt) ? forceDueAt : 0,
    forceDueMovedAt: Number.isFinite(forceDueMovedAt) ? forceDueMovedAt : 0
  };
}

function normalizeHistoryCurrentCardsState(state) {
  const source = state && typeof state === 'object' ? state : {};
  const cardIds = normalizeBookmarkIdList(source.cardIds || []);
  const flippedIds = normalizeBookmarkIdList(source.flippedIds || []);
  const cardData = Array.isArray(source.cardData)
    ? source.cardData
      .map(normalizeRecommendCardDataEntry)
      .filter(Boolean)
    : [];
  const timestamp = Number(source.timestamp || source.lastUpdated || 0);
  const lastUpdated = Number(source.lastUpdated || source.timestamp || 0);

  return {
    cardIds,
    flippedIds,
    cardData,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    lastUpdated: Number.isFinite(lastUpdated) ? lastUpdated : 0
  };
}

async function saveHistoryCurrentCardsState(cardIds = [], flippedIds = [], cardData = []) {
  const now = Date.now();
  const payload = {
    [HISTORY_CURRENT_CARDS_STORAGE_KEY]: {
      cardIds: normalizeBookmarkIdList(cardIds),
      flippedIds: normalizeBookmarkIdList(flippedIds),
      cardData: (Array.isArray(cardData) ? cardData : [])
        .map(normalizeRecommendCardDataEntry)
        .filter(Boolean),
      timestamp: now,
      lastUpdated: now
    }
  };
  await browserAPI.storage.local.set(payload);
  return payload[HISTORY_CURRENT_CARDS_STORAGE_KEY];
}

async function getRecommendPoolCursorValueForQuickReview(poolLength = 0) {
  const safePoolLength = normalizeRecommendPoolLength(poolLength);
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_POOL_CURSOR_STORAGE_KEY]);
    return normalizeRecommendPoolCursorValue(result?.[RECOMMEND_POOL_CURSOR_STORAGE_KEY], safePoolLength);
  } catch (_) {
    return 0;
  }
}

function compareRecommendPriorityForQuickReview(a, b) {
  const aTemplate = a?.scoreTemplate === true;
  const bTemplate = b?.scoreTemplate === true;
  if (aTemplate !== bTemplate) {
    return aTemplate ? 1 : -1;
  }

  const diff = (b?.priority ?? 0) - (a?.priority ?? 0);
  if (Math.abs(diff) >= 0.01) return diff;

  const bAdded = Number(b?.dateAdded || 0);
  const aAdded = Number(a?.dateAdded || 0);
  if (bAdded !== aAdded) return bAdded - aAdded;

  const aTitle = String(a?.title || a?.name || '').toLowerCase();
  const bTitle = String(b?.title || b?.name || '').toLowerCase();
  if (aTitle !== bTitle) return aTitle.localeCompare(bTitle);

  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function getQuickReviewDomainKey(bookmark) {
  if (!bookmark?.url) return '';
  try {
    return String(new URL(bookmark.url).hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
  } catch {
    return '';
  }
}

function pickWeightedQuickReviewEntry(entries = []) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let totalWeight = 0;
  for (const entry of entries) {
    const weight = Number(entry?.weight || 0);
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (!(totalWeight > 0)) {
    return entries[Math.floor(Math.random() * entries.length)] || null;
  }

  let roll = Math.random() * totalWeight;
  for (const entry of entries) {
    const weight = Number(entry?.weight || 0);
    if (!(Number.isFinite(weight) && weight > 0)) continue;
    roll -= weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1] || null;
}

function buildRecommendBatchFromPoolForQuickReview(pool = [], startIndex = 0, batchSize = QUICK_REVIEW_RECOMMEND_BATCH_SIZE) {
  if (!Array.isArray(pool) || pool.length === 0) return [];

  const size = Math.min(Math.max(1, Math.floor(Number(batchSize) || QUICK_REVIEW_RECOMMEND_BATCH_SIZE)), pool.length);
  const safeStart = ((Math.floor(Number(startIndex) || 0) % pool.length) + pool.length) % pool.length;
  const topRangeSize = Math.min(pool.length, Math.max(size * 6, 18));
  const exploreRangeSize = Math.min(pool.length, Math.max(size * 10, 30));
  const candidateIndexSet = new Set();

  for (let i = 0; i < topRangeSize; i++) {
    candidateIndexSet.add(i);
  }
  for (let step = 0; step < exploreRangeSize; step++) {
    candidateIndexSet.add((safeStart + step) % pool.length);
  }

  const candidateIndexes = Array.from(candidateIndexSet);
  const selectedIds = new Set();
  const selectedDomains = new Set();
  const batch = [];

  while (batch.length < size) {
    const available = candidateIndexes
      .map((index) => ({ index, item: pool[index] }))
      .filter((entry) => {
        const id = String(entry?.item?.id || '').trim();
        return !!id && !selectedIds.has(id);
      });

    if (available.length === 0) break;

    const hasAlternativeDomain = available.some((entry) => {
      const domain = getQuickReviewDomainKey(entry.item);
      return domain && !selectedDomains.has(domain);
    });

    const weighted = available.map((entry) => {
      const rank = Number(entry.index) + 1;
      const rankWeight = 1 / Math.pow(rank, 0.55);
      const priority = Number(entry?.item?.priority);
      const normalizedPriority = Number.isFinite(priority)
        ? Math.max(0, Math.min(1, priority))
        : 0.5;
      const priorityWeight = 0.6 + normalizedPriority;

      const domain = getQuickReviewDomainKey(entry.item);
      const domainPenalty = (hasAlternativeDomain && domain && selectedDomains.has(domain)) ? 0.45 : 1;
      const jitter = 0.92 + (Math.random() * 0.16);
      const weight = rankWeight * priorityWeight * domainPenalty * jitter;
      return { ...entry, weight };
    });

    const picked = pickWeightedQuickReviewEntry(weighted);
    if (!picked?.item) break;

    const pickedId = String(picked.item.id || '').trim();
    if (!pickedId || selectedIds.has(pickedId)) continue;

    selectedIds.add(pickedId);
    const pickedDomain = getQuickReviewDomainKey(picked.item);
    if (pickedDomain) selectedDomains.add(pickedDomain);
    batch.push(picked.item);
  }

  if (batch.length < size) {
    for (let step = 0; step < pool.length && batch.length < size; step++) {
      const idx = (safeStart + step) % pool.length;
      const item = pool[idx];
      const id = String(item?.id || '').trim();
      if (!id || selectedIds.has(id)) continue;
      selectedIds.add(id);
      batch.push(item);
    }
  }

  return batch;
}

function deriveRecommendStartIndexFromCurrentForQuickReview(pool = [], currentCardIds = [], fallbackCursor = 0) {
  if (!Array.isArray(pool) || pool.length === 0) return 0;

  const safeFallback = ((Math.floor(Number(fallbackCursor) || 0) % pool.length) + pool.length) % pool.length;
  const ids = normalizeBookmarkIdList(currentCardIds);
  if (!ids.length) return safeFallback;

  const firstId = ids[0];
  const firstIndex = pool.findIndex(item => String(item?.id || '').trim() === firstId);
  if (firstIndex === -1) return safeFallback;

  return (firstIndex + ids.length) % pool.length;
}

function normalizeQuickReviewBookmarkEntry(bookmark, meta = null) {
  const id = String(bookmark?.id || meta?.id || '').trim();
  const url = String(bookmark?.url || meta?.url || '').trim();
  if (!id || !url) return null;

  const priority = Number(meta?.priority ?? bookmark?.priority);
  const forceDueAt = Number(meta?.forceDueAt ?? bookmark?.forceDueAt ?? 0);
  const forceDueMovedAt = Number(meta?.forceDueMovedAt ?? bookmark?.forceDueMovedAt ?? 0);
  const title = String(
    bookmark?.title
    || bookmark?.name
    || meta?.title
    || meta?.name
    || url
  ).trim() || url;

  return {
    id,
    url,
    title,
    name: title,
    parentId: bookmark?.parentId ? String(bookmark.parentId) : '',
    ancestorFolderIds: Array.isArray(bookmark?.ancestorFolderIds)
      ? bookmark.ancestorFolderIds.map(item => String(item || '').trim()).filter(Boolean)
      : [],
    dateAdded: Number(bookmark?.dateAdded || 0),
    priority: Number.isFinite(priority) ? priority : 0.5,
    scoreTemplate: (bookmark?.scoreTemplate === true) || (meta?.scoreTemplate === true),
    forceDue: (meta?.forceDue === true) || (bookmark?.forceDue === true),
    forceDueAt: Number.isFinite(forceDueAt) ? forceDueAt : 0,
    forceDueMovedAt: Number.isFinite(forceDueMovedAt) ? forceDueMovedAt : 0
  };
}

function normalizeScoreCacheAncestorFolderIds(value) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const folderId of value) {
    const id = String(folderId || '').trim();
    if (id) normalized.push(id);
  }
  return normalized;
}

function normalizeScoreCacheMetadata(source, fallback = null) {
  const primary = source && typeof source === 'object' ? source : {};
  const secondary = fallback && typeof fallback === 'object' ? fallback : {};
  const url = String(primary.url || secondary.url || '').trim();
  if (!url) return null;

  const title = String(
    primary.title
    || primary.name
    || secondary.title
    || secondary.name
    || url
  ).trim() || url;

  const parentId = String(primary.parentId || secondary.parentId || '').trim();
  const rawDateAdded = Number(primary.dateAdded ?? secondary.dateAdded ?? 0);
  const dateAdded = Number.isFinite(rawDateAdded) ? rawDateAdded : 0;
  const ancestorFolderIds = normalizeScoreCacheAncestorFolderIds(
    Array.isArray(primary.ancestorFolderIds) ? primary.ancestorFolderIds : secondary.ancestorFolderIds
  );

  return {
    url,
    title,
    parentId,
    dateAdded,
    ancestorFolderIds
  };
}

function buildQuickReviewBookmarksFromScoresCache(scoresCache) {
  const source = scoresCache && typeof scoresCache === 'object' ? scoresCache : {};
  const result = [];

  for (const [bookmarkId, cachedEntry] of Object.entries(source)) {
    const id = String(bookmarkId || '').trim();
    if (!id || !cachedEntry || typeof cachedEntry !== 'object') continue;

    const metadata = normalizeScoreCacheMetadata(cachedEntry);
    if (!metadata) continue;

    const normalized = normalizeQuickReviewBookmarkEntry({
      id,
      url: metadata.url,
      title: metadata.title,
      name: metadata.title,
      parentId: metadata.parentId,
      ancestorFolderIds: metadata.ancestorFolderIds,
      dateAdded: metadata.dateAdded,
      priority: Number.isFinite(Number(cachedEntry.S)) ? Number(cachedEntry.S) : 0.5,
      scoreTemplate: cachedEntry._template === true
    });

    if (normalized) {
      result.push(normalized);
    }
  }

  return result;
}

function isQuickReviewBookmarkInBlockedFolder(bookmark, blockedFolderSet) {
  if (!blockedFolderSet || blockedFolderSet.size === 0) return false;
  const parentId = String(bookmark?.parentId || '').trim();
  if (parentId && blockedFolderSet.has(parentId)) return true;

  const ancestors = Array.isArray(bookmark?.ancestorFolderIds) ? bookmark.ancestorFolderIds : [];
  for (const folderId of ancestors) {
    const normalized = String(folderId || '').trim();
    if (normalized && blockedFolderSet.has(normalized)) {
      return true;
    }
  }
  return false;
}

function isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainSet) {
  if (!blockedDomainSet || blockedDomainSet.size === 0) return false;
  if (!bookmark?.url) return false;
  try {
    const hostname = String(new URL(bookmark.url).hostname || '')
      .trim()
      .toLowerCase()
      .replace(/^www\./, '');
    return blockedDomainSet.has(hostname);
  } catch {
    return false;
  }
}

async function selectQuickReviewCardsRoundState(options = {}) {
  await ensureScoreAlgoVersionReady();
  const force = options?.force === true;

  try {
    await ensureRecommendScoresReady({ reason: force ? 'quick-review-force' : 'quick-review-normal' });
  } catch (_) {}

  const [scoresCache, blocked, postponed, skippedIds, flippedResult, historyCardsResult] = await Promise.all([
    getScoresCache(),
    getRecommendBlockedState(),
    getRecommendPostponedList(),
    getRecommendSkippedIds(),
    browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]),
    options?.currentCards
      ? Promise.resolve({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: options.currentCards })
      : browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY])
  ]);

  const bookmarks = buildQuickReviewBookmarksFromScoresCache(scoresCache);
  const currentCards = normalizeHistoryCurrentCardsState(historyCardsResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);
  const flippedSet = new Set(normalizeBookmarkIdList(flippedResult?.[FLIPPED_BOOKMARKS_STORAGE_KEY] || []));
  const skipped = normalizeRecommendSkippedIds(skippedIds || []);
  const skippedSet = new Set(skipped);
  const skippedOrderMap = new Map(skipped.map((id, index) => [id, index]));

  const blockedBookmarkSet = new Set(normalizeBookmarkIdList(blocked?.bookmarks || []));
  const blockedFolderSet = new Set(normalizeBookmarkIdList(blocked?.folders || []));
  const blockedDomainSet = new Set(
    (Array.isArray(blocked?.domains) ? blocked.domains : [])
      .map(domain => String(domain || '').trim().toLowerCase().replace(/^www\./, ''))
      .filter(Boolean)
  );

  const now = Date.now();
  const postponedWaitingSet = new Set();
  const forceDuePostponedMap = new Map();
  for (const item of normalizeRecommendPostponedList(postponed || [])) {
    if (!item || item.bookmarkId == null || item.manuallyAdded) continue;
    const bookmarkId = String(item.bookmarkId || '').trim();
    if (!bookmarkId) continue;
    const postponeUntil = Number(item.postponeUntil || 0);
    if (postponeUntil > now) {
      postponedWaitingSet.add(bookmarkId);
    } else {
      forceDuePostponedMap.set(bookmarkId, item);
    }
  }

  const baseCandidateBookmarks = bookmarks.filter((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDue = forceDuePostponedMap.has(bookmarkId);

    if (!forceDue && flippedSet.has(bookmarkId)) return false;
    if (blockedBookmarkSet.has(bookmarkId)) return false;
    if (isQuickReviewBookmarkInBlockedFolder(bookmark, blockedFolderSet)) return false;
    if (isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainSet)) return false;
    if (!forceDue && postponedWaitingSet.has(bookmarkId)) return false;
    return true;
  });

  if (baseCandidateBookmarks.length === 0) {
    await saveHistoryCurrentCardsState([], [], []);
    await setRecommendPoolCursorState(0, 0);
    return { success: true, cards: [], currentCards: normalizeHistoryCurrentCardsState(null) };
  }

  const sortedPool = baseCandidateBookmarks.map((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDueInfo = forceDuePostponedMap.get(bookmarkId);
    const cached = scoresCache?.[bookmarkId];
    return normalizeQuickReviewBookmarkEntry({
      ...bookmark,
      priority: cached && Number.isFinite(Number(cached.S)) ? Number(cached.S) : 0.5,
      scoreTemplate: cached?._template === true,
      forceDue: !!forceDueInfo,
      forceDueAt: Number(forceDueInfo?.postponeUntil || 0),
      forceDueMovedAt: Number(forceDueInfo?.dueQueueMovedAt || 0)
    });
  }).filter(Boolean);

  sortedPool.sort(compareRecommendPriorityForQuickReview);

  const forceDuePool = sortedPool
    .filter(item => item.forceDue)
    .sort((a, b) => {
      const aMovedAt = Number(a.forceDueMovedAt || 0);
      const bMovedAt = Number(b.forceDueMovedAt || 0);
      const aMoved = aMovedAt > 0;
      const bMoved = bMovedAt > 0;

      if (aMoved !== bMoved) {
        return aMoved ? 1 : -1;
      }
      if (aMoved && bMoved && aMovedAt !== bMovedAt) {
        return aMovedAt - bMovedAt;
      }

      const dueDiff = Number(a.forceDueAt || 0) - Number(b.forceDueAt || 0);
      if (dueDiff !== 0) return dueDiff;
      return compareRecommendPriorityForQuickReview(a, b);
    });

  const compareNormalPoolPriorityWithSkip = (a, b) => {
    const aId = String(a?.id || '').trim();
    const bId = String(b?.id || '').trim();
    const aSkipped = skippedSet.has(aId);
    const bSkipped = skippedSet.has(bId);

    if (aSkipped !== bSkipped) {
      return aSkipped ? 1 : -1;
    }

    if (aSkipped && bSkipped) {
      const aOrder = skippedOrderMap.has(aId) ? skippedOrderMap.get(aId) : Number.MAX_SAFE_INTEGER;
      const bOrder = skippedOrderMap.has(bId) ? skippedOrderMap.get(bId) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) {
        return aOrder - bOrder;
      }
    }

    return compareRecommendPriorityForQuickReview(a, b);
  };

  const normalPool = sortedPool
    .filter(item => !item.forceDue)
    .sort(compareNormalPoolPriorityWithSkip);

  const currentCardIds = normalizeBookmarkIdList(currentCards.cardIds || []);
  const currentNormalCardIds = currentCardIds.filter(id =>
    normalPool.some(item => String(item?.id || '').trim() === id)
  );
  const currentAllFlipped = currentCardIds.length > 0
    && currentCardIds.every(id => flippedSet.has(id));

  const forceDueBatch = forceDuePool.slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
  const normalSlots = Math.max(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE - forceDueBatch.length);
  const expectedNormalBatchLen = normalSlots > 0 ? Math.min(normalSlots, normalPool.length) : 0;

  const shouldRotateByCurrent = (force || currentAllFlipped) && currentNormalCardIds.length > 0;
  let startIndex = 0;

  if (normalPool.length > 0) {
    if (shouldRotateByCurrent) {
      const storedCursor = await getRecommendPoolCursorValueForQuickReview(normalPool.length);
      startIndex = deriveRecommendStartIndexFromCurrentForQuickReview(normalPool, currentNormalCardIds, storedCursor);
    } else {
      const cursorMeta = await consumeRecommendPoolCursorState(normalPool.length, expectedNormalBatchLen);
      startIndex = Number.isFinite(Number(cursorMeta?.cursorBefore))
        ? Number(cursorMeta.cursorBefore)
        : 0;
    }
  }

  const normalBatch = normalSlots > 0
    ? buildRecommendBatchFromPoolForQuickReview(normalPool, startIndex, normalSlots)
    : [];

  const cards = [...forceDueBatch, ...normalBatch].slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
  const nextCursor = normalPool.length > 0
    ? (startIndex + normalBatch.length) % normalPool.length
    : 0;

  if (shouldRotateByCurrent) {
    await setRecommendPoolCursorState(normalPool.length, nextCursor);
  }

  const cardIds = cards.map(item => String(item?.id || '').trim()).filter(Boolean);
  const cardData = cards.map(item => normalizeRecommendCardDataEntry(item)).filter(Boolean);
  const saved = await saveHistoryCurrentCardsState(cardIds, [], cardData);

  return {
    success: true,
    cards,
    currentCards: saved
  };
}

async function peekQuickReviewPreloadUrlsState(options = {}) {
  await ensureScoreAlgoVersionReady();
  const limit = Math.max(6, Math.min(30, Number(options?.limit) || 12));

  try {
    await ensureRecommendScoresReady({ reason: 'quick-review-preload' });
  } catch (_) {}

  const [scoresCache, blocked, postponed, skippedIds, flippedResult, historyCardsResult] = await Promise.all([
    getScoresCache(),
    getRecommendBlockedState(),
    getRecommendPostponedList(),
    getRecommendSkippedIds(),
    browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]),
    browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY])
  ]);

  const bookmarks = buildQuickReviewBookmarksFromScoresCache(scoresCache);
  const currentCards = normalizeHistoryCurrentCardsState(historyCardsResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);
  const currentCardSet = new Set(normalizeBookmarkIdList(currentCards.cardIds || []));
  const flippedSet = new Set(normalizeBookmarkIdList(flippedResult?.[FLIPPED_BOOKMARKS_STORAGE_KEY] || []));
  const skipped = normalizeRecommendSkippedIds(skippedIds || []);
  const skippedSet = new Set(skipped);
  const skippedOrderMap = new Map(skipped.map((id, index) => [id, index]));

  const blockedBookmarkSet = new Set(normalizeBookmarkIdList(blocked?.bookmarks || []));
  const blockedFolderSet = new Set(normalizeBookmarkIdList(blocked?.folders || []));
  const blockedDomainSet = new Set(
    (Array.isArray(blocked?.domains) ? blocked.domains : [])
      .map(domain => String(domain || '').trim().toLowerCase().replace(/^www\./, ''))
      .filter(Boolean)
  );

  const now = Date.now();
  const postponedWaitingSet = new Set();
  const forceDuePostponedMap = new Map();
  for (const item of normalizeRecommendPostponedList(postponed || [])) {
    if (!item || item.bookmarkId == null || item.manuallyAdded) continue;
    const bookmarkId = String(item.bookmarkId || '').trim();
    if (!bookmarkId) continue;
    const postponeUntil = Number(item.postponeUntil || 0);
    if (postponeUntil > now) {
      postponedWaitingSet.add(bookmarkId);
    } else {
      forceDuePostponedMap.set(bookmarkId, item);
    }
  }

  const baseCandidateBookmarks = bookmarks.filter((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDue = forceDuePostponedMap.has(bookmarkId);

    if (currentCardSet.has(bookmarkId)) return false;
    if (!forceDue && flippedSet.has(bookmarkId)) return false;
    if (blockedBookmarkSet.has(bookmarkId)) return false;
    if (isQuickReviewBookmarkInBlockedFolder(bookmark, blockedFolderSet)) return false;
    if (isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainSet)) return false;
    if (!forceDue && postponedWaitingSet.has(bookmarkId)) return false;
    return true;
  });

  if (baseCandidateBookmarks.length === 0) {
    return { success: true, urls: [] };
  }

  const sortedPool = baseCandidateBookmarks.map((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDueInfo = forceDuePostponedMap.get(bookmarkId);
    const cached = scoresCache?.[bookmarkId];
    return normalizeQuickReviewBookmarkEntry({
      ...bookmark,
      priority: cached && Number.isFinite(Number(cached.S)) ? Number(cached.S) : 0.5,
      scoreTemplate: cached?._template === true,
      forceDue: !!forceDueInfo,
      forceDueAt: Number(forceDueInfo?.postponeUntil || 0),
      forceDueMovedAt: Number(forceDueInfo?.dueQueueMovedAt || 0)
    });
  }).filter(Boolean);

  sortedPool.sort(compareRecommendPriorityForQuickReview);

  const forceDuePool = sortedPool
    .filter(item => item.forceDue)
    .sort((a, b) => {
      const aMovedAt = Number(a.forceDueMovedAt || 0);
      const bMovedAt = Number(b.forceDueMovedAt || 0);
      const aMoved = aMovedAt > 0;
      const bMoved = bMovedAt > 0;

      if (aMoved !== bMoved) return aMoved ? 1 : -1;
      if (aMoved && bMoved && aMovedAt !== bMovedAt) return aMovedAt - bMovedAt;

      const dueDiff = Number(a.forceDueAt || 0) - Number(b.forceDueAt || 0);
      if (dueDiff !== 0) return dueDiff;
      return compareRecommendPriorityForQuickReview(a, b);
    });

  const compareNormalPoolPriorityWithSkip = (a, b) => {
    const aId = String(a?.id || '').trim();
    const bId = String(b?.id || '').trim();
    const aSkipped = skippedSet.has(aId);
    const bSkipped = skippedSet.has(bId);

    if (aSkipped !== bSkipped) return aSkipped ? 1 : -1;
    if (aSkipped && bSkipped) {
      const aOrder = skippedOrderMap.has(aId) ? skippedOrderMap.get(aId) : Number.MAX_SAFE_INTEGER;
      const bOrder = skippedOrderMap.has(bId) ? skippedOrderMap.get(bId) : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }
    return compareRecommendPriorityForQuickReview(a, b);
  };

  const normalPool = sortedPool
    .filter(item => !item.forceDue)
    .sort(compareNormalPoolPriorityWithSkip);

  const urls = [];
  const seenIds = new Set();
  let cursor = await getRecommendPoolCursorValueForQuickReview(normalPool.length);
  const rounds = Math.max(2, Math.ceil(limit / Math.max(1, QUICK_REVIEW_RECOMMEND_BATCH_SIZE)) + 1);

  for (let round = 0; round < rounds && urls.length < limit; round += 1) {
    const forceDueBatch = forceDuePool.slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
    const normalSlots = Math.max(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE - forceDueBatch.length);
    const normalBatch = normalSlots > 0
      ? buildRecommendBatchFromPoolForQuickReview(normalPool, cursor, normalSlots)
      : [];

    if (normalPool.length > 0) {
      cursor = (cursor + normalBatch.length) % normalPool.length;
    }

    const roundCards = [...forceDueBatch, ...normalBatch].slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
    for (const item of roundCards) {
      const id = String(item?.id || '').trim();
      const url = String(item?.url || '').trim();
      if (!id || !url || seenIds.has(id)) continue;
      seenIds.add(id);
      urls.push(url);
      if (urls.length >= limit) break;
    }
  }

  if (urls.length < limit) {
    for (const item of normalPool) {
      const id = String(item?.id || '').trim();
      const url = String(item?.url || '').trim();
      if (!id || !url || seenIds.has(id)) continue;
      seenIds.add(id);
      urls.push(url);
      if (urls.length >= limit) break;
    }
  }

  return { success: true, urls };
}

async function resolveQuickReviewPendingBookmark(currentCards) {
  const normalizedCards = normalizeHistoryCurrentCardsState(currentCards);
  if (normalizedCards.cardIds.length === 0) {
    return { currentCards: normalizedCards, bookmark: null };
  }

  const flippedSet = new Set(normalizedCards.flippedIds || []);
  const pendingIds = normalizedCards.cardIds.filter(id => !flippedSet.has(id));
  if (pendingIds.length === 0) {
    return { currentCards: normalizedCards, bookmark: null };
  }

  const bookmarks = await getBookmarksByIdsForScore(pendingIds);
  const bookmarkMap = new Map();
  for (const item of bookmarks) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    bookmarkMap.set(id, item);
  }

  const cardDataMap = new Map();
  for (const item of normalizedCards.cardData || []) {
    const id = String(item?.id || '').trim();
    if (!id) continue;
    cardDataMap.set(id, item);
  }

  for (const bookmarkId of pendingIds) {
    const bookmark = bookmarkMap.get(bookmarkId) || null;
    const cardData = cardDataMap.get(bookmarkId) || null;
    const normalized = normalizeQuickReviewBookmarkEntry({
      id: bookmarkId,
      url: bookmark?.url || cardData?.url || '',
      title: bookmark?.title || cardData?.title || bookmark?.url || cardData?.url || '',
      name: bookmark?.title || cardData?.title || bookmark?.url || cardData?.url || '',
      parentId: bookmark?.parentId || '',
      dateAdded: bookmark?.dateAdded || 0,
      ancestorFolderIds: []
    }, cardData);
    if (normalized && normalized.url) {
      return { currentCards: normalizedCards, bookmark: normalized };
    }
  }

  return { currentCards: normalizedCards, bookmark: null };
}

async function ensureQuickReviewCandidateState() {
  const currentResult = await browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]);
  const currentCards = normalizeHistoryCurrentCardsState(currentResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);

  const pending = await resolveQuickReviewPendingBookmark(currentCards);
  if (pending.bookmark) {
    return { source: 'current', currentCards: pending.currentCards, bookmark: pending.bookmark };
  }

  const refreshed = await selectQuickReviewCardsRoundState({ force: true, currentCards });
  const nextCards = normalizeHistoryCurrentCardsState(refreshed?.currentCards);
  const nextPending = await resolveQuickReviewPendingBookmark(nextCards);
  if (nextPending.bookmark) {
    return { source: 'refreshed', currentCards: nextPending.currentCards, bookmark: nextPending.bookmark };
  }

  return { source: 'empty', currentCards: nextCards, bookmark: null };
}

async function runQuickReviewNextState(source = 'command') {
  return runSerializedQuickReviewCommand(async () => {
    await ensureScoreAlgoVersionReady();
    const resolvedSource = String(source || 'unknown');
    const mode = await getQuickReviewOpenModeState();
    const candidate = await ensureQuickReviewCandidateState();
    const bookmark = candidate?.bookmark || null;

    if (!bookmark) {
      return {
        success: true,
        handled: false,
        empty: true,
        source: resolvedSource,
        openMode: mode
      };
    }

    const openResult = mode === 'new_tab'
      ? await openInQuickReviewNewTabState(bookmark.url, bookmark)
      : await openInQuickReviewTabState(bookmark.url, bookmark);

    if (!openResult || !openResult.success) {
      return {
        success: false,
        handled: false,
        source: resolvedSource,
        bookmarkId: bookmark.id || null,
        url: bookmark.url || '',
        openMode: mode,
        reason: 'open_failed',
        error: openResult?.error || 'open_failed'
      };
    }

    const bookmarkId = String(bookmark.id || '').trim();
    let allFlipped = false;

    if (bookmarkId) {
      try {
        await appendRecommendFlippedBookmarkState(bookmarkId);
      } catch (_) {}
      try {
        await appendRecommendFlipHistoryRecordState(bookmarkId, Date.now());
      } catch (_) {}
      try {
        await recordRecommendReviewState(bookmarkId);
      } catch (_) {}
      try {
        const markResult = await markHistoryCurrentCardFlippedState(bookmarkId);
        allFlipped = markResult?.allFlipped === true;
      } catch (_) {}
    }

    let roundRefreshed = false;
    let refreshMarked = false;
    if (allFlipped) {
      try {
        await selectQuickReviewCardsRoundState({ force: true });
        roundRefreshed = true;
        try {
          await markRecommendRefreshExecutedState();
          refreshMarked = true;
        } catch (_) {}
      } catch (_) {}
    }

    return {
      success: true,
      handled: true,
      source: resolvedSource,
      bookmarkId: bookmarkId || null,
      url: bookmark.url || '',
      openMode: mode,
      tabId: Number.isFinite(Number(openResult?.tabId)) ? Number(openResult.tabId) : null,
      allFlipped,
      roundRefreshed,
      refreshMarked
    };
  });
}

async function handleQuickReviewNextCommand() {
  triggerRecommendBackgroundRefresh('quick-review-command', { requireIdle: true });
  await runQuickReviewNextState('command');
}

function initSidePanel() {
  if (!browserAPI?.sidePanel) return;
  try {
    if (browserAPI.sidePanel.setPanelBehavior) {
      browserAPI.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }, () => {});
    }
  } catch (_) {}
}

async function getCurrentWindowIdAsync() {
  return await new Promise((resolve) => {
    try {
      if (!browserAPI?.windows?.getCurrent) {
        resolve(null);
        return;
      }
      browserAPI.windows.getCurrent((win) => {
        resolve(win && typeof win.id === 'number' ? win.id : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function resolveWindowIdForSidePanelAction(message, sender) {
  const requestedWindowId = Number(message && message.windowId);
  if (Number.isFinite(requestedWindowId) && requestedWindowId >= 0) {
    return requestedWindowId;
  }
  const senderWindowId = sender && sender.tab && typeof sender.tab.windowId === 'number'
    ? sender.tab.windowId
    : null;
  if (senderWindowId != null) return senderWindowId;
  return await getCurrentWindowIdAsync();
}

async function openSidePanelInWindow(windowId, view = null) {
  if (typeof windowId !== 'number') {
    return { success: false, error: 'window_unavailable' };
  }
  if (typeof browserAPI?.sidePanel?.open !== 'function') {
    return { success: false, error: 'open_unavailable' };
  }

  const safeView = normalizeHistoryPanelView(view, '');
  if (safeView) {
    try {
      browserAPI.storage.local.set({
        historyRequestedView: { view: safeView, time: Date.now() }
      }, () => {});
    } catch (_) {}
  }

  return await new Promise((resolve) => {
    try {
      browserAPI.sidePanel.open({ windowId }, () => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve({ success: false, error: err.message || 'open_failed' });
          return;
        }
        setSidePanelOpenWindowState(windowId, true);
        resolve({ success: true, isOpen: true });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || 'open_failed' });
    }
  });
}

const SIDE_PANEL_CONTEXT = browserAPI?.runtime?.ContextType?.SIDE_PANEL || 'SIDE_PANEL';
const SIDE_PANEL_TOGGLE_PORT = 'bookmark-record-recommend-sidepanel-toggle-v1';
const sidePanelOpenWindows = new Set();
const sidePanelTogglePortsByWindow = new Map();
const sidePanelToggleUnboundPorts = new Set();
let sidePanelTogglePortListenerRegistered = false;

function setSidePanelOpenWindowState(windowId, isOpen) {
  if (typeof windowId !== 'number') return;
  if (isOpen) {
    sidePanelOpenWindows.add(windowId);
    return;
  }
  sidePanelOpenWindows.delete(windowId);
}

function addUnboundSidePanelTogglePort(port) {
  if (!port) return;
  sidePanelToggleUnboundPorts.add(port);
}

function removeUnboundSidePanelTogglePort(port) {
  if (!port) return;
  sidePanelToggleUnboundPorts.delete(port);
}

function addSidePanelTogglePort(windowId, port) {
  if (typeof windowId !== 'number' || !port) return;
  removeUnboundSidePanelTogglePort(port);
  let windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (!windowPorts) {
    windowPorts = new Set();
    sidePanelTogglePortsByWindow.set(windowId, windowPorts);
  }
  windowPorts.add(port);
}

function cleanupWindowPortSetIfEmpty(windowId, windowPorts) {
  if (!windowPorts || windowPorts.size !== 0) return;
  sidePanelTogglePortsByWindow.delete(windowId);
}

function removeSidePanelTogglePort(windowId, port) {
  if (typeof windowId !== 'number' || !port) return;
  const windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (!windowPorts) return;
  windowPorts.delete(port);
  cleanupWindowPortSetIfEmpty(windowId, windowPorts);
}

function removeSidePanelTogglePortEverywhere(port) {
  if (!port) return;
  removeUnboundSidePanelTogglePort(port);
  for (const [windowId, windowPorts] of Array.from(sidePanelTogglePortsByWindow.entries())) {
    if (!windowPorts.has(port)) continue;
    windowPorts.delete(port);
    cleanupWindowPortSetIfEmpty(windowId, windowPorts);
  }
}

function registerSidePanelTogglePortListener() {
  if (sidePanelTogglePortListenerRegistered) return;
  if (!browserAPI?.runtime?.onConnect?.addListener) return;
  sidePanelTogglePortListenerRegistered = true;

  browserAPI.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== SIDE_PANEL_TOGGLE_PORT) return;

    let trackedWindowId = null;
    addUnboundSidePanelTogglePort(port);

    const updateTrackedWindowId = (windowId) => {
      if (typeof windowId !== 'number') return;
      if (trackedWindowId === windowId) return;
      if (typeof trackedWindowId === 'number') {
        removeSidePanelTogglePort(trackedWindowId, port);
      }
      trackedWindowId = windowId;
      addSidePanelTogglePort(trackedWindowId, port);
      setSidePanelOpenWindowState(trackedWindowId, true);
    };

    const senderWindowId = port?.sender?.tab?.windowId;
    if (typeof senderWindowId === 'number') {
      updateTrackedWindowId(senderWindowId);
    }

    const onMessage = (message) => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'sidepanel_toggle_bridge_hello') {
        updateTrackedWindowId(message.windowId);
        try {
          port.postMessage({ type: 'sidepanel_toggle_bridge_ack', ts: Date.now() });
        } catch (_) { }
      }
    };

    const onDisconnect = () => {
      try {
        const err = browserAPI?.runtime?.lastError;
        if (err && err.message) {
          // touch lastError to avoid unchecked runtime.lastError noise.
        }
      } catch (_) { }

      if (typeof trackedWindowId === 'number') {
        setSidePanelOpenWindowState(trackedWindowId, false);
      }
      removeSidePanelTogglePortEverywhere(port);
      try {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
      } catch (_) { }
    };

    try {
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
    } catch (_) { }

    try {
      port.postMessage({ type: 'sidepanel_toggle_bridge_request_window_id', ts: Date.now() });
    } catch (_) { }
  });

  if (browserAPI?.windows?.onRemoved?.addListener) {
    browserAPI.windows.onRemoved.addListener((windowId) => {
      if (typeof windowId !== 'number') return;
      sidePanelTogglePortsByWindow.delete(windowId);
      setSidePanelOpenWindowState(windowId, false);
    });
  }
}

async function getSidePanelContexts() {
  if (!browserAPI?.runtime?.getContexts) return null;
  try {
    const filter = { contextTypes: [SIDE_PANEL_CONTEXT] };
    const result = browserAPI.runtime.getContexts(filter);
    if (result && typeof result.then === 'function') {
      return await result;
    }
    return await new Promise((resolve) => {
      try {
        browserAPI.runtime.getContexts(filter, (contexts) => {
          resolve(Array.isArray(contexts) ? contexts : []);
        });
      } catch (_) {
        resolve([]);
      }
    });
  } catch (_) {
    return null;
  }
}

async function refreshSidePanelOpenWindows() {
  const contexts = await getSidePanelContexts();
  if (!Array.isArray(contexts)) return null;
  sidePanelOpenWindows.clear();
  contexts.forEach((ctx) => {
    if (ctx && typeof ctx.windowId === 'number') {
      setSidePanelOpenWindowState(ctx.windowId, true);
    }
  });
  return contexts;
}

async function getSidePanelOpenStateForWindow(windowId) {
  if (typeof windowId !== 'number') return false;
  const contexts = await refreshSidePanelOpenWindows();
  if (Array.isArray(contexts) && sidePanelOpenWindows.has(windowId)) {
    return true;
  }

  const windowPorts = sidePanelTogglePortsByWindow.get(windowId);
  if (windowPorts && windowPorts.size > 0) {
    return true;
  }

  return sidePanelOpenWindows.has(windowId);
}

async function closeSidePanelInWindow(windowId) {
  if (typeof windowId !== 'number') {
    return { success: false, error: 'window_unavailable' };
  }
  if (typeof browserAPI?.sidePanel?.close !== 'function') {
    return { success: false, error: 'close_unavailable' };
  }

  return await new Promise((resolve) => {
    try {
      browserAPI.sidePanel.close({ windowId }, () => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve({ success: false, error: err.message || 'close_failed' });
          return;
        }
        setSidePanelOpenWindowState(windowId, false);
        resolve({ success: true, isOpen: false });
      });
    } catch (error) {
      resolve({ success: false, error: error?.message || 'close_failed' });
    }
  });
}

if (browserAPI?.runtime?.onInstalled) {
  browserAPI.runtime.onInstalled.addListener(() => {
    initSidePanel();
    refreshSidePanelOpenWindows().catch(() => {});
    ensureRecommendBackgroundRefreshAlarm({ force: true }).catch(() => {});
    scheduleRecommendStartupSelfHeal('on-installed').catch(() => {});
    triggerRecommendBackgroundRefresh('on-installed', { requireIdle: true });
  });
}

if (browserAPI?.runtime?.onStartup) {
  browserAPI.runtime.onStartup.addListener(() => {
    ensureRecommendBackgroundRefreshAlarm({ force: true }).catch(() => {});
    scheduleRecommendStartupSelfHeal('on-startup').catch(() => {});
    triggerRecommendBackgroundRefresh('on-startup', { requireIdle: true });
  });
}

initSidePanel();
registerSidePanelTogglePortListener();
refreshSidePanelOpenWindows().catch(() => {});

if (browserAPI?.alarms?.onAlarm) {
  browserAPI.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== RECOMMEND_BACKGROUND_REFRESH_ALARM) return;
    triggerRecommendBackgroundRefresh('alarm', { requireIdle: true });
  });
}

if (browserAPI.commands && browserAPI.commands.onCommand) {
  browserAPI.commands.onCommand.addListener((command) => {
    if (command === 'open_additions_view') openView('additions');
    if (command === 'open_recommend_view') openView('recommend');
    if (command === 'quick_review_next') {
      handleQuickReviewNextCommand().catch(() => {});
    }
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
// Browsing history calibration (background)
// =================================================================================

const BROWSING_HISTORY_CACHE_KEY = 'bb_cache_browsing_history_v1';
const BROWSING_HISTORY_CACHE_DB_NAME = 'BookmarkBrowsingHistoryCacheDB';
const BROWSING_HISTORY_CACHE_DB_VERSION = 1;
const BROWSING_HISTORY_CACHE_DB_STORE = 'records';
const BROWSING_HISTORY_CACHE_DB_META = 'meta';
const BROWSING_HISTORY_SEARCH_PAGE_SIZE = 5000;
const BROWSING_HISTORY_SEARCH_MAX_ITEMS = 50000;
const BROWSING_HISTORY_MAX_VISITS_PER_URL = 400;
const BROWSING_HISTORY_LOOKBACK_DAYS = 0;

const BROWSING_CALIBRATION_SETTINGS_KEY = 'browsingCalibrationSettings';
const BROWSING_CALIBRATION_STATE_KEY = 'browsingCalibrationState';
const DEFAULT_BROWSING_CALIBRATION_SETTINGS = {
  autoEnabled: true,
  deleteThreshold: 15,
  openThreshold: 0
};
const DEFAULT_BROWSING_CALIBRATION_STATE = {
  pendingDeleteCount: 0,
  pendingOpenCount: 0,
  lastCalibrationTime: 0,
  lastDeletionTime: 0,
  lastOpenTime: 0
};

let browsingCalibrationInProgress = false;
let browsingHistoryCacheDbPromise = null;

function normalizeBrowsingCalibrationSettings(raw = {}) {
  const settings = { ...DEFAULT_BROWSING_CALIBRATION_SETTINGS, ...(raw || {}) };
  const hasDelete = Object.prototype.hasOwnProperty.call(raw || {}, 'deleteThreshold');
  const hasOpen = Object.prototype.hasOwnProperty.call(raw || {}, 'openThreshold');
  const hasClick = Object.prototype.hasOwnProperty.call(raw || {}, 'clickThreshold');
  const hasAutoEnabled = Object.prototype.hasOwnProperty.call(raw || {}, 'autoEnabled');
  const autoDisabled = hasAutoEnabled ? raw.autoEnabled === false : false;

  if (!hasOpen && hasClick) {
    settings.openThreshold = raw.clickThreshold;
  }

  if (raw && autoDisabled) {
    if (!hasDelete) settings.deleteThreshold = 0;
    if (!hasOpen && !hasClick) settings.openThreshold = 0;
  }

  settings.deleteThreshold = Math.max(0, Number(settings.deleteThreshold) || 0);
  settings.openThreshold = Math.max(0, Number(settings.openThreshold) || 0);
  return settings;
}

function getCalibrationThresholds(settings) {
  return {
    deleteThreshold: Math.max(0, Number(settings.deleteThreshold) || 0),
    openThreshold: Math.max(0, Number(settings.openThreshold) || 0)
  };
}

function isAutoCalibrationEnabled(settings, thresholds) {
  if (settings && settings.autoEnabled === false) return false;
  return (thresholds.deleteThreshold > 0 || thresholds.openThreshold > 0);
}

function normalizeHistoryDomain(domain) {
  if (!domain) return '';
  return String(domain).toLowerCase().replace(/^www\./, '');
}

function getHistoryUrlDomain(url) {
  if (!url) return '';
  try {
    return normalizeHistoryDomain(new URL(url).hostname);
  } catch (_) {
    return '';
  }
}

function getHistoryDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function openBrowsingHistoryCacheDB() {
  if (browsingHistoryCacheDbPromise) return browsingHistoryCacheDbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  browsingHistoryCacheDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(BROWSING_HISTORY_CACHE_DB_NAME, BROWSING_HISTORY_CACHE_DB_VERSION);
    request.onerror = () => {
      console.warn('[Background][HistoryCache] open DB failed:', request.error);
      resolve(null);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(BROWSING_HISTORY_CACHE_DB_STORE)) {
        db.createObjectStore(BROWSING_HISTORY_CACHE_DB_STORE, { keyPath: 'dateKey' });
      }
      if (!db.objectStoreNames.contains(BROWSING_HISTORY_CACHE_DB_META)) {
        db.createObjectStore(BROWSING_HISTORY_CACHE_DB_META, { keyPath: 'key' });
      }
    };
  });
  return browsingHistoryCacheDbPromise;
}

async function removeBrowsingHistoryCacheFromIDB() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
    tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE).clear();
    tx.objectStore(BROWSING_HISTORY_CACHE_DB_META).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function writeBrowsingHistoryCacheToIDB(payload) {
  if (!payload || !Array.isArray(payload.records)) return false;
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
    const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
    const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
    try {
      for (const [dateKey, items] of payload.records) {
        if (!dateKey) continue;
        recordsStore.put({ dateKey, items: Array.isArray(items) ? items : [] });
      }
      metaStore.put({ key: 'lastSyncTime', value: payload.lastSyncTime || Date.now() });
    } catch (error) {
      console.warn('[Background][HistoryCache] write DB failed:', error);
      resolve(false);
      return;
    }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

async function writeBrowsingHistoryCache(payload) {
  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    await removeBrowsingHistoryCacheFromIDB();
    const ok = await writeBrowsingHistoryCacheToIDB(payload);
    if (ok) return true;
  }
  try {
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] write storage failed:', error);
    return false;
  }
}

async function resetBrowsingHistoryCache(lastSyncTime) {
  const payload = {
    lastSyncTime: lastSyncTime || Date.now(),
    records: []
  };
  await writeBrowsingHistoryCache(payload);
}

async function getBrowsingCalibrationSettingsBG() {
  try {
    const result = await browserAPI.storage.local.get([BROWSING_CALIBRATION_SETTINGS_KEY]);
    return normalizeBrowsingCalibrationSettings(
      result && result[BROWSING_CALIBRATION_SETTINGS_KEY]
        ? result[BROWSING_CALIBRATION_SETTINGS_KEY]
        : {}
    );
  } catch (error) {
    console.warn('[Background][Calibration] settings read failed:', error);
    return normalizeBrowsingCalibrationSettings({});
  }
}

async function getBrowsingCalibrationState() {
  try {
    const result = await browserAPI.storage.local.get([BROWSING_CALIBRATION_STATE_KEY]);
    const stored = result && result[BROWSING_CALIBRATION_STATE_KEY]
      ? result[BROWSING_CALIBRATION_STATE_KEY]
      : {};
    const merged = {
      ...DEFAULT_BROWSING_CALIBRATION_STATE,
      ...stored
    };
    if (stored && stored.pendingClickCount) {
      const clickCount = Number(stored.pendingClickCount) || 0;
      merged.pendingOpenCount = (merged.pendingOpenCount || 0) + clickCount;
    }
    if (stored && stored.lastClickTime) {
      const lastClick = Number(stored.lastClickTime) || 0;
      if (!merged.lastOpenTime || lastClick > merged.lastOpenTime) {
        merged.lastOpenTime = lastClick;
      }
    }
    delete merged.pendingClickCount;
    delete merged.lastClickTime;
    return merged;
  } catch (error) {
    console.warn('[Background][Calibration] state read failed:', error);
    return { ...DEFAULT_BROWSING_CALIBRATION_STATE };
  }
}

async function saveBrowsingCalibrationState(state) {
  try {
    await browserAPI.storage.local.set({ [BROWSING_CALIBRATION_STATE_KEY]: state });
  } catch (error) {
    console.warn('[Background][Calibration] state save failed:', error);
  }
}

async function resetBrowsingCalibrationState(reason = 'manual') {
  const state = await getBrowsingCalibrationState();
  const nextState = {
    ...state,
    pendingDeleteCount: 0,
    pendingOpenCount: 0,
    lastCalibrationTime: Date.now()
  };
  await saveBrowsingCalibrationState(nextState);

}

function collectBookmarkUrlsAndTitles(node, urlSet, titleSet, parentPath = [], titleDomainMap = null) {
  if (!node) return;
  if (node.url) {
    urlSet.add(node.url);
    if (node.title && node.title.trim()) {
      const trimmedTitle = node.title.trim();
      titleSet.add(trimmedTitle);
      if (titleDomainMap) {
        const domain = getHistoryUrlDomain(node.url);
        if (domain) {
          let domains = titleDomainMap.get(trimmedTitle);
          if (!domains) {
            domains = new Set();
            titleDomainMap.set(trimmedTitle, domains);
          }
          domains.add(domain);
        }
      }
    }
  }
  if (node.children) {
    const currentPath = node.title ? [...parentPath, node.title] : parentPath;
    node.children.forEach(child => collectBookmarkUrlsAndTitles(child, urlSet, titleSet, currentPath, titleDomainMap));
  }
}

function addVisitRecord(recordsByDate, visitKeySet, item, visitTime, options = {}, cutoffTime = 0) {
  if (!item || !item.url || !visitTime) return false;
  if (cutoffTime && visitTime < cutoffTime) return false;
  const visitKey = `${item.url}|${visitTime}`;
  if (visitKeySet.has(visitKey)) return false;
  visitKeySet.add(visitKey);
  const dateKey = getHistoryDateKey(visitTime);
  if (!recordsByDate.has(dateKey)) {
    recordsByDate.set(dateKey, []);
  }
  const records = recordsByDate.get(dateKey);
  records.push({
    id: options.id || `${item.id || item.url}-${visitTime}-${records.length}`,
    title: item.title || item.url,
    url: item.url,
    dateAdded: visitTime,
    visitTime,
    visitCount: typeof options.count === 'number' && options.count > 0 ? options.count : 1,
    typedCount: item.typedCount || 0,
    folderPath: [],
    transition: options.transition || '',
    referringVisitId: options.referringVisitId || null,
    aggregated: !!options.aggregated
  });
  return true;
}

async function rebuildBrowsingHistoryCache(reason = 'auto') {
  if (!browserAPI.history || !browserAPI.history.search || !browserAPI.bookmarks) return false;

  const bookmarks = await browserAPI.bookmarks.getTree();
  const bookmarkUrls = new Set();
  const bookmarkTitles = new Set();
  const titleDomainMap = new Map();
  if (Array.isArray(bookmarks) && bookmarks[0]) {
    collectBookmarkUrlsAndTitles(bookmarks[0], bookmarkUrls, bookmarkTitles, [], titleDomainMap);
  }

  const now = Date.now();
  const lookbackMs = (typeof BROWSING_HISTORY_LOOKBACK_DAYS === 'number' && BROWSING_HISTORY_LOOKBACK_DAYS > 0)
    ? BROWSING_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const cutoffTime = lookbackMs ? (now - lookbackMs) : 0;

  if (bookmarkUrls.size === 0) {
    await resetBrowsingHistoryCache(now);
    return true;
  }

  const fetchHistoryBatch = (startTime, endTime) => new Promise((resolve) => {
    browserAPI.history.search({
      text: '',
      startTime,
      endTime,
      maxResults: BROWSING_HISTORY_SEARCH_PAGE_SIZE
    }, (results) => resolve(results || []));
  });

  const historyItems = [];
  let pageEnd = now;
  const effectiveStartTime = cutoffTime || 0;

  while (pageEnd >= effectiveStartTime) {
    const batch = await fetchHistoryBatch(effectiveStartTime, pageEnd);
    if (!batch.length) break;

    historyItems.push(...batch);
    if (historyItems.length >= BROWSING_HISTORY_SEARCH_MAX_ITEMS) {
      historyItems.length = BROWSING_HISTORY_SEARCH_MAX_ITEMS;
      break;
    }

    if (batch.length < BROWSING_HISTORY_SEARCH_PAGE_SIZE) break;

    let oldest = pageEnd;
    for (const item of batch) {
      const t = item.lastVisitTime || pageEnd;
      if (t < oldest) oldest = t;
    }
    if (!oldest || oldest <= effectiveStartTime) break;
    pageEnd = oldest - 1;
  }

  const relevantHistoryItems = historyItems.filter(item => {
    if (!item || !item.url) return false;
    if (bookmarkUrls.has(item.url)) return true;
    const title = item.title && item.title.trim();
    if (title && bookmarkTitles.has(title)) {
      const allowedDomains = titleDomainMap.get(title);
      if (allowedDomains && allowedDomains.size > 0) {
        const itemDomain = getHistoryUrlDomain(item.url);
        if (itemDomain && allowedDomains.has(itemDomain)) {
          return true;
        }
      }
    }
    return false;
  });

  if (!relevantHistoryItems.length) {
    await resetBrowsingHistoryCache(now);
    return true;
  }

  const recordsByDate = new Map();
  const visitKeySet = new Set();
  const hasVisitDetails = browserAPI.history && typeof browserAPI.history.getVisits === 'function';

  const getVisitsAsync = (item) => new Promise((resolve) => {
    try {
      browserAPI.history.getVisits({ url: item.url }, (visits) => resolve(visits || []));
    } catch (_) {
      resolve([]);
    }
  });

  if (!hasVisitDetails) {
    relevantHistoryItems.forEach(item => {
      const fallbackTime = item.lastVisitTime || 0;
      if (!fallbackTime) return;
      addVisitRecord(recordsByDate, visitKeySet, item, fallbackTime, {
        count: Math.max(item.visitCount || 1, 1),
        aggregated: true,
        id: item.id || item.url
      }, cutoffTime);
    });
  } else {
    const concurrency = Math.max(1, Math.min(8, relevantHistoryItems.length));
    let cursor = 0;

    const processNext = async () => {
      while (cursor < relevantHistoryItems.length) {
        const currentIndex = cursor++;
        const item = relevantHistoryItems[currentIndex];
        if (!item || !item.url) continue;

        const visits = await getVisitsAsync(item);
        let inserted = 0;

        if (Array.isArray(visits) && visits.length) {
          for (const visit of visits) {
            const visitTime = typeof visit.visitTime === 'number' ? visit.visitTime : 0;
            if (!visitTime) continue;
            if (addVisitRecord(recordsByDate, visitKeySet, item, visitTime, {
              id: `${item.id || item.url}-${visit.visitId || visitTime}-${inserted}`,
              transition: visit.transition || '',
              referringVisitId: visit.referringVisitId || null,
              count: 1
            }, cutoffTime)) {
              inserted += 1;
            }
            if (BROWSING_HISTORY_MAX_VISITS_PER_URL && inserted >= BROWSING_HISTORY_MAX_VISITS_PER_URL) {
              break;
            }
          }
        }

        if (inserted === 0 && item.lastVisitTime) {
          addVisitRecord(recordsByDate, visitKeySet, item, item.lastVisitTime, {
            count: Math.max(item.visitCount || 1, 1),
            aggregated: true,
            id: item.id || item.url
          }, cutoffTime);
        }

        if (cursor % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => processNext()));
  }

  const recordsPayload = [];
  for (const [dateKey, items] of recordsByDate.entries()) {
    const normalizedItems = items.map(record => ({
      ...record,
      dateAdded: typeof record.dateAdded === 'number' ? record.dateAdded : (record.visitTime || Date.now())
    }));
    recordsPayload.push([dateKey, normalizedItems]);
  }

  await writeBrowsingHistoryCache({
    lastSyncTime: now,
    records: recordsPayload
  });


  return true;
}

async function runBrowsingHistoryCalibration({ reason = 'auto', clearOnly = false } = {}) {
  if (browsingCalibrationInProgress) return false;
  browsingCalibrationInProgress = true;
  try {
    if (clearOnly) {
      await resetBrowsingHistoryCache(Date.now());
      try {
        browserAPI.runtime.sendMessage({
          action: 'browsingCalibrationCompleted',
          payload: { reason, clearOnly: true }
        }).catch(() => {});
      } catch (_) { }
      return true;
    }
    const ok = await rebuildBrowsingHistoryCache(reason);
    if (ok) {
      try {
        browserAPI.runtime.sendMessage({
          action: 'browsingCalibrationCompleted',
          payload: { reason, clearOnly: false }
        }).catch(() => {});
      } catch (_) { }
    }
    return ok;
  } catch (error) {
    console.warn('[Background][Calibration] failed:', error);
    return false;
  } finally {
    browsingCalibrationInProgress = false;
  }
}

async function maybeRunBrowsingHistoryCalibration({ settings, nextState, reason = 'auto' } = {}) {
  const thresholds = getCalibrationThresholds(settings || {});
  if (!isAutoCalibrationEnabled(settings || {}, thresholds)) return false;

  let trigger = null;
  if (thresholds.deleteThreshold > 0 && nextState.pendingDeleteCount >= thresholds.deleteThreshold) {
    trigger = 'delete';
  } else if (thresholds.openThreshold > 0 && nextState.pendingOpenCount >= thresholds.openThreshold) {
    trigger = 'open';
  }

  if (!trigger) return false;

  const ok = await runBrowsingHistoryCalibration({ reason: `${reason}-${trigger}-threshold` });
  if (ok) {
    nextState.pendingDeleteCount = 0;
    nextState.pendingOpenCount = 0;
    nextState.lastCalibrationTime = Date.now();
  }
  return ok;
}

async function recordDeletionForCalibration({ source = 'unknown', urlCount = 0, hasUrlList = true, allHistory = false } = {}) {
  const settings = await getBrowsingCalibrationSettingsBG();
  const state = await getBrowsingCalibrationState();
  if (allHistory) {
    await runBrowsingHistoryCalibration({ reason: `${source}-all-history`, clearOnly: true });
    const nextState = {
      ...state,
      pendingDeleteCount: 0,
      pendingOpenCount: 0,
      lastCalibrationTime: Date.now(),
      lastDeletionTime: Date.now()
    };
    await saveBrowsingCalibrationState(nextState);
    return;
  }

  const thresholds = getCalibrationThresholds(settings);
  let increment = 1;
  if (hasUrlList) {
    increment = Math.max(1, Number(urlCount) || 1);
  }
  const nextState = {
    ...state,
    pendingDeleteCount: (state.pendingDeleteCount || 0) + increment,
    lastDeletionTime: Date.now()
  };

  await maybeRunBrowsingHistoryCalibration({ settings, nextState, reason: source });

  await saveBrowsingCalibrationState(nextState);
}

async function recordInteractionForCalibration({ type = 'open', increment = 1, source = 'ui' } = {}) {
  const settings = await getBrowsingCalibrationSettingsBG();
  const state = await getBrowsingCalibrationState();
  const nextState = { ...state };
  const step = Math.max(1, Number(increment) || 1);

  if (type === 'open' || type === 'click') {
    nextState.pendingOpenCount = (state.pendingOpenCount || 0) + step;
    nextState.lastOpenTime = Date.now();
  } else {
    return;
  }

  await maybeRunBrowsingHistoryCalibration({ settings, nextState, reason: source });
  await saveBrowsingCalibrationState(nextState);
}

if (browserAPI.history && browserAPI.history.onVisitRemoved) {
  browserAPI.history.onVisitRemoved.addListener((details) => {
    const urls = Array.isArray(details?.urls) ? details.urls : [];
    recordDeletionForCalibration({
      source: 'history',
      allHistory: !!details?.allHistory,
      urlCount: urls.length,
      hasUrlList: urls.length > 0
    }).catch(() => {});
  });
}

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
let bookmarkBulkHasRemoval = false;
let scoreCacheMode = null;
let pendingTemplateRefineIds = new Set();
let templateRefineTimer = null;
let templateRefineRunning = false;
let recommendStateMutationChains = new Map();
let bulkTemplateRecoveryTimer = null;
let recommendScoresReadyPromise = null;
let removedRecommendPruneTimer = null;
let pendingRemovedBookmarkIds = new Set();
let pendingRemovedFolderIds = new Set();
let pendingMovedBookmarkIds = new Set();
let recommendBackgroundRefreshInProgress = false;
let recommendBackgroundRefreshLastAttemptAt = 0;
let ensureRecommendBackgroundRefreshAlarmPromise = null;
let ensureRecommendBackgroundRefreshAlarmLastCheckAt = 0;
let bookmarkMutationFlushTimer = null;
let bookmarkMutationFlushQueuedAt = 0;
let bookmarkMutationFlushInProgress = false;
let bookmarkMutationInFlightState = null;
let bookmarkMutationQueuePersistTimer = null;
let restoreBookmarkMutationQueuePromise = null;
let startupRecommendSelfHealPromise = null;
let pendingCreatedScoreBookmarkIds = new Set();
let pendingChangedScoreBookmarkIds = new Set();
let pendingChangedBookmarkUrls = new Set();

const BOOKMARK_BULK_WINDOW_MS = 800;
const BOOKMARK_BULK_THRESHOLD = 120;
const BOOKMARK_BULK_QUIET_MS = 5000;
const BOOKMARK_MUTATION_FLUSH_DEBOUNCE_MS = 1400;
const BOOKMARK_MUTATION_FLUSH_MAX_WAIT_MS = 30000;
const BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE = 200;
const BOOKMARK_MUTATION_QUEUE_STORAGE_KEY = 'bb_recommend_mutation_queue_v1';
const BOOKMARK_MUTATION_QUEUE_SAVE_DEBOUNCE_MS = 900;
const BOOKMARK_MUTATION_QUEUE_MAX_ITEMS = 6000;
const BOOKMARK_BULK_CHANGE_FLAG_KEY = 'bookmarkBulkChangeFlag';
const BOOKMARK_BULK_CHANGE_META_KEY = 'bookmarkBulkChangeMeta';
const BOOKMARK_BULK_CHANGE_STALE_MAX_MS = 2 * 60 * 60 * 1000;

const SCORE_ALGO_VERSION_KEY = 'recommend_scores_algo_version';
const SCORE_ALGO_VERSION = 6.3;

const SCORE_CACHE_MODE_KEY = 'recommend_scores_cache_mode';
const SCORE_CACHE_MODE_FULL = 'full';
const SCORE_CACHE_MODE_COMPACT = 'compact';
const SCORE_CACHE_COMPACT_THRESHOLD = 8000;

const SCORE_BOOTSTRAP_THRESHOLD = 1200;
const SCORE_BOOTSTRAP_LIMIT = 600;
const SCORE_INCREMENTAL_BATCH_SIZE = 180;
const SCORE_TEMPLATE_BATCH_THRESHOLD = 800;
const SCORE_TEMPLATE_DEFAULT_S = 0.5;
const SCORE_TEMPLATE_REFINE_DEBOUNCE_MS = 400;
const SCORE_TEMPLATE_REFINE_BATCH_SIZE = 360;
const BULK_TEMPLATE_RECOVERY_DEBOUNCE_MS = 1200;
const REMOVED_RECOMMEND_PRUNE_DEBOUNCE_MS = 900;
const RECOMMEND_BACKGROUND_REFRESH_ALARM = 'bb_recommend_background_refresh_v1';
const RECOMMEND_BACKGROUND_REFRESH_CHECK_PERIOD_MINUTES = 60;
const RECOMMEND_BACKGROUND_REFRESH_MIN_ATTEMPT_GAP_MS = 5 * 60 * 1000;
const RECOMMEND_BACKGROUND_REFRESH_ALARM_CHECK_MIN_GAP_MS = 60 * 1000;
const RECOMMEND_BACKGROUND_REFRESH_DEFAULT_MAX_STALE_MS = 6 * 60 * 60 * 1000;
const RECOMMEND_BACKGROUND_REFRESH_MIN_STALE_MS = 30 * 60 * 1000;
const RECOMMEND_BACKGROUND_REFRESH_MAX_STALE_MS = 14 * 24 * 60 * 60 * 1000;

const RECOMMEND_SKIPPED_STORAGE_KEY = 'recommend_skipped_bookmarks_v1';
const RECOMMEND_SKIPPED_MAX_ITEMS = 20000;
const RECOMMEND_BLOCKED_STORAGE_KEY = 'recommend_blocked';
const RECOMMEND_POSTPONED_STORAGE_KEY = 'recommend_postponed';
const RECOMMEND_STATE_MUTATION_CHANNEL = 'recommend_state_mutation_v1';
const RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY = 'recommendRefreshSettings';
const HISTORY_CURRENT_CARDS_STORAGE_KEY = 'historyCurrentCards';
const FLIPPED_BOOKMARKS_STORAGE_KEY = 'flippedBookmarks';
const RECOMMEND_POOL_CURSOR_STORAGE_KEY = 'bb_recommend_pool_cursor_v1';
const FLIP_HISTORY_STORAGE_KEY = 'flipHistory';
const HEATMAP_DAILY_INDEX_STORAGE_KEY = 'flipHistoryDailyIndexV1';
const FLIP_HISTORY_MAX_ITEMS = 12000;
const FLIP_HISTORY_RETENTION_DAYS = 420;
const FLIP_HISTORY_DAY_RECORDS_MAX = 300;

const DEFAULT_REFRESH_SETTINGS = {
  refreshEveryNOpens: 3,
  refreshAfterHours: 0,
  refreshAfterDays: 0,
  lastRefreshTime: 0,
  openCountSinceRefresh: 0,
  sidePanelOpenCountSinceRefresh: 0
};

ensureRecommendBackgroundRefreshAlarm().catch(() => {});
scheduleRecommendStartupSelfHeal('worker-boot').catch(() => {});

// Tracking cold-start fairness
const TRACKING_WARMUP_MIN_MS = 30 * 60 * 1000; // 30 minutes
const TRACKING_WARMUP_MIN_COUNT = 30; // 30 tracked items
const TRACKING_NEUTRAL_T = 0.5;

function buildScoreCacheEntry(options = {}) {
  const mode = options?.mode === SCORE_CACHE_MODE_FULL ? SCORE_CACHE_MODE_FULL : SCORE_CACHE_MODE_COMPACT;
  const existing = options?.existing && typeof options.existing === 'object' ? options.existing : {};
  const scores = options?.scores && typeof options.scores === 'object' ? options.scores : null;
  const template = options?.template === true;
  const bookmark = options?.bookmark && typeof options.bookmark === 'object' ? options.bookmark : null;

  const fallbackS = Number.isFinite(Number(existing?.S)) ? Number(existing.S) : SCORE_TEMPLATE_DEFAULT_S;
  const nextS = Number.isFinite(Number(scores?.S)) ? Number(scores.S) : fallbackS;
  let entry;

  if (mode === SCORE_CACHE_MODE_FULL) {
    entry = {
      S: nextS,
      F: Number.isFinite(Number(scores?.F))
        ? Number(scores.F)
        : (Number.isFinite(Number(existing?.F)) ? Number(existing.F) : SCORE_TEMPLATE_DEFAULT_S),
      C: Number.isFinite(Number(scores?.C))
        ? Number(scores.C)
        : (Number.isFinite(Number(existing?.C)) ? Number(existing.C) : SCORE_TEMPLATE_DEFAULT_S),
      T: Number.isFinite(Number(scores?.T))
        ? Number(scores.T)
        : (Number.isFinite(Number(existing?.T)) ? Number(existing.T) : SCORE_TEMPLATE_DEFAULT_S),
      D: Number.isFinite(Number(scores?.D))
        ? Number(scores.D)
        : (Number.isFinite(Number(existing?.D)) ? Number(existing.D) : SCORE_TEMPLATE_DEFAULT_S),
      L: Number.isFinite(Number(scores?.L))
        ? Number(scores.L)
        : (Number.isFinite(Number(existing?.L)) ? Number(existing.L) : 0),
      R: Number.isFinite(Number(scores?.R))
        ? Number(scores.R)
        : (Number.isFinite(Number(existing?.R)) ? Number(existing.R) : 1)
    };
  } else {
    entry = { S: nextS };
  }

  if (template || (scores == null && existing?._template === true)) {
    entry._template = true;
  }

  const metadata = normalizeScoreCacheMetadata(bookmark, existing);
  if (metadata) {
    entry.url = metadata.url;
    entry.title = metadata.title;
    entry.parentId = metadata.parentId;
    entry.dateAdded = metadata.dateAdded;
    entry.ancestorFolderIds = metadata.ancestorFolderIds;
  }

  return entry;
}

async function invalidateRecommendCaches(reason = '', options = {}) {
  const keepCurrentCards = options?.keepCurrentCards === true;

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
    const removeKeys = keepCurrentCards
      ? [RECOMMEND_POOL_CURSOR_STORAGE_KEY]
      : [HISTORY_CURRENT_CARDS_STORAGE_KEY, RECOMMEND_POOL_CURSOR_STORAGE_KEY];
    await browserAPI.storage.local.remove(removeKeys);
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

let ensureScoreAlgoVersionReadyPromise = null;
function ensureScoreAlgoVersionReady() {
  if (!ensureScoreAlgoVersionReadyPromise) {
    ensureScoreAlgoVersionReadyPromise = ensureScoreAlgoVersion()
      .catch(() => {})
      .then(() => true);
  }
  return ensureScoreAlgoVersionReadyPromise;
}

ensureScoreAlgoVersionReady().catch(() => { });

function runSerializedRecommendStateMutation(channel, task) {
  const key = String(channel || RECOMMEND_STATE_MUTATION_CHANNEL);
  const prev = recommendStateMutationChains.get(key) || Promise.resolve();
  const next = prev
    .catch(() => { })
    .then(async () => task());

  recommendStateMutationChains.set(key, next);

  next.finally(() => {
    if (recommendStateMutationChains.get(key) === next) {
      recommendStateMutationChains.delete(key);
    }
  });

  return next;
}

function normalizeRecommendSkippedIds(ids = []) {
  const list = Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  ));

  if (list.length <= RECOMMEND_SKIPPED_MAX_ITEMS) {
    return list;
  }
  return list.slice(list.length - RECOMMEND_SKIPPED_MAX_ITEMS);
}

async function getRecommendSkippedIds() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_SKIPPED_STORAGE_KEY]);
    return normalizeRecommendSkippedIds(result?.[RECOMMEND_SKIPPED_STORAGE_KEY] || []);
  } catch (_) {
    return [];
  }
}

async function getRecommendPostponedList() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_POSTPONED_STORAGE_KEY]);
    return Array.isArray(result?.[RECOMMEND_POSTPONED_STORAGE_KEY])
      ? result[RECOMMEND_POSTPONED_STORAGE_KEY]
      : [];
  } catch (_) {
    return [];
  }
}

function normalizeRecommendBlockedState(blocked) {
  const source = blocked && typeof blocked === 'object' ? blocked : {};

  const normalizeIdList = (list) => Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .map(item => String(item || '').trim())
      .filter(Boolean)
  ));

  const normalizeDomainList = (list) => Array.from(new Set(
    (Array.isArray(list) ? list : [])
      .map(item => normalizeBlockedDomain(item))
      .filter(Boolean)
  ));

  return {
    bookmarks: normalizeIdList(source.bookmarks),
    folders: normalizeIdList(source.folders),
    domains: normalizeDomainList(source.domains)
  };
}

function normalizeRecommendPostponedList(list) {
  if (!Array.isArray(list)) return [];

  const byBookmarkId = new Map();
  for (const item of list) {
    if (!item || item.bookmarkId == null) continue;
    const bookmarkId = String(item.bookmarkId || '').trim();
    if (!bookmarkId) continue;

    const normalized = {
      ...item,
      bookmarkId
    };

    if (!byBookmarkId.has(bookmarkId)) {
      byBookmarkId.set(bookmarkId, normalized);
      continue;
    }

    const existing = byBookmarkId.get(bookmarkId);
    const existingUpdatedAt = Number(existing?.updatedAt || existing?.createdAt || existing?.addedAt || 0);
    const nextUpdatedAt = Number(normalized?.updatedAt || normalized?.createdAt || normalized?.addedAt || 0);

    if (nextUpdatedAt >= existingUpdatedAt) {
      byBookmarkId.set(bookmarkId, {
        ...existing,
        ...normalized,
        bookmarkId
      });
    }
  }

  return Array.from(byBookmarkId.values());
}

async function getRecommendBlockedState() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_BLOCKED_STORAGE_KEY]);
    return normalizeRecommendBlockedState(result?.[RECOMMEND_BLOCKED_STORAGE_KEY]);
  } catch (_) {
    return normalizeRecommendBlockedState(null);
  }
}

async function setRecommendBlockedState(blocked) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const next = normalizeRecommendBlockedState(blocked);
    await browserAPI.storage.local.set({
      [RECOMMEND_BLOCKED_STORAGE_KEY]: next
    });
    return {
      success: true,
      blocked: next
    };
  });
}

async function setRecommendPostponedState(postponed) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const next = normalizeRecommendPostponedList(postponed);
    await browserAPI.storage.local.set({
      [RECOMMEND_POSTPONED_STORAGE_KEY]: next
    });
    return {
      success: true,
      postponed: next,
      count: next.length
    };
  });
}

async function getAllBookmarkUrlIdsForScore() {
  if (!browserAPI?.bookmarks?.getTree) return [];

  try {
    const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
    const ids = [];

    const traverse = (nodes) => {
      if (!Array.isArray(nodes)) return;
      for (const node of nodes) {
        if (node?.url && node?.id != null) {
          ids.push(String(node.id));
        }
        if (Array.isArray(node?.children) && node.children.length > 0) {
          traverse(node.children);
        }
      }
    };

    traverse(tree);
    return normalizeBookmarkIdList(ids);
  } catch (e) {
    console.warn('[S-score] collect bookmark ids failed:', e);
    return [];
  }
}

async function handleRecommendSkipState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, mode: 'none', skippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [rawSkipped, rawPostponed] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedList()
    ]);

    const skipped = normalizeRecommendSkippedIds(rawSkipped);
    const postponed = normalizeRecommendPostponedList(rawPostponed);
    const now = Date.now();

    let maxMovedAt = 0;
    for (const item of postponed) {
      if (!item || item.bookmarkId == null || item.manuallyAdded) continue;
      if (Number(item.postponeUntil || 0) > now) continue;
      const movedAt = Number(item.dueQueueMovedAt || 0);
      if (Number.isFinite(movedAt) && movedAt > maxMovedAt) {
        maxMovedAt = movedAt;
      }
    }

    const target = postponed.find((item) => {
      if (!item || item.bookmarkId == null || item.manuallyAdded) return false;
      if (String(item.bookmarkId || '').trim() !== id) return false;
      return Number(item.postponeUntil || 0) <= now;
    });

    if (target) {
      target.dueQueueMovedAt = Math.max(now, maxMovedAt + 1);
      target.updatedAt = now;

      const nextSkipped = skipped.filter(item => item !== id);
      await browserAPI.storage.local.set({
        [RECOMMEND_POSTPONED_STORAGE_KEY]: postponed,
        [RECOMMEND_SKIPPED_STORAGE_KEY]: normalizeRecommendSkippedIds(nextSkipped)
      });

      return {
        success: true,
        mode: 'due-tail',
        skippedIds: normalizeRecommendSkippedIds(nextSkipped),
        dueMoved: true
      };
    }

    const nextSkipped = skipped.filter(item => item !== id);
    nextSkipped.push(id);
    const normalized = normalizeRecommendSkippedIds(nextSkipped);

    await browserAPI.storage.local.set({
      [RECOMMEND_SKIPPED_STORAGE_KEY]: normalized
    });

    return {
      success: true,
      mode: 'skip',
      skippedIds: normalized,
      dueMoved: false
    };
  });
}

async function removeRecommendSkippedState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, skippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const current = await getRecommendSkippedIds();
    const next = normalizeRecommendSkippedIds(current.filter(item => item !== id));
    await browserAPI.storage.local.set({ [RECOMMEND_SKIPPED_STORAGE_KEY]: next });
    return { success: true, skippedIds: next };
  });
}

function normalizeRefreshOpenSource(source) {
  return source === 'sidepanel' ? 'sidepanel' : 'page';
}

function getRefreshOpenCountField(source) {
  return normalizeRefreshOpenSource(source) === 'sidepanel'
    ? 'sidePanelOpenCountSinceRefresh'
    : 'openCountSinceRefresh';
}

function getRefreshOpenCount(settings, source) {
  const field = getRefreshOpenCountField(source);
  const raw = Number(settings && settings[field]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function setRefreshOpenCount(settings, source, count) {
  const field = getRefreshOpenCountField(source);
  const safeCount = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : 0;
  settings[field] = safeCount;
}

async function getRecommendRefreshSettings() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY]);
    return {
      ...DEFAULT_REFRESH_SETTINGS,
      ...(result?.[RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY] || {})
    };
  } catch (_) {
    return { ...DEFAULT_REFRESH_SETTINGS };
  }
}

async function saveRecommendRefreshSettings(settings) {
  await browserAPI.storage.local.set({ [RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY]: settings });
}

async function recordRecommendViewOpenState(source) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safeSource = normalizeRefreshOpenSource(source);
    const settings = await getRecommendRefreshSettings();
    const now = Date.now();

    const nextCount = getRefreshOpenCount(settings, safeSource) + 1;
    setRefreshOpenCount(settings, safeSource, nextCount);

    let shouldRefresh = false;
    if (settings.refreshEveryNOpens > 0 && nextCount >= settings.refreshEveryNOpens) {
      shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterHours > 0 && settings.lastRefreshTime > 0) {
      const hoursSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60);
      if (hoursSinceRefresh >= settings.refreshAfterHours) {
        shouldRefresh = true;
      }
    }

    if (!shouldRefresh && settings.refreshAfterDays > 0 && settings.lastRefreshTime > 0) {
      const daysSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60 * 24);
      if (daysSinceRefresh >= settings.refreshAfterDays) {
        shouldRefresh = true;
      }
    }

    const shouldPreloadCandidates = !shouldRefresh
      && settings.refreshEveryNOpens > 1
      && nextCount === settings.refreshEveryNOpens - 1;

    await saveRecommendRefreshSettings(settings);

    return {
      success: true,
      source: safeSource,
      openCount: nextCount,
      shouldRefresh,
      shouldPreloadCandidates,
      settings
    };
  });
}

async function markRecommendRefreshExecutedState() {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const settings = await getRecommendRefreshSettings();
    settings.lastRefreshTime = Date.now();
    settings.openCountSinceRefresh = 0;
    settings.sidePanelOpenCountSinceRefresh = 0;
    await saveRecommendRefreshSettings(settings);
    return { success: true, settings };
  });
}

function getRecommendBackgroundRefreshThresholdMs(settings = null) {
  const source = settings && typeof settings === 'object' ? settings : DEFAULT_REFRESH_SETTINGS;
  const refreshAfterHours = Number(source.refreshAfterHours || 0);
  const refreshAfterDays = Number(source.refreshAfterDays || 0);

  let thresholdMs = RECOMMEND_BACKGROUND_REFRESH_DEFAULT_MAX_STALE_MS;
  if (Number.isFinite(refreshAfterHours) && refreshAfterHours > 0) {
    thresholdMs = refreshAfterHours * 60 * 60 * 1000;
  } else if (Number.isFinite(refreshAfterDays) && refreshAfterDays > 0) {
    thresholdMs = refreshAfterDays * 24 * 60 * 60 * 1000;
  }

  return Math.max(
    RECOMMEND_BACKGROUND_REFRESH_MIN_STALE_MS,
    Math.min(thresholdMs, RECOMMEND_BACKGROUND_REFRESH_MAX_STALE_MS)
  );
}

async function maybeRunRecommendBackgroundRefresh(options = {}) {
  const reason = String(options?.reason || 'auto');
  const force = options?.force === true;
  const requireIdle = options?.requireIdle === true;

  if (recommendBackgroundRefreshInProgress) {
    return { success: false, refreshed: false, skipped: 'in-progress', reason };
  }

  const now = Date.now();
  if (!force && recommendBackgroundRefreshLastAttemptAt > 0) {
    const sinceLastAttempt = now - recommendBackgroundRefreshLastAttemptAt;
    if (sinceLastAttempt < RECOMMEND_BACKGROUND_REFRESH_MIN_ATTEMPT_GAP_MS) {
      return { success: false, refreshed: false, skipped: 'rate-limited', reason };
    }
  }
  recommendBackgroundRefreshLastAttemptAt = now;

  if (!force && (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores || templateRefineRunning)) {
    return { success: false, refreshed: false, skipped: 'busy', reason };
  }

  if (!force && requireIdle) {
    const idleState = await queryIdleStateForBookmarkMutationFlush();
    if (idleState === 'active') {
      return { success: false, refreshed: false, skipped: 'active', reason };
    }
  }

  const [settings, scoreMeta] = await Promise.all([
    getRecommendRefreshSettings(),
    browserAPI.storage.local.get(['recommend_scores_time'])
  ]);
  const recommendScoresTime = Number(scoreMeta?.recommend_scores_time || 0);
  const lastRefreshTime = Number(settings?.lastRefreshTime || 0);
  const freshnessTime = Math.max(recommendScoresTime, lastRefreshTime);
  const maxStaleMs = getRecommendBackgroundRefreshThresholdMs(settings);

  if (!force && freshnessTime > 0 && (now - freshnessTime) < maxStaleMs) {
    return { success: true, refreshed: false, skipped: 'fresh', reason };
  }

  recommendBackgroundRefreshInProgress = true;
  try {
    const ready = await ensureRecommendScoresReady({ reason: `background-refresh:${reason}` });
    if (ready?.success === false || ready?.ready === false) {
      return { success: false, refreshed: false, skipped: 'not-ready', reason, ready };
    }

    const ok = await computeAllBookmarkScores({ forceFull: false });
    if (!ok) {
      return { success: false, refreshed: false, skipped: 'compute-failed', reason };
    }
    await markRecommendRefreshExecutedState();

    return { success: true, refreshed: true, reason };
  } catch (error) {
    console.warn('[S-score] background refresh failed:', error);
    return { success: false, refreshed: false, skipped: 'error', reason, error: error?.message || String(error) };
  } finally {
    recommendBackgroundRefreshInProgress = false;
  }
}

function triggerRecommendBackgroundRefresh(reason = 'auto', options = {}) {
  Promise.resolve()
    .then(() => maybeRunRecommendBackgroundRefresh({ reason, ...(options || {}) }))
    .catch(() => {});
}

async function ensureRecommendBackgroundRefreshAlarm(options = {}) {
  if (!browserAPI?.alarms?.create || !browserAPI?.alarms?.get) {
    return { success: false, skipped: 'alarms-api-unavailable' };
  }

  const force = options?.force === true;
  const now = Date.now();

  if (ensureRecommendBackgroundRefreshAlarmPromise) {
    return ensureRecommendBackgroundRefreshAlarmPromise;
  }

  if (!force && (now - ensureRecommendBackgroundRefreshAlarmLastCheckAt) < RECOMMEND_BACKGROUND_REFRESH_ALARM_CHECK_MIN_GAP_MS) {
    return { success: true, skipped: 'throttled' };
  }

  ensureRecommendBackgroundRefreshAlarmPromise = (async () => {
    try {
      const existingAlarm = await new Promise((resolve, reject) => {
        try {
          browserAPI.alarms.get(RECOMMEND_BACKGROUND_REFRESH_ALARM, (alarm) => {
            const err = browserAPI?.runtime?.lastError;
            if (err) {
              reject(new Error(err.message || 'alarms_get_failed'));
              return;
            }
            resolve(alarm || null);
          });
        } catch (error) {
          reject(error);
        }
      });

      if (existingAlarm) {
        return { success: true, created: false };
      }

      browserAPI.alarms.create(RECOMMEND_BACKGROUND_REFRESH_ALARM, {
        delayInMinutes: 1,
        periodInMinutes: RECOMMEND_BACKGROUND_REFRESH_CHECK_PERIOD_MINUTES
      });
      return { success: true, created: true };
    } catch (error) {
      console.warn('[S-score] ensure background refresh alarm failed:', error);
      return { success: false, error: error?.message || String(error) };
    } finally {
      ensureRecommendBackgroundRefreshAlarmLastCheckAt = Date.now();
      ensureRecommendBackgroundRefreshAlarmPromise = null;
    }
  })();

  return ensureRecommendBackgroundRefreshAlarmPromise;
}

async function appendRecommendFlippedBookmarkState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, flippedIds: [] };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]);
    const current = Array.isArray(result?.[FLIPPED_BOOKMARKS_STORAGE_KEY])
      ? result[FLIPPED_BOOKMARKS_STORAGE_KEY]
      : [];
    const normalized = normalizeBookmarkIdList(current);
    if (!normalized.includes(id)) {
      normalized.push(id);
      await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: normalized });
    }
    return { success: true, flippedIds: normalized };
  });
}

async function markHistoryCurrentCardFlippedState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, allFlipped: false, historyCurrentCards: null };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]);
    const current = result?.[HISTORY_CURRENT_CARDS_STORAGE_KEY];
    if (!current || typeof current !== 'object') {
      return { success: true, allFlipped: false, historyCurrentCards: null };
    }

    const cardIds = normalizeBookmarkIdList(Array.isArray(current.cardIds) ? current.cardIds : []);
    if (cardIds.length === 0 || !cardIds.includes(id)) {
      return {
        success: true,
        allFlipped: false,
        historyCurrentCards: {
          ...current,
          cardIds,
          flippedIds: normalizeBookmarkIdList(Array.isArray(current.flippedIds) ? current.flippedIds : [])
        }
      };
    }

    const flippedIds = normalizeBookmarkIdList(Array.isArray(current.flippedIds) ? current.flippedIds : []);
    if (!flippedIds.includes(id)) {
      flippedIds.push(id);
    }

    const now = Date.now();
    const next = {
      ...current,
      cardIds,
      flippedIds,
      timestamp: now,
      lastUpdated: now
    };
    await browserAPI.storage.local.set({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: next });

    const allFlipped = cardIds.length > 0 && cardIds.every(cardId => flippedIds.includes(cardId));
    return { success: true, allFlipped, historyCurrentCards: next };
  });
}

function normalizeRecommendPoolLength(poolLength) {
  const value = Number(poolLength);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeRecommendPoolCursorValue(cursor, poolLength = 0) {
  const raw = Number(cursor);
  const safeRaw = Number.isFinite(raw) ? Math.floor(raw) : 0;
  const safePoolLength = normalizeRecommendPoolLength(poolLength);

  if (safePoolLength <= 0) {
    return Math.max(0, safeRaw);
  }

  return ((safeRaw % safePoolLength) + safePoolLength) % safePoolLength;
}

async function consumeRecommendPoolCursorState(poolLength, consumeCount = 0) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safePoolLength = normalizeRecommendPoolLength(poolLength);
    const safeConsumeCount = Math.max(0, Math.floor(Number(consumeCount) || 0));

    if (safePoolLength <= 0) {
      await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: 0 });
      return {
        success: true,
        poolLength: 0,
        consumeCount: safeConsumeCount,
        cursorBefore: 0,
        cursorAfter: 0
      };
    }

    const result = await browserAPI.storage.local.get([RECOMMEND_POOL_CURSOR_STORAGE_KEY]);
    const currentCursor = normalizeRecommendPoolCursorValue(result?.[RECOMMEND_POOL_CURSOR_STORAGE_KEY], safePoolLength);
    const nextCursor = (currentCursor + safeConsumeCount) % safePoolLength;

    await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: nextCursor });

    return {
      success: true,
      poolLength: safePoolLength,
      consumeCount: safeConsumeCount,
      cursorBefore: currentCursor,
      cursorAfter: nextCursor
    };
  });
}

async function setRecommendPoolCursorState(poolLength, cursor = 0) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const safePoolLength = normalizeRecommendPoolLength(poolLength);
    const normalizedCursor = normalizeRecommendPoolCursorValue(cursor, safePoolLength);

    await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: normalizedCursor });

    return {
      success: true,
      poolLength: safePoolLength,
      cursor: normalizedCursor
    };
  });
}

function getLocalDateKey(date) {
  const value = date instanceof Date ? date : new Date(date);
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeHeatmapBookmarkCounts(counts = {}) {
  const source = counts && typeof counts === 'object' ? counts : {};
  const normalized = {};

  Object.entries(source).forEach(([bookmarkId, count]) => {
    const id = String(bookmarkId || '').trim();
    const value = Number(count);
    if (!id || !Number.isFinite(value) || value <= 0) return;
    normalized[id] = Math.max(1, Math.floor(value));
  });

  return normalized;
}

function normalizeHeatmapDayRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      const timestamp = Number(item?.timestamp || 0);
      if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
      }
      return { bookmarkId, timestamp };
    })
    .filter(Boolean)
    .slice(-FLIP_HISTORY_DAY_RECORDS_MAX);
}

function normalizeHeatmapDayEntry(entry) {
  const source = entry && typeof entry === 'object' ? entry : {};
  const records = normalizeHeatmapDayRecords(source.records || []);
  const byBookmark = normalizeHeatmapBookmarkCounts(source.byBookmark || {});

  if (Object.keys(byBookmark).length === 0 && records.length > 0) {
    records.forEach((record) => {
      byBookmark[record.bookmarkId] = (byBookmark[record.bookmarkId] || 0) + 1;
    });
  }

  const rawCount = Number(source.count);
  const count = Number.isFinite(rawCount) && rawCount >= records.length
    ? Math.floor(rawCount)
    : records.length;

  return {
    count: Math.max(0, count),
    byBookmark,
    records
  };
}

function normalizeHeatmapDailyIndex(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const sourceDays = source.days && typeof source.days === 'object' ? source.days : {};
  const days = {};

  Object.entries(sourceDays).forEach(([dateKey, value]) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    days[dateKey] = normalizeHeatmapDayEntry(value);
  });

  return {
    version: 1,
    updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : 0,
    days
  };
}

function pruneHeatmapDailyIndex(index) {
  if (!index || typeof index !== 'object' || !index.days || typeof index.days !== 'object') return index;

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - FLIP_HISTORY_RETENTION_DAYS);
  const cutoffKey = getLocalDateKey(cutoff);

  Object.keys(index.days).forEach((dateKey) => {
    if (dateKey < cutoffKey) {
      delete index.days[dateKey];
    }
  });

  return index;
}

function appendFlipEventToHeatmapIndex(index, event) {
  const normalized = normalizeHeatmapDailyIndex(index);
  const bookmarkId = String(event?.bookmarkId || '').trim();
  const timestamp = Number(event?.timestamp || 0);

  if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
    return normalized;
  }

  const dateKey = getLocalDateKey(new Date(timestamp));
  const day = normalizeHeatmapDayEntry(normalized.days[dateKey]);

  day.count += 1;
  day.byBookmark[bookmarkId] = (day.byBookmark[bookmarkId] || 0) + 1;

  day.records.push({ bookmarkId, timestamp });
  if (day.records.length > FLIP_HISTORY_DAY_RECORDS_MAX) {
    day.records = day.records.slice(day.records.length - FLIP_HISTORY_DAY_RECORDS_MAX);
  }

  normalized.days[dateKey] = day;
  normalized.updatedAt = Date.now();

  return pruneHeatmapDailyIndex(normalized);
}

function normalizeFlipHistoryRecords(records = []) {
  return (Array.isArray(records) ? records : [])
    .map((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      const timestamp = Number(item?.timestamp || 0);
      if (!bookmarkId || !Number.isFinite(timestamp) || timestamp <= 0) {
        return null;
      }
      return { bookmarkId, timestamp: Math.floor(timestamp) };
    })
    .filter(Boolean)
    .slice(-FLIP_HISTORY_MAX_ITEMS);
}

async function appendRecommendFlipHistoryRecordState(bookmarkId, timestamp = Date.now()) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, count: -1 };
  }

  const safeTimestamp = Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
    ? Math.floor(Number(timestamp))
    : Date.now();

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const result = await browserAPI.storage.local.get([FLIP_HISTORY_STORAGE_KEY, HEATMAP_DAILY_INDEX_STORAGE_KEY]);
    const flipHistory = normalizeFlipHistoryRecords(result?.[FLIP_HISTORY_STORAGE_KEY]);

    flipHistory.push({
      bookmarkId: id,
      timestamp: safeTimestamp
    });

    const trimmed = flipHistory.length > FLIP_HISTORY_MAX_ITEMS
      ? flipHistory.slice(flipHistory.length - FLIP_HISTORY_MAX_ITEMS)
      : flipHistory;

    const nextIndex = appendFlipEventToHeatmapIndex(
      result?.[HEATMAP_DAILY_INDEX_STORAGE_KEY],
      { bookmarkId: id, timestamp: safeTimestamp }
    );

    await browserAPI.storage.local.set({
      [FLIP_HISTORY_STORAGE_KEY]: trimmed,
      [HEATMAP_DAILY_INDEX_STORAGE_KEY]: nextIndex
    });

    return {
      success: true,
      count: trimmed.length,
      indexUpdatedAt: Number(nextIndex?.updatedAt || 0)
    };
  });
}

function normalizeRecommendReviewState(reviews) {
  if (!reviews || typeof reviews !== 'object') return {};
  return { ...reviews };
}

async function recordRecommendReviewState(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, review: null, postponed: [], skippedIds: [] };
  }

  const state = await runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [reviewResult, rawPostponed, rawSkipped] = await Promise.all([
      browserAPI.storage.local.get(['recommend_reviews']),
      getRecommendPostponedList(),
      getRecommendSkippedIds()
    ]);

    const reviews = normalizeRecommendReviewState(reviewResult?.recommend_reviews);
    const postponed = normalizeRecommendPostponedList(rawPostponed);
    const skippedIds = normalizeRecommendSkippedIds(rawSkipped);
    const now = Date.now();

    const nextPostponed = postponed.filter((item) => String(item?.bookmarkId || '').trim() !== id);
    const nextSkippedIds = normalizeRecommendSkippedIds(skippedIds.filter((item) => item !== id));

    const existing = reviews[id] && typeof reviews[id] === 'object' ? reviews[id] : null;
    const existingInterval = Number(existing?.interval);
    const baseInterval = Number.isFinite(existingInterval) && existingInterval > 0
      ? Math.floor(existingInterval)
      : 1;
    const existingReviewCount = Number(existing?.reviewCount);
    const baseReviewCount = Number.isFinite(existingReviewCount) && existingReviewCount > 0
      ? Math.floor(existingReviewCount)
      : 0;

    const nextInterval = existing ? Math.min(baseInterval * 2, 30) : 1;
    const nextReview = {
      lastReview: now,
      interval: nextInterval,
      reviewCount: baseReviewCount + 1,
      nextReview: now + nextInterval * 24 * 60 * 60 * 1000
    };

    reviews[id] = nextReview;

    await browserAPI.storage.local.set({
      recommend_reviews: reviews,
      [RECOMMEND_POSTPONED_STORAGE_KEY]: nextPostponed,
      [RECOMMEND_SKIPPED_STORAGE_KEY]: nextSkippedIds
    });

    return {
      success: true,
      review: nextReview,
      postponed: nextPostponed,
      skippedIds: nextSkippedIds
    };
  });

  await updateSingleBookmarkScore(id);

  return state;
}

function collectRemovedNodeIds(node, bookmarkIdSet, folderIdSet) {
  if (!node || typeof node !== 'object') return;

  const nodeId = String(node.id || '').trim();
  if (node.url) {
    if (nodeId) bookmarkIdSet.add(nodeId);
  } else {
    if (nodeId) folderIdSet.add(nodeId);
    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        collectRemovedNodeIds(child, bookmarkIdSet, folderIdSet);
      }
    }
  }
}

function queueRemovedRecommendStatePrune({ bookmarkIds = [], folderIds = [] } = {}) {
  const normalizedBookmarks = normalizeBookmarkIdList(bookmarkIds);
  const normalizedFolders = normalizeBookmarkIdList(folderIds);

  normalizedBookmarks.forEach((id) => pendingRemovedBookmarkIds.add(id));
  normalizedFolders.forEach((id) => pendingRemovedFolderIds.add(id));

  if (pendingRemovedBookmarkIds.size === 0 && pendingRemovedFolderIds.size === 0) {
    return;
  }

  if (removedRecommendPruneTimer) {
    clearTimeout(removedRecommendPruneTimer);
  }

  removedRecommendPruneTimer = setTimeout(() => {
    removedRecommendPruneTimer = null;
    runRemovedRecommendStatePrune().catch((e) => {
      console.warn('[Recommend] prune removed state failed:', e);
    });
  }, REMOVED_RECOMMEND_PRUNE_DEBOUNCE_MS);
}

async function runRemovedRecommendStatePrune() {
  const removedBookmarkIds = normalizeBookmarkIdList(Array.from(pendingRemovedBookmarkIds));
  const removedFolderIds = normalizeBookmarkIdList(Array.from(pendingRemovedFolderIds));
  pendingRemovedBookmarkIds.clear();
  pendingRemovedFolderIds.clear();

  if (removedBookmarkIds.length === 0 && removedFolderIds.length === 0) {
    return;
  }

  const removedBookmarkSet = new Set(removedBookmarkIds);
  const removedFolderSet = new Set(removedFolderIds);

  await runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const [rawSkipped, rawPostponed, rawBlocked, rawCache, historyCardsResult] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedList(),
      getRecommendBlockedState(),
      getScoresCache(),
      browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY])
    ]);

    const updates = {};

    const nextSkipped = normalizeRecommendSkippedIds(
      rawSkipped.filter(id => !removedBookmarkSet.has(String(id || '').trim()))
    );
    if (nextSkipped.length !== rawSkipped.length) {
      updates[RECOMMEND_SKIPPED_STORAGE_KEY] = nextSkipped;
    }

    const normalizedPostponed = normalizeRecommendPostponedList(rawPostponed || []);
    const nextPostponed = normalizedPostponed.filter((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      return bookmarkId && !removedBookmarkSet.has(bookmarkId);
    });
    if (nextPostponed.length !== normalizedPostponed.length) {
      updates[RECOMMEND_POSTPONED_STORAGE_KEY] = nextPostponed;
    }

    const blocked = normalizeRecommendBlockedState(rawBlocked);
    const nextBlocked = {
      bookmarks: blocked.bookmarks.filter(id => !removedBookmarkSet.has(String(id || '').trim())),
      folders: blocked.folders.filter(id => !removedFolderSet.has(String(id || '').trim())),
      domains: blocked.domains.slice()
    };

    if (
      nextBlocked.bookmarks.length !== blocked.bookmarks.length
      || nextBlocked.folders.length !== blocked.folders.length
    ) {
      updates[RECOMMEND_BLOCKED_STORAGE_KEY] = nextBlocked;
    }

    const cache = rawCache && typeof rawCache === 'object' ? { ...rawCache } : {};
    let cacheChanged = false;
    for (const bookmarkId of removedBookmarkSet) {
      if (Object.prototype.hasOwnProperty.call(cache, bookmarkId)) {
        delete cache[bookmarkId];
        cacheChanged = true;
      }
    }
    if (cacheChanged) {
      updates.recommend_scores_cache = cache;
      updates.recommend_scores_time = Date.now();
    }

    const historyCurrentCards = historyCardsResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY];
    if (historyCurrentCards && typeof historyCurrentCards === 'object') {
      const cardIds = Array.isArray(historyCurrentCards.cardIds)
        ? historyCurrentCards.cardIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      const flippedIds = Array.isArray(historyCurrentCards.flippedIds)
        ? historyCurrentCards.flippedIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      const cardData = Array.isArray(historyCurrentCards.cardData)
        ? historyCurrentCards.cardData.filter(item => !removedBookmarkSet.has(String(item?.id || '').trim()))
        : undefined;

      const nextCardIds = cardIds.filter(id => !removedBookmarkSet.has(id));
      const nextFlippedIds = flippedIds.filter(id => !removedBookmarkSet.has(id));

      if (
        nextCardIds.length !== cardIds.length
        || nextFlippedIds.length !== flippedIds.length
        || (Array.isArray(cardData) && cardData.length !== (Array.isArray(historyCurrentCards.cardData) ? historyCurrentCards.cardData.length : 0))
      ) {
        const now = Date.now();
        updates[HISTORY_CURRENT_CARDS_STORAGE_KEY] = {
          ...historyCurrentCards,
          cardIds: nextCardIds,
          flippedIds: nextFlippedIds,
          ...(Array.isArray(cardData) ? { cardData } : {}),
          timestamp: now,
          lastUpdated: now
        };
      }
    }

    if (Object.keys(updates).length > 0) {
      await browserAPI.storage.local.set(updates);
    }
  });
}

async function scheduleBulkTemplateRecovery(reason = '') {
  if (bulkTemplateRecoveryTimer) {
    clearTimeout(bulkTemplateRecoveryTimer);
  }

  bulkTemplateRecoveryTimer = setTimeout(async () => {
    bulkTemplateRecoveryTimer = null;

    if (isBookmarkImporting || isBookmarkBulkChanging) {
      scheduleBulkTemplateRecovery(reason);
      return;
    }

    if (isComputingScores) {
      scheduleBulkTemplateRecovery(reason);
      return;
    }

    try {
      const ids = await getAllBookmarkUrlIdsForScore();
      if (!Array.isArray(ids) || ids.length === 0) {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: { staleAt: 0, reason: `bulk-template:${reason || 'none'}:empty` }
        });
        return;
      }

      if (ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
        await applyTemplateScoresByIds(ids);
        queueTemplateScoreRefine(ids);
      } else {
        await updateBookmarkScoresByIds(ids);
      }

      await browserAPI.storage.local.set({
        recommendScoresStaleMeta: { staleAt: 0, reason: `bulk-template:${reason || 'none'}` }
      });
    } catch (e) {
      console.warn('[S-score] bulk template recovery failed:', e);
    }
  }, BULK_TEMPLATE_RECOVERY_DEBOUNCE_MS);
}

async function ensureRecommendScoresReady(options = {}) {
  if (recommendScoresReadyPromise) {
    return recommendScoresReadyPromise;
  }

  const reason = String(options?.reason || 'unknown');

  recommendScoresReadyPromise = (async () => {
    try {
      const existingCache = await getScoresCache();
      const existingCount = Object.keys(existingCache || {}).length;
      if (existingCount > 0) {
        return {
          success: true,
          ready: true,
          mode: 'existing',
          cacheCount: existingCount
        };
      }

      if (isBookmarkImporting || isBookmarkBulkChanging) {
        return {
          success: true,
          ready: false,
          mode: 'bulk-pending',
          cacheCount: existingCount
        };
      }

      if (isComputingScores || templateRefineRunning) {
        return {
          success: true,
          ready: false,
          mode: 'computing',
          cacheCount: existingCount
        };
      }

      const ids = await getAllBookmarkUrlIdsForScore();
      if (!Array.isArray(ids) || ids.length === 0) {
        return {
          success: true,
          ready: true,
          mode: 'empty-tree',
          cacheCount: 0,
          bookmarkCount: 0
        };
      }

      if (ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
        await applyTemplateScoresByIds(ids);
        queueTemplateScoreRefine(ids);
      } else {
        await updateBookmarkScoresByIds(ids);
      }

      const nextCache = await getScoresCache();
      const nextCount = Object.keys(nextCache || {}).length;

      try {
        await browserAPI.storage.local.set({
          recommendScoresStaleMeta: {
            staleAt: 0,
            reason: `ensure-ready:${reason}`
          }
        });
      } catch (_) { }

      return {
        success: true,
        ready: nextCount > 0,
        mode: ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD ? 'template' : 'incremental',
        cacheCount: nextCount,
        bookmarkCount: ids.length
      };
    } catch (e) {
      console.warn('[S-score] ensure-ready failed:', e);
      return {
        success: false,
        ready: false,
        error: e?.message || String(e)
      };
    }
  })();

  recommendScoresReadyPromise.finally(() => {
    if (recommendScoresReadyPromise) {
      recommendScoresReadyPromise = null;
    }
  });

  return recommendScoresReadyPromise;
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
  bookmarkBulkHasRemoval = reason === 'removed';
  clearQueuedBookmarkMutations();
  try {
    await browserAPI.storage.local.set({
      [BOOKMARK_BULK_CHANGE_FLAG_KEY]: true,
      [BOOKMARK_BULK_CHANGE_META_KEY]: {
        active: true,
        reason: lastBulkReason,
        updatedAt: Date.now()
      }
    });
  } catch (_) { }
  await invalidateRecommendCaches(`bulk:${reason || 'unknown'}`);
  clearBookmarkUrlIndex();
  scheduleBookmarkBulkExit();
}

async function exitBookmarkBulkChangeMode() {
  if (!isBookmarkBulkChanging) return;

  isBookmarkBulkChanging = false;
  bookmarkBulkWindowStart = 0;
  bookmarkBulkEventCount = 0;
  try {
    await browserAPI.storage.local.set({
      [BOOKMARK_BULK_CHANGE_FLAG_KEY]: false,
      [BOOKMARK_BULK_CHANGE_META_KEY]: {
        active: false,
        reason: lastBulkReason || 'unknown',
        updatedAt: Date.now()
      }
    });
  } catch (_) { }

  // 导入场景：不要自动全量重算，避免导入结束“立刻重算”再次拉跨浏览器；交给 UI 按需触发。
  const reason = String(lastBulkReason || '');
  if (!reason.startsWith('import')) {
    await scheduleBulkTemplateRecovery(`bulk-exit:${reason || 'unknown'}`);
  }
  bookmarkBulkHasRemoval = false;
}

function noteBookmarkEventForBulkGuard(eventType = '') {
  // 导入本身有独立 flag：不需要通过计数进入 bulk
  // 重要：导入期间事件极多，频繁 clearTimeout/setTimeout 也会带来额外卡顿
  if (isBookmarkImporting) {
    return;
  }

  if (eventType === 'removed') {
    bookmarkBulkHasRemoval = true;
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
    // 这里不清空当前轮次卡片，避免 UI 首屏出现“先显示一批，再被自动换批”。
    await invalidateRecommendCaches('init-default-formula', { keepCurrentCards: true });
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
        const keysToCheck = [FLIPPED_BOOKMARKS_STORAGE_KEY, 'thumbnailCache', RECOMMEND_POSTPONED_STORAGE_KEY];
        const data = await browserAPI.storage.local.get(keysToCheck);

        if (data[FLIPPED_BOOKMARKS_STORAGE_KEY]) {
          const raw = data[FLIPPED_BOOKMARKS_STORAGE_KEY];
          let normalized = [];

          if (Array.isArray(raw)) {
            normalized = raw
              .map(id => String(id || '').trim())
              .filter(Boolean);
          } else if (raw && typeof raw === 'object') {
            const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            normalized = Object.entries(raw)
              .filter(([, time]) => Number(time) > oneWeekAgo)
              .sort((a, b) => Number(a[1]) - Number(b[1]))
              .map(([id]) => String(id || '').trim())
              .filter(Boolean);
          }

          if (normalized.length > 1000) {
            normalized = normalized.slice(normalized.length - 1000);
          }

          await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: normalized });
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
        newCache[String(bookmark.id)] = buildScoreCacheEntry({
          mode: nextMode,
          scores,
          bookmark
        });
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
        newCache[String(bookmark.id)] = buildScoreCacheEntry({
          mode: nextMode,
          scores,
          bookmark
        });
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

async function getBookmarkNodeByIdForScore(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id || !browserAPI?.bookmarks?.get) return null;

  return await new Promise((resolve) => {
    try {
      browserAPI.bookmarks.get([id], (items) => {
        if (browserAPI.runtime?.lastError) {
          resolve(null);
          return;
        }
        resolve(Array.isArray(items) && items[0] ? items[0] : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

async function getAncestorFolderIdsByParentIdForScore(parentId) {
  const ancestors = [];
  let cursor = String(parentId || '').trim();
  if (!cursor) return ancestors;

  const visited = new Set();
  let depth = 0;

  while (cursor && !visited.has(cursor) && depth < 64) {
    visited.add(cursor);
    ancestors.unshift(cursor);
    const parentNode = await getBookmarkNodeByIdForScore(cursor);
    cursor = String(parentNode?.parentId || '').trim();
    depth += 1;
  }

  return ancestors;
}

async function getBookmarkAncestorMapForIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  const idSet = new Set(unique);
  const result = new Map();

  if (idSet.size === 0 || !browserAPI?.bookmarks?.getTree) {
    return result;
  }

  try {
    const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
    const traverse = (nodes, ancestors = []) => {
      if (!Array.isArray(nodes) || idSet.size === 0) return;
      for (const node of nodes) {
        if (!node) continue;
        const nodeId = String(node.id || '').trim();
        if (node.url && nodeId && idSet.has(nodeId)) {
          result.set(nodeId, normalizeScoreCacheAncestorFolderIds(ancestors));
          idSet.delete(nodeId);
          if (idSet.size === 0) return;
        }
        if (Array.isArray(node.children) && node.children.length > 0) {
          const nextAncestors = node.url
            ? ancestors
            : normalizeScoreCacheAncestorFolderIds([...ancestors, nodeId]);
          traverse(node.children, nextAncestors);
          if (idSet.size === 0) return;
        }
      }
    };

    traverse(tree, []);
  } catch (_) {}

  return result;
}

async function updateSingleBookmarkScore(bookmarkId) {
  try {
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    const id = String(bookmarkId || '').trim();
    if (!id) return;

    const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([id], resolve));
    if (!bookmarks || bookmarks.length === 0) return;

    const bookmark = bookmarks[0];
    if (!bookmark || !bookmark.url) return;
    const ancestorFolderIds = await getAncestorFolderIdsByParentIdForScore(bookmark.parentId);
    const bookmarkForScore = {
      ...bookmark,
      ancestorFolderIds
    };

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

    const scores = calculateBookmarkScore(bookmarkForScore, historyStats, trackingData, config, postponedList, reviewData);
    const mode = await getScoreCacheMode();
    const cache = await getScoresCache();
    cache[id] = buildScoreCacheEntry({
      mode,
      scores,
      existing: cache[id],
      bookmark: bookmarkForScore
    });
    await saveScoresCache(cache);
  } catch (e) {
    console.warn('[S-score] incremental update failed:', e);
  }
}

function collectBookmarkIdsUnderFolders(nodes, folderIdSet, inTarget, output) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    const isTargetBranch = inTarget || (node && folderIdSet.has(String(node.id)));
    if (node && node.url && isTargetBranch) {
      output.push(String(node.id));
    }
    if (node && node.children) {
      collectBookmarkIdsUnderFolders(node.children, folderIdSet, isTargetBranch, output);
    }
  }
}

function getBookmarkIdsByFolderIdsFromTree(folderIds, bookmarkTree) {
  const ids = [];
  const folderIdSet = new Set((folderIds || []).map(id => String(id)).filter(Boolean));
  if (folderIdSet.size === 0) return ids;
  collectBookmarkIdsUnderFolders(Array.isArray(bookmarkTree) ? bookmarkTree : [], folderIdSet, false, ids);
  return [...new Set(ids)];
}

async function getBookmarkIdsByFolderIds(folderIds) {
  const folderIdSet = new Set((folderIds || []).map(id => String(id)).filter(Boolean));
  if (folderIdSet.size === 0 || !browserAPI?.bookmarks?.getTree) return [];
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  return getBookmarkIdsByFolderIdsFromTree(Array.from(folderIdSet), tree);
}

function collectBookmarkIdsByDomains(nodes, domainSet, output) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node && node.url) {
      try {
        const host = normalizeBlockedDomain(new URL(node.url).hostname);
        if (host && domainSet.has(host)) {
          output.push(String(node.id));
        }
      } catch (_) { }
    }
    if (node && node.children) {
      collectBookmarkIdsByDomains(node.children, domainSet, output);
    }
  }
}

async function getBookmarkIdsByDomains(domains) {
  const ids = [];
  const domainSet = new Set((domains || [])
    .map(normalizeBlockedDomain)
    .filter(Boolean));
  if (domainSet.size === 0 || !browserAPI?.bookmarks?.getTree) return ids;
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  collectBookmarkIdsByDomains(tree, domainSet, ids);
  return [...new Set(ids)];
}

function normalizeBookmarkIdList(ids) {
  return Array.from(new Set(
    (Array.isArray(ids) ? ids : [])
      .map(id => String(id || '').trim())
      .filter(Boolean)
  ));
}

async function getBookmarksByIdsForScore(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0 || !browserAPI?.bookmarks?.get) return [];

  const result = [];
  const chunkSize = 300;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const chunkBookmarks = await new Promise((resolve) => {
      try {
        browserAPI.bookmarks.get(chunk, (items) => {
          if (browserAPI.runtime?.lastError) {
            resolve([]);
            return;
          }
          resolve(Array.isArray(items) ? items : []);
        });
      } catch (_) {
        resolve([]);
      }
    });

    for (const item of chunkBookmarks) {
      if (item && item.url) {
        result.push(item);
      }
    }

    if (i + chunkSize < unique.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  return result;
}

async function recomputeScoresForBookmarkIds(ids, options = {}) {
  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores) return 0;

  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  const bookmarks = await getBookmarksByIdsForScore(unique);
  if (bookmarks.length === 0) return 0;

  const [historyStats, config, trackingData, postponedList, reviewData, mode, cache] = await Promise.all([
    getBatchHistoryDataWithTitle(),
    getFormulaConfig(),
    getTrackingDataForScore(),
    getPostponedBookmarksForScore(),
    getReviewDataForScore(),
    getScoreCacheMode(),
    getScoresCache()
  ]);
  const ancestorLookupIds = [];
  for (const bookmark of bookmarks) {
    const bookmarkId = String(bookmark?.id || '').trim();
    if (!bookmarkId) continue;
    const existing = cache[bookmarkId];
    const existingParentId = String(existing?.parentId || '').trim();
    const bookmarkParentId = String(bookmark?.parentId || '').trim();
    const hasAncestors = normalizeScoreCacheAncestorFolderIds(existing?.ancestorFolderIds).length > 0;
    if (!existingParentId || existingParentId !== bookmarkParentId || !hasAncestors) {
      ancestorLookupIds.push(bookmarkId);
    }
  }
  const ancestorMap = ancestorLookupIds.length > 0
    ? await getBookmarkAncestorMapForIds(ancestorLookupIds)
    : new Map();

  const batchSize = Math.max(40, Number(options.batchSize) || SCORE_INCREMENTAL_BATCH_SIZE);
  const flushByBatch = options.flushByBatch === true;
  const flushEveryBatches = Math.max(1, Number(options.flushEveryBatches) || 2);
  let updated = 0;
  let processedBatches = 0;

  for (let i = 0; i < bookmarks.length; i += batchSize) {
    const batch = bookmarks.slice(i, i + batchSize);
    for (const bookmark of batch) {
      const bookmarkId = String(bookmark?.id || '').trim();
      if (!bookmarkId) continue;
      const existing = cache[bookmarkId];
      const existingParentId = String(existing?.parentId || '').trim();
      const bookmarkParentId = String(bookmark?.parentId || '').trim();
      const fallbackAncestors = existingParentId && existingParentId === bookmarkParentId
        ? normalizeScoreCacheAncestorFolderIds(existing?.ancestorFolderIds)
        : [];
      const bookmarkForScore = {
        ...bookmark,
        ancestorFolderIds: ancestorMap.get(bookmarkId) || fallbackAncestors
      };
      const scores = calculateBookmarkScore(bookmarkForScore, historyStats, trackingData, config, postponedList, reviewData);
      cache[bookmarkId] = buildScoreCacheEntry({
        mode,
        scores,
        existing,
        bookmark: bookmarkForScore
      });
      updated += 1;
    }

    processedBatches += 1;

    if (flushByBatch && (processedBatches % flushEveryBatches === 0 || i + batchSize >= bookmarks.length)) {
      await saveScoresCache(cache);
    }

    if (i + batchSize < bookmarks.length) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  if (!flushByBatch) {
    await saveScoresCache(cache);
  }

  return updated;
}

async function applyTemplateScoresByIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  const [mode, cache, bookmarks] = await Promise.all([
    getScoreCacheMode(),
    getScoresCache(),
    getBookmarksByIdsForScore(unique)
  ]);
  const bookmarkMap = new Map();
  for (const bookmark of bookmarks) {
    const id = String(bookmark?.id || '').trim();
    if (id) {
      bookmarkMap.set(id, bookmark);
    }
  }
  const ancestorMap = await getBookmarkAncestorMapForIds(unique);

  let updated = 0;
  for (const id of unique) {
    const existing = cache[id];
    const bookmark = bookmarkMap.get(id);
    const fallbackAncestors = normalizeScoreCacheAncestorFolderIds(existing?.ancestorFolderIds);
    const bookmarkForCache = bookmark
      ? {
        ...bookmark,
        ancestorFolderIds: ancestorMap.get(id) || fallbackAncestors
      }
      : existing;

    cache[id] = buildScoreCacheEntry({
      mode,
      scores: existing,
      existing,
      bookmark: bookmarkForCache,
      template: true
    });
    updated += 1;
  }

  await saveScoresCache(cache);
  return updated;
}

async function refreshScoreCacheMetadataForBookmarkIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  const [mode, cache, bookmarks] = await Promise.all([
    getScoreCacheMode(),
    getScoresCache(),
    getBookmarksByIdsForScore(unique)
  ]);

  if (bookmarks.length === 0) return 0;

  const bookmarkMap = new Map();
  for (const bookmark of bookmarks) {
    const id = String(bookmark?.id || '').trim();
    if (id) {
      bookmarkMap.set(id, bookmark);
    }
  }

  const ancestorMap = await getBookmarkAncestorMapForIds(unique);
  let updated = 0;

  for (const id of unique) {
    const existing = cache[id];
    if (!existing || typeof existing !== 'object') continue;
    const bookmark = bookmarkMap.get(id);
    if (!bookmark || !bookmark.url) continue;

    const bookmarkForCache = {
      ...bookmark,
      ancestorFolderIds: ancestorMap.get(id) || normalizeScoreCacheAncestorFolderIds(existing?.ancestorFolderIds)
    };

    cache[id] = buildScoreCacheEntry({
      mode,
      scores: existing,
      existing,
      bookmark: bookmarkForCache,
      template: existing?._template === true
    });
    updated += 1;
  }

  if (updated > 0) {
    await saveScoresCache(cache);
  }

  return updated;
}

function queueTemplateScoreRefine(ids) {
  const unique = normalizeBookmarkIdList(ids);
  unique.forEach(id => pendingTemplateRefineIds.add(id));

  if (pendingTemplateRefineIds.size === 0) {
    return;
  }

  if (templateRefineTimer) {
    clearTimeout(templateRefineTimer);
  }

  templateRefineTimer = setTimeout(() => {
    templateRefineTimer = null;
    runTemplateScoreRefine().catch((e) => {
      console.warn('[S-score] template refine failed:', e);
    });
  }, SCORE_TEMPLATE_REFINE_DEBOUNCE_MS);
}

async function runTemplateScoreRefine() {
  if (templateRefineRunning) {
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
    return;
  }

  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores) {
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
    return;
  }

  const ids = Array.from(pendingTemplateRefineIds);
  pendingTemplateRefineIds.clear();
  if (ids.length === 0) return;

  templateRefineRunning = true;
  try {
    await recomputeScoresForBookmarkIds(ids, {
      batchSize: SCORE_TEMPLATE_REFINE_BATCH_SIZE,
      flushByBatch: true,
      flushEveryBatches: 2
    });
  } finally {
    templateRefineRunning = false;
    if (pendingTemplateRefineIds.size > 0) {
      queueTemplateScoreRefine([]);
    }
  }
}

async function updateBookmarkScoresByIds(ids) {
  const unique = normalizeBookmarkIdList(ids);
  if (unique.length === 0) return 0;

  if (unique.length <= 3) {
    let updated = 0;
    for (const id of unique) {
      await updateSingleBookmarkScore(id);
      updated += 1;
    }
    return updated;
  }

  if (unique.length >= SCORE_TEMPLATE_BATCH_THRESHOLD) {
    const templated = await applyTemplateScoresByIds(unique);
    queueTemplateScoreRefine(unique);
    return templated;
  }

  return recomputeScoresForBookmarkIds(unique, {
    batchSize: SCORE_INCREMENTAL_BATCH_SIZE,
    flushByBatch: false
  });
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

async function resolveMovedBookmarkIdsForMetadataRefresh(movedIds) {
  const unique = normalizeBookmarkIdList(movedIds);
  if (unique.length === 0) return [];

  const directBookmarks = await getBookmarksByIdsForScore(unique);
  const bookmarkIdSet = new Set(
    directBookmarks
      .map(item => String(item?.id || '').trim())
      .filter(Boolean)
  );

  const folderIds = unique.filter(id => !bookmarkIdSet.has(id));
  if (folderIds.length > 0 && browserAPI?.bookmarks?.getTree) {
    try {
      const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
      const descendants = getBookmarkIdsByFolderIdsFromTree(folderIds, tree);
      for (const descendantId of descendants) {
        const normalized = String(descendantId || '').trim();
        if (normalized) bookmarkIdSet.add(normalized);
      }
    } catch (_) { }
  }

  return normalizeBookmarkIdList(Array.from(bookmarkIdSet));
}

async function runMovedScoreMetadataRefresh(movedIds) {
  const targetIds = await resolveMovedBookmarkIdsForMetadataRefresh(movedIds);
  if (targetIds.length === 0) return 0;
  return refreshScoreCacheMetadataForBookmarkIds(targetIds);
}

function clearQueuedBookmarkMutations() {
  pendingCreatedScoreBookmarkIds.clear();
  pendingChangedScoreBookmarkIds.clear();
  pendingMovedBookmarkIds.clear();
  pendingChangedBookmarkUrls.clear();
  bookmarkMutationInFlightState = null;
  bookmarkMutationFlushInProgress = false;
  if (bookmarkMutationFlushTimer) {
    clearTimeout(bookmarkMutationFlushTimer);
    bookmarkMutationFlushTimer = null;
  }
  if (bookmarkMutationQueuePersistTimer) {
    clearTimeout(bookmarkMutationQueuePersistTimer);
    bookmarkMutationQueuePersistTimer = null;
  }
  bookmarkMutationFlushQueuedAt = 0;
  persistPendingBookmarkMutationQueueNow('clear').catch(() => { });
}

function getPendingBookmarkMutationCount() {
  const inFlight = normalizeBookmarkMutationQueuePayload(bookmarkMutationInFlightState);
  const inFlightCount = inFlight.createdIds.length
    + inFlight.changedIds.length
    + inFlight.movedIds.length
    + inFlight.changedUrls.length;

  return pendingCreatedScoreBookmarkIds.size
    + pendingChangedScoreBookmarkIds.size
    + pendingMovedBookmarkIds.size
    + pendingChangedBookmarkUrls.size
    + inFlightCount;
}

function normalizeBookmarkMutationQueueUrlList(urls = []) {
  return Array.from(new Set(
    (Array.isArray(urls) ? urls : [])
      .map((url) => String(url || '').trim())
      .filter(Boolean)
  )).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS);
}

function normalizeBookmarkMutationQueuePayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    createdIds: normalizeBookmarkIdList(source.createdIds || []).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    changedIds: normalizeBookmarkIdList(source.changedIds || []).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    movedIds: normalizeBookmarkIdList(source.movedIds || []).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    changedUrls: normalizeBookmarkMutationQueueUrlList(source.changedUrls || []),
    queuedAt: Number.isFinite(Number(source.queuedAt)) && Number(source.queuedAt) > 0
      ? Number(source.queuedAt)
      : 0,
    updatedAt: Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
      ? Number(source.updatedAt)
      : 0
  };
}

function hasBookmarkMutationQueuePayload(payload) {
  return payload.createdIds.length > 0
    || payload.changedIds.length > 0
    || payload.movedIds.length > 0
    || payload.changedUrls.length > 0;
}

function mergeBookmarkMutationQueuePayloadIntoPending(payload) {
  const normalized = normalizeBookmarkMutationQueuePayload(payload);
  normalized.createdIds.forEach((id) => pendingCreatedScoreBookmarkIds.add(id));
  normalized.changedIds.forEach((id) => pendingChangedScoreBookmarkIds.add(id));
  normalized.movedIds.forEach((id) => pendingMovedBookmarkIds.add(id));
  normalized.changedUrls.forEach((url) => pendingChangedBookmarkUrls.add(url));

  if (normalized.queuedAt > 0) {
    if (!bookmarkMutationFlushQueuedAt) {
      bookmarkMutationFlushQueuedAt = normalized.queuedAt;
    } else {
      bookmarkMutationFlushQueuedAt = Math.min(bookmarkMutationFlushQueuedAt, normalized.queuedAt);
    }
  }
}

function buildBookmarkMutationQueueSnapshot() {
  const createdSet = new Set(pendingCreatedScoreBookmarkIds);
  const changedSet = new Set(pendingChangedScoreBookmarkIds);
  const movedSet = new Set(pendingMovedBookmarkIds);
  const changedUrlSet = new Set(pendingChangedBookmarkUrls);

  const inFlight = normalizeBookmarkMutationQueuePayload(bookmarkMutationInFlightState);
  inFlight.createdIds.forEach((id) => createdSet.add(id));
  inFlight.changedIds.forEach((id) => changedSet.add(id));
  inFlight.movedIds.forEach((id) => movedSet.add(id));
  inFlight.changedUrls.forEach((url) => changedUrlSet.add(url));

  const snapshot = {
    version: 1,
    createdIds: normalizeBookmarkIdList(Array.from(createdSet)).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    changedIds: normalizeBookmarkIdList(Array.from(changedSet)).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    movedIds: normalizeBookmarkIdList(Array.from(movedSet)).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS),
    changedUrls: normalizeBookmarkMutationQueueUrlList(Array.from(changedUrlSet)),
    queuedAt: bookmarkMutationFlushQueuedAt > 0 ? bookmarkMutationFlushQueuedAt : Date.now(),
    updatedAt: Date.now(),
    inFlight: bookmarkMutationFlushInProgress === true
  };

  return normalizeBookmarkMutationQueuePayload(snapshot);
}

async function persistPendingBookmarkMutationQueueNow(reason = '') {
  try {
    const snapshot = buildBookmarkMutationQueueSnapshot();
    if (!hasBookmarkMutationQueuePayload(snapshot)) {
      await browserAPI.storage.local.remove([BOOKMARK_MUTATION_QUEUE_STORAGE_KEY]);
      return { success: true, removed: true, reason };
    }
    await browserAPI.storage.local.set({
      [BOOKMARK_MUTATION_QUEUE_STORAGE_KEY]: {
        ...snapshot,
        reason: String(reason || '')
      }
    });
    return {
      success: true,
      removed: false,
      reason,
      count: snapshot.createdIds.length + snapshot.changedIds.length + snapshot.movedIds.length + snapshot.changedUrls.length
    };
  } catch (error) {
    console.warn('[S-score] persist bookmark mutation queue failed:', error);
    return { success: false, reason, error: error?.message || String(error) };
  }
}

function schedulePersistPendingBookmarkMutationQueue(reason = '') {
  if (bookmarkMutationQueuePersistTimer) {
    clearTimeout(bookmarkMutationQueuePersistTimer);
  }
  bookmarkMutationQueuePersistTimer = setTimeout(() => {
    bookmarkMutationQueuePersistTimer = null;
    persistPendingBookmarkMutationQueueNow(reason).catch(() => { });
  }, BOOKMARK_MUTATION_QUEUE_SAVE_DEBOUNCE_MS);
}

function restoreBookmarkMutationQueueState(reason = 'startup') {
  if (restoreBookmarkMutationQueuePromise) {
    return restoreBookmarkMutationQueuePromise;
  }

  restoreBookmarkMutationQueuePromise = (async () => {
    try {
      const result = await browserAPI.storage.local.get([BOOKMARK_MUTATION_QUEUE_STORAGE_KEY]);
      const payload = normalizeBookmarkMutationQueuePayload(result?.[BOOKMARK_MUTATION_QUEUE_STORAGE_KEY]);
      if (!hasBookmarkMutationQueuePayload(payload)) {
        await browserAPI.storage.local.remove([BOOKMARK_MUTATION_QUEUE_STORAGE_KEY]);
        return { success: true, restoredCount: 0, reason };
      }

      mergeBookmarkMutationQueuePayloadIntoPending(payload);
      bookmarkMutationInFlightState = null;
      schedulePersistPendingBookmarkMutationQueue('restore-normalize');
      queueBookmarkMutationFlush();

      const restoredCount = payload.createdIds.length + payload.changedIds.length + payload.movedIds.length + payload.changedUrls.length;
      console.warn(`[S-score] restored mutation queue (${restoredCount}) from ${reason}`);
      return { success: true, restoredCount, reason };
    } catch (error) {
      console.warn('[S-score] restore bookmark mutation queue failed:', error);
      return { success: false, restoredCount: 0, reason, error: error?.message || String(error) };
    } finally {
      restoreBookmarkMutationQueuePromise = null;
    }
  })();

  return restoreBookmarkMutationQueuePromise;
}

async function queryIdleStateForBookmarkMutationFlush() {
  if (!browserAPI?.idle?.queryState) return 'unknown';
  return await new Promise((resolve) => {
    try {
      browserAPI.idle.queryState(60, (state) => {
        if (browserAPI.runtime?.lastError) {
          resolve('unknown');
          return;
        }
        resolve(String(state || 'unknown'));
      });
    } catch (_) {
      resolve('unknown');
    }
  });
}

function queueBookmarkMutationFlush() {
  if (!bookmarkMutationFlushQueuedAt) {
    bookmarkMutationFlushQueuedAt = Date.now();
  }
  schedulePersistPendingBookmarkMutationQueue('queue');

  if (bookmarkMutationFlushTimer) {
    clearTimeout(bookmarkMutationFlushTimer);
  }

  bookmarkMutationFlushTimer = setTimeout(() => {
    bookmarkMutationFlushTimer = null;
    flushQueuedBookmarkMutations().catch((e) => {
      console.warn('[S-score] bookmark mutation flush failed:', e);
      if (getPendingBookmarkMutationCount() > 0) {
        queueBookmarkMutationFlush();
      }
    });
  }, BOOKMARK_MUTATION_FLUSH_DEBOUNCE_MS);
}

function queueBookmarkScoreMutation(bookmarkId, type = 'changed') {
  const normalized = String(bookmarkId || '').trim();
  if (!normalized) return;

  if (type === 'created') {
    pendingCreatedScoreBookmarkIds.add(normalized);
  } else {
    pendingChangedScoreBookmarkIds.add(normalized);
  }

  queueBookmarkMutationFlush();
}

function queueBookmarkChangedUrlForFavicon(url) {
  const normalized = String(url || '').trim();
  if (!normalized) return;
  pendingChangedBookmarkUrls.add(normalized);
  queueBookmarkMutationFlush();
}

function queueMovedScoreMetadataRefresh(id, moveInfo = null) {
  const normalized = String(id || '').trim();
  if (!normalized) return;

  const oldParentId = String(moveInfo?.oldParentId || '').trim();
  const newParentId = String(moveInfo?.parentId || '').trim();
  if (oldParentId && newParentId && oldParentId === newParentId) {
    return;
  }

  pendingMovedBookmarkIds.add(normalized);
  queueBookmarkMutationFlush();
}

async function flushQueuedBookmarkMutations() {
  if (bookmarkMutationFlushInProgress) {
    queueBookmarkMutationFlush();
    return;
  }

  if (bookmarkMutationInFlightState) {
    mergeBookmarkMutationQueuePayloadIntoPending(bookmarkMutationInFlightState);
    bookmarkMutationInFlightState = null;
  }

  const pendingCount = getPendingBookmarkMutationCount();
  if (pendingCount === 0) {
    bookmarkMutationFlushQueuedAt = 0;
    await persistPendingBookmarkMutationQueueNow('flush-empty');
    return;
  }

  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores || templateRefineRunning) {
    queueBookmarkMutationFlush();
    return;
  }

  const queuedForMs = bookmarkMutationFlushQueuedAt > 0 ? (Date.now() - bookmarkMutationFlushQueuedAt) : 0;
  if (pendingCount >= BOOKMARK_BULK_THRESHOLD && queuedForMs < BOOKMARK_MUTATION_FLUSH_MAX_WAIT_MS) {
    const idleState = await queryIdleStateForBookmarkMutationFlush();
    if (idleState === 'active') {
      queueBookmarkMutationFlush();
      return;
    }
  }

  const createdIds = normalizeBookmarkIdList(Array.from(pendingCreatedScoreBookmarkIds));
  const changedIds = normalizeBookmarkIdList(Array.from(pendingChangedScoreBookmarkIds));
  const movedIds = normalizeBookmarkIdList(Array.from(pendingMovedBookmarkIds));
  const changedUrls = Array.from(pendingChangedBookmarkUrls)
    .map(url => String(url || '').trim())
    .filter(Boolean);

  bookmarkMutationInFlightState = {
    createdIds,
    changedIds,
    movedIds,
    changedUrls,
    queuedAt: bookmarkMutationFlushQueuedAt || Date.now(),
    updatedAt: Date.now()
  };
  bookmarkMutationFlushInProgress = true;
  await persistPendingBookmarkMutationQueueNow('flush-inflight');

  pendingCreatedScoreBookmarkIds.clear();
  pendingChangedScoreBookmarkIds.clear();
  pendingMovedBookmarkIds.clear();
  pendingChangedBookmarkUrls.clear();

  try {
    const scoreIds = normalizeBookmarkIdList([...createdIds, ...changedIds]);
    for (let i = 0; i < scoreIds.length; i += BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE) {
      const chunk = scoreIds.slice(i, i + BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE);
      if (chunk.length === 0) continue;
      await updateBookmarkScoresByIds(chunk);
      if (i + BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE < scoreIds.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (movedIds.length > 0) {
      await runMovedScoreMetadataRefresh(movedIds);
    }

    if (changedUrls.length > 0) {
      for (const url of changedUrls) {
        try {
          browserAPI.runtime.sendMessage({
            action: 'clearFaviconCache',
            url
          }).catch(() => { });
        } catch (_) { }
      }
    }

    bookmarkMutationInFlightState = null;
    bookmarkMutationFlushInProgress = false;

    if (getPendingBookmarkMutationCount() > 0) {
      queueBookmarkMutationFlush();
      await persistPendingBookmarkMutationQueueNow('flush-requeue');
      return;
    }

    bookmarkMutationFlushQueuedAt = 0;
    await persistPendingBookmarkMutationQueueNow('flush-commit');
  } catch (error) {
    bookmarkMutationFlushInProgress = false;
    throw error;
  }
}

async function healStaleBookmarkBulkChangeState(reason = 'startup') {
  try {
    const result = await browserAPI.storage.local.get([BOOKMARK_BULK_CHANGE_FLAG_KEY, BOOKMARK_BULK_CHANGE_META_KEY]);
    const activeFlag = result?.[BOOKMARK_BULK_CHANGE_FLAG_KEY] === true;
    if (!activeFlag) {
      return { success: true, healed: false, reason };
    }

    const meta = result?.[BOOKMARK_BULK_CHANGE_META_KEY];
    const updatedAt = Number(meta?.updatedAt || 0);
    const ageMs = updatedAt > 0 ? (Date.now() - updatedAt) : Number.POSITIVE_INFINITY;
    if (ageMs <= BOOKMARK_BULK_CHANGE_STALE_MAX_MS) {
      return { success: true, healed: false, reason, ageMs };
    }

    await browserAPI.storage.local.set({
      [BOOKMARK_BULK_CHANGE_FLAG_KEY]: false,
      [BOOKMARK_BULK_CHANGE_META_KEY]: {
        active: false,
        reason: `${reason}:stale-heal`,
        updatedAt: Date.now()
      }
    });
    console.warn('[S-score] healed stale bookmarkBulkChangeFlag on startup');
    return { success: true, healed: true, reason, ageMs };
  } catch (error) {
    console.warn('[S-score] heal stale bulk flag failed:', error);
    return { success: false, healed: false, reason, error: error?.message || String(error) };
  }
}

function scheduleRecommendStartupSelfHeal(reason = 'startup') {
  if (startupRecommendSelfHealPromise) {
    return startupRecommendSelfHealPromise;
  }

  startupRecommendSelfHealPromise = (async () => {
    try {
      await ensureRecommendBackgroundRefreshAlarm({ force: true });
      const [restoreResult, healResult] = await Promise.all([
        restoreBookmarkMutationQueueState(reason),
        healStaleBookmarkBulkChangeState(reason)
      ]);

      return {
        success: true,
        reason,
        restoredCount: Number(restoreResult?.restoredCount || 0),
        healedBulkFlag: healResult?.healed === true
      };
    } catch (error) {
      console.warn('[S-score] startup self-heal failed:', error);
      return { success: false, reason, error: error?.message || String(error) };
    } finally {
      startupRecommendSelfHealPromise = null;
    }
  })();

  return startupRecommendSelfHealPromise;
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
    queueBookmarkScoreMutation(id, 'created');
  }
});

browserAPI.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
  noteBookmarkEventForBulkGuard('removed');

  const removedBookmarkSet = new Set();
  const removedFolderSet = new Set();

  if (removeInfo && removeInfo.node) {
    collectRemovedNodeIds(removeInfo.node, removedBookmarkSet, removedFolderSet);
  }

  const normalizedId = String(id || '').trim();
  if (normalizedId && removedBookmarkSet.size === 0 && removedFolderSet.size === 0) {
    removedBookmarkSet.add(normalizedId);
    removedFolderSet.add(normalizedId);
  }

  for (const bookmarkId of removedBookmarkSet) {
    removeBookmarkFromUrlIndex(bookmarkId);
  }

  queueRemovedRecommendStatePrune({
    bookmarkIds: Array.from(removedBookmarkSet),
    folderIds: Array.from(removedFolderSet)
  });

  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
});

browserAPI.bookmarks.onChanged.addListener((id, changeInfo) => {
  noteBookmarkEventForBulkGuard('changed');
  if (isBookmarkImporting || isBookmarkBulkChanging) {
    return;
  }
  if (changeInfo.url || changeInfo.title) {
    if (changeInfo.url) {
      updateBookmarkUrlIndex(id, changeInfo.url);
      queueBookmarkChangedUrlForFavicon(changeInfo.url);
    }
    queueBookmarkScoreMutation(id, 'changed');
  }
});

// 移动/重排不直接影响 S 值公式，但在大批量移动时会触发事件风暴：用 bulk guard 兜底降噪
if (browserAPI.bookmarks.onMoved) {
  browserAPI.bookmarks.onMoved.addListener((id, moveInfo) => {
    noteBookmarkEventForBulkGuard('moved');
    if (isBookmarkImporting || isBookmarkBulkChanging) return;
    queueMovedScoreMetadataRefresh(id, moveInfo || null);
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

const processedFaviconUpdates = new Map();
const FAVICON_UPDATE_COOLDOWN_MS = 5000;

async function blobToDataUrlBackground(blob) {
  if (!blob) return null;
  return await new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onloadend = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    } catch (_) {
      resolve(null);
    }
  });
}

async function readBlobDimensionsBackground(blob) {
  if (!blob) return null;
  try {
    if (typeof createImageBitmap !== 'function') {
      return null;
    }
    const bitmap = await createImageBitmap(blob);
    const width = Number(bitmap && bitmap.width) || 0;
    const height = Number(bitmap && bitmap.height) || 0;
    try {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    } catch (_) { }
    if (width > 0 && height > 0) {
      return { width, height };
    }
    return null;
  } catch (_) {
    return null;
  }
}

async function fetchImageAsDataUrlBackground(url, options = {}) {
  if (!url || typeof url !== 'string') {
    return options.includeMeta === true
      ? { dataUrl: '', meta: { attempted: false, hardFailure: false, errorCode: 'invalid_url' } }
      : null;
  }

  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 4000);
  const maxBytes = Math.max(1024, Number(options.maxBytes) || (512 * 1024));
  const minDimensionPx = Math.max(1, Number(options.minDimensionPx) || 1);
  const includeMeta = options.includeMeta === true;
  const wrap = (dataUrl, meta) => includeMeta ? { dataUrl, meta } : dataUrl;
  const isHardFailureStatus = (statusCode) => {
    const code = Number(statusCode);
    if (!Number.isFinite(code)) return false;
    if (code === 0 || code === 408) return true;
    return code >= 500 && code <= 599;
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try { controller.abort(); } catch (_) { }
  }, timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const statusCode = Number(res.status) || 0;
      return wrap('', {
        attempted: true,
        statusCode,
        hardFailure: isHardFailureStatus(statusCode),
        errorCode: `http_${statusCode || 0}`
      });
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'non_image_content'
      });
    }

    const declaredLength = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'payload_too_large'
      });
    }

    const blob = await res.blob();
    if (!blob || blob.size <= 0 || blob.size > maxBytes) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'invalid_blob'
      });
    }

    const dimensions = await readBlobDimensionsBackground(blob);
    if (!dimensions || dimensions.width < minDimensionPx || dimensions.height < minDimensionPx) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'dimension_too_small'
      });
    }

    const dataUrl = await blobToDataUrlBackground(blob);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'invalid_data_url'
      });
    }
    return wrap(dataUrl, {
      attempted: true,
      statusCode: Number(res.status) || 200,
      hardFailure: false,
      errorCode: ''
    });
  } catch (error) {
    const errorCode = error && error.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    return wrap('', {
      attempted: true,
      hardFailure: true,
      errorCode
    });
  } finally {
    clearTimeout(timeout);
  }
}

if (browserAPI.tabs && browserAPI.tabs.onUpdated) {
  browserAPI.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    (async () => {
      try {
        const pageUrl = String(tab?.url || '');
        if (!pageUrl || (!pageUrl.startsWith('http://') && !pageUrl.startsWith('https://'))) {
          return;
        }

        const sourceIconUrl = String(changeInfo?.favIconUrl || tab?.favIconUrl || '');
        if (!sourceIconUrl) {
          return;
        }

        const now = Date.now();
        const processKey = `${pageUrl}|${sourceIconUrl}`;
        const lastProcessed = Number(processedFaviconUpdates.get(processKey) || 0);
        if (lastProcessed > 0 && (now - lastProcessed) < FAVICON_UPDATE_COOLDOWN_MS) {
          return;
        }
        processedFaviconUpdates.set(processKey, now);

        if (processedFaviconUpdates.size > 400) {
          for (const [key, ts] of processedFaviconUpdates.entries()) {
            if ((now - Number(ts || 0)) > (FAVICON_UPDATE_COOLDOWN_MS * 3)) {
              processedFaviconUpdates.delete(key);
            }
          }
        }

        const dataUrl = await fetchImageAsDataUrlBackground(sourceIconUrl, {
          minDimensionPx: 16,
          maxBytes: 512 * 1024,
          timeoutMs: 4000
        });

        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
          try {
            browserAPI.runtime.sendMessage({
              action: 'updateFaviconFromTab',
              url: pageUrl,
              favIconUrl: dataUrl
            }).catch(() => { });
          } catch (_) { }
        }
      } catch (_) { }
    })();
  });
}

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !message.action) {
    sendResponse({ success: false, error: 'Invalid message' });
    return;
  }

  const action = message.action;

  if (action === 'canvasFetchFaviconDataUrl') {
    (async () => {
      try {
        const url = typeof message.url === 'string' ? message.url : '';
        const includeMeta = message.includeMeta === true;
        const dataResult = await fetchImageAsDataUrlBackground(url, {
          minDimensionPx: Number(message.minDimensionPx) || 1,
          maxBytes: Number(message.maxBytes) || (512 * 1024),
          timeoutMs: Number(message.timeoutMs) || 4000,
          includeMeta
        });
        const dataUrl = includeMeta
          ? (dataResult && typeof dataResult.dataUrl === 'string' ? dataResult.dataUrl : '')
          : (typeof dataResult === 'string' ? dataResult : '');
        sendResponse({
          success: true,
          dataUrl,
          meta: includeMeta && dataResult && typeof dataResult.meta === 'object' ? dataResult.meta : null
        });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
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

  if (action === 'quickReviewNext') {
    (async () => {
      try {
        triggerRecommendBackgroundRefresh('quick-review-message', { requireIdle: true });
        const result = await runQuickReviewNextState(message.source || 'ui');
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, handled: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'selectRecommendCardsRound') {
    (async () => {
      try {
        const result = await selectQuickReviewCardsRoundState({
          force: message.force === true
        });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'peekRecommendPreloadUrls') {
    (async () => {
      try {
        const result = await peekQuickReviewPreloadUrlsState({
          limit: Number(message.limit) || 12
        });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, urls: [], error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setQuickReviewOpenMode') {
    (async () => {
      try {
        const mode = await setQuickReviewOpenModeState(message.mode);
        sendResponse({ success: true, mode });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getQuickReviewOpenMode') {
    (async () => {
      try {
        const mode = await getQuickReviewOpenModeState();
        sendResponse({ success: true, mode });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordBrowsingDeletion') {
    (async () => {
      try {
        await recordDeletionForCalibration(message.payload || {});
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordBrowsingInteraction') {
    (async () => {
      try {
        await recordInteractionForCalibration(message.payload || {});
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'resetBrowsingCalibrationState') {
    (async () => {
      try {
        await resetBrowsingCalibrationState(message?.payload?.reason || 'manual');
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

  if (action === 'getTrackingRankingStatsByRange') {
    (async () => {
      try {
        const range = message.range || 'all';
        const startTime = Number(message.startTime || 0);
        const endTime = Number(message.endTime || Date.now());
        const result = await getTrackingRankingStatsByRange(range, startTime, endTime);
        sendResponse({
          success: true,
          stats: result?.stats || {},
          startedAt: Number(result?.startedAt || 0),
          source: result?.source || 'total'
        });
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

  if (action === 'recordRecommendViewOpen') {
    (async () => {
      try {
        const result = await recordRecommendViewOpenState(message.source);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markRecommendRefreshExecuted') {
    (async () => {
      try {
        const result = await markRecommendRefreshExecutedState();
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'appendRecommendFlippedBookmark') {
    (async () => {
      try {
        const result = await appendRecommendFlippedBookmarkState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markHistoryCurrentCardFlippedState') {
    (async () => {
      try {
        const result = await markHistoryCurrentCardFlippedState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'appendRecommendFlipHistoryRecord') {
    (async () => {
      try {
        const result = await appendRecommendFlipHistoryRecordState(message.bookmarkId, message.timestamp);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'recordRecommendReviewState') {
    (async () => {
      try {
        const result = await recordRecommendReviewState(message.bookmarkId);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
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

  if (action === 'updateBookmarkScoresByIds') {
    (async () => {
      try {
        const ids = Array.isArray(message.ids)
          ? message.ids
          : (message.bookmarkId ? [message.bookmarkId] : []);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoresByFolder') {
    (async () => {
      try {
        const folderIds = Array.isArray(message.folderIds) ? message.folderIds : [message.folderId];
        const ids = await getBookmarkIdsByFolderIds(folderIds);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateBookmarkScoresByDomain') {
    (async () => {
      try {
        const domains = Array.isArray(message.domains) ? message.domains : [message.domain];
        const ids = await getBookmarkIdsByDomains(domains);
        const updated = await updateBookmarkScoresByIds(ids);
        sendResponse({ success: true, updated, total: ids.length });
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

  if (action === 'setRecommendBlockedState') {
    (async () => {
      try {
        const result = await setRecommendBlockedState(message.blocked);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setRecommendPostponedState') {
    (async () => {
      try {
        const result = await setRecommendPostponedState(message.postponed);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'ensureRecommendScoresReady') {
    (async () => {
      try {
        const result = await ensureRecommendScoresReady({ reason: message.reason || '' });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, ready: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'handleRecommendSkipState') {
    (async () => {
      try {
        const result = await handleRecommendSkipState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'removeRecommendSkippedState') {
    (async () => {
      try {
        const result = await removeRecommendSkippedState(message.bookmarkId);
        sendResponse({ success: true, ...(result || {}) });
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
          browserAPI.storage.local.get([
            'recommendScoresStaleMeta',
            BOOKMARK_BULK_CHANGE_FLAG_KEY,
            BOOKMARK_BULK_CHANGE_META_KEY,
            'recommend_scores_time',
            SCORE_ALGO_VERSION_KEY
          ])
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
        if (meta?.[BOOKMARK_BULK_CHANGE_FLAG_KEY]) notes.push('bookmarkBulkChangeFlag=true');
        const bulkMetaUpdatedAt = Number(meta?.[BOOKMARK_BULK_CHANGE_META_KEY]?.updatedAt || 0);
        if (bulkMetaUpdatedAt > 0 && (Date.now() - bulkMetaUpdatedAt) > BOOKMARK_BULK_CHANGE_STALE_MAX_MS) {
          notes.push('bookmarkBulkChangeFlag may be stale (startup self-heal pending)');
        }
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
            const bookmarkForCache = {
              ...bookmark,
              ancestorFolderIds: normalizeScoreCacheAncestorFolderIds(cachedEntry?.ancestorFolderIds)
            };
            cache[bookmarkId] = buildScoreCacheEntry({
              mode,
              scores: debug.factors,
              existing: cachedEntry,
              bookmark: bookmarkForCache
            });
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

  if (action === 'trackingDataUpdated') {
    if (message.url) {
      scheduleScoreUpdateByUrl(message.url);
    }
    return false;
  }

  if (action === 'openSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        const view = typeof message.view === 'string'
          ? normalizeHistoryPanelView(message.view, '')
          : null;
        const result = await openSidePanelInWindow(windowId, view);
        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'open_failed' });
          return;
        }
        sendResponse({ success: true, isOpen: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getSidePanelStateFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        const isOpen = await getSidePanelOpenStateForWindow(windowId);
        sendResponse({ success: true, isOpen });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'closeSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        const result = await closeSidePanelInWindow(windowId);
        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'close_failed' });
          return;
        }
        sendResponse({ success: true, isOpen: false });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'toggleSidePanelFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        const view = typeof message.view === 'string'
          ? normalizeHistoryPanelView(message.view, '')
          : null;
        const isOpen = await getSidePanelOpenStateForWindow(windowId);
        const result = isOpen
          ? await closeSidePanelInWindow(windowId)
          : await openSidePanelInWindow(windowId, view);

        if (!result || result.success !== true) {
          sendResponse({ success: false, error: result?.error || 'toggle_failed' });
          return;
        }

        sendResponse({ success: true, isOpen: result.isOpen === true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markSidePanelOpenFromHistoryPage') {
    (async () => {
      try {
        const windowId = await resolveWindowIdForSidePanelAction(message, sender);
        if (windowId == null) {
          sendResponse({ success: false, error: 'window_unavailable' });
          return;
        }
        setSidePanelOpenWindowState(windowId, true);
        sendResponse({ success: true, isOpen: true, state: 'opened' });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  sendResponse({ success: false, error: 'Unsupported action' });
});
