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
  clearCurrentTrackingSessions,
  clearTrackingStatsByRange,
  restoreActiveSessionsFromStorage
} from './active_time_tracker/index.js';
const browserAPI = (function () {
  if (typeof chrome !== 'undefined') return chrome;
  if (typeof browser !== 'undefined') return browser;
  throw new Error('Unsupported browser');
})();

function normalizeHistoryPanelView(view) {
  if (view === 'widgets' || view === 'recommend' || view === 'additions' || view === 'sync') {
    return view;
  }
  return 'widgets';
}

function openView(view) {
  const safeView = normalizeHistoryPanelView(view);
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
  const favicon = String(entry?.favicon || entry?.faviconUrl || '').trim();

  return {
    id,
    title,
    name: title,
    url,
    favicon: favicon || null,
    faviconUrl: favicon || null,
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
  const version = Number(source.version || 0);

  return {
    cardIds,
    flippedIds,
    cardData,
    timestamp: Number.isFinite(timestamp) ? timestamp : 0,
    lastUpdated: Number.isFinite(lastUpdated) ? lastUpdated : 0,
    version: Number.isFinite(version) && version > 0 ? Math.floor(version) : 0
  };
}

function buildNextHistoryCurrentCardsVersion(previousState = null, now = Date.now()) {
  const currentVersion = Number(previousState?.version || 0);
  const safeCurrentVersion = Number.isFinite(currentVersion) && currentVersion > 0
    ? Math.floor(currentVersion)
    : 0;
  return Math.max(now, safeCurrentVersion + 1);
}

async function saveHistoryCurrentCardsState(cardIds = [], flippedIds = [], cardData = [], options = {}) {
  const now = Date.now();
  let previousState = options?.previousState || null;
  if (!previousState) {
    try {
      const result = await browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]);
      previousState = normalizeHistoryCurrentCardsState(result?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);
    } catch (_) {
      previousState = normalizeHistoryCurrentCardsState(null);
    }
  } else {
    previousState = normalizeHistoryCurrentCardsState(previousState);
  }

  const payload = {
    [HISTORY_CURRENT_CARDS_STORAGE_KEY]: {
      cardIds: normalizeBookmarkIdList(cardIds),
      flippedIds: normalizeBookmarkIdList(flippedIds),
      cardData: (Array.isArray(cardData) ? cardData : [])
        .map(normalizeRecommendCardDataEntry)
        .filter(Boolean),
      timestamp: now,
      lastUpdated: now,
      version: buildNextHistoryCurrentCardsVersion(previousState, now)
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

function buildRecommendSkippedOrderMap(skippedIds = []) {
  const normalized = normalizeRecommendSkippedIds(skippedIds || []);
  return new Map(normalized.map((id, index) => [id, index]));
}

function compareRecommendPriorityWithSkippedForQuickReview(a, b, options = {}) {
  const skippedSet = options?.skippedSet instanceof Set ? options.skippedSet : new Set();
  const skippedOrderMap = options?.skippedOrderMap instanceof Map ? options.skippedOrderMap : new Map();

  const aId = String(a?.id || '').trim();
  const bId = String(b?.id || '').trim();
  const aForceDue = a?.forceDue === true;
  const bForceDue = b?.forceDue === true;
  const aSkipped = skippedSet.has(aId);
  const bSkipped = skippedSet.has(bId);
  const aDeferred = aSkipped || (aForceDue && Number(a?.forceDueMovedAt || 0) > 0);
  const bDeferred = bSkipped || (bForceDue && Number(b?.forceDueMovedAt || 0) > 0);

  if (aDeferred !== bDeferred) {
    return aDeferred ? 1 : -1;
  }

  if (aForceDue !== bForceDue) {
    return aForceDue ? -1 : 1;
  }

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
}

function isRecommendQuickReviewItemSkipped(item, skippedSet) {
  const id = String(item?.id || '').trim();
  return Boolean(id && skippedSet instanceof Set && skippedSet.has(id));
}

function compareRecommendForceDueForQuickReview(a, b) {
  const aMovedAt = Number(a?.forceDueMovedAt || 0);
  const bMovedAt = Number(b?.forceDueMovedAt || 0);
  const aMoved = aMovedAt > 0;
  const bMoved = bMovedAt > 0;

  if (aMoved !== bMoved) {
    return aMoved ? 1 : -1;
  }
  if (aMoved && bMoved && aMovedAt !== bMovedAt) {
    return aMovedAt - bMovedAt;
  }

  const dueDiff = Number(a?.forceDueAt || 0) - Number(b?.forceDueAt || 0);
  if (dueDiff !== 0) return dueDiff;
  return compareRecommendPriorityForQuickReview(a, b);
}

function compareRecommendDeferredForQuickReview(a, b, options = {}) {
  const skippedSet = options?.skippedSet instanceof Set ? options.skippedSet : new Set();
  const skippedOrderMap = options?.skippedOrderMap instanceof Map ? options.skippedOrderMap : new Map();
  const aSkipped = isRecommendQuickReviewItemSkipped(a, skippedSet);
  const bSkipped = isRecommendQuickReviewItemSkipped(b, skippedSet);

  if (aSkipped && bSkipped) {
    const aId = String(a?.id || '').trim();
    const bId = String(b?.id || '').trim();
    const aOrder = skippedOrderMap.has(aId) ? skippedOrderMap.get(aId) : Number.MAX_SAFE_INTEGER;
    const bOrder = skippedOrderMap.has(bId) ? skippedOrderMap.get(bId) : Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
  }

  const aForceDue = a?.forceDue === true;
  const bForceDue = b?.forceDue === true;
  if (aForceDue !== bForceDue) {
    return aForceDue ? -1 : 1;
  }
  if (aForceDue && bForceDue) {
    return compareRecommendForceDueForQuickReview(a, b);
  }
  return compareRecommendPriorityForQuickReview(a, b);
}

function buildQuickReviewPriorityPools(sortedPool = [], options = {}) {
  const skippedSet = options?.skippedSet instanceof Set ? options.skippedSet : new Set();
  const skippedOrderMap = options?.skippedOrderMap instanceof Map ? options.skippedOrderMap : new Map();
  const activeForceDuePool = [];
  const normalPool = [];
  const deferredPool = [];

  for (const item of Array.isArray(sortedPool) ? sortedPool : []) {
    if (!item) continue;
    const skipped = isRecommendQuickReviewItemSkipped(item, skippedSet);
    const forceDue = item.forceDue === true;
    const movedToTail = forceDue && Number(item.forceDueMovedAt || 0) > 0;

    if (forceDue && !skipped && !movedToTail) {
      activeForceDuePool.push(item);
    } else if (!forceDue && !skipped) {
      normalPool.push(item);
    } else {
      deferredPool.push(item);
    }
  }

  return {
    activeForceDuePool: activeForceDuePool.sort(compareRecommendForceDueForQuickReview),
    normalPool: normalPool.sort(compareRecommendPriorityForQuickReview),
    deferredPool: deferredPool.sort((a, b) => compareRecommendDeferredForQuickReview(a, b, {
      skippedSet,
      skippedOrderMap
    }))
  };
}

function getQuickReviewDomainKey(bookmark) {
  if (!bookmark?.url) return '';
  try {
    return getRecommendBaseDomainFromHost(new URL(bookmark.url).hostname || '');
  } catch {
    return '';
  }
}

function buildQuickReviewDeterministicHash(input = '') {
  const text = String(input || '');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createQuickReviewDeterministicRandom(seedInput = '') {
  let state = buildQuickReviewDeterministicHash(seedInput);
  if (state === 0) {
    state = 1;
  }
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function buildQuickReviewSelectionSeed(pool = [], startIndex = 0, batchSize = QUICK_REVIEW_RECOMMEND_BATCH_SIZE) {
  if (!Array.isArray(pool) || pool.length === 0) {
    const safeStart = Math.max(0, Math.floor(Number(startIndex) || 0));
    const safeSize = Math.max(0, Math.floor(Number(batchSize) || 0));
    return `empty|start:${safeStart}|size:${safeSize}`;
  }

  const safeStart = ((Math.floor(Number(startIndex) || 0) % pool.length) + pool.length) % pool.length;
  const safeSize = Math.max(1, Math.floor(Number(batchSize) || 0));
  const inspectCount = Math.min(pool.length, 96);
  const ids = [];
  for (let i = 0; i < inspectCount; i += 1) {
    const idx = (safeStart + i) % pool.length;
    ids.push(String(pool[idx]?.id || ''));
  }
  return `len:${pool.length}|start:${safeStart}|size:${safeSize}|ids:${ids.join(',')}`;
}

function createQuickReviewSelectionRandom(pool = [], startIndex = 0, batchSize = QUICK_REVIEW_RECOMMEND_BATCH_SIZE) {
  return createQuickReviewDeterministicRandom(
    buildQuickReviewSelectionSeed(pool, startIndex, batchSize)
  );
}

function pickWeightedQuickReviewEntry(entries = [], randomFn = Math.random) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const random = typeof randomFn === 'function' ? randomFn : Math.random;
  let totalWeight = 0;
  for (const entry of entries) {
    const weight = Number(entry?.weight || 0);
    if (Number.isFinite(weight) && weight > 0) {
      totalWeight += weight;
    }
  }

  if (!(totalWeight > 0)) {
    return entries[Math.floor(random() * entries.length)] || null;
  }

  let roll = random() * totalWeight;
  for (const entry of entries) {
    const weight = Number(entry?.weight || 0);
    if (!(Number.isFinite(weight) && weight > 0)) continue;
    roll -= weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1] || null;
}

function buildRecommendBatchFromPoolForQuickReview(pool = [], startIndex = 0, batchSize = QUICK_REVIEW_RECOMMEND_BATCH_SIZE, options = {}) {
  if (!Array.isArray(pool) || pool.length === 0) return [];

  const size = Math.min(Math.max(1, Math.floor(Number(batchSize) || QUICK_REVIEW_RECOMMEND_BATCH_SIZE)), pool.length);
  const safeStart = ((Math.floor(Number(startIndex) || 0) % pool.length) + pool.length) % pool.length;
  const random = typeof options?.randomFn === 'function' ? options.randomFn : Math.random;
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
      const jitter = 0.92 + (random() * 0.16);
      const weight = rankWeight * priorityWeight * domainPenalty * jitter;
      return { ...entry, weight };
    });

    const picked = pickWeightedQuickReviewEntry(weighted, random);
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

function buildSequentialRecommendBatchFromPool(pool = [], startIndex = 0, batchSize = QUICK_REVIEW_RECOMMEND_BATCH_SIZE) {
  if (!Array.isArray(pool) || pool.length === 0) return [];
  const size = Math.min(Math.max(1, Math.floor(Number(batchSize) || QUICK_REVIEW_RECOMMEND_BATCH_SIZE)), pool.length);
  const safeStart = ((Math.floor(Number(startIndex) || 0) % pool.length) + pool.length) % pool.length;
  const batch = [];
  const seenIds = new Set();

  for (let step = 0; step < pool.length && batch.length < size; step += 1) {
    const item = pool[(safeStart + step) % pool.length];
    const id = String(item?.id || '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    batch.push(item);
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

function buildQuickReviewBookmarksFromScoresCacheWithStats(scoresCache) {
  const source = scoresCache && typeof scoresCache === 'object' ? scoresCache : {};
  const result = [];
  const stats = {
    cacheCount: 0,
    validScoreCount: 0,
    invalidScoreCount: 0,
    metadataReadyCount: 0,
    missingMetadataCount: 0,
    invalidEntryCount: 0,
    bookmarkCount: 0
  };

  for (const [bookmarkId, cachedEntry] of Object.entries(source)) {
    stats.cacheCount += 1;
    const id = String(bookmarkId || '').trim();
    if (!id || !cachedEntry || typeof cachedEntry !== 'object') {
      stats.invalidEntryCount += 1;
      continue;
    }

    const score = Number(cachedEntry.S);
    if (Number.isFinite(score)) {
      stats.validScoreCount += 1;
    } else {
      stats.invalidScoreCount += 1;
    }

    const metadata = normalizeScoreCacheMetadata(cachedEntry);
    if (!metadata) {
      stats.missingMetadataCount += 1;
      continue;
    }
    stats.metadataReadyCount += 1;

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
      stats.bookmarkCount += 1;
    }
  }

  return { bookmarks: result, stats };
}

function buildQuickReviewBookmarksFromScoresCache(scoresCache) {
  return buildQuickReviewBookmarksFromScoresCacheWithStats(scoresCache).bookmarks;
}

function normalizeRecommendScoresCacheHealth(stats = {}) {
  const cacheCount = Math.max(0, Number(stats.cacheCount) || 0);
  const validScoreCount = Math.max(0, Number(stats.validScoreCount) || 0);
  const invalidScoreCount = Math.max(0, Number(stats.invalidScoreCount) || 0);
  const metadataReadyCount = Math.max(0, Number(stats.metadataReadyCount) || 0);
  const missingMetadataCount = Math.max(0, Number(stats.missingMetadataCount) || 0);
  const invalidEntryCount = Math.max(0, Number(stats.invalidEntryCount) || 0);
  const bookmarkCount = Math.max(0, Number(stats.bookmarkCount) || 0);
  const validScoreRatio = cacheCount > 0 ? validScoreCount / cacheCount : 1;
  const metadataReadyRatio = cacheCount > 0 ? metadataReadyCount / cacheCount : 1;
  const healthy = cacheCount === 0
    || (
      validScoreCount > 0
      && metadataReadyCount > 0
      && validScoreRatio >= SCORE_CACHE_HEALTH_MIN_VALID_RATIO
      && metadataReadyRatio >= SCORE_CACHE_HEALTH_MIN_METADATA_RATIO
    );

  return {
    cacheCount,
    validScoreCount,
    invalidScoreCount,
    metadataReadyCount,
    missingMetadataCount,
    invalidEntryCount,
    bookmarkCount,
    validScoreRatio,
    metadataReadyRatio,
    healthy
  };
}

function getRecommendScoresStaleAt(staleMeta) {
  const staleAt = Number(staleMeta?.staleAt || 0);
  return Number.isFinite(staleAt) && staleAt > 0 ? staleAt : 0;
}

function compactRecommendScoresCacheHealth(stats = {}) {
  const health = normalizeRecommendScoresCacheHealth(stats);
  return {
    cacheCount: health.cacheCount,
    validScoreCount: health.validScoreCount,
    invalidScoreCount: health.invalidScoreCount,
    metadataReadyCount: health.metadataReadyCount,
    missingMetadataCount: health.missingMetadataCount,
    invalidEntryCount: health.invalidEntryCount,
    bookmarkCount: health.bookmarkCount,
    validScoreRatio: Number(health.validScoreRatio.toFixed(4)),
    metadataReadyRatio: Number(health.metadataReadyRatio.toFixed(4)),
    healthy: health.healthy
  };
}

function getRecommendScoresCacheRepairReason(stats = {}, staleMeta = null) {
  const staleAt = getRecommendScoresStaleAt(staleMeta);
  if (staleAt > 0) return String(staleMeta?.reason || 'score-cache-stale');

  const health = normalizeRecommendScoresCacheHealth(stats);
  if (health.cacheCount <= 0) return '';
  if (health.validScoreCount <= 0 || health.validScoreRatio < SCORE_CACHE_HEALTH_MIN_VALID_RATIO) {
    return 'score-cache-invalid-scores';
  }
  if (health.metadataReadyCount <= 0 || health.metadataReadyRatio < SCORE_CACHE_HEALTH_MIN_METADATA_RATIO) {
    return 'score-cache-missing-metadata';
  }
  if (health.bookmarkCount <= 0) {
    return 'score-cache-no-selectable-bookmarks';
  }
  return '';
}

async function markRecommendScoresCacheRepairing(reason = '', stats = {}) {
  try {
    await browserAPI.storage.local.set({
      recommendScoresStaleMeta: {
        staleAt: Date.now(),
        reason: reason || 'score-cache-repair',
        cacheHealth: compactRecommendScoresCacheHealth(stats)
      }
    });
  } catch (_) { }
}

function queueRecommendScoresCacheRepair(reason = '', stats = {}) {
  markRecommendScoresCacheRepairing(reason, stats).catch(() => { });
  if (isBookmarkImporting || isBookmarkBulkChanging || isComputingScores || templateRefineRunning) return;
  scheduleRecomputeAllScoresSoon(reason || 'score-cache-repair', { forceFull: true });
}

function shouldHoldQuickReviewForScoreCache(stats = {}, staleMeta = null, scoresReadyResult = null) {
  const health = normalizeRecommendScoresCacheHealth(stats);
  const repairReason = getRecommendScoresCacheRepairReason(health, staleMeta);
  if (repairReason) return repairReason;

  if (health.cacheCount === 0 && scoresReadyResult?.ready === false) {
    return scoresReadyResult?.mode === 'empty-tree' ? '' : String(scoresReadyResult?.mode || 'score-cache-not-ready');
  }

  return '';
}

function normalizeRecommendReviewNextReviewAt(review) {
  const nextReview = Number(review?.nextReview || 0);
  return Number.isFinite(nextReview) && nextReview > 0 ? Math.floor(nextReview) : 0;
}

function buildQuickReviewEligibilityState(postponed = [], reviewData = {}, now = Date.now()) {
  const postponedWaitingSet = new Set();
  const forceDuePostponedMap = new Map();
  for (const item of normalizeRecommendPostponedList(postponed || [])) {
    if (!item || item.bookmarkId == null) continue;
    const bookmarkId = String(item.bookmarkId || '').trim();
    if (!bookmarkId) continue;

    const postponeUntil = Number(item.postponeUntil || 0);
    const isManual = item.manuallyAdded === true;
    if (isManual) {
      forceDuePostponedMap.set(bookmarkId, item);
    } else if (postponeUntil > now) {
      postponedWaitingSet.add(bookmarkId);
    }
  }

  const reviewedSet = new Set();
  const reviewWaitingSet = new Set();
  const forceDueReviewMap = new Map();
  const reviews = reviewData && typeof reviewData === 'object' ? reviewData : {};
  for (const [rawBookmarkId, review] of Object.entries(reviews)) {
    const bookmarkId = String(rawBookmarkId || '').trim();
    if (!bookmarkId || !review || typeof review !== 'object') continue;
    reviewedSet.add(bookmarkId);

    const nextReviewAt = normalizeRecommendReviewNextReviewAt(review);
    if (nextReviewAt > now) {
      reviewWaitingSet.add(bookmarkId);
    } else {
      forceDueReviewMap.set(bookmarkId, review);
    }
  }

  return {
    postponedWaitingSet,
    forceDuePostponedMap,
    reviewedSet,
    reviewWaitingSet,
    forceDueReviewMap
  };
}

function getQuickReviewForceDueInfo(bookmarkId, eligibility, now = Date.now()) {
  const id = String(bookmarkId || '').trim();
  if (!id || !eligibility) {
    return { forceDue: false, forceDueAt: 0, forceDueMovedAt: 0 };
  }

  const postponedInfo = eligibility.forceDuePostponedMap?.get(id);
  if (postponedInfo) {
    const postponeUntil = Number(postponedInfo.postponeUntil || 0);
    const movedAt = Number(postponedInfo.dueQueueMovedAt || 0);
    return {
      forceDue: true,
      forceDueAt: Number.isFinite(postponeUntil) && postponeUntil > 0 ? postponeUntil : now,
      forceDueMovedAt: Number.isFinite(movedAt) ? movedAt : 0
    };
  }

  return { forceDue: false, forceDueAt: 0, forceDueMovedAt: 0 };
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

function isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainMatchers) {
  if (!blockedDomainMatchers || blockedDomainMatchers.hasRules !== true) return false;
  if (!bookmark?.url) return false;
  try {
    const hostname = normalizeRecommendDomainHost(new URL(bookmark.url).hostname || '');
    return isHostnameBlockedByDomainMatchers(hostname, blockedDomainMatchers);
  } catch {
    return false;
  }
}

async function selectQuickReviewCardsRoundState(options = {}) {
  await ensureScoreAlgoVersionReady();
  const force = options?.force === true;
  let scoresReadyResult = null;

  try {
    scoresReadyResult = await ensureRecommendScoresReady({ reason: force ? 'quick-review-force' : 'quick-review-normal' });
  } catch (_) {}

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    return selectQuickReviewCardsRoundStateUnlocked({
      ...(options || {}),
      scoresReadyChecked: scoresReadyResult != null,
      scoresReadyResult
    });
  });
}

async function removeFlippedBookmarksStateByIds(ids = [], options = {}) {
  const safeIds = normalizeBookmarkIdList(ids || []);
  if (safeIds.length === 0) {
    return { success: true, removed: 0, flippedIds: [] };
  }

  if (options?.unlocked === true) {
    try {
      const result = await browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]);
      const current = Array.isArray(result?.[FLIPPED_BOOKMARKS_STORAGE_KEY])
        ? result[FLIPPED_BOOKMARKS_STORAGE_KEY]
        : [];
      const currentNormalized = normalizeBookmarkIdList(current);
      const removeSet = new Set(safeIds);
      const next = currentNormalized.filter(id => !removeSet.has(id));
      if (next.length !== currentNormalized.length) {
        await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: next });
      }
      return {
        success: true,
        removed: Math.max(0, currentNormalized.length - next.length),
        flippedIds: next
      };
    } catch (error) {
      return { success: false, removed: 0, error: error?.message || String(error), flippedIds: [] };
    }
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    return removeFlippedBookmarksStateByIds(safeIds, { unlocked: true });
  });
}

async function selectQuickReviewCardsRoundStateUnlocked(options = {}) {
  await ensureScoreAlgoVersionReady();
  const force = options?.force === true;
  const batchSize = Math.max(
    0,
    Math.min(
      QUICK_REVIEW_RECOMMEND_BATCH_SIZE,
      Math.floor(Number(options?.batchSize) || QUICK_REVIEW_RECOMMEND_BATCH_SIZE)
    )
  );
  const shouldPersist = options?.persist !== false;
  const excludeCardSet = new Set(normalizeBookmarkIdList(options?.excludeCardIds || []));

  if (options?.scoresReadyChecked !== true) {
    try {
      options.scoresReadyResult = await ensureRecommendScoresReady({ reason: force ? 'quick-review-force' : 'quick-review-normal' });
    } catch (_) {}
  }

  const [scoresCache, blocked, postponed, skippedIds, flippedResult, historyCardsResult, staleMetaResult, reviewData] = await Promise.all([
    getScoresCache(),
    getRecommendBlockedState(),
    getRecommendPostponedList(),
    getRecommendSkippedIds(),
    browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]),
    options?.currentCards
      ? Promise.resolve({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: options.currentCards })
      : browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]),
    browserAPI.storage.local.get(['recommendScoresStaleMeta']),
    getReviewDataForScore()
  ]);

  const cacheBuild = buildQuickReviewBookmarksFromScoresCacheWithStats(scoresCache);
  const bookmarks = cacheBuild.bookmarks;
  const cacheHealth = normalizeRecommendScoresCacheHealth(cacheBuild.stats);
  const staleMeta = staleMetaResult?.recommendScoresStaleMeta || null;
  const holdReason = shouldHoldQuickReviewForScoreCache(cacheHealth, staleMeta, options?.scoresReadyResult || null);
  if (holdReason) {
    queueRecommendScoresCacheRepair(`quick-review:${holdReason}`, cacheHealth);
    return {
      success: false,
      ready: false,
      repairing: true,
      reason: holdReason,
      cards: [],
      cacheHealth: compactRecommendScoresCacheHealth(cacheHealth)
    };
  }

  const currentCards = normalizeHistoryCurrentCardsState(historyCardsResult?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);
  const flippedSet = new Set(normalizeBookmarkIdList(flippedResult?.[FLIPPED_BOOKMARKS_STORAGE_KEY] || []));
  const skipped = normalizeRecommendSkippedIds(skippedIds || []);
  const skippedSet = new Set(skipped);
  const skippedOrderMap = buildRecommendSkippedOrderMap(skipped);

  const blockedBookmarkSet = new Set(normalizeBookmarkIdList(blocked?.bookmarks || []));
  const blockedFolderSet = new Set(normalizeBookmarkIdList(blocked?.folders || []));
  const blockedDomainSet = buildBlockedDomainMatchers(
    Array.isArray(blocked?.domains) ? blocked.domains : []
  );

  const now = Date.now();
  const eligibility = buildQuickReviewEligibilityState(postponed, reviewData, now);

  const baseCandidateBookmarks = bookmarks.filter((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDue = getQuickReviewForceDueInfo(bookmarkId, eligibility, now).forceDue;

    if (excludeCardSet.has(bookmarkId)) return false;
    if (blockedBookmarkSet.has(bookmarkId)) return false;
    if (isQuickReviewBookmarkInBlockedFolder(bookmark, blockedFolderSet)) return false;
    if (isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainSet)) return false;
    if (eligibility.postponedWaitingSet.has(bookmarkId)) return false;
    if (!forceDue && eligibility.reviewWaitingSet.has(bookmarkId)) return false;
    if (!forceDue && flippedSet.has(bookmarkId) && !eligibility.reviewedSet.has(bookmarkId)) return false;
    return true;
  });

  if (baseCandidateBookmarks.length === 0) {
    if (!shouldPersist) {
      return { success: true, cards: [], currentCards };
    }
    const saved = await saveHistoryCurrentCardsState([], [], [], { previousState: currentCards });
    await setRecommendPoolCursorState(0, 0, { unlocked: true });
    return { success: true, cards: [], currentCards: saved };
  }

  const sortedPool = baseCandidateBookmarks.map((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDueInfo = getQuickReviewForceDueInfo(bookmarkId, eligibility, now);
    const cached = scoresCache?.[bookmarkId];
    return normalizeQuickReviewBookmarkEntry({
      ...bookmark,
      priority: cached && Number.isFinite(Number(cached.S)) ? Number(cached.S) : 0.5,
      scoreTemplate: cached?._template === true,
      forceDue: forceDueInfo.forceDue === true,
      forceDueAt: Number(forceDueInfo.forceDueAt || 0),
      forceDueMovedAt: Number(forceDueInfo.forceDueMovedAt || 0)
    });
  }).filter(Boolean).sort((a, b) => compareRecommendPriorityWithSkippedForQuickReview(a, b, {
    skippedSet,
    skippedOrderMap
  }));

  const { activeForceDuePool, normalPool, deferredPool } = buildQuickReviewPriorityPools(sortedPool, {
    skippedSet,
    skippedOrderMap
  });

  const currentCardIds = normalizeBookmarkIdList(currentCards.cardIds || []);
  const currentNormalCardIds = currentCardIds.filter(id =>
    normalPool.some(item => String(item?.id || '').trim() === id)
  );
  const currentFlippedSet = new Set(normalizeBookmarkIdList(currentCards.flippedIds || []));
  const currentAllFlipped = currentCardIds.length > 0
    && currentCardIds.every(id => currentFlippedSet.has(id));

  const forceDueStartIndex = force && activeForceDuePool.length > 0 && currentCardIds.length > 0
    ? deriveRecommendStartIndexFromCurrentForQuickReview(activeForceDuePool, currentCardIds, 0)
    : 0;
  const forceDueBatch = force
    ? buildSequentialRecommendBatchFromPool(activeForceDuePool, forceDueStartIndex, batchSize)
    : activeForceDuePool.slice(0, batchSize);
  const normalSlots = Math.max(0, batchSize - forceDueBatch.length);
  const expectedNormalBatchLen = normalSlots > 0 ? Math.min(normalSlots, normalPool.length) : 0;

  const shouldRotateByCurrent = (force || currentAllFlipped) && currentNormalCardIds.length > 0;
  let startIndex = 0;

  if (normalPool.length > 0) {
    if (shouldRotateByCurrent) {
      const storedCursor = await getRecommendPoolCursorValueForQuickReview(normalPool.length);
      startIndex = force
        ? storedCursor
        : deriveRecommendStartIndexFromCurrentForQuickReview(normalPool, currentNormalCardIds, storedCursor);
    } else {
      const cursorMeta = await consumeRecommendPoolCursorState(normalPool.length, expectedNormalBatchLen, { unlocked: true });
      startIndex = Number.isFinite(Number(cursorMeta?.cursorBefore))
        ? Number(cursorMeta.cursorBefore)
        : 0;
    }
  }

  const normalBatch = normalSlots > 0
    ? buildRecommendBatchFromPoolForQuickReview(normalPool, startIndex, normalSlots, {
      randomFn: createQuickReviewSelectionRandom(normalPool, startIndex, normalSlots)
    })
    : [];

  const deferredSlots = Math.max(0, batchSize - forceDueBatch.length - normalBatch.length);
  const deferredBatch = deferredSlots > 0
    ? deferredPool.slice(0, deferredSlots)
    : [];
  const cards = [...forceDueBatch, ...normalBatch, ...deferredBatch].slice(0, batchSize);
  const nextCursor = normalPool.length > 0
    ? (startIndex + normalBatch.length) % normalPool.length
    : 0;

  if (shouldRotateByCurrent) {
    await setRecommendPoolCursorState(normalPool.length, nextCursor, { unlocked: true });
  }

  const cardIds = cards.map(item => String(item?.id || '').trim()).filter(Boolean);
  const cardData = cards.map(item => normalizeRecommendCardDataEntry(item)).filter(Boolean);
  if (!shouldPersist) {
    return {
      success: true,
      cards,
      currentCards
    };
  }

  const saved = await saveHistoryCurrentCardsState(cardIds, [], cardData, { previousState: currentCards });

  return {
    success: true,
    cards,
    currentCards: saved
  };
}

async function peekQuickReviewPreloadUrlsState(options = {}) {
  await ensureScoreAlgoVersionReady();
  const limit = Math.max(6, Math.min(30, Number(options?.limit) || 12));
  let scoresReadyResult = null;

  try {
    scoresReadyResult = await ensureRecommendScoresReady({ reason: 'quick-review-preload' });
  } catch (_) {}

  const [scoresCache, blocked, postponed, skippedIds, flippedResult, staleMetaResult, reviewData] = await Promise.all([
    getScoresCache(),
    getRecommendBlockedState(),
    getRecommendPostponedList(),
    getRecommendSkippedIds(),
    browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]),
    browserAPI.storage.local.get(['recommendScoresStaleMeta']),
    getReviewDataForScore()
  ]);

  const cacheBuild = buildQuickReviewBookmarksFromScoresCacheWithStats(scoresCache);
  const bookmarks = cacheBuild.bookmarks;
  const cacheHealth = normalizeRecommendScoresCacheHealth(cacheBuild.stats);
  const staleMeta = staleMetaResult?.recommendScoresStaleMeta || null;
  const holdReason = shouldHoldQuickReviewForScoreCache(cacheHealth, staleMeta, scoresReadyResult);
  if (holdReason) {
    queueRecommendScoresCacheRepair(`quick-review-preload:${holdReason}`, cacheHealth);
    return {
      success: false,
      ready: false,
      repairing: true,
      reason: holdReason,
      urls: [],
      cacheHealth: compactRecommendScoresCacheHealth(cacheHealth)
    };
  }

  const flippedSet = new Set(normalizeBookmarkIdList(flippedResult?.[FLIPPED_BOOKMARKS_STORAGE_KEY] || []));
  const skipped = normalizeRecommendSkippedIds(skippedIds || []);
  const skippedSet = new Set(skipped);
  const skippedOrderMap = buildRecommendSkippedOrderMap(skipped);

  const blockedBookmarkSet = new Set(normalizeBookmarkIdList(blocked?.bookmarks || []));
  const blockedFolderSet = new Set(normalizeBookmarkIdList(blocked?.folders || []));
  const blockedDomainSet = buildBlockedDomainMatchers(
    Array.isArray(blocked?.domains) ? blocked.domains : []
  );

  const now = Date.now();
  const eligibility = buildQuickReviewEligibilityState(postponed, reviewData, now);

  const baseCandidateBookmarks = bookmarks.filter((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDue = getQuickReviewForceDueInfo(bookmarkId, eligibility, now).forceDue;

    if (blockedBookmarkSet.has(bookmarkId)) return false;
    if (isQuickReviewBookmarkInBlockedFolder(bookmark, blockedFolderSet)) return false;
    if (isQuickReviewBookmarkBlockedDomain(bookmark, blockedDomainSet)) return false;
    if (eligibility.postponedWaitingSet.has(bookmarkId)) return false;
    if (!forceDue && eligibility.reviewWaitingSet.has(bookmarkId)) return false;
    if (!forceDue && flippedSet.has(bookmarkId) && !eligibility.reviewedSet.has(bookmarkId)) return false;
    return true;
  });

  if (baseCandidateBookmarks.length === 0) {
    return { success: true, urls: [] };
  }

  const sortedPool = baseCandidateBookmarks.map((bookmark) => {
    const bookmarkId = String(bookmark?.id || '').trim();
    const forceDueInfo = getQuickReviewForceDueInfo(bookmarkId, eligibility, now);
    const cached = scoresCache?.[bookmarkId];
    return normalizeQuickReviewBookmarkEntry({
      ...bookmark,
      priority: cached && Number.isFinite(Number(cached.S)) ? Number(cached.S) : 0.5,
      scoreTemplate: cached?._template === true,
      forceDue: forceDueInfo.forceDue === true,
      forceDueAt: Number(forceDueInfo.forceDueAt || 0),
      forceDueMovedAt: Number(forceDueInfo.forceDueMovedAt || 0)
    });
  }).filter(Boolean).sort((a, b) => compareRecommendPriorityWithSkippedForQuickReview(a, b, {
    skippedSet,
    skippedOrderMap
  }));

  const { activeForceDuePool, normalPool, deferredPool } = buildQuickReviewPriorityPools(sortedPool, {
    skippedSet,
    skippedOrderMap
  });

  const urls = [];
  const seenIds = new Set();
  let cursor = await getRecommendPoolCursorValueForQuickReview(normalPool.length);
  const rounds = Math.max(2, Math.ceil(limit / Math.max(1, QUICK_REVIEW_RECOMMEND_BATCH_SIZE)) + 1);

  for (let round = 0; round < rounds && urls.length < limit; round += 1) {
    const forceDueBatch = activeForceDuePool.slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
    const normalSlots = Math.max(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE - forceDueBatch.length);
    const normalBatch = normalSlots > 0
      ? buildRecommendBatchFromPoolForQuickReview(normalPool, cursor, normalSlots, {
        randomFn: createQuickReviewSelectionRandom(normalPool, cursor, normalSlots)
      })
      : [];

    if (normalPool.length > 0) {
      cursor = (cursor + normalBatch.length) % normalPool.length;
    }

    const deferredSlots = Math.max(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE - forceDueBatch.length - normalBatch.length);
    const deferredBatch = deferredSlots > 0
      ? deferredPool.slice(0, deferredSlots)
      : [];
    const roundCards = [...forceDueBatch, ...normalBatch, ...deferredBatch].slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
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
    for (const item of [...normalPool, ...deferredPool]) {
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

  if (currentCards.cardIds.length > 0 && currentCards.version > 0) {
    const pending = await resolveQuickReviewPendingBookmark(currentCards);
    if (pending.bookmark) {
      return { source: 'current', currentCards: pending.currentCards, bookmark: pending.bookmark };
    }
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
    const actionResult = bookmarkId
      ? await executeRecommendCardActionState({
        recommendAction: 'review',
        bookmarkId,
        expectedVersion: candidate?.currentCards?.version,
        timestamp: Date.now(),
        source: `quick-review:${resolvedSource}`
      })
      : { success: false, reason: 'missing_bookmark_id' };
    const actionSuccess = actionResult && actionResult.success !== false;

    return {
      success: actionSuccess,
      handled: true,
      source: resolvedSource,
      bookmarkId: bookmarkId || null,
      url: bookmark.url || '',
      openMode: mode,
      tabId: Number.isFinite(Number(openResult?.tabId)) ? Number(openResult.tabId) : null,
      allFlipped: actionResult?.allFlipped === true,
      roundRefreshed: actionResult?.roundRefreshed === true,
      refreshMarked: actionResult?.refreshMarked === true,
      stale: actionResult?.stale === true,
      reason: actionResult?.reason || '',
      actionResult
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
  browserAPI.runtime.onInstalled.addListener((details = {}) => {
    initSidePanel();
    refreshSidePanelOpenWindows().catch(() => {});
    ensureRecommendBackgroundRefreshAlarm({ force: true }).catch(() => {});
    ensureBrowsingHistoryLibrarySeeded({
      reason: details?.reason === 'update' ? 'extension-update' : 'extension-install',
      previousVersion: details?.previousVersion || ''
    }).catch(() => {});
    ensureHistoryBackgroundSyncAlarm({ force: true }).catch(() => {});
    scheduleReviewReminderAlarm().catch(() => {});
    scheduleRecommendStartupSelfHeal('on-installed').catch(() => {});
    triggerRecommendBackgroundRefresh('on-installed', { requireIdle: true });
  });
}

if (browserAPI?.runtime?.onStartup) {
  browserAPI.runtime.onStartup.addListener(() => {
    ensureRecommendBackgroundRefreshAlarm({ force: true }).catch(() => {});
    ensureBrowsingHistoryLibrarySeeded({ reason: 'extension-startup' }).catch(() => {});
    ensureHistoryBackgroundSyncAlarm({ force: true }).catch(() => {});
    scheduleReviewReminderAlarm().catch(() => {});
    scheduleRecommendStartupSelfHeal('on-startup').catch(() => {});
    triggerRecommendBackgroundRefresh('on-startup', { requireIdle: true });
  });
}

initSidePanel();
registerSidePanelTogglePortListener();
refreshSidePanelOpenWindows().catch(() => {});

if (browserAPI?.storage?.onChanged) {
  browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes) return;
    if (
      Object.prototype.hasOwnProperty.call(changes, RECOMMEND_POSTPONED_STORAGE_KEY) ||
      Object.prototype.hasOwnProperty.call(changes, RECOMMEND_REVIEW_REMINDER_ENABLED_STORAGE_KEY)
    ) {
      scheduleReviewReminderAlarm().catch(() => {});
    }
    if (Object.prototype.hasOwnProperty.call(changes, BROWSING_CALIBRATION_SETTINGS_KEY)) {
      ensureHistoryBackgroundSyncAlarm({ force: true }).catch(() => {});
    }
  });
}

if (browserAPI?.alarms?.onAlarm) {
  browserAPI.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    if (alarm.name === RECOMMEND_BACKGROUND_REFRESH_ALARM) {
      triggerRecommendBackgroundRefresh('alarm', { requireIdle: true });
      return;
    }
    if (alarm.name === RECOMMEND_REVIEW_REMINDER_ALARM) {
      showReviewReminderPopupIfDue('alarm').catch(() => {});
      return;
    }
    if (alarm.name === HISTORY_BACKGROUND_SYNC_ALARM || alarm.name === HISTORY_BACKGROUND_SYNC_RETRY_ALARM) {
      const reason = alarm.name === HISTORY_BACKGROUND_SYNC_RETRY_ALARM ? 'background-alarm-retry' : 'background-alarm-sync';
      (async () => {
        const settings = await getBrowsingCalibrationSettingsBG();
        if (settings.scheduledCalibrationEnabled === false) return;
        await runScheduledBrowsingHistoryCalibration({
          settings,
          reason,
          requireIdle: settings.scheduledCalibrationRequireIdle === true,
          dedupeToday: alarm.name === HISTORY_BACKGROUND_SYNC_RETRY_ALARM
        });
      })().catch(() => {});
      return;
    }
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
        let matchedBookmarkIds = [];

        try {
          const matches = await browserAPI.bookmarks.search({ url });
          if (Array.isArray(matches) && matches.length > 0) {
            matchedBookmarkIds = normalizeBookmarkIdList(matches.map(item => item?.id));
            bookmarkId = matchedBookmarkIds[0] || null;
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

        syncBrowsingHistoryCacheForUrls([url], {
          reason: 'auto-bookmark-navigation',
          repairRecommendScores: false
        }).catch((error) => {
          console.warn('[Background][HistoryCache] auto-bookmark url sync failed:', error);
        });

        for (const matchedBookmarkId of matchedBookmarkIds) {
          const reviewResult = await markPostponedBookmarkReviewedFromOpen(matchedBookmarkId, {
            timestamp: typeof details.timeStamp === 'number' ? details.timeStamp : Date.now(),
            source: 'browser_auto_bookmark'
          });
          if (reviewResult?.reviewed === true) break;
          if (reviewResult?.success === false) {
            console.warn('[AutoBookmarkOpen] auto review failed:', reviewResult?.reason || 'unknown');
            break;
          }
        }
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
const BROWSING_HISTORY_LEGACY_CACHE_DB_NAME = 'BookmarkBrowsingHistoryCacheDB';
const BROWSING_HISTORY_CACHE_DB_NAME = 'BookmarkBrowsingHistoryCacheDB_v2';
const BROWSING_HISTORY_CACHE_DB_VERSION = 1;
const BROWSING_HISTORY_CACHE_DB_STORE = 'records';
const BROWSING_HISTORY_CACHE_DB_META = 'meta';
const BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION = 2;
const BROWSING_HISTORY_LIBRARY_SEED_STATE_KEY = 'bb_browsing_history_library_v2_seed_state';
const BROWSING_HISTORY_INITIAL_SEED_REASON = 'history-library-v2-initial-seed';
const BROWSING_HISTORY_META_LAST_SYNC = 'lastSyncTime';
const BROWSING_HISTORY_META_LAST_FULL_SYNC = 'lastFullSyncTime';
const BROWSING_HISTORY_META_LAST_INCREMENTAL_WRITE = 'lastIncrementalWriteTime';
const BROWSING_HISTORY_META_LAST_PARTIAL_SYNC = 'lastPartialSyncTime';
const BROWSING_HISTORY_META_LAST_ANY_WRITE = 'lastAnyWriteTime';
const BROWSING_HISTORY_META_SCHEMA_VERSION = 'schemaVersion';
const BROWSING_HISTORY_DAY_MS = 24 * 60 * 60 * 1000;
const BROWSING_HISTORY_SEARCH_PAGE_SIZE = 5000;
const BROWSING_HISTORY_SEARCH_MAX_ITEMS = 50000;
const BROWSING_HISTORY_MAX_VISITS_PER_URL = 400;
const BROWSING_HISTORY_LOOKBACK_DAYS = 0;
const BROWSING_HISTORY_PARTIAL_DELETE_PROTECT_DAYS = 90;
const BROWSING_HISTORY_REBUILD_FLUSH_DAYS = 10;
// 自动对账只回看上次成功整段校准的边界附近，避免每次打开都重扫固定天数。
// 首次建库、手动校准及无法定位范围的删除仍沿用 90 天热区。
const BROWSING_HISTORY_SYNC_BOUNDARY_BUFFER_MS = 5 * 60 * 1000;
const BROWSING_HISTORY_MAX_AUTO_CALIBRATION_LOOKBACK_DAYS = 90;
const BROWSING_HISTORY_BOOKMARK_VISIT_DIRTY_REASON = 'history-bookmark-visited';

const BROWSING_CALIBRATION_SETTINGS_KEY = 'browsingCalibrationSettings';
const BROWSING_CALIBRATION_STATE_KEY = 'browsingCalibrationState';
const BROWSING_HISTORY_OPEN_REFRESH_DIRTY_KEY = 'browsingHistoryOpenRefreshDirty';
const DEFAULT_BROWSING_CALIBRATION_SETTINGS = {
  autoEnabled: true,
  deleteThreshold: 50,
  openThreshold: 200,
  scheduledCalibrationEnabled: true,
  scheduledCalibrationTime: '15:30',
  scheduledCalibrationRequireIdle: true
};
const DEFAULT_BROWSING_CALIBRATION_STATE = {
  pendingDeleteCount: 0,
  pendingOpenCount: 0,
  lastCalibrationTime: 0,
  lastDeletionTime: 0,
  lastOpenTime: 0,
  lastScheduledCalibrationDate: '',
  lastScheduledCalibrationTime: 0
};

let browsingCalibrationInProgress = false;
let browsingHistoryCacheDbPromise = null;
let browsingHistoryLegacyDiscardPromise = null;
let browsingHistoryLegacyDiscardFinished = false;
let browsingHistoryLibrarySeedPromise = null;
let browsingHistoryOpenRefreshDirtyState = null;

const HISTORY_BACKGROUND_SYNC_ALARM = 'bb_history_background_sync_v1';
const HISTORY_BACKGROUND_SYNC_RETRY_ALARM = 'bb_history_background_sync_retry_v1';
const HISTORY_BACKGROUND_SYNC_PERIOD_MINUTES = 24 * 60; // daily
const HISTORY_BACKGROUND_SYNC_RETRY_DELAY_MINUTES = 15;
let ensureHistoryBackgroundSyncAlarmPromise = null;
let ensureHistoryBackgroundSyncAlarmLastCheckAt = 0;

function getSafeBrowsingHistoryMetaTime(...values) {
  for (const value of values) {
    const numeric = Number(value || 0);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;
  }
  return 0;
}

function normalizeDailyCalibrationTime(value) {
  const text = String(value || '').trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return DEFAULT_BROWSING_CALIBRATION_SETTINGS.scheduledCalibrationTime;
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function getNextDailyCalibrationTime(timeText, now = Date.now()) {
  const [hour, minute] = normalizeDailyCalibrationTime(timeText).split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now + 30 * 1000) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function getTodayDailyCalibrationTime(timeText, now = Date.now()) {
  const [hour, minute] = normalizeDailyCalibrationTime(timeText).split(':').map(Number);
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

function isAdaptiveBrowsingHistoryCalibrationReason(reason = '') {
  const safeReason = String(reason || '');
  return safeReason === 'background-alarm-sync'
    || safeReason === 'background-alarm-retry'
    || safeReason === 'ui-open-dirty-history-refresh'
    || safeReason === 'sync-push-before-collect'
    || safeReason.endsWith('-threshold')
    || safeReason === 'history-delete-without-url-list';
}

function applyBrowsingHistoryCachePayloadMeta(payload, timestamp, mode = 'full', existing = {}) {
  const safeTime = getSafeBrowsingHistoryMetaTime(timestamp, Date.now());
  const previousFullSync = getSafeBrowsingHistoryMetaTime(existing.lastFullSyncTime, existing.lastSyncTime, payload.lastFullSyncTime, payload.lastSyncTime);
  payload.schemaVersion = BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION;
  payload.dbName = BROWSING_HISTORY_CACHE_DB_NAME;
  if (mode === 'incremental') {
    payload.lastSyncTime = previousFullSync;
    payload.lastFullSyncTime = previousFullSync;
    payload.lastIncrementalWriteTime = safeTime;
  } else if (mode === 'partial') {
    payload.lastSyncTime = previousFullSync;
    payload.lastFullSyncTime = previousFullSync;
    payload.lastPartialSyncTime = safeTime;
  } else {
    payload.lastSyncTime = safeTime;
    payload.lastFullSyncTime = safeTime;
  }
  payload.lastAnyWriteTime = safeTime;
  return payload;
}

function putBrowsingHistoryCacheMeta(metaStore, timestamp, mode = 'full') {
  if (!metaStore || typeof metaStore.put !== 'function') return;
  const safeTime = getSafeBrowsingHistoryMetaTime(timestamp, Date.now());
  metaStore.put({ key: BROWSING_HISTORY_META_SCHEMA_VERSION, value: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION });
  if (mode === 'incremental') {
    metaStore.put({ key: BROWSING_HISTORY_META_LAST_INCREMENTAL_WRITE, value: safeTime });
  } else if (mode === 'partial') {
    metaStore.put({ key: BROWSING_HISTORY_META_LAST_PARTIAL_SYNC, value: safeTime });
  } else {
    metaStore.put({ key: BROWSING_HISTORY_META_LAST_SYNC, value: safeTime });
    metaStore.put({ key: BROWSING_HISTORY_META_LAST_FULL_SYNC, value: safeTime });
  }
  metaStore.put({ key: BROWSING_HISTORY_META_LAST_ANY_WRITE, value: safeTime });
}

async function scheduleHistoryBackgroundSyncRetry(reason = 'idle-active') {
  if (!browserAPI?.alarms?.create) return false;
  try {
    browserAPI.alarms.create(HISTORY_BACKGROUND_SYNC_RETRY_ALARM, {
      delayInMinutes: HISTORY_BACKGROUND_SYNC_RETRY_DELAY_MINUTES
    });
    console.info('[Background][HistoryCache] scheduled retry after skip:', reason);
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] schedule retry failed:', error);
    return false;
  }
}

async function ensureHistoryBackgroundSyncAlarm(options = {}) {
  if (!browserAPI?.alarms?.create || !browserAPI?.alarms?.get) {
    return { success: false, skipped: 'alarms-api-unavailable' };
  }

  const force = options?.force === true;
  const now = Date.now();

  if (ensureHistoryBackgroundSyncAlarmPromise) {
    return ensureHistoryBackgroundSyncAlarmPromise;
  }

  if (!force && (now - ensureHistoryBackgroundSyncAlarmLastCheckAt) < 60 * 1000) {
    return { success: true, skipped: 'throttled' };
  }

  ensureHistoryBackgroundSyncAlarmPromise = (async () => {
    try {
      const settings = await getBrowsingCalibrationSettingsBG();
      if (settings.scheduledCalibrationEnabled === false) {
        await new Promise((resolve) => {
          try {
            browserAPI.alarms.clear(HISTORY_BACKGROUND_SYNC_ALARM, () => resolve());
          } catch (_) {
            resolve();
          }
        });
        await new Promise((resolve) => {
          try {
            browserAPI.alarms.clear(HISTORY_BACKGROUND_SYNC_RETRY_ALARM, () => resolve());
          } catch (_) {
            resolve();
          }
        });
        return { success: true, created: false, disabled: true };
      }

      const nextRunAt = getNextDailyCalibrationTime(settings.scheduledCalibrationTime, now);
      const existingAlarm = await new Promise((resolve, reject) => {
        try {
          browserAPI.alarms.get(HISTORY_BACKGROUND_SYNC_ALARM, (alarm) => {
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
        const existingTime = Number(existingAlarm.scheduledTime || 0);
        const existingPeriod = Number(existingAlarm.periodInMinutes || 0);
        const sameSchedule = Math.abs(existingTime - nextRunAt) < 60 * 1000
          && existingPeriod === HISTORY_BACKGROUND_SYNC_PERIOD_MINUTES;
        if (sameSchedule) {
          const missedResult = await maybeRunMissedBrowsingHistoryScheduledCalibration({
            settings,
            reason: 'background-startup-missed'
          });
          return { success: true, created: false, nextRunAt, missed: missedResult };
        }
        await new Promise((resolve) => {
          try {
            browserAPI.alarms.clear(HISTORY_BACKGROUND_SYNC_ALARM, () => resolve());
          } catch (_) {
            resolve();
          }
        });
      }

      browserAPI.alarms.create(HISTORY_BACKGROUND_SYNC_ALARM, {
        when: nextRunAt,
        periodInMinutes: HISTORY_BACKGROUND_SYNC_PERIOD_MINUTES
      });
      const missedResult = await maybeRunMissedBrowsingHistoryScheduledCalibration({
        settings,
        reason: 'background-startup-missed'
      });
      return { success: true, created: true, nextRunAt, missed: missedResult };
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    } finally {
      ensureHistoryBackgroundSyncAlarmLastCheckAt = Date.now();
      ensureHistoryBackgroundSyncAlarmPromise = null;
    }
  })();

  return ensureHistoryBackgroundSyncAlarmPromise;
}

function normalizeBrowsingCalibrationSettings(raw = {}) {
  const settings = { ...DEFAULT_BROWSING_CALIBRATION_SETTINGS, ...(raw || {}) };
  const hasDelete = Object.prototype.hasOwnProperty.call(raw || {}, 'deleteThreshold');
  const hasOpen = Object.prototype.hasOwnProperty.call(raw || {}, 'openThreshold');
  const hasClick = Object.prototype.hasOwnProperty.call(raw || {}, 'clickThreshold');
  const hasAutoEnabled = Object.prototype.hasOwnProperty.call(raw || {}, 'autoEnabled');
  const hasOpenUserConfigured = Object.prototype.hasOwnProperty.call(raw || {}, 'openThresholdUserConfigured');
  const autoDisabled = hasAutoEnabled ? raw.autoEnabled === false : false;

  if (!hasOpen && hasClick) {
    settings.openThreshold = raw.clickThreshold;
  }

  if (hasOpen && !hasClick && !hasOpenUserConfigured && !autoDisabled && Number(raw.openThreshold) === 0) {
    settings.openThreshold = DEFAULT_BROWSING_CALIBRATION_SETTINGS.openThreshold;
  }

  if (raw && autoDisabled) {
    if (!hasDelete) settings.deleteThreshold = 0;
    if (!hasOpen && !hasClick) settings.openThreshold = 0;
  }

  settings.deleteThreshold = Math.max(0, Number(settings.deleteThreshold) || 0);
  settings.openThreshold = Math.max(0, Number(settings.openThreshold) || 0);
  settings.scheduledCalibrationEnabled = settings.scheduledCalibrationEnabled !== false;
  settings.scheduledCalibrationTime = normalizeDailyCalibrationTime(settings.scheduledCalibrationTime);
  settings.scheduledCalibrationRequireIdle = settings.scheduledCalibrationRequireIdle === true;
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

function getHistoryDateKey(timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getBrowsingHistoryPartialDeleteCutoff() {
  const cutoffTime = Date.now() - (BROWSING_HISTORY_PARTIAL_DELETE_PROTECT_DAYS * 24 * 60 * 60 * 1000);
  return {
    cutoffTime,
    cutoffDateKey: getHistoryDateKey(cutoffTime)
  };
}

function shouldRemoveBrowsingHistoryCacheItemForUrl(item, urlSet, cutoffTime = 0) {
  if (!item || !urlSet?.has(item.url)) return false;
  if (!cutoffTime) return true;
  const timestamp = getBrowsingHistoryRecordTimestamp(item);
  return !timestamp || timestamp >= cutoffTime;
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

async function writeBrowsingHistoryCacheToIDB(payload, metaMode = 'full', options = {}) {
  if (!payload || !Array.isArray(payload.records)) return false;
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
    const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
    const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
    try {
      if (options.replaceExisting) {
        recordsStore.clear();
        metaStore.clear();
      }
      for (const [dateKey, items] of payload.records) {
        if (!dateKey) continue;
        recordsStore.put({ dateKey, items: Array.isArray(items) ? items : [] });
      }
      putBrowsingHistoryCacheMeta(metaStore, payload.lastSyncTime || payload.lastFullSyncTime || Date.now(), metaMode);
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

async function removeBrowsingHistoryStorageCacheValue() {
  try {
    if (browserAPI?.storage?.local?.remove) {
      await browserAPI.storage.local.remove(BROWSING_HISTORY_CACHE_KEY);
    }
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] remove storage cache failed:', error);
    return false;
  }
}

async function deleteBrowsingHistoryLegacyCacheDB() {
  if (typeof indexedDB === 'undefined') return false;
  if (BROWSING_HISTORY_LEGACY_CACHE_DB_NAME === BROWSING_HISTORY_CACHE_DB_NAME) return false;

  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(BROWSING_HISTORY_LEGACY_CACHE_DB_NAME);
      request.onsuccess = () => resolve(true);
      request.onerror = () => {
        console.warn('[Background][HistoryCache] delete legacy DB failed:', request.error);
        resolve(false);
      };
      request.onblocked = () => {
        console.warn('[Background][HistoryCache] delete legacy DB blocked');
        resolve(false);
      };
    } catch (error) {
      console.warn('[Background][HistoryCache] delete legacy DB exception:', error);
      resolve(false);
    }
  });
}

async function removeBrowsingHistoryLegacyStorageCache() {
  try {
    if (browserAPI?.storage?.local?.get) {
      const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
      const cached = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
      if (isCurrentBrowsingHistoryStorageCache(cached)) {
        return false;
      }
    }
    return await removeBrowsingHistoryStorageCacheValue();
  } catch (error) {
    console.warn('[Background][HistoryCache] remove legacy storage cache failed:', error);
    return false;
  } finally {
    browsingHistoryLegacyDiscardFinished = true;
  }
}

async function discardLegacyBrowsingHistoryCache() {
  if (browsingHistoryLegacyDiscardFinished) return false;
  if (browsingHistoryLegacyDiscardPromise) return browsingHistoryLegacyDiscardPromise;

  browsingHistoryLegacyDiscardPromise = (async () => {
    try {
      await removeBrowsingHistoryLegacyStorageCache();
      return true;
    } finally {
      browsingHistoryLegacyDiscardPromise = null;
    }
  })();

  return browsingHistoryLegacyDiscardPromise;
}

function isCurrentBrowsingHistoryStorageCache(payload) {
  return !!(
    payload &&
    typeof payload === 'object' &&
    Number(payload.schemaVersion || 0) === BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION &&
    payload.dbName === BROWSING_HISTORY_CACHE_DB_NAME &&
    Array.isArray(payload.records)
  );
}

async function clearBrowsingHistoryCacheIDB() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE).clear();
      tx.objectStore(BROWSING_HISTORY_CACHE_DB_META).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (error) {
      console.warn('[Background][HistoryCache] clear DB failed:', error);
      resolve(false);
    }
  });
}

async function ensureBrowsingHistoryCacheSchemaMeta(timestamp = Date.now()) {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return true;

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      putBrowsingHistoryCacheMeta(metaStore, timestamp || Date.now(), 'full');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (error) {
      console.warn('[Background][HistoryCache] ensure schema meta failed:', error);
      resolve(false);
    }
  });
}

async function markBrowsingHistoryFullSyncComplete(timestamp = Date.now()) {
  const db = await openBrowsingHistoryCacheDB();
  if (db) {
    return ensureBrowsingHistoryCacheSchemaMeta(timestamp);
  }

  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
    const cached = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
    if (!isCurrentBrowsingHistoryStorageCache(cached)) return true;
    const payload = applyBrowsingHistoryCachePayloadMeta(
      { records: Array.isArray(cached.records) ? cached.records : [] },
      timestamp || Date.now(),
      'full',
      cached
    );
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] mark full sync failed:', error);
    return false;
  }
}

function normalizeBrowsingHistoryLibrarySeedState(raw = {}) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    schemaVersion: Number(state.schemaVersion || 0) || 0,
    dbName: typeof state.dbName === 'string' ? state.dbName : '',
    legacyDiscardedAt: Number(state.legacyDiscardedAt || 0) || 0,
    seedCompletedAt: Number(state.seedCompletedAt || 0) || 0,
    previousVersion: typeof state.previousVersion === 'string' ? state.previousVersion : '',
    reason: typeof state.reason === 'string' ? state.reason : ''
  };
}

async function getBrowsingHistoryLibrarySeedState() {
  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_LIBRARY_SEED_STATE_KEY]);
    return normalizeBrowsingHistoryLibrarySeedState(result?.[BROWSING_HISTORY_LIBRARY_SEED_STATE_KEY] || {});
  } catch (_) {
    return normalizeBrowsingHistoryLibrarySeedState({});
  }
}

async function saveBrowsingHistoryLibrarySeedState(state) {
  try {
    await browserAPI.storage.local.set({
      [BROWSING_HISTORY_LIBRARY_SEED_STATE_KEY]: normalizeBrowsingHistoryLibrarySeedState(state)
    });
  } catch (error) {
    console.warn('[Background][HistoryCache] save seed state failed:', error);
  }
}

async function ensureBrowsingHistoryLibrarySeeded(options = {}) {
  if (browsingHistoryLibrarySeedPromise) return browsingHistoryLibrarySeedPromise;

  browsingHistoryLibrarySeedPromise = (async () => {
    const now = Date.now();
    let state = await getBrowsingHistoryLibrarySeedState();
    const hasCurrentSeedState = state.schemaVersion === BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION
      && state.dbName === BROWSING_HISTORY_CACHE_DB_NAME
      && state.legacyDiscardedAt > 0;

    if (!hasCurrentSeedState) {
      const cleared = await clearBrowsingHistoryCacheIDB();
      if (!cleared) {
        return { success: false, error: 'history_cache_clear_failed' };
      }
      state = {
        schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION,
        dbName: BROWSING_HISTORY_CACHE_DB_NAME,
        legacyDiscardedAt: 0,
        seedCompletedAt: 0,
        previousVersion: options?.previousVersion || '',
        reason: options?.reason || 'initial-seed'
      };
      await saveBrowsingHistoryLibrarySeedState(state);
    } else {
      await discardLegacyBrowsingHistoryCache();
      deleteBrowsingHistoryLegacyCacheDB().catch(() => {});
    }

    if (state.seedCompletedAt > 0) {
      return { success: true, skipped: 'already-seeded', seedCompletedAt: state.seedCompletedAt };
    }

    const ok = await runBrowsingHistoryCalibration({
      reason: BROWSING_HISTORY_INITIAL_SEED_REASON,
      requireIdle: false,
      skipLibrarySeedCheck: true
    });

    if (ok) {
      const completedAt = Date.now();
      const metaOk = await ensureBrowsingHistoryCacheSchemaMeta(completedAt);
      if (!metaOk) {
        return { success: false, seeded: false, error: 'history_cache_schema_meta_failed' };
      }
      await removeBrowsingHistoryLegacyStorageCache();
      deleteBrowsingHistoryLegacyCacheDB().catch(() => {});
      await saveBrowsingHistoryLibrarySeedState({
        ...state,
        schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION,
        dbName: BROWSING_HISTORY_CACHE_DB_NAME,
        legacyDiscardedAt: completedAt,
        seedCompletedAt: completedAt
      });
      return { success: true, seeded: true, seedCompletedAt: completedAt };
    }

    return { success: false, seeded: false };
  })().finally(() => {
    browsingHistoryLibrarySeedPromise = null;
  });

  return browsingHistoryLibrarySeedPromise;
}

async function readBrowsingHistoryLastSyncTime() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) {
    try {
      const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
      const cached = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
      return isCurrentBrowsingHistoryStorageCache(cached)
        ? getSafeBrowsingHistoryMetaTime(cached?.lastFullSyncTime, cached?.lastSyncTime)
        : 0;
    } catch (_) {
      return 0;
    }
  }
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_META], 'readonly');
      const store = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      const fullReq = store.get(BROWSING_HISTORY_META_LAST_FULL_SYNC);
      const fallbackReq = store.get(BROWSING_HISTORY_META_LAST_SYNC);
      let fullValue = 0;
      let fallbackValue = 0;
      let pending = 2;
      const finish = () => {
        pending -= 1;
        if (pending > 0) return;
        resolve(getSafeBrowsingHistoryMetaTime(fullValue, fallbackValue));
      };
      fullReq.onsuccess = () => {
        fullValue = fullReq.result?.value || 0;
        finish();
      };
      fullReq.onerror = () => finish();
      fallbackReq.onsuccess = () => {
        fallbackValue = fallbackReq.result?.value || 0;
        finish();
      };
      fallbackReq.onerror = () => finish();
    } catch (e) {
      console.warn('[Background][HistoryCache] get lastSyncTime failed:', e);
      resolve(0);
    }
  });
}

function getBrowsingHistoryRecordTimestamp(record) {
  const timestamp = Number(record?.visitTime || record?.dateAdded || 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function mergeBrowsingHistoryRecordItems(existingItems = [], newItems = []) {
  const merged = [];
  const seen = new Set();
  for (const item of [...existingItems, ...newItems]) {
    const timestamp = getBrowsingHistoryRecordTimestamp(item);
    const key = `${item?.url || ''}|${timestamp || item?.id || ''}`;
    if (!item || seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged.sort((a, b) => getBrowsingHistoryRecordTimestamp(a) - getBrowsingHistoryRecordTimestamp(b));
}

function areBrowsingHistoryRecordItemsEqual(leftItems = [], rightItems = []) {
  const left = Array.isArray(leftItems) ? leftItems : [];
  const right = Array.isArray(rightItems) ? rightItems : [];
  if (left.length !== right.length) return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch (_) {
    return false;
  }
}

async function mergeBrowsingHistoryCacheRecordsMapInIDB(recordsMap, lastSyncTime) {
  if (!recordsMap || recordsMap.size === 0) return true;
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
      const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      const entries = Array.from(recordsMap.entries())
        .filter(([dateKey]) => !!dateKey)
        .sort((a, b) => a[0].localeCompare(b[0]));
      let index = 0;

      const processNext = () => {
        if (index >= entries.length) {
          putBrowsingHistoryCacheMeta(metaStore, lastSyncTime || Date.now(), 'incremental');
          return;
        }

        const [dateKey, items] = entries[index++];
        const request = recordsStore.get(dateKey);
        request.onsuccess = () => {
          const existingItems = Array.isArray(request.result?.items) ? request.result.items : [];
          const mergedItems = mergeBrowsingHistoryRecordItems(existingItems, Array.isArray(items) ? items : []);
          if (mergedItems.length) {
            recordsStore.put({ dateKey, items: mergedItems });
          }
          processNext();
        };
        request.onerror = () => processNext();
      };

      processNext();
      tx.oncomplete = () => finish(true);
      tx.onerror = () => finish(false);
      tx.onabort = () => finish(false);
    } catch (error) {
      console.warn('[Background][HistoryCache] merge records in DB failed:', error);
      finish(false);
    }
  });
}

async function mergeBrowsingHistoryCacheRecordsMap(recordsMap, lastSyncTime = Date.now()) {
  if (!recordsMap || recordsMap.size === 0) return true;

  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const ok = await mergeBrowsingHistoryCacheRecordsMapInIDB(recordsMap, lastSyncTime);
    if (ok) {
      await removeBrowsingHistoryLegacyStorageCache();
      return true;
    }
  }

  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
    const stored = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
    const existing = isCurrentBrowsingHistoryStorageCache(stored)
      ? stored
      : { schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION, dbName: BROWSING_HISTORY_CACHE_DB_NAME, lastSyncTime: 0, records: [] };
    const mergedMap = new Map(existing.records || []);
    for (const [dateKey, items] of recordsMap.entries()) {
      if (!dateKey) continue;
      const existingItems = Array.isArray(mergedMap.get(dateKey)) ? mergedMap.get(dateKey) : [];
      mergedMap.set(dateKey, mergeBrowsingHistoryRecordItems(existingItems, Array.isArray(items) ? items : []));
    }
    const recordsPayload = Array.from(mergedMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const payload = applyBrowsingHistoryCachePayloadMeta({ records: recordsPayload }, lastSyncTime || Date.now(), 'incremental', existing);
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] fallback merge records failed:', error);
    return false;
  }
}

async function replaceBrowsingHistoryCacheRangeInIDB(recordsMap, lastSyncTime, startDateKey, endDateKey, startTime = 0, endTime = 0, metaMode = 'full') {
  if (!recordsMap || !startDateKey || !endDateKey) return false;
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
      const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      const range = IDBKeyRange.bound(startDateKey, endDateKey);
      const request = recordsStore.openCursor(range);
      const existingRangeMap = new Map();
      const retainedMap = new Map();

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          const value = cursor.value || {};
          const dateKey = value.dateKey;
          const items = Array.isArray(value.items) ? value.items : [];
          if (dateKey) {
            existingRangeMap.set(dateKey, items);
          }
          const retainedItems = (startTime || endTime)
            ? items.filter((item) => {
              const timestamp = getBrowsingHistoryRecordTimestamp(item);
              if (!timestamp) return true;
              if (startTime && timestamp < startTime) return true;
              if (endTime && timestamp > endTime) return true;
              return false;
            })
            : [];
          if (dateKey && retainedItems.length) {
            retainedMap.set(dateKey, retainedItems);
          }
          cursor.continue();
          return;
        }

        const dateKeys = new Set([...existingRangeMap.keys(), ...retainedMap.keys(), ...recordsMap.keys()]);
        for (const dateKey of Array.from(dateKeys).sort((a, b) => a.localeCompare(b))) {
          if (!dateKey || dateKey < startDateKey || dateKey > endDateKey) continue;
          const items = mergeBrowsingHistoryRecordItems(
            retainedMap.get(dateKey) || [],
            recordsMap.get(dateKey) || []
          );
          if (items.length) {
            if (!areBrowsingHistoryRecordItemsEqual(existingRangeMap.get(dateKey) || [], items)) {
              recordsStore.put({ dateKey, items });
            }
          } else if (existingRangeMap.has(dateKey)) {
            recordsStore.delete(dateKey);
          }
        }
        putBrowsingHistoryCacheMeta(metaStore, lastSyncTime || Date.now(), metaMode);
      };
      request.onerror = () => finish(false);
      tx.oncomplete = () => finish(true);
      tx.onerror = () => finish(false);
      tx.onabort = () => finish(false);
    } catch (error) {
      console.warn('[Background][HistoryCache] replace range in DB failed:', error);
      finish(false);
    }
  });
}

async function replaceBrowsingHistoryCacheRange(recordsMap, lastSyncTime, startDateKey, endDateKey, startTime = 0, endTime = 0, metaMode = 'full') {
  if (!recordsMap || !startDateKey || !endDateKey) return false;

  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const ok = await replaceBrowsingHistoryCacheRangeInIDB(recordsMap, lastSyncTime, startDateKey, endDateKey, startTime, endTime, metaMode);
    if (ok) {
      await removeBrowsingHistoryLegacyStorageCache();
      return true;
    }
  }

  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
    const stored = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
    const existing = isCurrentBrowsingHistoryStorageCache(stored)
      ? stored
      : { schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION, dbName: BROWSING_HISTORY_CACHE_DB_NAME, lastSyncTime: 0, records: [] };
    const mergedMap = new Map(existing.records || []);
    const retainedMap = new Map();
    for (const dateKey of Array.from(mergedMap.keys())) {
      if (dateKey >= startDateKey && dateKey <= endDateKey) {
        const items = mergedMap.get(dateKey) || [];
        const retainedItems = (startTime || endTime)
          ? items.filter((item) => {
            const timestamp = getBrowsingHistoryRecordTimestamp(item);
            if (!timestamp) return true;
            if (startTime && timestamp < startTime) return true;
            if (endTime && timestamp > endTime) return true;
            return false;
          })
          : [];
        if (retainedItems.length) {
          retainedMap.set(dateKey, retainedItems);
        }
        mergedMap.delete(dateKey);
      }
    }
    for (const [dateKey, items] of recordsMap.entries()) {
      if (!dateKey || dateKey < startDateKey || dateKey > endDateKey) continue;
      mergedMap.set(dateKey, mergeBrowsingHistoryRecordItems(retainedMap.get(dateKey) || [], items || []));
      retainedMap.delete(dateKey);
    }
    for (const [dateKey, items] of retainedMap.entries()) {
      mergedMap.set(dateKey, items);
    }
    const recordsPayload = Array.from(mergedMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const payload = applyBrowsingHistoryCachePayloadMeta({ records: recordsPayload }, lastSyncTime || Date.now(), metaMode, existing);
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] fallback replace range failed:', error);
    return false;
  }
}

async function removeBrowsingHistoryCacheUrlsFromIDB(urls, options = {}) {
  const urlSet = new Set((Array.isArray(urls) ? urls : []).filter(Boolean));
  if (urlSet.size === 0) return { success: true, deletedCount: 0 };
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return { success: false, deletedCount: 0 };
  const cutoffTime = Number(options.cutoffTime || 0) || 0;
  const cutoffDateKey = options.cutoffDateKey || '';

  return new Promise((resolve) => {
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      const store = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
      const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      const range = cutoffDateKey ? IDBKeyRange.lowerBound(cutoffDateKey) : null;
      const request = range ? store.openCursor(range) : store.openCursor();
      let deletedCount = 0;

      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) {
          if (deletedCount > 0) {
            putBrowsingHistoryCacheMeta(metaStore, Date.now(), 'incremental');
          }
          return;
        }

        const value = cursor.value || {};
        if (cutoffDateKey && value.dateKey && value.dateKey < cutoffDateKey) {
          cursor.continue();
          return;
        }
        const items = Array.isArray(value.items) ? value.items : [];
        const remaining = items.filter((item) => {
          const shouldDelete = shouldRemoveBrowsingHistoryCacheItemForUrl(item, urlSet, cutoffTime);
          if (shouldDelete) deletedCount += 1;
          return !shouldDelete;
        });

        if (remaining.length !== items.length) {
          if (remaining.length) {
            cursor.update({ ...value, items: remaining });
          } else {
            cursor.delete();
          }
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve({ success: true, deletedCount });
      tx.onerror = () => resolve({ success: false, deletedCount });
      tx.onabort = () => resolve({ success: false, deletedCount });
    } catch (error) {
      console.warn('[Background][HistoryCache] remove urls from DB failed:', error);
      resolve({ success: false, deletedCount: 0 });
    }
  });
}

async function removeBrowsingHistoryCacheUrls(urls, options = {}) {
  const urlSet = new Set((Array.isArray(urls) ? urls : []).filter(Boolean));
  if (urlSet.size === 0) return { success: true, deletedCount: 0, remainingCount: 0 };
  const cutoffTime = Number(options.cutoffTime || 0) || 0;
  const cutoffDateKey = options.cutoffDateKey || '';

  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const result = await removeBrowsingHistoryCacheUrlsFromIDB(Array.from(urlSet), { cutoffTime, cutoffDateKey });
    if (result.success) {
      await removeBrowsingHistoryLegacyStorageCache();
      const stats = options.includeRemainingCount === true
        ? await getBrowsingHistoryStats()
        : null;
      return {
        success: true,
        deletedCount: result.deletedCount,
        remainingCount: stats ? stats.recordsCount : null
      };
    }
  }

  try {
    const existingCache = await readBrowsingHistoryCache();
    if (!existingCache || !Array.isArray(existingCache.records)) {
      return { success: true, deletedCount: 0, remainingCount: 0 };
    }

    let deletedCount = 0;
    const remainingRecords = [];
    for (const [dateKey, items] of existingCache.records) {
      if (cutoffDateKey && dateKey && dateKey < cutoffDateKey) {
        remainingRecords.push([dateKey, Array.isArray(items) ? items : []]);
        continue;
      }
      const safeItems = Array.isArray(items) ? items : [];
      const remainingItems = safeItems.filter((item) => {
        const shouldDelete = shouldRemoveBrowsingHistoryCacheItemForUrl(item, urlSet, cutoffTime);
        if (shouldDelete) deletedCount += 1;
        return !shouldDelete;
      });
      if (remainingItems.length) remainingRecords.push([dateKey, remainingItems]);
    }
    const remainingCount = remainingRecords.reduce((sum, [, items]) => sum + (items?.length || 0), 0);
    const payload = applyBrowsingHistoryCachePayloadMeta(
      { records: remainingRecords },
      Date.now(),
      'incremental',
      existingCache
    );
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return { success: true, deletedCount, remainingCount };
  } catch (error) {
    console.warn('[Background][HistoryCache] fallback remove urls failed:', error);
    return { success: false, deletedCount: 0, remainingCount: 0, error: error?.message || String(error) };
  }
}

async function purgeBrowsingHistoryCacheFromIDB(cutoffDateKey) {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return { success: false, deletedCount: 0 };
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readwrite');
      const store = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
      const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
      const range = IDBKeyRange.upperBound(cutoffDateKey, true); // strictly less than cutoffDateKey
      const request = store.openCursor(range);
      let deletedCount = 0;
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          deletedCount += cursor.value?.items?.length || 0;
          cursor.delete();
          cursor.continue();
        } else if (deletedCount > 0) {
          putBrowsingHistoryCacheMeta(metaStore, Date.now(), 'incremental');
        }
      };
      request.onerror = () => finish({ success: false, deletedCount });
      tx.oncomplete = () => finish({ success: true, deletedCount });
      tx.onerror = () => finish({ success: false, deletedCount });
      tx.onabort = () => finish({ success: false, deletedCount });
    } catch (e) {
      console.warn('[Background][HistoryCache] purge from IDB exception:', e);
      finish({ success: false, deletedCount: 0 });
    }
  });
}

async function getBrowsingHistoryStatsFromIDB() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE], 'readonly');
      const store = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
      const request = store.openCursor();
      let daysCount = 0;
      let recordsCount = 0;
      let totalChars = 0;
      request.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          daysCount += 1;
          const items = cursor.value.items || [];
          recordsCount += items.length;
          totalChars += JSON.stringify(cursor.value).length;
          cursor.continue();
        } else {
          resolve({
            success: true,
            daysCount,
            recordsCount,
            estimatedBytes: totalChars * 2
          });
        }
      };
      request.onerror = () => resolve(null);
    } catch (e) {
      console.warn('[Background][HistoryCache] get stats exception:', e);
      resolve(null);
    }
  });
}

async function writeBrowsingHistoryCache(payload, metaMode = 'full') {
  if (payload && typeof payload === 'object') {
    payload.schemaVersion = BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION;
    payload.dbName = BROWSING_HISTORY_CACHE_DB_NAME;
  }
  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const ok = await writeBrowsingHistoryCacheToIDB(payload, metaMode, { replaceExisting: true });
    if (ok) {
      await removeBrowsingHistoryLegacyStorageCache();
      return true;
    }
  }
  try {
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_CACHE_KEY]: payload });
    return true;
  } catch (error) {
    console.warn('[Background][HistoryCache] write storage failed:', error);
    return false;
  }
}

async function readBrowsingHistoryCacheFromIDB() {
  const db = await openBrowsingHistoryCacheDB();
  if (!db) return null;

  return new Promise((resolve) => {
    const tx = db.transaction([BROWSING_HISTORY_CACHE_DB_STORE, BROWSING_HISTORY_CACHE_DB_META], 'readonly');
    const recordsStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_STORE);
    const metaStore = tx.objectStore(BROWSING_HISTORY_CACHE_DB_META);
    const recordsRequest = recordsStore.getAll();
    const metaRequest = metaStore.getAll();
    let records = null;
    let meta = {};
    let pending = 2;

    const finish = () => {
      pending -= 1;
      if (pending > 0) return;
      if (Number(meta.schemaVersion || 0) !== BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION) {
        resolve(null);
        return;
      }
      const lastSyncTime = getSafeBrowsingHistoryMetaTime(meta.lastFullSyncTime, meta.lastSyncTime);
      if (!records || records.length === 0) {
        resolve(lastSyncTime ? { ...meta, schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION, dbName: BROWSING_HISTORY_CACHE_DB_NAME, lastSyncTime, records: [] } : null);
        return;
      }
      const normalizedRecords = records.map(entry => [entry.dateKey, entry.items || []]);
      resolve({ ...meta, schemaVersion: BROWSING_HISTORY_LIBRARY_SCHEMA_VERSION, dbName: BROWSING_HISTORY_CACHE_DB_NAME, lastSyncTime, records: normalizedRecords });
    };

    recordsRequest.onsuccess = () => {
      records = recordsRequest.result || [];
      finish();
    };
    recordsRequest.onerror = () => {
      records = null;
      finish();
    };
    metaRequest.onsuccess = () => {
      meta = {};
      for (const entry of (metaRequest.result || [])) {
        if (entry?.key) meta[entry.key] = entry.value || 0;
      }
      finish();
    };
    metaRequest.onerror = () => {
      meta = {};
      finish();
    };
  });
}

async function readBrowsingHistoryCache() {
  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const cached = await readBrowsingHistoryCacheFromIDB();
    if (cached) return cached;
  }
  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_CACHE_KEY]);
    const cached = result && result[BROWSING_HISTORY_CACHE_KEY] ? result[BROWSING_HISTORY_CACHE_KEY] : null;
    return isCurrentBrowsingHistoryStorageCache(cached) ? cached : null;
  } catch (error) {
    console.warn('[Background][HistoryCache] read storage failed:', error);
    return null;
  }
}

async function purgeBrowsingHistoryCache(cutoffDateKey) {
  if (!cutoffDateKey) return { success: false, error: 'cutoffDateKey is required' };

  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const purgeResult = await purgeBrowsingHistoryCacheFromIDB(cutoffDateKey);
    if (purgeResult.success) {
      const stats = await getBrowsingHistoryStats();
      return {
        success: true,
        deletedCount: purgeResult.deletedCount,
        remainingCount: stats.recordsCount
      };
    }
  }

  // Fallback to storage.local
  const existingCache = await readBrowsingHistoryCache();
  if (!existingCache || !Array.isArray(existingCache.records)) return { success: true, deletedCount: 0, remainingCount: 0 };

  const initialCount = existingCache.records.reduce((sum, [, items]) => sum + (items?.length || 0), 0);
  const remainingRecords = existingCache.records.filter(([dateKey]) => dateKey >= cutoffDateKey);
  const finalCount = remainingRecords.reduce((sum, [, items]) => sum + (items?.length || 0), 0);
  const deletedCount = initialCount - finalCount;

  await writeBrowsingHistoryCache(applyBrowsingHistoryCachePayloadMeta(
    { records: remainingRecords },
    Date.now(),
    'incremental',
    existingCache
  ), 'incremental');

  return { success: true, deletedCount, remainingCount: finalCount };
}

async function getBrowsingHistoryStats() {
  const idbOk = await openBrowsingHistoryCacheDB();
  if (idbOk) {
    const idbStats = await getBrowsingHistoryStatsFromIDB();
    if (idbStats) return idbStats;
  }

  const cached = await readBrowsingHistoryCache();
  if (!cached || !Array.isArray(cached.records)) {
    return { success: true, daysCount: 0, recordsCount: 0, estimatedBytes: 0 };
  }

  const daysCount = cached.records.length;
  const recordsCount = cached.records.reduce((sum, [, items]) => sum + (items?.length || 0), 0);
  const estimatedBytes = JSON.stringify(cached).length * 2; // approximation (UTF-16 characters)

  return { success: true, daysCount, recordsCount, estimatedBytes };
}

async function resetBrowsingHistoryCache(lastSyncTime) {
  const payload = applyBrowsingHistoryCachePayloadMeta({ records: [] }, lastSyncTime || Date.now(), 'full');
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

async function getBrowsingHistoryOpenRefreshDirtyState() {
  if (browsingHistoryOpenRefreshDirtyState) return browsingHistoryOpenRefreshDirtyState;
  try {
    const result = await browserAPI.storage.local.get([BROWSING_HISTORY_OPEN_REFRESH_DIRTY_KEY]);
    const stored = result?.[BROWSING_HISTORY_OPEN_REFRESH_DIRTY_KEY];
    browsingHistoryOpenRefreshDirtyState = stored && typeof stored === 'object'
      ? { dirty: stored.dirty === true, reason: String(stored.reason || ''), changedAt: Number(stored.changedAt || 0) || 0 }
      // 兼容已有安装：第一次打开先校准一次，随后只在真实变化后再校准。
      : { dirty: true, reason: 'initial-open-refresh', changedAt: 0 };
  } catch (_) {
    browsingHistoryOpenRefreshDirtyState = { dirty: true, reason: 'dirty-state-unavailable', changedAt: 0 };
  }
  return browsingHistoryOpenRefreshDirtyState;
}

async function setBrowsingHistoryOpenRefreshDirty(dirty, reason = '') {
  const next = {
    dirty: dirty === true,
    reason: String(reason || ''),
    changedAt: Date.now()
  };
  browsingHistoryOpenRefreshDirtyState = next;
  try {
    await browserAPI.storage.local.set({ [BROWSING_HISTORY_OPEN_REFRESH_DIRTY_KEY]: next });
  } catch (error) {
    console.warn('[Background][HistoryCache] save open-refresh dirty state failed:', error);
  }
  return next;
}

async function markBrowsingHistoryOpenRefreshDirty(reason = 'history-changed') {
  const current = await getBrowsingHistoryOpenRefreshDirtyState();
  // 校准进行中仍须记录新的访问/删除，避免旧校准完成后误把新变更清为 clean。
  if (current.dirty && !browsingCalibrationInProgress) return current;
  return setBrowsingHistoryOpenRefreshDirty(true, reason);
}

async function clearBrowsingHistoryOpenRefreshDirtyIfUnchanged(calibrationStartedAt, reason = '') {
  const current = await getBrowsingHistoryOpenRefreshDirtyState();
  if (current.dirty && Number(current.changedAt || 0) > Number(calibrationStartedAt || 0)) {
    return current;
  }
  return setBrowsingHistoryOpenRefreshDirty(false, reason);
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

async function markScheduledBrowsingHistoryCalibrationComplete(state = null, timestamp = Date.now()) {
  const baseState = state || await getBrowsingCalibrationState();
  const nextState = {
    ...baseState,
    pendingDeleteCount: 0,
    pendingOpenCount: 0,
    lastCalibrationTime: timestamp,
    lastScheduledCalibrationDate: getHistoryDateKey(timestamp),
    lastScheduledCalibrationTime: timestamp
  };
  await saveBrowsingCalibrationState(nextState);
  return nextState;
}

async function runScheduledBrowsingHistoryCalibration({ settings, reason = 'background-scheduled', requireIdle = false, dedupeToday = false } = {}) {
  const normalizedSettings = settings || await getBrowsingCalibrationSettingsBG();
  const now = Date.now();
  const state = await getBrowsingCalibrationState();
  const todayKey = getHistoryDateKey(now);

  // 定时任务是兜底，不应在历史库没有变化时每天重新扫描普通网页浏览记录。
  // 首次安装、书签访问的增量同步失败、删除等情况会保留 dirty，仍会进入下面的校准。
  const dirtyState = await getBrowsingHistoryOpenRefreshDirtyState();
  if (dirtyState.dirty !== true) {
    return { success: true, skipped: 'history-library-clean' };
  }

  if (dedupeToday && state.lastScheduledCalibrationDate === todayKey) {
    return { success: true, skipped: 'already-scheduled-today' };
  }

  const scheduledAt = getTodayDailyCalibrationTime(normalizedSettings.scheduledCalibrationTime, now);
  if (dedupeToday && Number(state.lastCalibrationTime || 0) >= scheduledAt) {
    await markScheduledBrowsingHistoryCalibrationComplete(state, Number(state.lastCalibrationTime || 0) || now);
    return { success: true, skipped: 'already-calibrated-after-scheduled-time' };
  }

  const ok = await runBrowsingHistoryCalibration({
    reason,
    requireIdle: requireIdle === true
  });
  if (ok) {
    await markScheduledBrowsingHistoryCalibrationComplete(state, Date.now());
  }
  return { success: ok === true };
}

async function maybeRunMissedBrowsingHistoryScheduledCalibration({ settings, reason = 'background-startup-missed' } = {}) {
  const normalizedSettings = settings || await getBrowsingCalibrationSettingsBG();
  if (normalizedSettings.scheduledCalibrationEnabled === false) {
    return { success: true, skipped: 'scheduled-disabled' };
  }

  const now = Date.now();
  const scheduledAt = getTodayDailyCalibrationTime(normalizedSettings.scheduledCalibrationTime, now);
  if (now <= scheduledAt + 30 * 1000) {
    return { success: true, skipped: 'scheduled-time-not-passed' };
  }

  return runScheduledBrowsingHistoryCalibration({
    settings: normalizedSettings,
    reason,
    requireIdle: normalizedSettings.scheduledCalibrationRequireIdle === true,
    dedupeToday: true
  });
}

function buildHistoryVisitRecord(item, visitTime, options = {}) {
  const safeVisitTime = Number(visitTime || 0);
  if (!item || !item.url || !safeVisitTime) return null;
  return {
    id: options.id || `${item.id || item.url}-${safeVisitTime}`,
    title: item.title || item.url,
    url: item.url,
    dateAdded: safeVisitTime,
    visitTime: safeVisitTime,
    visitCount: typeof options.count === 'number' && options.count > 0 ? options.count : 1,
    typedCount: item.typedCount || 0,
    folderPath: [],
    transition: options.transition || '',
    referringVisitId: options.referringVisitId || null,
    aggregated: !!options.aggregated
  };
}

function getHistoryItemLastVisitTime(item) {
  const timestamp = Number(item?.lastVisitTime || 0);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : 0;
}

function getHistoryItemVisitCount(item) {
  const count = Number(item?.visitCount || 0);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function shouldUseSingleVisitFastPath(item, startTime = 0, endTime = Date.now()) {
  const lastVisitTime = getHistoryItemLastVisitTime(item);
  return getHistoryItemVisitCount(item) === 1
    && lastVisitTime > 0
    && (!startTime || lastVisitTime >= startTime)
    && (!endTime || lastVisitTime <= endTime);
}

function createBrowsingHistoryRebuildChunks(startTime, endTime, chunkDays = BROWSING_HISTORY_REBUILD_FLUSH_DAYS) {
  const safeStart = Number(startTime || 0) || 0;
  const safeEnd = Number(endTime || 0) || 0;
  if (!safeStart || !safeEnd || safeEnd < safeStart) return [];

  const chunkMs = Math.max(1, Number(chunkDays || 0) || BROWSING_HISTORY_REBUILD_FLUSH_DAYS) * BROWSING_HISTORY_DAY_MS;
  const chunks = [];
  let chunkEndTime = safeEnd;
  while (chunkEndTime >= safeStart) {
    const chunkStartTime = Math.max(safeStart, chunkEndTime - chunkMs + 1);
    chunks.push({
      startTime: chunkStartTime,
      endTime: chunkEndTime,
      startDateKey: getHistoryDateKey(chunkStartTime),
      endDateKey: getHistoryDateKey(chunkEndTime)
    });
    chunkEndTime = chunkStartTime - 1;
  }
  return chunks;
}

function findBrowsingHistoryRebuildChunkIndex(chunks, timestamp) {
  const safeTimestamp = Number(timestamp || 0);
  if (!Number.isFinite(safeTimestamp) || safeTimestamp <= 0) return -1;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (safeTimestamp >= chunk.startTime && safeTimestamp <= chunk.endTime) {
      return i;
    }
  }
  return -1;
}

function addVisitRecordToRebuildChunks(chunkRecordsMap, chunks, visitKeySet, item, visitTime, options = {}) {
  const safeVisitTime = Number(visitTime || 0);
  if (!Number.isFinite(safeVisitTime) || safeVisitTime <= 0) return false;
  const chunkIndex = findBrowsingHistoryRebuildChunkIndex(chunks, safeVisitTime);
  if (chunkIndex < 0) return false;

  const record = buildHistoryVisitRecord(item, safeVisitTime, options);
  if (!record) return false;

  const visitKey = `${record.url}|${safeVisitTime}`;
  if (visitKeySet.has(visitKey)) return false;
  visitKeySet.add(visitKey);

  let recordsByDate = chunkRecordsMap.get(chunkIndex);
  if (!recordsByDate) {
    recordsByDate = new Map();
    chunkRecordsMap.set(chunkIndex, recordsByDate);
  }

  const dateKey = getHistoryDateKey(safeVisitTime);
  if (!recordsByDate.has(dateKey)) recordsByDate.set(dateKey, []);
  recordsByDate.get(dateKey).push(record);
  return true;
}

function normalizeBrowsingHistoryRecordsMap(recordsMap) {
  const normalized = new Map();
  if (!recordsMap || !(recordsMap instanceof Map)) return normalized;
  for (const [dateKey, items] of recordsMap.entries()) {
    if (!dateKey || !Array.isArray(items)) continue;
    normalized.set(dateKey, items.map(record => ({
      ...record,
      dateAdded: typeof record.dateAdded === 'number' ? record.dateAdded : (record.visitTime || Date.now())
    })));
  }
  return normalized;
}

async function syncBrowsingHistoryCacheForUrls(urls = [], {
  reason = 'history-url-sync',
  repairRecommendScores = true
} = {}) {
  if (!browserAPI?.history || typeof browserAPI.history.getVisits !== 'function') {
    return { success: false, skipped: 'history-getVisits-unavailable' };
  }

  const urlList = Array.from(new Set(
    (Array.isArray(urls) ? urls : [])
      .map(url => String(url || '').trim())
      .filter(url => /^https?:\/\//i.test(url))
  ));
  if (urlList.length === 0) {
    return { success: true, addedCount: 0, urlCount: 0 };
  }

  const now = Date.now();
  const hotStartTime = now - 90 * 24 * 60 * 60 * 1000;
  const recordsByDate = new Map();
  let addedCount = 0;

  const getHistoryItem = (url) => new Promise((resolve) => {
    try {
      if (typeof browserAPI.history?.search !== 'function') {
        resolve({ url, title: url });
        return;
      }
      browserAPI.history.search({
        text: url,
        startTime: hotStartTime,
        endTime: now,
        maxResults: 10
      }, (results) => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve({ url, title: url });
          return;
        }
        const exact = Array.isArray(results) ? results.find(item => item?.url === url) : null;
        resolve(exact ? { ...exact, url, title: String(exact.title || url).trim() || url } : { url, title: url });
      });
    } catch (_) {
      resolve({ url, title: url });
    }
  });

  const getVisitsAsync = (url) => new Promise((resolve) => {
    try {
      browserAPI.history.getVisits({ url }, (visits) => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          resolve([]);
          return;
        }
        resolve(Array.isArray(visits) ? visits : []);
      });
    } catch (_) {
      resolve([]);
    }
  });

  for (const url of urlList) {
    const historyItem = await getHistoryItem(url);
    const title = String(historyItem?.title || url).trim() || url;

    if (shouldUseSingleVisitFastPath(historyItem, hotStartTime, now)) {
      const visitTime = getHistoryItemLastVisitTime(historyItem);
      const record = buildHistoryVisitRecord({ ...historyItem, url, title }, visitTime, {
        id: `${historyItem?.id || url}-${visitTime}-single`,
        count: 1
      });
      if (record) {
        const dateKey = getHistoryDateKey(visitTime);
        if (!recordsByDate.has(dateKey)) recordsByDate.set(dateKey, []);
        recordsByDate.get(dateKey).push(record);
        addedCount += 1;
      }
      continue;
    }

    const visits = await getVisitsAsync(url);
    let inserted = 0;
    for (const visit of visits) {
      const visitTime = Number(visit?.visitTime || 0);
      if (!Number.isFinite(visitTime) || visitTime < hotStartTime || visitTime > now) continue;
      const record = buildHistoryVisitRecord({ ...historyItem, url, title }, visitTime, {
        id: `${url}-${visit?.visitId || visitTime}-${inserted}`,
        transition: visit?.transition || '',
        referringVisitId: visit?.referringVisitId || null,
        count: 1
      });
      if (!record) continue;
      const dateKey = getHistoryDateKey(visitTime);
      if (!recordsByDate.has(dateKey)) recordsByDate.set(dateKey, []);
      recordsByDate.get(dateKey).push(record);
      inserted += 1;
      addedCount += 1;
      if (BROWSING_HISTORY_MAX_VISITS_PER_URL && inserted >= BROWSING_HISTORY_MAX_VISITS_PER_URL) break;
    }
  }

  if (recordsByDate.size === 0) {
    return { success: true, addedCount: 0, urlCount: urlList.length };
  }

  const ok = await mergeBrowsingHistoryCacheRecordsMap(recordsByDate, now);
  if (ok) {
    notifyBrowsingHistoryCacheChanged(reason, false, { repairRecommendScores });
  }
  return { success: ok, addedCount, urlCount: urlList.length };
}

// Backward-compatible name for older foreground pages/messages. The cache is a
// raw browsing-history library; bookmark matching happens when consumers read it.
async function syncBrowsingHistoryCacheForBookmarkUrls(urls = [], options = {}) {
  return syncBrowsingHistoryCacheForUrls(urls, options);
}

function normalizeBrowsingInteractionUrls(payload = {}) {
  const values = [];
  if (payload && typeof payload.url === 'string') values.push(payload.url);
  if (Array.isArray(payload?.urls)) values.push(...payload.urls);
  return Array.from(new Set(
    values
      .map(url => String(url || '').trim())
      .filter(url => /^https?:\/\//i.test(url))
  ));
}

const BROWSING_HISTORY_INTERACTION_URL_SYNC_DELAY_MS = 1500;
const BROWSING_HISTORY_INTERACTION_URL_SYNC_COOLDOWN_MS = 30 * 1000;
const browsingHistoryInteractionPendingUrls = new Set();
const browsingHistoryInteractionLastSyncAt = new Map();
let browsingHistoryInteractionUrlSyncTimer = null;
let browsingHistoryInteractionUrlSyncInFlight = false;
let browsingHistoryInteractionPendingReason = 'interaction-url-sync';

function scheduleBrowsingHistoryUrlSyncForInteraction(urls = [], reason = 'interaction-url-sync') {
  const now = Date.now();
  const urlList = Array.from(new Set(
    (Array.isArray(urls) ? urls : [])
      .map(url => String(url || '').trim())
      .filter(url => /^https?:\/\//i.test(url))
  ));
  for (const url of urlList) {
    const lastSyncAt = Number(browsingHistoryInteractionLastSyncAt.get(url) || 0);
    if (lastSyncAt && now - lastSyncAt < BROWSING_HISTORY_INTERACTION_URL_SYNC_COOLDOWN_MS) {
      continue;
    }
    browsingHistoryInteractionPendingUrls.add(url);
  }
  if (browsingHistoryInteractionPendingUrls.size === 0) return;
  browsingHistoryInteractionPendingReason = reason || browsingHistoryInteractionPendingReason;

  const runSync = () => {
    browsingHistoryInteractionUrlSyncTimer = null;
    if (browsingHistoryInteractionUrlSyncInFlight) {
      scheduleBrowsingHistoryUrlSyncForInteraction([], browsingHistoryInteractionPendingReason);
      return;
    }

    const pendingUrls = Array.from(browsingHistoryInteractionPendingUrls);
    browsingHistoryInteractionPendingUrls.clear();
    if (pendingUrls.length === 0) return;

    const syncStartedAt = Date.now();
    pendingUrls.forEach(url => browsingHistoryInteractionLastSyncAt.set(url, syncStartedAt));
    browsingHistoryInteractionUrlSyncInFlight = true;
    syncBrowsingHistoryCacheForUrls(pendingUrls, {
      reason: browsingHistoryInteractionPendingReason,
      repairRecommendScores: false
    })
      .catch((error) => {
        console.warn('[Background][HistoryCache] interaction url sync failed:', error);
      })
      .finally(() => {
        browsingHistoryInteractionUrlSyncInFlight = false;
        if (browsingHistoryInteractionPendingUrls.size > 0) {
          scheduleBrowsingHistoryUrlSyncForInteraction([], browsingHistoryInteractionPendingReason);
        }
      });
  };
  try {
    if (browsingHistoryInteractionUrlSyncTimer) {
      clearTimeout(browsingHistoryInteractionUrlSyncTimer);
    }
    browsingHistoryInteractionUrlSyncTimer = setTimeout(runSync, BROWSING_HISTORY_INTERACTION_URL_SYNC_DELAY_MS);
  } catch (_) {
    runSync();
  }
}

async function rebuildBrowsingHistoryCache(reason = 'auto') {
  if (!browserAPI.history || !browserAPI.history.search) return false;

  const now = Date.now();

  // 1. 读取上次同步时间
  const lastSyncTime = await readBrowsingHistoryLastSyncTime();

  // 2. 自动校准从上次成功整段校准的边界继续读取，只给边界预留很小缓冲。
  // 这样一小时前的书签访问不会在下次打开时重复重建 3 天历史。
  // 首次建库、手动校准和无法定位删除范围的场景仍使用 90 天热区。
  const maxAutoLookbackMs = BROWSING_HISTORY_MAX_AUTO_CALIBRATION_LOOKBACK_DAYS * BROWSING_HISTORY_DAY_MS;
  let apiCutoffTime = now - maxAutoLookbackMs;
  const canUseLastSyncBoundary = isAdaptiveBrowsingHistoryCalibrationReason(reason)
    && reason !== 'history-delete-without-url-list';
  if (canUseLastSyncBoundary && lastSyncTime > 0) {
    apiCutoffTime = Math.max(
      now - maxAutoLookbackMs,
      lastSyncTime - BROWSING_HISTORY_SYNC_BOUNDARY_BUFFER_MS
    );
  }

  const lookbackMs = (typeof BROWSING_HISTORY_LOOKBACK_DAYS === 'number' && BROWSING_HISTORY_LOOKBACK_DAYS > 0)
    ? BROWSING_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
    : 0;
  const cutoffTime = lookbackMs ? (now - lookbackMs) : 0;

  // 2. 只向浏览器查询热数据区作为对齐数据
  const effectiveStartTime = Math.max(cutoffTime, apiCutoffTime);
  const effectiveEndTime = now;
  const replaceStartDateKey = getHistoryDateKey(effectiveStartTime);
  const replaceEndDateKey = getHistoryDateKey(effectiveEndTime);

  let historySearchError = '';
  const fetchHistoryBatch = (startTime, endTime) => new Promise((resolve) => {
    try {
      browserAPI.history.search({
        text: '',
        startTime,
        endTime,
        maxResults: BROWSING_HISTORY_SEARCH_PAGE_SIZE
      }, (results) => {
        const err = browserAPI?.runtime?.lastError;
        if (err) {
          historySearchError = err.message || 'history_search_failed';
          resolve([]);
          return;
        }
        resolve(Array.isArray(results) ? results : []);
      });
    } catch (error) {
      historySearchError = error?.message || 'history_search_failed';
      resolve([]);
    }
  });

  const historyItems = [];
  let pageEnd = effectiveEndTime;
  let historySearchHitLimit = false;

  while (pageEnd >= effectiveStartTime) {
    const batch = await fetchHistoryBatch(effectiveStartTime, pageEnd);
    if (historySearchError) {
      console.warn('[Background][HistoryCache] history.search failed, keeping existing cache:', historySearchError);
      return false;
    }
    if (!batch.length) break;

    historyItems.push(...batch);
    if (historyItems.length >= BROWSING_HISTORY_SEARCH_MAX_ITEMS) {
      historyItems.length = BROWSING_HISTORY_SEARCH_MAX_ITEMS;
      historySearchHitLimit = true;
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

  const unknownTimeHistoryItems = [];
  const relevantHistoryItems = [];
  for (const item of historyItems) {
    if (!item || !item.url) continue;
    if (!/^https?:\/\//i.test(String(item.url).trim())) continue;
    const lastVisitTime = getHistoryItemLastVisitTime(item);
    if (!lastVisitTime) {
      unknownTimeHistoryItems.push(item);
      continue;
    }
    if (lastVisitTime >= effectiveStartTime && lastVisitTime <= effectiveEndTime) {
      relevantHistoryItems.push(item);
    }
  }
  relevantHistoryItems.sort((a, b) => getHistoryItemLastVisitTime(b) - getHistoryItemLastVisitTime(a));

  if (!relevantHistoryItems.length && !unknownTimeHistoryItems.length) {
    if (historySearchHitLimit) {
      console.info('[Background][HistoryCache] search hit max items without cacheable history items; keeping existing cache range.');
      return true;
    }
    // 若最近扫描范围内没有匹配到新记录，只替换热区范围，冷数据不动。
    await replaceBrowsingHistoryCacheRange(new Map(), now, replaceStartDateKey, replaceEndDateKey, effectiveStartTime, effectiveEndTime);
    return true;
  }

  const rebuildChunks = createBrowsingHistoryRebuildChunks(effectiveStartTime, effectiveEndTime);
  if (!rebuildChunks.length) return false;

  const chunkRecordsMap = new Map();
  const visitKeySet = new Set();
  const hasVisitDetails = browserAPI.history && typeof browserAPI.history.getVisits === 'function';

  const getVisitsAsync = (item) => new Promise((resolve) => {
    try {
      browserAPI.history.getVisits({ url: item.url }, (visits) => resolve(visits || []));
    } catch (_) {
      resolve([]);
    }
  });

  const processHistoryItem = async (item) => {
    if (!item || !item.url) return;
    const fallbackTime = getHistoryItemLastVisitTime(item);

    if (shouldUseSingleVisitFastPath(item, effectiveStartTime, effectiveEndTime)) {
      addVisitRecordToRebuildChunks(chunkRecordsMap, rebuildChunks, visitKeySet, item, fallbackTime, {
        count: 1,
        id: `${item.id || item.url}-${fallbackTime}-single`
      });
      return;
    }

    if (!hasVisitDetails) {
      if (!fallbackTime) return;
      addVisitRecordToRebuildChunks(chunkRecordsMap, rebuildChunks, visitKeySet, item, fallbackTime, {
        count: Math.max(getHistoryItemVisitCount(item) || 1, 1),
        aggregated: true,
        id: item.id || item.url
      });
      return;
    }

    const visits = await getVisitsAsync(item);
    let inserted = 0;

    if (Array.isArray(visits) && visits.length) {
      for (const visit of visits) {
        const visitTime = typeof visit.visitTime === 'number' ? visit.visitTime : 0;
        if (!visitTime) continue;
        if (addVisitRecordToRebuildChunks(chunkRecordsMap, rebuildChunks, visitKeySet, item, visitTime, {
          id: `${item.id || item.url}-${visit.visitId || visitTime}-${inserted}`,
          transition: visit.transition || '',
          referringVisitId: visit.referringVisitId || null,
          count: 1
        })) {
          inserted += 1;
        }
        if (BROWSING_HISTORY_MAX_VISITS_PER_URL && inserted >= BROWSING_HISTORY_MAX_VISITS_PER_URL) {
          break;
        }
      }
    }

    if (inserted === 0 && fallbackTime) {
      addVisitRecordToRebuildChunks(chunkRecordsMap, rebuildChunks, visitKeySet, item, fallbackTime, {
        count: Math.max(getHistoryItemVisitCount(item) || 1, 1),
        aggregated: true,
        id: item.id || item.url
      });
    }
  };

  const processHistoryItems = async (items = []) => {
    if (!Array.isArray(items) || items.length === 0) return;
    const concurrency = Math.max(1, Math.min(8, items.length));
    let cursor = 0;

    const processNext = async () => {
      while (cursor < items.length) {
        const currentIndex = cursor++;
        await processHistoryItem(items[currentIndex]);

        if (cursor % 100 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => processNext()));
  };

  const flushRebuildChunk = async (chunkIndex) => {
    const chunk = rebuildChunks[chunkIndex];
    if (!chunk) return true;
    const normalizedRecordsMap = normalizeBrowsingHistoryRecordsMap(chunkRecordsMap.get(chunkIndex) || new Map());
    chunkRecordsMap.delete(chunkIndex);

    if (historySearchHitLimit) {
      if (normalizedRecordsMap.size === 0) return true;
      return await mergeBrowsingHistoryCacheRecordsMap(normalizedRecordsMap, now);
    }

    return await replaceBrowsingHistoryCacheRange(
      normalizedRecordsMap,
      now,
      chunk.startDateKey,
      chunk.endDateKey,
      chunk.startTime,
      chunk.endTime,
      'partial'
    );
  };

  await processHistoryItems(unknownTimeHistoryItems);

  let itemCursor = 0;
  for (let chunkIndex = 0; chunkIndex < rebuildChunks.length; chunkIndex += 1) {
    const chunk = rebuildChunks[chunkIndex];
    const chunkItems = [];
    while (
      itemCursor < relevantHistoryItems.length
      && getHistoryItemLastVisitTime(relevantHistoryItems[itemCursor]) >= chunk.startTime
    ) {
      chunkItems.push(relevantHistoryItems[itemCursor]);
      itemCursor += 1;
    }

    await processHistoryItems(chunkItems);
    const chunkOk = await flushRebuildChunk(chunkIndex);
    if (!chunkOk) return false;
  }

  if (!historySearchHitLimit) {
    return await markBrowsingHistoryFullSyncComplete(now);
  }

  return true;
}

async function runBrowsingHistoryCalibration({ reason = 'auto', clearOnly = false, requireIdle = false, skipLibrarySeedCheck = false } = {}) {
  if (!skipLibrarySeedCheck && !clearOnly) {
    const seedResult = await ensureBrowsingHistoryLibrarySeeded({ reason: `${reason}-preflight` });
    if (seedResult?.seeded === true) return seedResult.success === true;
    if (seedResult?.success === false) return false;
  }

  if (browsingCalibrationInProgress) return false;

  if (requireIdle) {
    const idleState = await queryIdleStateForBookmarkMutationFlush();
    if (idleState === 'active') {
      await scheduleHistoryBackgroundSyncRetry(`${reason}-active`);
      return false;
    }
  }

  const calibrationStartedAt = Date.now();
  browsingCalibrationInProgress = true;
  try {
    if (clearOnly) {
      await resetBrowsingHistoryCache(Date.now());
      await clearBrowsingHistoryOpenRefreshDirtyIfUnchanged(calibrationStartedAt, `cleared:${reason}`);
      queueRecommendScoresCacheRepair(`history-calibration:${reason}`);
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
      await clearBrowsingHistoryOpenRefreshDirtyIfUnchanged(calibrationStartedAt, `calibrated:${reason}`);
      queueRecommendScoresCacheRepair(`history-calibration:${reason}`);
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

async function recordInteractionForCalibration(payload = {}) {
  const { type = 'open', increment = 1, source = 'ui' } = payload || {};
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

  const urls = normalizeBrowsingInteractionUrls(payload);
  if (urls.length) {
    scheduleBrowsingHistoryUrlSyncForInteraction(urls, `${source || 'ui'}-interaction-url-sync`);
  }

  await maybeRunBrowsingHistoryCalibration({ settings, nextState, reason: source });
  await saveBrowsingCalibrationState(nextState);
}

function notifyBrowsingHistoryCacheChanged(reason = 'history-cache-updated', clearOnly = false, options = {}) {
  const repairRecommendScores = options?.repairRecommendScores !== false;
  try {
    if (!clearOnly && repairRecommendScores) {
      queueRecommendScoresCacheRepair(`history-cache:${reason || 'updated'}`);
    }
  } catch (_) { }

  try {
    const maybePromise = browserAPI.runtime.sendMessage({
      action: 'browsingCalibrationCompleted',
      payload: { reason, clearOnly, repairRecommendScores }
    });
    if (maybePromise && typeof maybePromise.catch === 'function') {
      maybePromise.catch(() => {});
    }
  } catch (_) { }
}

async function handleBrowsingHistoryVisitRemoved(details = {}) {
  const urls = Array.isArray(details?.urls) ? details.urls.filter(Boolean) : [];
  const allHistory = !!details?.allHistory;
  let immediateCalibrationSucceeded = false;

  await markBrowsingHistoryOpenRefreshDirty('history-visit-removed');

  if (!allHistory && urls.length > 0) {
    const partialDeleteCutoff = getBrowsingHistoryPartialDeleteCutoff();
    const result = await removeBrowsingHistoryCacheUrls(urls, partialDeleteCutoff);
    if (result?.success && result.deletedCount > 0) {
      notifyBrowsingHistoryCacheChanged('history-url-removed', false);
    }
  } else if (!allHistory && urls.length === 0) {
    immediateCalibrationSucceeded = await runBrowsingHistoryCalibration({ reason: 'history-delete-without-url-list', requireIdle: true }) === true;
  }

  if (immediateCalibrationSucceeded) {
    const state = await getBrowsingCalibrationState();
    await saveBrowsingCalibrationState({
      ...state,
      pendingDeleteCount: 0,
      pendingOpenCount: 0,
      lastCalibrationTime: Date.now(),
      lastDeletionTime: Date.now()
    });
    return;
  }

  await recordDeletionForCalibration({
    source: 'history',
    allHistory,
    urlCount: urls.length,
    hasUrlList: urls.length > 0
  });
}

if (browserAPI.history && browserAPI.history.onVisitRemoved) {
  browserAPI.history.onVisitRemoved.addListener((details) => {
    handleBrowsingHistoryVisitRemoved(details).catch((error) => {
      console.warn('[Background][HistoryCache] handle visit removed failed:', error);
    });
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
let reviewReminderPopupInProgress = false;
let activeReviewReminderPopup = null;
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
const BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY = 'bb_recommend_bulk_task_checkpoint_v1';
const BOOKMARK_MUTATION_QUEUE_SAVE_DEBOUNCE_MS = 900;
const BOOKMARK_MUTATION_QUEUE_MAX_ITEMS = 6000;
const BOOKMARK_BULK_CHANGE_FLAG_KEY = 'bookmarkBulkChangeFlag';
const BOOKMARK_BULK_CHANGE_META_KEY = 'bookmarkBulkChangeMeta';
const BOOKMARK_BULK_CHANGE_STALE_MAX_MS = 2 * 60 * 60 * 1000;

const SCORE_ALGO_VERSION_KEY = 'recommend_scores_algo_version';
const SCORE_ALGO_VERSION = 6.4;

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
const SCORE_CACHE_HEALTH_MIN_VALID_RATIO = 0.95;
const SCORE_CACHE_HEALTH_MIN_METADATA_RATIO = 0.65;
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
const RECOMMEND_BLOCKED_DOMAIN_MODE_BASE = 'base';
const RECOMMEND_BLOCKED_DOMAIN_MODE_EXACT = 'exact';
const RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX = 'base:';
const RECOMMEND_POSTPONED_STORAGE_KEY = 'recommend_postponed';
const RECOMMEND_POSTPONED_VERSION_STORAGE_KEY = 'recommend_postponed_version_v1';
const RECOMMEND_STATE_MUTATION_CHANNEL = 'recommend_state_mutation_v1';
const RECOMMEND_REFRESH_SETTINGS_STORAGE_KEY = 'recommendRefreshSettings';
const RECOMMEND_REVIEW_REMINDER_ENABLED_STORAGE_KEY = 'recommendReviewReminderPopupEnabled';
const RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY = 'recommendReviewReminderNotified';
const RECOMMEND_REVIEW_REMINDER_ALARM = 'bb_recommend_review_reminder_v1';
const RECOMMEND_REVIEW_REMINDER_POPUP_PATH = 'review_reminder/review_reminder_popup.html';
const RECOMMEND_REVIEW_REMINDER_POPUP_WIDTH = 720;
const RECOMMEND_REVIEW_REMINDER_POPUP_MIN_HEIGHT = 420;
const RECOMMEND_REVIEW_REMINDER_POPUP_MAX_HEIGHT = 780;
const RECOMMEND_REVIEW_REMINDER_POPUP_BASE_HEIGHT = 250;
const RECOMMEND_REVIEW_REMINDER_POPUP_ROW_HEIGHT = 160;
const RECOMMEND_REVIEW_REMINDER_MAX_ITEMS = 12;
const RECOMMEND_REVIEW_REMINDER_OVERDUE_DELAY_MS = 5 * 1000;
const RECOMMEND_REVIEW_REMINDER_POPUP_RETRY_DELAY_MS = 60 * 1000;
const RECOMMEND_REVIEW_REMINDER_BATCH_HOUR_MS = 60 * 60 * 1000;
const RECOMMEND_REVIEW_REMINDER_PRESET_DELAYS = {
  '1h': 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000
};
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
scheduleReviewReminderAlarm().catch(() => {});
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

function normalizeRecommendStateVersion(value) {
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : 0;
}

function normalizeRecommendExpectedStateVersion(value) {
  if (value == null || value === '') return null;
  const version = Number(value);
  if (!Number.isFinite(version) || version < 0) return null;
  return Math.floor(version);
}

function buildNextRecommendStateVersion(currentVersion = 0, now = Date.now()) {
  return Math.max(now, normalizeRecommendStateVersion(currentVersion) + 1);
}

function buildRecommendStateVersionMismatchResponse(kind, currentVersion, reason = 'stale_recommend_state') {
  return {
    success: false,
    stale: true,
    reason,
    state: String(kind || 'recommend'),
    version: normalizeRecommendStateVersion(currentVersion)
  };
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

async function getRecommendPostponedStateSnapshot() {
  try {
    const result = await browserAPI.storage.local.get([
      RECOMMEND_POSTPONED_STORAGE_KEY,
      RECOMMEND_POSTPONED_VERSION_STORAGE_KEY
    ]);
    return {
      postponed: normalizeRecommendPostponedList(result?.[RECOMMEND_POSTPONED_STORAGE_KEY]),
      version: normalizeRecommendStateVersion(result?.[RECOMMEND_POSTPONED_VERSION_STORAGE_KEY])
    };
  } catch (_) {
    return {
      postponed: normalizeRecommendPostponedList(null),
      version: 0
    };
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
      .map(item => normalizeBlockedDomainEntry(item))
      .filter(Boolean)
  ));

  return {
    bookmarks: normalizeIdList(source.bookmarks),
    folders: normalizeIdList(source.folders),
    domains: normalizeDomainList(source.domains),
    version: normalizeRecommendStateVersion(source.version || source.stateVersion)
  };
}

function normalizeBlockedDomainEntry(entry, options = {}) {
  const modeHint = String(options?.mode || '').trim().toLowerCase();
  const toBaseEntry = (value) => {
    return buildBlockedDomainBaseEntry(value);
  };
  const toExactEntry = (value) => normalizeRecommendDomainHost(value);

  if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
    const mode = String(entry?.matchMode || entry?.mode || modeHint || RECOMMEND_BLOCKED_DOMAIN_MODE_EXACT).trim().toLowerCase();
    const raw = String(entry?.domain || entry?.host || entry?.value || '').trim();
    if (!raw) return '';
    return mode === RECOMMEND_BLOCKED_DOMAIN_MODE_BASE
      ? toBaseEntry(raw)
      : toExactEntry(raw);
  }

  const raw = String(entry || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith(RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX)) {
    return toBaseEntry(raw.slice(RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX.length));
  }
  if (modeHint === RECOMMEND_BLOCKED_DOMAIN_MODE_BASE) {
    return toBaseEntry(raw);
  }
  return toExactEntry(raw);
}

function parseBlockedDomainEntry(entry) {
  const normalized = normalizeBlockedDomainEntry(entry);
  if (!normalized) return null;

  if (normalized.startsWith(RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX)) {
    const baseDomain = normalizeRecommendDomainHost(normalized.slice(RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX.length));
    if (!baseDomain) return null;
    return {
      entry: `${RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX}${baseDomain}`,
      mode: RECOMMEND_BLOCKED_DOMAIN_MODE_BASE,
      baseDomain,
      exactDomain: '',
      displayDomain: baseDomain
    };
  }

  const exactDomain = normalizeRecommendDomainHost(normalized);
  if (!exactDomain) return null;
  return {
    entry: exactDomain,
    mode: RECOMMEND_BLOCKED_DOMAIN_MODE_EXACT,
    baseDomain: getRecommendBaseDomainFromHost(exactDomain),
    exactDomain,
    displayDomain: exactDomain
  };
}

function buildBlockedDomainMatchers(domains = []) {
  const exact = new Set();
  const base = new Set();
  for (const entry of Array.isArray(domains) ? domains : []) {
    const parsed = parseBlockedDomainEntry(entry);
    if (!parsed) continue;
    if (parsed.mode === RECOMMEND_BLOCKED_DOMAIN_MODE_BASE) {
      base.add(parsed.baseDomain);
    } else if (parsed.exactDomain) {
      exact.add(parsed.exactDomain);
    }
  }
  return {
    exact,
    base,
    hasRules: exact.size > 0 || base.size > 0
  };
}

function isHostnameBlockedByDomainMatchers(hostname, domainMatchers) {
  if (!domainMatchers || domainMatchers.hasRules !== true) return false;
  const safeHost = normalizeRecommendDomainHost(hostname);
  if (!safeHost) return false;
  if (domainMatchers.exact?.has(safeHost)) return true;
  const baseDomain = getRecommendBaseDomainFromHost(safeHost);
  return Boolean(baseDomain && domainMatchers.base?.has(baseDomain));
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

function buildReviewReminderNotificationKey(item) {
  const bookmarkId = String(item?.bookmarkId || '').trim();
  const postponeUntil = Math.max(0, Math.floor(Number(item?.postponeUntil || 0)));
  return bookmarkId && postponeUntil > 0 ? `${bookmarkId}:${postponeUntil}` : '';
}

function normalizeReviewReminderPresetKey(value, delayMs = null) {
  const key = String(value || '').trim();
  if (Object.prototype.hasOwnProperty.call(RECOMMEND_REVIEW_REMINDER_PRESET_DELAYS, key)) {
    return key;
  }

  const delay = Math.floor(Number(delayMs || 0));
  for (const [presetKey, presetDelay] of Object.entries(RECOMMEND_REVIEW_REMINDER_PRESET_DELAYS)) {
    if (delay === presetDelay) return presetKey;
  }
  return '';
}

function getReviewReminderBatchHour(postponeUntil) {
  const time = Number(postponeUntil || 0);
  if (!Number.isFinite(time) || time <= 0) return 0;
  return Math.floor(time / RECOMMEND_REVIEW_REMINDER_BATCH_HOUR_MS);
}

function buildReviewReminderPresetBatchKey(item) {
  const presetKey = normalizeReviewReminderPresetKey(item?.postponePresetKey);
  const batchHour = Math.floor(Number(item?.reminderBatchHour || 0));
  if (!presetKey || !Number.isFinite(batchHour) || batchHour <= 0) return '';
  return `preset:${batchHour}`;
}

function normalizeReviewReminderNotifiedState(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {};
  for (const [key, notifiedAt] of Object.entries(source)) {
    const normalizedKey = String(key || '').trim();
    const time = Number(notifiedAt || 0);
    if (!normalizedKey || !Number.isFinite(time) || time <= 0) continue;
    result[normalizedKey] = Math.floor(time);
  }
  return result;
}

function normalizeReviewReminderKeys(keys = [], singleKey = '') {
  const merged = [];
  if (Array.isArray(keys)) {
    merged.push(...keys);
  } else {
    merged.push(keys);
  }
  if (singleKey != null && singleKey !== '') {
    merged.push(singleKey);
  }
  return Array.from(new Set(
    merged
      .map(key => String(key || '').trim())
      .filter(Boolean)
  ));
}

function getReviewReminderPopupHeight(itemCount = 0) {
  const safeCount = Math.max(1, Number(itemCount) || 0);
  const rows = Math.max(1, Math.ceil(safeCount / 4));
  const rawHeight = RECOMMEND_REVIEW_REMINDER_POPUP_BASE_HEIGHT
    + rows * RECOMMEND_REVIEW_REMINDER_POPUP_ROW_HEIGHT;
  return Math.max(
    RECOMMEND_REVIEW_REMINDER_POPUP_MIN_HEIGHT,
    Math.min(RECOMMEND_REVIEW_REMINDER_POPUP_MAX_HEIGHT, rawHeight)
  );
}

async function getReviewReminderPopupEnabledState() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_REVIEW_REMINDER_ENABLED_STORAGE_KEY]);
    return result?.[RECOMMEND_REVIEW_REMINDER_ENABLED_STORAGE_KEY] !== false;
  } catch (_) {
    return true;
  }
}

function isReviewReminderCandidate(item, now = Date.now()) {
  if (!item || item.manuallyAdded === true) return false;
  const bookmarkId = String(item.bookmarkId || '').trim();
  const postponeUntil = Number(item.postponeUntil || 0);
  return Boolean(bookmarkId) && Number.isFinite(postponeUntil) && postponeUntil > 0 && postponeUntil <= now;
}

async function getReviewReminderCandidates(options = {}) {
  const now = Number(options.now || Date.now());
  const batchKeys = new Set(
    Array.isArray(options.batchKeys)
      ? options.batchKeys.map(key => String(key || '').trim()).filter(Boolean)
      : []
  );
  const onlyKeys = new Set(
    Array.isArray(options.keys)
      ? options.keys.map(key => String(key || '').trim()).filter(Boolean)
      : []
  );
  const [postponed, notifiedResult] = await Promise.all([
    getRecommendPostponedList(),
    browserAPI.storage.local.get([RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY])
  ]);
  const notified = normalizeReviewReminderNotifiedState(
    notifiedResult?.[RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY]
  );
  const candidates = [];

  for (const item of normalizeRecommendPostponedList(postponed)) {
    const key = buildReviewReminderNotificationKey(item);
    if (!key) continue;
    const isDue = isReviewReminderCandidate(item, now);
    const isRequestedKey = onlyKeys.size > 0 && onlyKeys.has(key);
    const isSamePresetBatch = batchKeys.size > 0 && batchKeys.has(buildReviewReminderPresetBatchKey(item));
    if (!isDue && !isRequestedKey && !isSamePresetBatch) continue;
    if (onlyKeys.size > 0 && !onlyKeys.has(key)) continue;
    if (options.onlyUnnotified === true && notified[key]) continue;
    candidates.push({ ...item, reminderKey: key });
  }

  candidates.sort((a, b) => Number(a.postponeUntil || 0) - Number(b.postponeUntil || 0));
  return {
    candidates: candidates.slice(0, Math.max(1, Number(options.limit) || RECOMMEND_REVIEW_REMINDER_MAX_ITEMS)),
    notified
  };
}

async function buildReviewReminderPopupItems(candidates = []) {
  const items = [];
  let scoreCache = {};
  let historyStats = new Map();
  let formulaConfig = null;
  let trackingData = null;
  let postponedList = [];
  let reviewData = {};
  try {
    const [scores, history, config, tracking, postponed, review] = await Promise.all([
      getScoresCache(),
      getHistoryStatsForScoreDebug(),
      getFormulaConfig(),
      getTrackingDataForScore(),
      getPostponedBookmarksForScore(),
      getReviewDataForScore()
    ]);
    scoreCache = scores;
    historyStats = history;
    formulaConfig = config;
    trackingData = tracking;
    postponedList = Array.isArray(postponed) ? postponed : [];
    reviewData = review && typeof review === 'object' ? review : {};
  } catch (_) {
    scoreCache = {};
    historyStats = new Map();
    formulaConfig = {
      weights: {
        freshness: 0.15,
        coldness: 0.15,
        shallowRead: 0.30,
        forgetting: 0.20,
        laterReview: 0.20
      },
      thresholds: {
        freshness: 7,
        coldness: 5,
        shallowRead: 30,
        forgetting: 7
      },
      trackingEnabled: true
    };
    trackingData = { byUrl: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
    postponedList = [];
    reviewData = {};
  }

  for (const candidate of candidates) {
    const bookmark = await getBookmarkNodeByIdForScore(candidate.bookmarkId);
    if (!bookmark?.url) continue;
    const bookmarkForScore = {
      id: String(candidate.bookmarkId || '').trim(),
      title: bookmark.title || bookmark.url || '',
      url: bookmark.url || '',
      dateAdded: Number(bookmark.dateAdded || 0),
      parentId: bookmark.parentId || ''
    };
    const cached = scoreCache && typeof scoreCache === 'object'
      ? scoreCache[String(candidate.bookmarkId || '').trim()]
      : null;
    const priority = Number(cached?.S);
    const computed = Number.isFinite(priority)
      ? priority
      : Number(calculateBookmarkScore(
        bookmarkForScore,
        historyStats,
        trackingData,
        formulaConfig,
        postponedList,
        reviewData
      )?.S);
    items.push({
      reminderKey: candidate.reminderKey || buildReviewReminderNotificationKey(candidate),
      bookmarkId: String(candidate.bookmarkId || '').trim(),
      title: bookmark.title || bookmark.url || '',
      url: bookmark.url || '',
      postponeUntil: Number(candidate.postponeUntil || 0),
      groupName: candidate.groupName || '',
      priority: Number.isFinite(priority) ? priority : (Number.isFinite(computed) ? computed : null)
    });
  }
  return items;
}

async function markReviewReminderNotified(keys = []) {
  const normalizedKeys = Array.from(new Set(
    (Array.isArray(keys) ? keys : [])
      .map(key => String(key || '').trim())
      .filter(Boolean)
  ));
  if (normalizedKeys.length === 0) return;

  const [postponed, result] = await Promise.all([
    getRecommendPostponedList(),
    browserAPI.storage.local.get([RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY])
  ]);
  const activeKeys = new Set(
    normalizeRecommendPostponedList(postponed)
      .map(item => buildReviewReminderNotificationKey(item))
      .filter(Boolean)
  );
  const notified = normalizeReviewReminderNotifiedState(
    result?.[RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY]
  );
  const now = Date.now();

  for (const key of Object.keys(notified)) {
    if (!activeKeys.has(key)) delete notified[key];
  }
  for (const key of normalizedKeys) {
    if (!activeKeys.has(key)) continue;
    notified[key] = now;
  }

  await browserAPI.storage.local.set({
    [RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY]: notified
  });
}

async function isReviewReminderPopupWindowOpen() {
  if (!browserAPI?.windows?.getAll || !browserAPI?.runtime?.getURL) return false;
  const popupUrlPrefix = browserAPI.runtime.getURL(RECOMMEND_REVIEW_REMINDER_POPUP_PATH);
  return new Promise((resolve) => {
    try {
      browserAPI.windows.getAll({ populate: true, windowTypes: ['popup'] }, (windowsList) => {
        if (browserAPI.runtime?.lastError) {
          resolve(false);
          return;
        }
        const windows = Array.isArray(windowsList) ? windowsList : [];
        const hasOpenPopup = windows.some((win) => {
          if (!Array.isArray(win?.tabs) || win.tabs.length === 0) return false;
          return win.tabs.some(tab => String(tab?.url || '').startsWith(popupUrlPrefix));
        });
        resolve(hasOpenPopup);
      });
    } catch (_) {
      resolve(false);
    }
  });
}

function registerActiveReviewReminderPopup(windowInfo, items = []) {
  const windowId = Number(windowInfo?.id);
  if (!Number.isFinite(windowId)) return;
  const pendingItems = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const bookmarkId = String(item?.bookmarkId || '').trim();
    if (!bookmarkId) continue;
    pendingItems.set(bookmarkId, {
      bookmarkId,
      keys: normalizeReviewReminderKeys(item?.reminderKey),
      title: item?.title || '',
      url: item?.url || ''
    });
  }
  activeReviewReminderPopup = {
    windowId,
    pendingItems,
    createdAt: Date.now()
  };
}

function clearActiveReviewReminderPopupItem(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id || !activeReviewReminderPopup?.pendingItems) return;
  activeReviewReminderPopup.pendingItems.delete(id);
}

function clearActiveReviewReminderPopup() {
  activeReviewReminderPopup = null;
}

async function skipActiveReviewReminderPopupOnClose(windowId) {
  const normalizedWindowId = Number(windowId);
  const popup = activeReviewReminderPopup;
  if (!popup || Number(popup.windowId) !== normalizedWindowId) return;

  const pendingItems = Array.from(popup.pendingItems?.values?.() || []);
  clearActiveReviewReminderPopup();
  if (pendingItems.length === 0) {
    await scheduleReviewReminderAlarm();
    return;
  }

  for (const item of pendingItems) {
    try {
      const result = await executeRecommendCardActionFromReminderPopup('skip', item.bookmarkId, {
        timestamp: Date.now(),
        source: 'review_reminder_popup_window_close'
      });
      if (result?.success !== false && Array.isArray(item.keys) && item.keys.length > 0) {
        await markReviewReminderNotified(item.keys);
      }
    } catch (error) {
      console.warn('[待复习提醒] 关闭弹窗时跳过失败:', error);
    }
  }
  await scheduleReviewReminderAlarm();
}

if (browserAPI?.windows?.onRemoved?.addListener) {
  browserAPI.windows.onRemoved.addListener((windowId) => {
    skipActiveReviewReminderPopupOnClose(windowId).catch((error) => {
      console.warn('[待复习提醒] 处理弹窗关闭失败:', error);
    });
  });
}

async function executeRecommendCardActionFromReminderPopup(actionType, bookmarkId, options = {}) {
  const normalizedAction = String(actionType || '').trim();
  const normalizedBookmarkId = String(bookmarkId || '').trim();
  if (!normalizedAction || !normalizedBookmarkId) {
    return { success: false, reason: 'invalid_action' };
  }

  const message = {
    recommendAction: normalizedAction,
    bookmarkId: normalizedBookmarkId,
    expectedVersion: options.expectedVersion,
    source: options.source || 'review_reminder_popup',
    delayMs: options.delayMs,
    postponeUntil: options.postponeUntil,
    postponePresetKey: options.postponePresetKey,
    scope: options.scope,
    timestamp: Number(options.timestamp || Date.now())
  };

  let result = await executeRecommendCardActionState(message);
  if (result?.success === false && result?.reason === 'missing_current_cards_version') {
    const currentCards = await getHistoryCurrentCardsStateForAction();
    const currentIds = new Set(normalizeBookmarkIdList(currentCards?.cardIds || []));
    const currentVersion = Number(currentCards?.version || 0);
    if (currentIds.has(normalizedBookmarkId) && Number.isFinite(currentVersion) && currentVersion > 0) {
      result = await executeRecommendCardActionState({
        ...message,
        expectedVersion: Math.floor(currentVersion)
      });
    }
  }

  return result;
}

async function markPostponedBookmarkReviewedFromOpen(bookmarkId, options = {}) {
  const normalizedBookmarkId = String(bookmarkId || '').trim();
  if (!normalizedBookmarkId) {
    return { success: false, reviewed: false, reason: 'invalid_bookmark_id' };
  }

  const postponed = normalizeRecommendPostponedList(await getRecommendPostponedList());
  const target = postponed.find((item) => String(item?.bookmarkId || '').trim() === normalizedBookmarkId);
  if (!target) {
    return { success: true, reviewed: false, reason: 'bookmark_not_postponed' };
  }
  if (!isReviewReminderCandidate(target, Number(options.timestamp || Date.now()))) {
    return { success: true, reviewed: false, reason: 'bookmark_not_due' };
  }

  const result = await executeRecommendCardActionFromReminderPopup('review', normalizedBookmarkId, {
    timestamp: Number(options.timestamp || Date.now()),
    source: options.source || 'bookmark_open_auto_review'
  });

  if (result?.success === false) {
    return {
      success: false,
      reviewed: false,
      reason: result?.reason || 'review_action_failed',
      result
    };
  }

  clearActiveReviewReminderPopupItem(normalizedBookmarkId);
  await scheduleReviewReminderAlarm();
  return { success: true, reviewed: true, reason: 'reviewed', result };
}

async function findBookmarkIdsByUrl(url = '') {
  const safeUrl = String(url || '').trim();
  if (!safeUrl || !browserAPI?.bookmarks?.search) return [];
  try {
    const matches = await browserAPI.bookmarks.search({ url: safeUrl });
    return normalizeBookmarkIdList(
      (Array.isArray(matches) ? matches : []).map(item => item?.id)
    );
  } catch (_) {
    return [];
  }
}

async function markPostponedBookmarkReviewedFromOpenContext(options = {}) {
  const normalizedBookmarkId = String(options.bookmarkId || '').trim();
  const safeUrl = String(options.url || '').trim();
  const timestamp = Number(options.timestamp || Date.now());
  const source = options.source || 'bookmark_open_auto_review';
  const candidates = normalizedBookmarkId
    ? [normalizedBookmarkId]
    : await findBookmarkIdsByUrl(safeUrl);

  if (candidates.length === 0) {
    return { success: true, reviewed: false, reason: 'bookmark_not_found' };
  }

  for (const candidateId of candidates) {
    const reviewResult = await markPostponedBookmarkReviewedFromOpen(candidateId, {
      timestamp,
      source
    });
    if (reviewResult?.success === false) {
      return reviewResult;
    }
    if (reviewResult?.reviewed === true) {
      return reviewResult;
    }
  }

  return { success: true, reviewed: false, reason: 'bookmark_not_due' };
}

async function scheduleReviewReminderAlarm(options = {}) {
  if (!browserAPI?.alarms?.create || !browserAPI?.alarms?.clear) {
    return { success: false, skipped: 'alarms-api-unavailable' };
  }

  const enabled = await getReviewReminderPopupEnabledState();
  if (!enabled) {
    await new Promise(resolve => browserAPI.alarms.clear(RECOMMEND_REVIEW_REMINDER_ALARM, () => resolve()));
    return { success: true, enabled: false, cleared: true };
  }

  const popupOpen = options.skipPopupOpenCheck === true
    ? false
    : await isReviewReminderPopupWindowOpen();

  const [postponedRaw, notifiedResult] = await Promise.all([
    getRecommendPostponedList(),
    browserAPI.storage.local.get([RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY])
  ]);
  const postponed = normalizeRecommendPostponedList(postponedRaw);
  const notified = normalizeReviewReminderNotifiedState(
    notifiedResult?.[RECOMMEND_REVIEW_REMINDER_NOTIFIED_STORAGE_KEY]
  );
  const now = Date.now();
  let nextDueAt = 0;
  for (const item of postponed) {
    if (!item || item.manuallyAdded === true) continue;
    const postponeUntil = Number(item.postponeUntil || 0);
    if (!Number.isFinite(postponeUntil) || postponeUntil <= 0) continue;
    const key = buildReviewReminderNotificationKey(item);
    if (key && notified[key]) continue;
    if (postponeUntil <= now) {
      nextDueAt = now + RECOMMEND_REVIEW_REMINDER_OVERDUE_DELAY_MS;
      break;
    }
    if (!nextDueAt || postponeUntil < nextDueAt) nextDueAt = postponeUntil;
  }

  if (!nextDueAt) {
    await new Promise(resolve => browserAPI.alarms.clear(RECOMMEND_REVIEW_REMINDER_ALARM, () => resolve()));
    return { success: true, enabled: true, scheduled: false };
  }

  if (popupOpen) {
    const when = now + RECOMMEND_REVIEW_REMINDER_POPUP_RETRY_DELAY_MS;
    browserAPI.alarms.create(RECOMMEND_REVIEW_REMINDER_ALARM, { when });
    return { success: true, enabled: true, scheduled: true, when, reason: 'popup_open_retry' };
  }

  browserAPI.alarms.create(RECOMMEND_REVIEW_REMINDER_ALARM, {
    when: Math.max(nextDueAt, now + 1000)
  });
  return { success: true, enabled: true, scheduled: true, when: nextDueAt };
}

async function showReviewReminderPopupIfDue(reason = 'alarm') {
  if (reviewReminderPopupInProgress) {
    return { success: true, skipped: 'in-progress' };
  }
  reviewReminderPopupInProgress = true;
  try {
    if (!await getReviewReminderPopupEnabledState()) {
      await scheduleReviewReminderAlarm();
      return { success: false, skipped: 'disabled' };
    }

    if (await isReviewReminderPopupWindowOpen()) {
      await scheduleReviewReminderAlarm();
      return { success: true, shown: false, reason: 'popup_already_open' };
    }

    const dueResult = await getReviewReminderCandidates({ onlyUnnotified: true });
    const firstDueCandidate = Array.isArray(dueResult.candidates) ? dueResult.candidates[0] : null;
    const firstBatchKey = buildReviewReminderPresetBatchKey(firstDueCandidate);
    const { candidates } = firstBatchKey
      ? await getReviewReminderCandidates({ onlyUnnotified: true, batchKeys: [firstBatchKey] })
      : dueResult;
    const items = await buildReviewReminderPopupItems(candidates);
    if (items.length === 0) {
      await scheduleReviewReminderAlarm();
      return { success: true, shown: false, reason: 'no_due_items' };
    }

    const keys = items.map(item => item.reminderKey).filter(Boolean);
    const popupHeight = getReviewReminderPopupHeight(items.length);
    const params = new URLSearchParams();
    params.set('keys', keys.join(','));
    params.set('reason', reason || 'alarm');
    const url = browserAPI.runtime.getURL(`${RECOMMEND_REVIEW_REMINDER_POPUP_PATH}?${params.toString()}`);

    const windowInfo = await new Promise((resolve, reject) => {
      try {
        browserAPI.windows.create({
          url,
          type: 'popup',
          width: RECOMMEND_REVIEW_REMINDER_POPUP_WIDTH,
          height: popupHeight,
          focused: true
        }, (windowInfo) => {
          const err = browserAPI?.runtime?.lastError;
          if (err) {
            reject(new Error(err.message || 'windows_create_failed'));
            return;
          }
          resolve(windowInfo);
        });
      } catch (error) {
        reject(error);
      }
    });
    registerActiveReviewReminderPopup(windowInfo, items);

    await scheduleReviewReminderAlarm();
    return { success: true, shown: true, count: items.length };
  } finally {
    reviewReminderPopupInProgress = false;
  }
}

async function getReviewReminderPopupPayload(keys = []) {
  const normalizedKeys = (Array.isArray(keys) ? keys : [])
    .map(key => String(key || '').trim())
    .filter(Boolean);
  const { candidates } = await getReviewReminderCandidates({
    keys: normalizedKeys,
    onlyUnnotified: false,
    limit: RECOMMEND_REVIEW_REMINDER_MAX_ITEMS
  });
  const allItems = await buildReviewReminderPopupItems(candidates);
  const items = allItems.slice(0, RECOMMEND_REVIEW_REMINDER_MAX_ITEMS);
  const hasMore = false;
  return {
    success: true,
    items,
    totalCount: items.length,
    hasMore
  };
}

async function getRecommendBlockedState() {
  try {
    const result = await browserAPI.storage.local.get([RECOMMEND_BLOCKED_STORAGE_KEY]);
    return normalizeRecommendBlockedState(result?.[RECOMMEND_BLOCKED_STORAGE_KEY]);
  } catch (_) {
    return normalizeRecommendBlockedState(null);
  }
}

async function setRecommendBlockedState(blocked, options = {}) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const current = await getRecommendBlockedState();
    const expectedVersion = normalizeRecommendExpectedStateVersion(
      options.expectedVersion ?? blocked?.version ?? blocked?.stateVersion
    );
    if (expectedVersion == null) {
      return buildRecommendStateVersionMismatchResponse('blocked', current.version, 'missing_recommend_state_version');
    }
    if (expectedVersion !== normalizeRecommendStateVersion(current.version)) {
      return buildRecommendStateVersionMismatchResponse('blocked', current.version);
    }

    const next = normalizeRecommendBlockedState(blocked);
    next.version = buildNextRecommendStateVersion(current.version);
    await browserAPI.storage.local.set({
      [RECOMMEND_BLOCKED_STORAGE_KEY]: next
    });
    return {
      success: true,
      blocked: next
    };
  });
}

async function setRecommendPostponedState(postponed, options = {}) {
  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const current = await getRecommendPostponedStateSnapshot();
    const expectedVersion = normalizeRecommendExpectedStateVersion(
      options.expectedVersion ?? postponed?.stateVersion ?? postponed?.version
    );
    if (expectedVersion == null) {
      return buildRecommendStateVersionMismatchResponse('postponed', current.version, 'missing_recommend_state_version');
    }
    if (expectedVersion !== normalizeRecommendStateVersion(current.version)) {
      return buildRecommendStateVersionMismatchResponse('postponed', current.version);
    }

    const next = normalizeRecommendPostponedList(postponed);
    const currentById = new Map(current.postponed.map(item => [String(item?.bookmarkId || '').trim(), item]));
    const addedBookmarkIds = normalizeBookmarkIdList(
      next
        .filter(item => {
          const bookmarkId = String(item?.bookmarkId || '').trim();
          if (!bookmarkId) return false;
          const previous = currentById.get(bookmarkId);
          return !previous || (item?.manuallyAdded === true && previous?.manuallyAdded !== true);
        })
        .map(item => item?.bookmarkId)
    );
    if (addedBookmarkIds.length > 0) {
      await removeFlippedBookmarksStateByIds(addedBookmarkIds, { unlocked: true });
    }
    const nextVersion = buildNextRecommendStateVersion(current.version);
    await browserAPI.storage.local.set({
      [RECOMMEND_POSTPONED_STORAGE_KEY]: next,
      [RECOMMEND_POSTPONED_VERSION_STORAGE_KEY]: nextVersion
    });
    return {
      success: true,
      postponed: next,
      count: next.length,
      version: nextVersion
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

async function handleRecommendSkipState(bookmarkId, options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, mode: 'none', skippedIds: [] };
  }

  const task = async () => {
    const [rawSkipped, postponedSnapshot] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedStateSnapshot()
    ]);

    const skipped = normalizeRecommendSkippedIds(rawSkipped);
    const postponed = normalizeRecommendPostponedList(postponedSnapshot.postponed);
    const postponedVersion = normalizeRecommendStateVersion(postponedSnapshot.version);
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
      nextSkipped.push(id);
      const normalizedSkipped = normalizeRecommendSkippedIds(nextSkipped);
      const nextPostponedVersion = buildNextRecommendStateVersion(postponedVersion);
      await browserAPI.storage.local.set({
        [RECOMMEND_POSTPONED_STORAGE_KEY]: postponed,
        [RECOMMEND_POSTPONED_VERSION_STORAGE_KEY]: nextPostponedVersion,
        [RECOMMEND_SKIPPED_STORAGE_KEY]: normalizedSkipped
      });

      return {
        success: true,
        mode: 'due-tail',
        skippedIds: normalizedSkipped,
        postponedVersion: nextPostponedVersion,
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
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
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

async function markRecommendRefreshExecutedState(options = {}) {
  const task = async () => {
    const settings = await getRecommendRefreshSettings();
    settings.lastRefreshTime = Date.now();
    settings.openCountSinceRefresh = 0;
    settings.sidePanelOpenCountSinceRefresh = 0;
    await saveRecommendRefreshSettings(settings);
    return { success: true, settings };
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
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
      return { success: false, error: error?.message || String(error) };
    } finally {
      ensureRecommendBackgroundRefreshAlarmLastCheckAt = Date.now();
      ensureRecommendBackgroundRefreshAlarmPromise = null;
    }
  })();

  return ensureRecommendBackgroundRefreshAlarmPromise;
}

async function appendRecommendFlippedBookmarkState(bookmarkId, options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, flippedIds: [] };
  }

  const task = async () => {
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
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
}

async function trimRecommendFlippedBookmarksState(maxItems = 1000, options = {}) {
  const safeMaxItems = Math.max(1, Math.floor(Number(maxItems) || 1000));
  const task = async () => {
    const result = await browserAPI.storage.local.get([FLIPPED_BOOKMARKS_STORAGE_KEY]);
    const raw = result?.[FLIPPED_BOOKMARKS_STORAGE_KEY];
    let current = [];
    if (Array.isArray(raw)) {
      current = normalizeBookmarkIdList(raw);
    } else if (raw && typeof raw === 'object') {
      const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      current = normalizeBookmarkIdList(
        Object.entries(raw)
          .filter(([, time]) => Number(time) > oneWeekAgo)
          .sort((a, b) => Number(a[1]) - Number(b[1]))
          .map(([id]) => id)
      );
    }
    if (current.length <= safeMaxItems) {
      return { success: true, trimmed: false, count: current.length, flippedIds: current };
    }

    const trimmed = current.slice(current.length - safeMaxItems);
    await browserAPI.storage.local.set({ [FLIPPED_BOOKMARKS_STORAGE_KEY]: trimmed });
    return {
      success: true,
      trimmed: true,
      count: trimmed.length,
      removed: current.length - trimmed.length,
      flippedIds: trimmed
    };
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
}

async function markHistoryCurrentCardFlippedState(bookmarkId, options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, allFlipped: false, historyCurrentCards: null };
  }

  const task = async () => {
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
      lastUpdated: now,
      version: buildNextHistoryCurrentCardsVersion(current, now)
    };
    await browserAPI.storage.local.set({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: next });

    const allFlipped = cardIds.length > 0 && cardIds.every(cardId => flippedIds.includes(cardId));
    return { success: true, allFlipped, historyCurrentCards: next };
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
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

async function consumeRecommendPoolCursorState(poolLength, consumeCount = 0, options = {}) {
  const task = async () => {
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
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
}

async function setRecommendPoolCursorState(poolLength, cursor = 0, options = {}) {
  const task = async () => {
    const safePoolLength = normalizeRecommendPoolLength(poolLength);
    const normalizedCursor = normalizeRecommendPoolCursorValue(cursor, safePoolLength);

    await browserAPI.storage.local.set({ [RECOMMEND_POOL_CURSOR_STORAGE_KEY]: normalizedCursor });

    return {
      success: true,
      poolLength: safePoolLength,
      cursor: normalizedCursor
    };
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
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

async function appendRecommendFlipHistoryRecordState(bookmarkId, timestamp = Date.now(), options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, count: -1 };
  }

  const safeTimestamp = Number.isFinite(Number(timestamp)) && Number(timestamp) > 0
    ? Math.floor(Number(timestamp))
    : Date.now();

  const task = async () => {
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
  };

  return options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task);
}

function normalizeRecommendReviewState(reviews) {
  if (!reviews || typeof reviews !== 'object') return {};
  return { ...reviews };
}

async function recordRecommendReviewState(bookmarkId, options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) {
    return { success: false, review: null, postponed: [], skippedIds: [] };
  }

  const task = async () => {
    const [reviewResult, postponedSnapshot, rawSkipped] = await Promise.all([
      browserAPI.storage.local.get(['recommend_reviews']),
      getRecommendPostponedStateSnapshot(),
      getRecommendSkippedIds()
    ]);

    const reviews = normalizeRecommendReviewState(reviewResult?.recommend_reviews);
    const postponed = normalizeRecommendPostponedList(postponedSnapshot.postponed);
    const postponedVersion = normalizeRecommendStateVersion(postponedSnapshot.version);
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
    const nextPostponedVersion = buildNextRecommendStateVersion(postponedVersion);

    await browserAPI.storage.local.set({
      recommend_reviews: reviews,
      [RECOMMEND_POSTPONED_STORAGE_KEY]: nextPostponed,
      [RECOMMEND_POSTPONED_VERSION_STORAGE_KEY]: nextPostponedVersion,
      [RECOMMEND_SKIPPED_STORAGE_KEY]: nextSkippedIds
    });

    return {
      success: true,
      review: nextReview,
      postponed: nextPostponed,
      postponedVersion: nextPostponedVersion,
      skippedIds: nextSkippedIds
    };
  };

  const state = await (options?.unlocked === true
    ? task()
    : runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, task));

  const scoreRecomputeWasRunning = isComputingScores;
  await updateSingleBookmarkScore(id);
  // 全量重算可能已在复习前读取了旧 reviewData；等它结束后再补一次，
  // 避免旧批次最后写入时覆盖刚完成复习的 S 值。
  if (scoreRecomputeWasRunning || isComputingScores) {
    scheduleRecomputeAllScoresSoon('review-during-score-recompute', { forceFull: true });
  }

  return state;
}

function normalizeRecommendActionExpectedVersion(value) {
  if (value == null || value === '') return null;
  const version = Number(value);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : null;
}

function buildRecommendStaleActionResponse(currentCards, reason = 'stale_current_cards') {
  return {
    success: false,
    stale: true,
    reason,
    currentCards: normalizeHistoryCurrentCardsState(currentCards)
  };
}

function isRecommendActionVersionStale(currentCards, expectedVersion) {
  const expected = normalizeRecommendActionExpectedVersion(expectedVersion);
  if (expected == null) return false;
  const currentVersion = Number(currentCards?.version || 0);
  return !Number.isFinite(currentVersion) || Math.floor(currentVersion) !== expected;
}

async function getHistoryCurrentCardsStateForAction() {
  try {
    const result = await browserAPI.storage.local.get([HISTORY_CURRENT_CARDS_STORAGE_KEY]);
    return normalizeHistoryCurrentCardsState(result?.[HISTORY_CURRENT_CARDS_STORAGE_KEY]);
  } catch (_) {
    return normalizeHistoryCurrentCardsState(null);
  }
}

async function setRecommendPostponedBookmarkState(bookmarkId, options = {}) {
  const id = String(bookmarkId || '').trim();
  if (!id) return { success: false, postponed: [], reason: 'missing_bookmark_id' };

  const postponedSnapshot = await getRecommendPostponedStateSnapshot();
  const postponed = normalizeRecommendPostponedList(postponedSnapshot.postponed);
  const postponedVersion = normalizeRecommendStateVersion(postponedSnapshot.version);
  const now = Date.now();
  const delayMs = Number(options.delayMs);
  const explicitUntil = Number(options.postponeUntil);
  const postponeUntil = Number.isFinite(explicitUntil) && explicitUntil > 0
    ? Math.floor(explicitUntil)
    : now + Math.max(0, Number.isFinite(delayMs) ? Math.floor(delayMs) : 0);
  const postponePresetKey = normalizeReviewReminderPresetKey(options.postponePresetKey, delayMs);
  const reminderBatchHour = postponePresetKey ? getReviewReminderBatchHour(postponeUntil) : 0;
  const manuallyAdded = options.manuallyAdded === true;
  const existing = postponed.find(item => String(item?.bookmarkId || '').trim() === id);

  if (existing) {
    existing.postponeUntil = postponeUntil;
    existing.postponeCount = manuallyAdded
      ? Number(existing.postponeCount || 0)
      : Number(existing.postponeCount || 0) + 1;
    existing.dueQueueMovedAt = 0;
    existing.postponePresetKey = postponePresetKey;
    existing.reminderBatchHour = reminderBatchHour;
    existing.manuallyAdded = existing.manuallyAdded === true || manuallyAdded;
    if (options.groupId != null) existing.groupId = options.groupId;
    if (options.groupType != null) existing.groupType = options.groupType;
    if (options.groupName != null) existing.groupName = options.groupName;
    existing.updatedAt = now;
  } else {
    postponed.push({
      bookmarkId: id,
      postponeUntil,
      postponeCount: manuallyAdded ? 0 : 1,
      dueQueueMovedAt: 0,
      postponePresetKey,
      reminderBatchHour,
      manuallyAdded,
      ...(options.groupId != null ? { groupId: options.groupId } : {}),
      ...(options.groupType != null ? { groupType: options.groupType } : {}),
      ...(options.groupName != null ? { groupName: options.groupName } : {}),
      createdAt: now,
      updatedAt: now
    });
  }

  const nextPostponed = normalizeRecommendPostponedList(postponed);
  const nextPostponedVersion = buildNextRecommendStateVersion(postponedVersion);
  await browserAPI.storage.local.set({
    [RECOMMEND_POSTPONED_STORAGE_KEY]: nextPostponed,
    [RECOMMEND_POSTPONED_VERSION_STORAGE_KEY]: nextPostponedVersion
  });
  await updateSingleBookmarkScore(id);
  return { success: true, postponed: nextPostponed, version: nextPostponedVersion };
}

async function getSameTitleBookmarkIdsForBlock(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id || !browserAPI?.bookmarks?.get || !browserAPI?.bookmarks?.getTree) return [];

  const targetBookmarks = await new Promise(resolve => {
    try {
      browserAPI.bookmarks.get(id, (items) => {
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
  const target = targetBookmarks && targetBookmarks[0] ? targetBookmarks[0] : null;
  const title = String(target?.title || '').trim();
  if (!target || !title) return [id];

  const tree = await new Promise(resolve => {
    try {
      browserAPI.bookmarks.getTree(resolve);
    } catch (_) {
      resolve([]);
    }
  });
  const ids = [];
  const traverse = (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (node?.url && String(node.title || '').trim() === title && node.id != null) {
        ids.push(String(node.id));
      }
      if (Array.isArray(node?.children)) {
        traverse(node.children);
      }
    }
  };
  traverse(tree);
  return normalizeBookmarkIdList(ids.length > 0 ? ids : [id]);
}

async function setRecommendBlockedBookmarksState(bookmarkIds = []) {
  const requestedIds = normalizeBookmarkIdList(bookmarkIds);
  if (requestedIds.length === 0) return { success: false, blocked: normalizeRecommendBlockedState(null) };

  const [blocked, postponedSnapshot] = await Promise.all([
    getRecommendBlockedState(),
    getRecommendPostponedStateSnapshot()
  ]);
  const postponedSet = new Set(
    normalizeRecommendPostponedList(postponedSnapshot.postponed)
      .map(item => String(item?.bookmarkId || '').trim())
      .filter(Boolean)
  );
  const ids = requestedIds.filter(id => !postponedSet.has(id));
  const skippedPostponedIds = requestedIds.filter(id => postponedSet.has(id));
  const bookmarkSet = new Set(normalizeBookmarkIdList(blocked.bookmarks || []));
  ids.forEach(id => bookmarkSet.add(id));
  const nextBlocked = normalizeRecommendBlockedState({
    ...blocked,
    bookmarks: Array.from(bookmarkSet),
    version: buildNextRecommendStateVersion(blocked.version)
  });

  if (ids.length === 0) {
    return {
      success: true,
      blocked,
      blockedBookmarkIds: [],
      skippedPostponedIds
    };
  }

  await browserAPI.storage.local.set({ [RECOMMEND_BLOCKED_STORAGE_KEY]: nextBlocked });
  return {
    success: true,
    blocked: nextBlocked,
    blockedBookmarkIds: ids,
    skippedPostponedIds
  };
}

async function updateHistoryCurrentCardDataState(cardData = [], expectedVersion = null) {
  const normalizedCardData = (Array.isArray(cardData) ? cardData : [])
    .map(normalizeRecommendCardDataEntry)
    .filter(Boolean);
  if (normalizedCardData.length === 0) {
    return { success: false, reason: 'empty_card_data', currentCards: null };
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const currentCards = await getHistoryCurrentCardsStateForAction();
    const versionStale = isRecommendActionVersionStale(currentCards, expectedVersion);
    if (versionStale) {
      return buildRecommendStaleActionResponse(currentCards);
    }

    const currentIds = normalizeBookmarkIdList(currentCards.cardIds || []);
    const dataIds = normalizeBookmarkIdList(normalizedCardData.map(item => item.id));
    if (!areNormalizedBookmarkIdListsEqual(currentIds, dataIds)) {
      return { success: false, stale: true, reason: 'card_ids_changed', currentCards };
    }

    const next = {
      ...currentCards,
      cardData: normalizedCardData,
      timestamp: Date.now(),
      lastUpdated: Date.now()
    };
    await browserAPI.storage.local.set({ [HISTORY_CURRENT_CARDS_STORAGE_KEY]: next });
    return { success: true, currentCards: next };
  });
}

function areNormalizedBookmarkIdListsEqual(a = [], b = []) {
  const listA = normalizeBookmarkIdList(a);
  const listB = normalizeBookmarkIdList(b);
  if (listA.length !== listB.length) return false;
  for (let i = 0; i < listA.length; i += 1) {
    if (listA[i] !== listB[i]) return false;
  }
  return true;
}

function buildRecommendCardDataMap(cardData = []) {
  const map = new Map();
  for (const item of Array.isArray(cardData) ? cardData : []) {
    const normalized = normalizeRecommendCardDataEntry(item);
    const id = String(normalized?.id || '').trim();
    if (id && normalized) {
      map.set(id, normalized);
    }
  }
  return map;
}

async function replaceCurrentCardsForRecommendAction(currentCards, removeIds = [], options = {}) {
  const normalizedCurrent = normalizeHistoryCurrentCardsState(currentCards);
  const removedSet = new Set(normalizeBookmarkIdList(removeIds || []));
  const currentIds = normalizeBookmarkIdList(normalizedCurrent.cardIds || []);
  const retainedIds = currentIds.filter(id => !removedSet.has(id));
  const cardDataMap = buildRecommendCardDataMap(normalizedCurrent.cardData || []);
  const slots = Math.max(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE - retainedIds.length);
  const excludeCardIds = Array.from(new Set([
    ...retainedIds,
    ...Array.from(removedSet)
  ]));

  let fillCards = [];
  let selection = null;
  if (slots > 0) {
    selection = await selectQuickReviewCardsRoundStateUnlocked({
      force: options.force !== false,
      currentCards: normalizedCurrent,
      scoresReadyChecked: options.scoresReadyChecked === true && options.scoresReadyResult != null,
      scoresReadyResult: options.scoresReadyResult || null,
      excludeCardIds,
      batchSize: slots,
      persist: false
    });
    fillCards = Array.isArray(selection?.cards) ? selection.cards : [];
  }

  const fillData = fillCards
    .map(item => normalizeRecommendCardDataEntry(item))
    .filter(Boolean);
  const fillQueue = fillData.slice();
  const nextIds = [];
  const nextData = [];

  for (const id of currentIds) {
    if (removedSet.has(id)) {
      const fill = fillQueue.shift();
      const fillId = String(fill?.id || '').trim();
      if (fill && fillId) {
        nextIds.push(fillId);
        nextData.push(fill);
      }
      continue;
    }

    const retained = cardDataMap.get(id);
    if (retained) {
      nextIds.push(id);
      nextData.push(retained);
    }
  }

  while (nextIds.length < QUICK_REVIEW_RECOMMEND_BATCH_SIZE && fillQueue.length > 0) {
    const fill = fillQueue.shift();
    const fillId = String(fill?.id || '').trim();
    if (!fill || !fillId || nextIds.includes(fillId)) continue;
    nextIds.push(fillId);
    nextData.push(fill);
  }

  const slicedIds = nextIds.slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
  const nextIdSet = new Set(slicedIds);
  const slicedData = nextData
    .filter(item => nextIdSet.has(String(item?.id || '').trim()))
    .slice(0, QUICK_REVIEW_RECOMMEND_BATCH_SIZE);
  const nextFlippedIds = normalizeBookmarkIdList(normalizedCurrent.flippedIds || [])
    .filter(id => nextIdSet.has(id));

  const saved = await saveHistoryCurrentCardsState(slicedIds, nextFlippedIds, slicedData, {
    previousState: normalizedCurrent
  });

  return {
    currentCards: saved,
    cards: slicedData,
    roundRefreshed: false,
    partialRefreshed: fillData.length > 0,
    ready: selection?.ready !== false,
    repairing: selection?.repairing === true,
    reason: selection?.reason || null
  };
}

async function refreshCurrentCardsForRecommendAction(currentCards, options = {}) {
  const normalizedCurrent = normalizeHistoryCurrentCardsState(currentCards);
  const force = options.force !== false;
  const result = await selectQuickReviewCardsRoundStateUnlocked({
    force,
    currentCards: normalizedCurrent,
    scoresReadyChecked: options.scoresReadyChecked === true && options.scoresReadyResult != null,
    scoresReadyResult: options.scoresReadyResult || null
  });
  if (result?.ready === false) {
    return {
      currentCards: normalizedCurrent,
      cards: normalizedCurrent.cardData || [],
      roundRefreshed: false,
      ready: false,
      repairing: result?.repairing === true,
      reason: result?.reason || null
    };
  }
  return {
    currentCards: result?.currentCards ? normalizeHistoryCurrentCardsState(result.currentCards) : normalizeHistoryCurrentCardsState(null),
    cards: Array.isArray(result?.cards) ? result.cards : [],
    roundRefreshed: true,
    ready: result?.ready !== false,
    repairing: result?.repairing === true,
    reason: result?.reason || null
  };
}

async function executeRecommendCardActionState(message = {}) {
  const actionType = String(message.recommendAction || message.cardAction || message.type || '').trim();
  const bookmarkId = String(message.bookmarkId || message.id || '').trim();
  const expectedVersion = normalizeRecommendActionExpectedVersion(message.expectedVersion);

  if (!bookmarkId || !actionType) {
    return { success: false, reason: 'invalid_action' };
  }

  await ensureScoreAlgoVersionReady();
  let scoresReadyResult = null;
  if (actionType !== 'open') {
    try {
      scoresReadyResult = await ensureRecommendScoresReady({ reason: `recommend-action:${actionType}` });
    } catch (_) {}
  }

  return runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
    const currentCardsBefore = await getHistoryCurrentCardsStateForAction();
    const currentCardSet = new Set(normalizeBookmarkIdList(currentCardsBefore.cardIds || []));
    const isCurrentCard = currentCardSet.has(bookmarkId);
    const requiresVersion = isCurrentCard && ['review', 'skip', 'postpone', 'block'].includes(actionType);

    if (requiresVersion) {
      if (expectedVersion == null) {
        return buildRecommendStaleActionResponse(currentCardsBefore, 'missing_current_cards_version');
      }
      if (isRecommendActionVersionStale(currentCardsBefore, expectedVersion)) {
        return buildRecommendStaleActionResponse(currentCardsBefore);
      }
    }

    if (actionType === 'open') {
      return { success: true, action: actionType, currentCards: currentCardsBefore, changedCurrentCards: false };
    }

    let currentCards = currentCardsBefore;
    let cards = [];
    let changedCurrentCards = false;
    let actionResult = null;
    let allFlipped = false;
    let roundRefreshed = false;
    let refreshMarked = false;
    const partialErrors = [];
    const warnings = [];

    const captureReviewWriteStep = async (step, fn, options = {}) => {
      try {
        const result = await fn();
        if (options?.critical === true && result && result.success === false) {
          const error = new Error(result?.reason || `${step}_failed`);
          error.result = result;
          throw error;
        }
        return result;
      } catch (error) {
        const messageText = error?.message || String(error);
        partialErrors.push({ step, error: messageText });
        warnings.push(`[${step}] ${messageText}`);
        if (options?.critical === true) {
          throw error;
        }
        return null;
      }
    };

    if (actionType === 'review') {
      const review = await captureReviewWriteStep(
        'recordRecommendReviewState',
        () => recordRecommendReviewState(bookmarkId, { unlocked: true }),
        { critical: true }
      );
      if (!review || review.success === false) {
        return {
          success: false,
          action: actionType,
          bookmarkId,
          isCurrentCard,
          changedCurrentCards,
          allFlipped,
          roundRefreshed,
          refreshMarked,
          currentCards,
          cards,
          review: review || null,
          partialErrors,
          warnings,
          reason: 'review_write_failed'
        };
      }
      actionResult = { review };

      await captureReviewWriteStep('appendRecommendFlippedBookmarkState', () =>
        appendRecommendFlippedBookmarkState(bookmarkId, { unlocked: true })
      );
      await captureReviewWriteStep('appendRecommendFlipHistoryRecordState', () =>
        appendRecommendFlipHistoryRecordState(bookmarkId, message.timestamp || Date.now(), { unlocked: true })
      );

      if (isCurrentCard) {
        const markResult = await captureReviewWriteStep('markHistoryCurrentCardFlippedState', () =>
          markHistoryCurrentCardFlippedState(bookmarkId, { unlocked: true })
        );
        if (markResult) {
          allFlipped = markResult?.allFlipped === true;
          currentCards = normalizeHistoryCurrentCardsState(markResult?.historyCurrentCards || currentCardsBefore);
          changedCurrentCards = true;

          if (allFlipped) {
            const refreshed = await captureReviewWriteStep('refreshCurrentCardsForRecommendAction', () =>
              refreshCurrentCardsForRecommendAction(currentCards, {
                force: true,
                scoresReadyChecked: true,
                scoresReadyResult
              })
            );
            if (refreshed) {
              currentCards = refreshed.currentCards;
              cards = refreshed.cards;
              roundRefreshed = refreshed.roundRefreshed === true;
              const markRefreshResult = await captureReviewWriteStep('markRecommendRefreshExecutedState', () =>
                markRecommendRefreshExecutedState({ unlocked: true })
              );
              refreshMarked = markRefreshResult?.success === true;
            }
          }
        }
      }
    } else if (actionType === 'skip') {
      actionResult = await handleRecommendSkipState(bookmarkId, { unlocked: true });
      if (isCurrentCard) {
        const refreshed = await replaceCurrentCardsForRecommendAction(currentCardsBefore, [bookmarkId], {
          force: true,
          scoresReadyChecked: true,
          scoresReadyResult
        });
        currentCards = refreshed.currentCards;
        cards = refreshed.cards;
        changedCurrentCards = true;
        roundRefreshed = refreshed.roundRefreshed === true;
      }
    } else if (actionType === 'postpone') {
      actionResult = await setRecommendPostponedBookmarkState(bookmarkId, {
        delayMs: message.delayMs,
        postponeUntil: message.postponeUntil,
        postponePresetKey: message.postponePresetKey,
        manuallyAdded: message.manuallyAdded === true,
        groupId: message.groupId,
        groupType: message.groupType,
        groupName: message.groupName
      });
      if (isCurrentCard) {
        const refreshed = await replaceCurrentCardsForRecommendAction(currentCardsBefore, [bookmarkId], {
          force: true,
          scoresReadyChecked: true,
          scoresReadyResult
        });
        currentCards = refreshed.currentCards;
        cards = refreshed.cards;
        changedCurrentCards = true;
        roundRefreshed = refreshed.roundRefreshed === true;
      }
    } else if (actionType === 'block') {
      const blockIds = message.scope === 'single'
        ? [bookmarkId]
        : await getSameTitleBookmarkIdsForBlock(bookmarkId);
      actionResult = await setRecommendBlockedBookmarksState(blockIds);
      const blockedSet = new Set(normalizeBookmarkIdList(actionResult?.blockedBookmarkIds || blockIds));
      const touchesCurrent = normalizeBookmarkIdList(currentCardsBefore.cardIds || [])
        .some(id => blockedSet.has(id));
      if (touchesCurrent) {
        const removedCurrentIds = normalizeBookmarkIdList(currentCardsBefore.cardIds || [])
          .filter(id => blockedSet.has(id));
        const refreshed = await replaceCurrentCardsForRecommendAction(currentCardsBefore, removedCurrentIds, {
          force: true,
          scoresReadyChecked: true,
          scoresReadyResult
        });
        currentCards = refreshed.currentCards;
        cards = refreshed.cards;
        changedCurrentCards = true;
        roundRefreshed = refreshed.roundRefreshed === true;
      }
    } else {
      return { success: false, reason: 'unknown_action', action: actionType };
    }

    return {
      success: true,
      action: actionType,
      bookmarkId,
      isCurrentCard,
      changedCurrentCards,
      allFlipped,
      roundRefreshed,
      refreshMarked,
      currentCards,
      cards,
      partialErrors,
      warnings,
      ...(actionResult && typeof actionResult === 'object' ? actionResult : {})
    };
  });
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
    const [rawSkipped, postponedSnapshot, rawBlocked, rawCache, historyCardsResult] = await Promise.all([
      getRecommendSkippedIds(),
      getRecommendPostponedStateSnapshot(),
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

    const normalizedPostponed = normalizeRecommendPostponedList(postponedSnapshot.postponed || []);
    const nextPostponed = normalizedPostponed.filter((item) => {
      const bookmarkId = String(item?.bookmarkId || '').trim();
      return bookmarkId && !removedBookmarkSet.has(bookmarkId);
    });
    if (nextPostponed.length !== normalizedPostponed.length) {
      updates[RECOMMEND_POSTPONED_STORAGE_KEY] = nextPostponed;
      updates[RECOMMEND_POSTPONED_VERSION_STORAGE_KEY] = buildNextRecommendStateVersion(postponedSnapshot.version);
    }

    const blocked = normalizeRecommendBlockedState(rawBlocked);
    const nextBlocked = {
      bookmarks: blocked.bookmarks.filter(id => !removedBookmarkSet.has(String(id || '').trim())),
      folders: blocked.folders.filter(id => !removedFolderSet.has(String(id || '').trim())),
      domains: blocked.domains.slice(),
      version: blocked.version
    };

    if (
      nextBlocked.bookmarks.length !== blocked.bookmarks.length
      || nextBlocked.folders.length !== blocked.folders.length
    ) {
      nextBlocked.version = buildNextRecommendStateVersion(blocked.version);
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
          lastUpdated: now,
          version: buildNextHistoryCurrentCardsVersion(historyCurrentCards, now)
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
      const [existingCache, staleMetaResult] = await Promise.all([
        getScoresCache(),
        browserAPI.storage.local.get(['recommendScoresStaleMeta'])
      ]);
      const existingBuild = buildQuickReviewBookmarksFromScoresCacheWithStats(existingCache);
      const existingHealth = normalizeRecommendScoresCacheHealth(existingBuild.stats);
      const staleMeta = staleMetaResult?.recommendScoresStaleMeta || null;
      const repairReason = getRecommendScoresCacheRepairReason(existingHealth, staleMeta);

      if (existingHealth.cacheCount > 0 && !repairReason) {
        return {
          success: true,
          ready: true,
          mode: 'existing',
          cacheCount: existingHealth.cacheCount,
          cacheHealth: compactRecommendScoresCacheHealth(existingHealth)
        };
      }

      if (isBookmarkImporting || isBookmarkBulkChanging) {
        return {
          success: true,
          ready: false,
          mode: 'bulk-pending',
          repairing: !!repairReason,
          reason: repairReason || 'bulk-pending',
          cacheCount: existingHealth.cacheCount,
          cacheHealth: compactRecommendScoresCacheHealth(existingHealth)
        };
      }

      if (isComputingScores || templateRefineRunning) {
        return {
          success: true,
          ready: false,
          mode: 'computing',
          repairing: !!repairReason,
          reason: repairReason || 'computing',
          cacheCount: existingHealth.cacheCount,
          cacheHealth: compactRecommendScoresCacheHealth(existingHealth)
        };
      }

      const ids = await getAllBookmarkUrlIdsForScore();
      if (!Array.isArray(ids) || ids.length === 0) {
        if (existingHealth.cacheCount > 0) {
          await saveScoresCache({});
        }
        try {
          await browserAPI.storage.local.set({
            recommendScoresStaleMeta: {
              staleAt: 0,
              reason: `ensure-ready:${reason}:empty-tree`
            }
          });
        } catch (_) { }
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
      const nextBuild = buildQuickReviewBookmarksFromScoresCacheWithStats(nextCache);
      const nextHealth = normalizeRecommendScoresCacheHealth(nextBuild.stats);
      const nextRepairReason = getRecommendScoresCacheRepairReason(nextHealth, null);

      if (nextRepairReason) {
        await markRecommendScoresCacheRepairing(`ensure-ready:${nextRepairReason}`, nextHealth);
        queueRecommendScoresCacheRepair(`ensure-ready:${nextRepairReason}:full`, nextHealth);
      } else {
        try {
          await browserAPI.storage.local.set({
            recommendScoresStaleMeta: {
              staleAt: 0,
              reason: `ensure-ready:${reason}`
            }
          });
        } catch (_) { }
      }

      return {
        success: true,
        ready: nextHealth.cacheCount > 0 && !nextRepairReason,
        mode: ids.length >= SCORE_TEMPLATE_BATCH_THRESHOLD ? 'template' : 'incremental',
        repairing: !!nextRepairReason,
        reason: nextRepairReason || undefined,
        cacheCount: nextHealth.cacheCount,
        bookmarkCount: ids.length,
        cacheHealth: compactRecommendScoresCacheHealth(nextHealth)
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
    if (isComputingScores || templateRefineRunning) {
      scheduleRecomputeAllScoresSoon(reason, { forceFull });
      return;
    }
    computeAllBookmarkScores({ forceFull })
      .then((ok) => {
        if (ok === false) {
          markRecommendScoresCacheRepairing(`${reason || 'scheduled-recompute'}:not-computed`).catch(() => { });
          return;
        }
        try {
          browserAPI.storage.local.set({
            recommendScoresStaleMeta: { staleAt: 0, reason: reason || '' }
          });
        } catch (_) { }
      })
      .catch((error) => {
        markRecommendScoresCacheRepairing(`${reason || 'scheduled-recompute'}:failed`, {
          error: error?.message || String(error)
        }).catch(() => { });
      });
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

  const reason = String(lastBulkReason || '');
  await scheduleBulkTemplateRecovery(`bulk-exit:${reason || 'unknown'}`);
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
  return getRecommendBaseDomainFromHost(domain);
}

function normalizeRecommendDomainHost(domain) {
  return String(domain || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function buildBlockedDomainBaseEntry(domain) {
  const safeBase = getRecommendBaseDomainFromHost(domain);
  return safeBase ? `${RECOMMEND_BLOCKED_DOMAIN_BASE_PREFIX}${safeBase}` : '';
}

function getRecommendBaseDomainFromHost(hostname) {
  const safeHost = normalizeRecommendDomainHost(hostname);
  if (!safeHost) return '';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(safeHost)) return safeHost;
  const parts = safeHost.split('.').filter(Boolean);
  if (parts.length <= 2) return safeHost;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  const commonSecondLevelSuffixes = new Set(['com', 'net', 'org', 'gov', 'edu', 'ac', 'co']);
  const keepCount = last.length === 2 && commonSecondLevelSuffixes.has(secondLast) && parts.length >= 3 ? 3 : 2;
  return parts.slice(-keepCount).join('.');
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

function getScoreHistoryUrlDomain(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    return String(new URL(url).hostname || '').toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function getScoreHistoryTitleDomainKey(title, url) {
  const safeTitle = String(title || '').trim();
  const domain = getScoreHistoryUrlDomain(url);
  return safeTitle && domain ? `${safeTitle}|${domain}` : '';
}

function mergeScoreHistoryData(map, key, data) {
  if (!(map instanceof Map) || !key || !data) return;
  const next = {
    visitCount: Number(data.visitCount || 0) || 0,
    lastVisitTime: Number(data.lastVisitTime || 0) || 0
  };
  const existing = map.get(key);
  if (!existing) {
    map.set(key, next);
    return;
  }
  map.set(key, {
    visitCount: (Number(existing.visitCount || 0) || 0) + next.visitCount,
    lastVisitTime: Math.max(Number(existing.lastVisitTime || 0) || 0, next.lastVisitTime)
  });
}

let bookmarkUrlIndexReady = false;
let bookmarkUrlIndexBuilding = null;
let bookmarkUrlIndexStale = false;
const bookmarkUrlIndex = new Map(); // urlKey -> Set<bookmarkId>
const bookmarkIdToUrlKey = new Map();
const bookmarkIdToUrl = new Map();

function clearBookmarkUrlIndex() {
  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  bookmarkIdToUrl.clear();
  bookmarkUrlIndexReady = false;
  bookmarkUrlIndexStale = true;
}

function addBookmarkToUrlIndex(bookmark) {
  if (!bookmark || !bookmark.id || !bookmark.url) return;
  const bookmarkId = String(bookmark.id);
  const key = normalizeScoreUrlKey(bookmark.url);
  if (!key) return;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(bookmarkId);
  bookmarkIdToUrlKey.set(bookmarkId, key);
  bookmarkIdToUrl.set(bookmarkId, bookmark.url);
}

function removeBookmarkFromUrlIndex(bookmarkId) {
  if (!bookmarkId) return '';
  const safeId = String(bookmarkId);
  const oldUrl = bookmarkIdToUrl.get(safeId) || '';
  const key = bookmarkIdToUrlKey.get(safeId);
  if (!key) {
    bookmarkIdToUrl.delete(safeId);
    return oldUrl;
  }
  const set = bookmarkUrlIndex.get(key);
  if (set) {
    set.delete(safeId);
    if (set.size === 0) {
      bookmarkUrlIndex.delete(key);
    }
  }
  bookmarkIdToUrlKey.delete(safeId);
  bookmarkIdToUrl.delete(safeId);
  return oldUrl;
}

function updateBookmarkUrlIndex(bookmarkId, newUrl) {
  const safeId = String(bookmarkId || '').trim();
  const oldUrl = removeBookmarkFromUrlIndex(safeId);
  if (!newUrl || !safeId) return oldUrl;
  const key = normalizeScoreUrlKey(newUrl);
  if (!key) return oldUrl;
  let set = bookmarkUrlIndex.get(key);
  if (!set) {
    set = new Set();
    bookmarkUrlIndex.set(key, set);
  }
  set.add(safeId);
  bookmarkIdToUrlKey.set(safeId, key);
  bookmarkIdToUrl.set(safeId, newUrl);
  return oldUrl;
}

async function buildBookmarkUrlIndex() {
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  const nextIndex = new Map();
  const nextIdMap = new Map();
  const nextUrlMap = new Map();

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
          const bookmarkId = String(node.id);
          set.add(bookmarkId);
          nextIdMap.set(bookmarkId, key);
          nextUrlMap.set(bookmarkId, node.url);
        }
      }
      if (node.children) traverse(node.children);
    }
  }

  traverse(tree);

  bookmarkUrlIndex.clear();
  bookmarkIdToUrlKey.clear();
  bookmarkIdToUrl.clear();
  for (const [key, set] of nextIndex.entries()) {
    bookmarkUrlIndex.set(key, set);
  }
  for (const [id, key] of nextIdMap.entries()) {
    bookmarkIdToUrlKey.set(id, key);
  }
  for (const [id, url] of nextUrlMap.entries()) {
    bookmarkIdToUrl.set(id, url);
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
  const domainMatchers = buildBlockedDomainMatchers(blocked.domains || []);
  return {
    bookmarks: new Set(blocked.bookmarks || []),
    domains: domainMatchers,
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
    return true;
  } catch (error) {
    const message = error?.message || String(error);
    if (message.includes('QUOTA')) {
      console.warn('[S-score] storage quota reached, cleaning...');
      try {
        const keysToCheck = [FLIPPED_BOOKMARKS_STORAGE_KEY, 'thumbnailCache', RECOMMEND_POSTPONED_STORAGE_KEY];
        const data = await browserAPI.storage.local.get(keysToCheck);

        if (data[FLIPPED_BOOKMARKS_STORAGE_KEY]) {
          await trimRecommendFlippedBookmarksState(1000, { unlocked: true });
        }

        if (data.thumbnailCache) {
          await browserAPI.storage.local.remove(['thumbnailCache']);
        }

        await browserAPI.storage.local.set({ recommend_scores_cache: cache, recommend_scores_time: Date.now() });
        return true;
      } catch (retryError) {
        console.error('[S-score] save after cleanup failed:', retryError);
        await markRecommendScoresCacheRepairing('score-cache-save-failed', buildQuickReviewBookmarksFromScoresCacheWithStats(cache).stats);
        throw retryError;
      }
    } else {
      console.error('[S-score] save failed:', error);
      await markRecommendScoresCacheRepairing('score-cache-save-failed', buildQuickReviewBookmarksFromScoresCacheWithStats(cache).stats);
      throw error;
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
      if (stat.bookmarkId) byBookmarkId.set(stat.bookmarkId, data);
    }

    return { byUrl, byBookmarkId, totalMs, totalCount };
  } catch (e) {
    console.warn('[S-score] tracking stats failed:', e);
    return { byUrl: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
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

  const titleDomainKey = getScoreHistoryTitleDomainKey(bookmark.title, bookmark.url);
  if (titleDomainKey && historyStats.titleDomainMap) {
    history = historyStats.titleDomainMap.get(titleDomainKey);
    if (history && history.visitCount > 0) {
      return { matchType: 'title_domain', matchKey: titleDomainKey, history };
    }
  }

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

function getBrowsingCacheRecordTimestampForScore(record) {
  const raw = record?.visitTime ?? record?.dateAdded ?? record?.lastVisitTime ?? 0;
  if (raw instanceof Date) return raw.getTime();
  const numeric = Number(raw || 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function createEmptyScoreHistoryStats(source = 'history-cache-empty') {
  const urlMap = new Map();
  const titleDomainMap = new Map();
  urlMap.titleDomainMap = titleDomainMap;
  urlMap.source = source;
  urlMap.meta = {
    source,
    recordCount: 0,
    matchedRecordCount: 0,
    lastSyncTime: 0,
    lastFullSyncTime: 0
  };
  return urlMap;
}

function normalizeScoreHistoryTargetBookmarks(bookmarks = []) {
  const targetBookmarks = Array.isArray(bookmarks) ? bookmarks : [];
  const urlKeys = new Set();
  const titleDomainKeys = new Set();

  for (const bookmark of targetBookmarks) {
    const urlKey = normalizeScoreUrlKey(bookmark?.url || '');
    if (urlKey) urlKeys.add(urlKey);

    const titleDomainKey = getScoreHistoryTitleDomainKey(bookmark?.title, bookmark?.url);
    if (titleDomainKey) titleDomainKeys.add(titleDomainKey);
  }

  if (urlKeys.size === 0 && titleDomainKeys.size === 0) return null;
  return { urlKeys, titleDomainKeys };
}

function shouldIncludeScoreHistoryTarget(target, urlKey, titleDomainKey) {
  if (!target) return true;
  return !!(
    (urlKey && target.urlKeys?.has(urlKey)) ||
    (titleDomainKey && target.titleDomainKeys?.has(titleDomainKey))
  );
}

async function buildScoreHistoryStatsFromBrowsingCache(cachePayload, options = {}) {
  const stats = createEmptyScoreHistoryStats('history-cache');
  const target = options.target || null;
  const rows = Array.isArray(cachePayload?.records) ? cachePayload.records : [];
  let recordCount = 0;
  let matchedRecordCount = 0;

  for (const [, records] of rows) {
    for (const record of (Array.isArray(records) ? records : [])) {
      recordCount += 1;
      const url = String(record?.url || '').trim();
      if (!url) continue;

      const urlKey = normalizeScoreUrlKey(url);
      const titleDomainKey = getScoreHistoryTitleDomainKey(record?.title, url);
      if (!urlKey && !titleDomainKey) continue;
      if (!shouldIncludeScoreHistoryTarget(target, urlKey, titleDomainKey)) continue;

      const visitTime = getBrowsingCacheRecordTimestampForScore(record);
      if (!visitTime) continue;
      const count = Math.max(1, Number(record?.visitCount || 1) || 1);
      const data = {
        visitCount: count,
        lastVisitTime: visitTime
      };

      if (urlKey) {
        mergeScoreHistoryData(stats, urlKey, data);
      }
      if (titleDomainKey) {
        mergeScoreHistoryData(stats.titleDomainMap, titleDomainKey, data);
      }

      matchedRecordCount += 1;
      if (shouldYieldBrowsingHistoryScoreRows(matchedRecordCount, options.yieldEvery)) {
        await yieldBrowsingHistoryScoreRows();
      }
    }
  }

  stats.meta = {
    source: 'history-cache',
    recordCount,
    matchedRecordCount,
    lastSyncTime: Number(cachePayload?.lastSyncTime || 0) || 0,
    lastFullSyncTime: Number(cachePayload?.lastFullSyncTime || cachePayload?.lastSyncTime || 0) || 0,
    targeted: !!target
  };
  return stats;
}

function shouldYieldBrowsingHistoryScoreRows(processedCount, yieldEvery = 1000) {
  const safeEvery = Math.max(0, Number(yieldEvery || 0) || 0);
  return !!(safeEvery && processedCount > 0 && processedCount % safeEvery === 0);
}

function yieldBrowsingHistoryScoreRows() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

async function getBatchHistoryDataWithTitle(options = {}) {
  const target = normalizeScoreHistoryTargetBookmarks(options.bookmarks || []);

  try {
    if (options.ensureSeed !== false) {
      await ensureBrowsingHistoryLibrarySeeded({
        reason: options.reason || 'score-history-cache-read'
      });
    }
    const cachePayload = await readBrowsingHistoryCache();
    if (!cachePayload || !Array.isArray(cachePayload.records)) {
      return createEmptyScoreHistoryStats('history-cache-empty');
    }
    return await buildScoreHistoryStatsFromBrowsingCache(cachePayload, {
      target,
      yieldEvery: options.yieldEvery
    });
  } catch (e) {
    console.warn('[S-score] history cache load failed:', e);
    return createEmptyScoreHistoryStats('history-cache-error');
  }
}

async function backfillScoreHistoryForBookmarks(bookmarks = [], reason = 'score-history-backfill', options = {}) {
  const maxUrls = Math.max(0, Number(options.maxUrls || 120) || 120);
  const urls = Array.from(new Set(
    (Array.isArray(bookmarks) ? bookmarks : [])
      .map(bookmark => String(bookmark?.url || '').trim())
      .filter(url => /^https?:\/\//i.test(url))
  ));
  if (urls.length === 0) return { success: true, skipped: 'no-urls' };
  if (maxUrls > 0 && urls.length > maxUrls) {
    return { success: true, skipped: 'too-many-urls', urlCount: urls.length };
  }
  try {
    return await syncBrowsingHistoryCacheForUrls(urls, { reason, repairRecommendScores: false });
  } catch (error) {
    console.warn('[S-score] score history batch backfill failed:', error);
    return { success: false, error: error?.message || String(error), urlCount: urls.length };
  }
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
      if (blocked.domains?.hasRules !== true || !bookmark.url) return false;
      try {
        const url = new URL(bookmark.url);
        return isHostnameBlockedByDomainMatchers(url.hostname, blocked.domains);
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
      const trackingData = { byUrl: new Map(), byBookmarkId: new Map(), totalMs: 0, totalCount: 0 };
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
      getBatchHistoryDataWithTitle({ reason: 'score-full-history-read' }),
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

async function updateSingleBookmarkScore(bookmarkId, options = {}) {
  try {
    if (isBookmarkImporting || isBookmarkBulkChanging) return false;
    const id = String(bookmarkId || '').trim();
    if (!id) return false;

    const bookmarks = await new Promise(resolve => browserAPI.bookmarks.get([id], resolve));
    if (!bookmarks || bookmarks.length === 0) return false;

    const bookmark = bookmarks[0];
    if (!bookmark || !bookmark.url) return false;
    const ancestorFolderIds = await getAncestorFolderIdsByParentIdForScore(bookmark.parentId);
    const bookmarkForScore = {
      ...bookmark,
      ancestorFolderIds
    };

    if (options?.skipHistoryBackfill !== true) {
      await backfillScoreHistoryForBookmarks([bookmark], 'score-single-history-backfill', { maxUrls: 1 });
    }
    const historyStats = await getBatchHistoryDataWithTitle({
      bookmarks: [bookmarkForScore],
      reason: 'score-single-history-read'
    });

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
    return true;
  } catch (e) {
    console.warn('[S-score] incremental update failed:', e);
    if (options?.throwOnFailure === true) throw e;
    return false;
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

function collectBookmarkIdsByDomains(nodes, domainMatchers, output) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (node && node.url) {
      try {
        const host = normalizeRecommendDomainHost(new URL(node.url).hostname);
        if (isHostnameBlockedByDomainMatchers(host, domainMatchers)) {
          output.push(String(node.id));
        }
      } catch (_) { }
    }
    if (node && node.children) {
      collectBookmarkIdsByDomains(node.children, domainMatchers, output);
    }
  }
}

async function getBookmarkIdsByDomains(domains) {
  const ids = [];
  const domainMatchers = buildBlockedDomainMatchers(domains || []);
  if (domainMatchers.hasRules !== true || !browserAPI?.bookmarks?.getTree) return ids;
  const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
  collectBookmarkIdsByDomains(tree, domainMatchers, ids);
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

  await backfillScoreHistoryForBookmarks(bookmarks, 'score-batch-history-backfill');

  const [historyStats, config, trackingData, postponedList, reviewData, mode, cache] = await Promise.all([
    getBatchHistoryDataWithTitle({
      bookmarks,
      reason: 'score-batch-history-read'
    }),
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
      const ok = await updateSingleBookmarkScore(id, { throwOnFailure: true });
      if (ok) {
        updated += 1;
      }
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
let pendingBookmarkVisitScoreUrls = new Set();
let urlUpdateTimer = null;
let urlUpdateInFlight = false;

async function clearBookmarkVisitHistoryDirtyIfSettled() {
  if (pendingBookmarkVisitScoreUrls.size > 0 || urlUpdateTimer || urlUpdateInFlight) return;
  const state = await getBrowsingHistoryOpenRefreshDirtyState();
  if (!state?.dirty || state.reason !== BROWSING_HISTORY_BOOKMARK_VISIT_DIRTY_REASON) return;
  if (browsingCalibrationInProgress) return;
  await setBrowsingHistoryOpenRefreshDirty(false, 'incremental-bookmark-history-synced');
}

async function scheduleScoreUpdateByUrl(url, options = {}) {
  if (isBookmarkImporting || isBookmarkBulkChanging) return;
  if (!url) return;
  pendingUrlUpdates.add(url);
  if (options?.historyBookmarkVisit === true) {
    pendingBookmarkVisitScoreUrls.add(url);
  }

  if (urlUpdateTimer) clearTimeout(urlUpdateTimer);

  urlUpdateTimer = setTimeout(async () => {
    const urls = [...pendingUrlUpdates];
    pendingUrlUpdates.clear();
    const bookmarkVisitUrls = new Set(pendingBookmarkVisitScoreUrls);
    pendingBookmarkVisitScoreUrls.clear();
    urlUpdateTimer = null;
    urlUpdateInFlight = true;
    let bookmarkVisitBatchCanClearDirty = bookmarkVisitUrls.size === 0;

    try {
      const urlKeySet = new Set(urls.map(normalizeScoreUrlKey).filter(Boolean));
      if (urlKeySet.size === 0) {
        bookmarkVisitBatchCanClearDirty = true;
        if (bookmarkVisitUrls.size > 0) await clearBookmarkVisitHistoryDirtyIfSettled();
        return;
      }

      const indexReady = await ensureBookmarkUrlIndex();
      if (indexReady) {
        const idSet = new Set();
        const matchedUrls = [];
        for (const key of urlKeySet) {
          const ids = bookmarkUrlIndex.get(key);
          if (ids) {
            ids.forEach(id => idSet.add(id));
            for (const url of urls) {
              if (normalizeScoreUrlKey(url) === key) matchedUrls.push(url);
            }
          }
        }
        if (idSet.size === 0) {
          // 事件到达后书签已被删除时，已不再有任何书签派生数据需要同步。
          bookmarkVisitBatchCanClearDirty = true;
          if (bookmarkVisitUrls.size > 0) await clearBookmarkVisitHistoryDirtyIfSettled();
          return;
        }
        let historySynced = false;
        try {
          const result = await syncBrowsingHistoryCacheForUrls(matchedUrls, {
            reason: 'score-url-visited-history-backfill',
            // 这里随后会按命中的书签做单条更新，不能再把一次普通访问升级成全量 S 修复。
            repairRecommendScores: false
          });
          historySynced = result?.success === true && result?.addedCount > 0;
        } catch (error) {
          console.warn('[S-score] visited url history backfill failed:', error);
        }
        // 对浏览器 onVisited 而言，原始访问明细未写入时不能用旧库覆盖 S 值；
        // 保留 dirty，由下次打开/定时兜底校准后再修复。
        if (bookmarkVisitUrls.size > 0 && !historySynced) return;
        let scoreUpdateFailed = false;
        for (const bookmarkId of idSet) {
          const updated = await updateSingleBookmarkScore(bookmarkId, { skipHistoryBackfill: true });
          if (updated !== true) scoreUpdateFailed = true;
        }
        if (scoreUpdateFailed) {
          queueRecommendScoresCacheRepair('incremental-bookmark-score-update-failed');
        }
        if (bookmarkVisitUrls.size > 0 && historySynced) {
          bookmarkVisitBatchCanClearDirty = true;
          await clearBookmarkVisitHistoryDirtyIfSettled();
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

      let scoreUpdateFailed = false;
      let historySynced = false;
      const bookmarkVisitUrlKeys = new Set(
        Array.from(bookmarkVisitUrls).map(normalizeScoreUrlKey).filter(Boolean)
      );
      let bookmarkVisitSyncFailed = false;
      for (const bookmark of bookmarks) {
        let bookmarkHistorySynced = false;
        try {
          const result = await syncBrowsingHistoryCacheForUrls([bookmark.url], {
            reason: 'score-url-visited-history-backfill',
            repairRecommendScores: false
          });
          bookmarkHistorySynced = result?.success === true && result?.addedCount > 0;
          historySynced = historySynced || bookmarkHistorySynced;
        } catch (error) {
          console.warn('[S-score] visited bookmark history backfill failed:', error);
        }
        const isPendingBookmarkVisit = bookmarkVisitUrlKeys.has(normalizeScoreUrlKey(bookmark.url));
        if (isPendingBookmarkVisit && !bookmarkHistorySynced) {
          bookmarkVisitSyncFailed = true;
          continue;
        }
        const updated = await updateSingleBookmarkScore(bookmark.id, { skipHistoryBackfill: true });
        if (updated !== true) scoreUpdateFailed = true;
      }
      if (scoreUpdateFailed) {
        queueRecommendScoresCacheRepair('incremental-bookmark-score-update-failed');
      }
      if (bookmarkVisitUrls.size > 0 && historySynced && !bookmarkVisitSyncFailed) {
        bookmarkVisitBatchCanClearDirty = true;
        await clearBookmarkVisitHistoryDirtyIfSettled();
      }
    } catch (e) {
    } finally {
      urlUpdateInFlight = false;
      if (bookmarkVisitUrls.size > 0 && bookmarkVisitBatchCanClearDirty) {
        await clearBookmarkVisitHistoryDirtyIfSettled();
      }
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

function normalizeBookmarkBulkTaskCheckpoint(task) {
  const source = task && typeof task === 'object' ? task : {};
  const scoreIds = normalizeBookmarkIdList(source.scoreIds || []).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS);
  const movedIds = normalizeBookmarkIdList(source.movedIds || []).slice(0, BOOKMARK_MUTATION_QUEUE_MAX_ITEMS);
  const changedUrls = normalizeBookmarkMutationQueueUrlList(source.changedUrls || []);
  const total = scoreIds.length;
  const cursor = Math.max(0, Math.min(total, Math.floor(Number(source.cursor) || 0)));
  const stage = ['score', 'moved', 'favicon', 'done', 'failed'].includes(source.stage)
    ? source.stage
    : 'score';
  const now = Date.now();

  return {
    version: 1,
    taskId: String(source.taskId || `mutation-${now}`).trim(),
    type: String(source.type || 'bookmark-mutation'),
    stage,
    scoreIds,
    movedIds,
    changedUrls,
    cursor,
    completed: Math.max(0, Math.min(total, Math.floor(Number(source.completed ?? cursor) || 0))),
    total,
    chunkSize: Math.max(1, Math.floor(Number(source.chunkSize) || BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE)),
    needContinue: source.needContinue !== false && stage !== 'done',
    queuedAt: Number.isFinite(Number(source.queuedAt)) && Number(source.queuedAt) > 0
      ? Number(source.queuedAt)
      : now,
    updatedAt: Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
      ? Number(source.updatedAt)
      : now,
    lastSuccessAt: Number.isFinite(Number(source.lastSuccessAt)) && Number(source.lastSuccessAt) > 0
      ? Number(source.lastSuccessAt)
      : 0,
    lastError: String(source.lastError || '')
  };
}

function hasBookmarkBulkTaskCheckpoint(task) {
  const normalized = normalizeBookmarkBulkTaskCheckpoint(task);
  if (!normalized.needContinue || normalized.stage === 'done') return false;
  return normalized.scoreIds.length > normalized.cursor
    || normalized.movedIds.length > 0
    || normalized.changedUrls.length > 0;
}

async function writeBookmarkBulkTaskCheckpoint(taskPatch = {}) {
  const task = normalizeBookmarkBulkTaskCheckpoint({
    ...(taskPatch || {}),
    updatedAt: Date.now()
  });
  await browserAPI.storage.local.set({ [BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY]: task });
  return task;
}

async function clearBookmarkBulkTaskCheckpoint(reason = '') {
  try {
    await browserAPI.storage.local.remove([BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY]);
    return { success: true, reason };
  } catch (error) {
    return { success: false, reason, error: error?.message || String(error) };
  }
}

async function restoreBookmarkBulkTaskCheckpoint(reason = 'startup') {
  try {
    const result = await browserAPI.storage.local.get([BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY]);
    const task = normalizeBookmarkBulkTaskCheckpoint(result?.[BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY]);
    if (!hasBookmarkBulkTaskCheckpoint(task)) {
      await clearBookmarkBulkTaskCheckpoint(`${reason}:empty`);
      return { success: true, restoredCount: 0, reason };
    }

    if (task.stage === 'score' || task.stage === 'failed') {
      task.scoreIds.slice(task.cursor).forEach(id => pendingChangedScoreBookmarkIds.add(id));
    }
    if (task.stage === 'score' || task.stage === 'moved' || task.stage === 'failed') {
      task.movedIds.forEach(id => pendingMovedBookmarkIds.add(id));
    }
    if (task.stage === 'score' || task.stage === 'moved' || task.stage === 'favicon' || task.stage === 'failed') {
      task.changedUrls.forEach(url => pendingChangedBookmarkUrls.add(url));
    }

    const restoredCount = getPendingBookmarkMutationCount();
    await persistPendingBookmarkMutationQueueNow(`${reason}:bulk-checkpoint`);
    await clearBookmarkBulkTaskCheckpoint(`${reason}:merged`);
    if (restoredCount > 0) {
      queueBookmarkMutationFlush();
    }
    return { success: true, restoredCount, reason };
  } catch (error) {
    return { success: false, restoredCount: 0, reason, error: error?.message || String(error) };
  }
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
      return { success: true, restoredCount, reason };
    } catch (error) {
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
    let bulkCheckpoint = null;
    let checkpointWriteEnabled = true;
    const writeBulkCheckpointBestEffort = async (taskPatch = null) => {
      if (!taskPatch || checkpointWriteEnabled !== true) {
        return null;
      }

      try {
        return await writeBookmarkBulkTaskCheckpoint(taskPatch);
      } catch (error) {
        checkpointWriteEnabled = false;
        console.warn('[Recommend] bulk checkpoint write failed, continue without checkpoint:', error);
        return null;
      }
    };

    if (scoreIds.length > 0 || movedIds.length > 0 || changedUrls.length > 0) {
      bulkCheckpoint = await writeBulkCheckpointBestEffort({
        taskId: `mutation-${Date.now()}`,
        type: 'bookmark-mutation',
        stage: scoreIds.length > 0 ? 'score' : (movedIds.length > 0 ? 'moved' : 'favicon'),
        scoreIds,
        movedIds,
        changedUrls,
        cursor: 0,
        completed: 0,
        total: scoreIds.length,
        chunkSize: BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE,
        needContinue: true,
        queuedAt: bookmarkMutationInFlightState?.queuedAt || Date.now()
      });
    }

    for (let i = 0; i < scoreIds.length; i += BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE) {
      const chunk = scoreIds.slice(i, i + BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE);
      if (chunk.length === 0) continue;
      await updateBookmarkScoresByIds(chunk);
      if (bulkCheckpoint) {
        bulkCheckpoint = await writeBulkCheckpointBestEffort({
          ...bulkCheckpoint,
          stage: 'score',
          cursor: Math.min(i + chunk.length, scoreIds.length),
          completed: Math.min(i + chunk.length, scoreIds.length),
          lastSuccessAt: Date.now(),
          lastError: ''
        });
      }
      if (i + BOOKMARK_MUTATION_FLUSH_CHUNK_SIZE < scoreIds.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    if (movedIds.length > 0) {
      if (bulkCheckpoint) {
        bulkCheckpoint = await writeBulkCheckpointBestEffort({
          ...bulkCheckpoint,
          stage: 'moved',
          cursor: scoreIds.length,
          completed: scoreIds.length,
          lastSuccessAt: Date.now(),
          lastError: ''
        });
      }
      await runMovedScoreMetadataRefresh(movedIds);
    }

    if (changedUrls.length > 0) {
      if (bulkCheckpoint) {
        bulkCheckpoint = await writeBulkCheckpointBestEffort({
          ...bulkCheckpoint,
          stage: 'favicon',
          cursor: scoreIds.length,
          completed: scoreIds.length,
          lastSuccessAt: Date.now(),
          lastError: ''
        });
      }
      for (const url of changedUrls) {
        try {
          browserAPI.runtime.sendMessage({
            action: 'clearFaviconCache',
            url
          }).catch(() => { });
        } catch (_) { }
      }
    }

    await clearBookmarkBulkTaskCheckpoint('flush-complete');

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
    try {
      const result = await browserAPI.storage.local.get([BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY]);
      const task = result?.[BOOKMARK_BULK_TASK_CHECKPOINT_STORAGE_KEY];
      if (task && typeof task === 'object') {
        await writeBookmarkBulkTaskCheckpoint({
          ...task,
          stage: task.stage || 'failed',
          needContinue: true,
          lastError: error?.message || String(error)
        });
      }
    } catch (_) { }
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
    return { success: true, healed: true, reason, ageMs };
  } catch (error) {
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
      const [restoreResult, bulkCheckpointResult, healResult] = await Promise.all([
        restoreBookmarkMutationQueueState(reason),
        restoreBookmarkBulkTaskCheckpoint(reason),
        healStaleBookmarkBulkChangeState(reason)
      ]);

      return {
        success: true,
        reason,
        restoredCount: Number(restoreResult?.restoredCount || 0) + Number(bulkCheckpointResult?.restoredCount || 0),
        healedBulkFlag: healResult?.healed === true
      };
    } catch (error) {
      return { success: false, reason, error: error?.message || String(error) };
    } finally {
      startupRecommendSelfHealPromise = null;
    }
  })();

  return startupRecommendSelfHealPromise;
}

ensureBookmarkUrlIndex().catch(() => {});
ensureBrowsingHistoryLibrarySeeded({ reason: 'background-init' }).catch(() => {});
ensureHistoryBackgroundSyncAlarm().catch(() => {});

async function handleVisitedBookmarkHistory(url) {
  const safeUrl = String(url || '').trim();
  const urlKey = normalizeScoreUrlKey(safeUrl);
  if (!urlKey) return;

  let matched = false;
  let indexAvailable = false;
  try {
    const indexReady = await ensureBookmarkUrlIndex();
    indexAvailable = indexReady === true;
    matched = indexAvailable && (bookmarkUrlIndex.get(urlKey)?.size || 0) > 0;
  } catch (_) { }

  // 只有索引冷启动失败时才用书签 API 做一次精确兜底；
  // 索引已就绪但未命中时绝不能为每个普通网页额外查询书签树。
  if (!matched && !indexAvailable) {
    try {
      const matches = await browserAPI.bookmarks.search({ url: safeUrl });
      matched = Array.isArray(matches) && matches.some(item => !!item?.url);
    } catch (_) { }
  }
  if (!matched) return;

  // 只有命中书签的访问才会进入自动书签历史链路。
  // 该标记是 URL 增量同步失败/后台被挂起时的持久化兜底。
  await markBrowsingHistoryOpenRefreshDirty(BROWSING_HISTORY_BOOKMARK_VISIT_DIRTY_REASON);
  scheduleScoreUpdateByUrl(safeUrl, { historyBookmarkVisit: true });
  invalidateScoreDebugHistoryStatsCache();
}

  if (browserAPI.history && browserAPI.history.onVisited) {
    browserAPI.history.onVisited.addListener((result) => {
      if (result && result.url) {
        handleVisitedBookmarkHistory(result.url).catch(() => {});
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
    syncBrowsingHistoryCacheForUrls([bookmark.url], {
      reason: 'bookmark-created-history-backfill',
      repairRecommendScores: false
    }).catch((error) => {
      console.warn('[Background][HistoryCache] bookmark created history sync failed:', error);
    });
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
      const syncUrls = changeInfo.url ? [changeInfo.url] : [];
      // Bookmark URL changes affect derived matching only. The raw browsing
      // history library keeps old URL visits until browser history deletes them
      // or the user explicitly purges local records.
      (async () => {
        if (syncUrls.length) {
          await syncBrowsingHistoryCacheForUrls(syncUrls, {
            reason: 'bookmark-url-changed-history-backfill',
            repairRecommendScores: false
          });
        }
      })().catch((error) => {
        console.warn('[Background][HistoryCache] bookmark url change sync failed:', error);
      });
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
      ? { dataUrl: '', meta: { attempted: false, hardFailure: false, errorCode: 'invalid_url', resultClass: 'invalid_content' } }
      : null;
  }

  const timeoutMs = Math.max(500, Number(options.timeoutMs) || 4000);
  const maxBytes = Math.max(1024, Number(options.maxBytes) || (512 * 1024));
  const minDimensionPx = Math.max(1, Number(options.minDimensionPx) || 1);
  const includeMeta = options.includeMeta === true;
  const wrap = (dataUrl, meta) => includeMeta ? { dataUrl, meta } : dataUrl;
  const normalizedUrl = String(url).trim();
  const extensionProtocol = (() => {
    try {
      return String(new URL(browserAPI.runtime.getURL('/')).protocol || '').toLowerCase();
    } catch (_) {
      return '';
    }
  })();
  const isFetchableFaviconUrl = (candidateUrl) => {
    const text = String(candidateUrl || '').trim();
    if (!text) return false;
    if (text.startsWith('/')) return true;
    try {
      const protocol = String(new URL(text).protocol || '').toLowerCase();
      if (!protocol) return false;
      if (protocol === 'http:' || protocol === 'https:' || protocol === 'data:' || protocol === 'blob:') {
        return true;
      }
      return Boolean(extensionProtocol && protocol === extensionProtocol);
    } catch (_) {
      return false;
    }
  };
  if (!isFetchableFaviconUrl(normalizedUrl)) {
    return wrap('', {
      attempted: false,
      hardFailure: false,
      errorCode: 'non_fetchable',
      resultClass: 'non_fetchable'
    });
  }
  const isHardFailureStatus = (statusCode) => {
    const code = Number(statusCode);
    if (!Number.isFinite(code)) return false;
    if (code === 0 || code === 408) return true;
    return code >= 500 && code <= 599;
  };
  const classifyFetchException = (error) => {
    const errorName = String(error?.name || '').toLowerCase();
    const errorMessage = String(error?.message || '').toLowerCase();
    if (errorName === 'aborterror') {
      return { errorCode: 'timeout', hardFailure: true, resultClass: 'hard_failure' };
    }
    const looksNonFetchable =
      errorName === 'typeerror' && (
        errorMessage.includes('unsupported') ||
        errorMessage.includes('not supported') ||
        errorMessage.includes('scheme') ||
        errorMessage.includes('protocol') ||
        errorMessage.includes('invalid url') ||
        errorMessage.includes('url is invalid') ||
        errorMessage.includes('not allowed') ||
        errorMessage.includes('only http')
      );
    if (looksNonFetchable) {
      return { errorCode: 'non_fetchable', hardFailure: false, resultClass: 'non_fetchable' };
    }
    return { errorCode: 'fetch_failed', hardFailure: true, resultClass: 'hard_failure' };
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    try { controller.abort(); } catch (_) { }
  }, timeoutMs);

  try {
    const res = await fetch(normalizedUrl, { signal: controller.signal });
    if (!res.ok) {
      const statusCode = Number(res.status) || 0;
      const hardFailure = isHardFailureStatus(statusCode);
      return wrap('', {
        attempted: true,
        statusCode,
        hardFailure,
        errorCode: `http_${statusCode || 0}`,
        resultClass: hardFailure ? 'hard_failure' : 'invalid_content'
      });
    }

    const contentType = String(res.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.startsWith('image/')) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'non_image_content',
        resultClass: 'invalid_content'
      });
    }

    const declaredLength = Number(res.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'payload_too_large',
        resultClass: 'invalid_content'
      });
    }

    const blob = await res.blob();
    if (!blob || blob.size <= 0 || blob.size > maxBytes) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'invalid_blob',
        resultClass: 'invalid_content'
      });
    }

    const dimensions = await readBlobDimensionsBackground(blob);
    if (!dimensions || dimensions.width < minDimensionPx || dimensions.height < minDimensionPx) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'dimension_too_small',
        resultClass: 'invalid_content'
      });
    }

    const dataUrl = await blobToDataUrlBackground(blob);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      return wrap('', {
        attempted: true,
        statusCode: Number(res.status) || 200,
        hardFailure: false,
        errorCode: 'invalid_data_url',
        resultClass: 'invalid_content'
      });
    }
    return wrap(dataUrl, {
      attempted: true,
      statusCode: Number(res.status) || 200,
      hardFailure: false,
      errorCode: '',
      resultClass: 'success'
    });
  } catch (error) {
    const classifiedError = classifyFetchException(error);
    return wrap('', {
      attempted: true,
      hardFailure: classifiedError.hardFailure,
      errorCode: classifiedError.errorCode,
      resultClass: classifiedError.resultClass
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

        const sourceIconUrl = String(tab?.favIconUrl || '');

        const now = Date.now();
        const processKey = `${pageUrl}|${sourceIconUrl || '_favicon_fallback'}`;
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

        let dataUrl = '';
        let fetchMeta = null;

        if (sourceIconUrl) {
          const primaryResult = await fetchImageAsDataUrlBackground(sourceIconUrl, {
            minDimensionPx: 16,
            maxBytes: 512 * 1024,
            timeoutMs: 4000,
            includeMeta: true
          });
          dataUrl = typeof primaryResult?.dataUrl === 'string' ? primaryResult.dataUrl : '';
          fetchMeta = primaryResult && typeof primaryResult.meta === 'object' ? primaryResult.meta : null;
        }

        if (!dataUrl || fetchMeta?.resultClass !== 'success') {
          let fallbackUrl = '';
          try {
            const fallbackPath = `/_favicon?pageUrl=${encodeURIComponent(pageUrl)}&size=32`;
            fallbackUrl = browserAPI?.runtime?.getURL
              ? browserAPI.runtime.getURL(fallbackPath)
              : fallbackPath;
          } catch (_) {
            fallbackUrl = '';
          }
          if (fallbackUrl) {
            const fallbackResult = await fetchImageAsDataUrlBackground(fallbackUrl, {
              minDimensionPx: 16,
              maxBytes: 512 * 1024,
              timeoutMs: 4000,
              includeMeta: true
            });
            dataUrl = typeof fallbackResult?.dataUrl === 'string' ? fallbackResult.dataUrl : '';
            fetchMeta = fallbackResult && typeof fallbackResult.meta === 'object' ? fallbackResult.meta : null;
          }
        }

        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') && fetchMeta?.resultClass === 'success') {
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

        const reviewResult = await markPostponedBookmarkReviewedFromOpenContext({
          bookmarkId,
          url,
          timestamp: Date.now(),
          source: 'extension'
        });
        if (reviewResult?.success === false) {
          console.warn('[ExtensionOpen] auto review failed:', reviewResult?.reason || 'unknown');
        }

        sendResponse({
          success: true,
          reviewHandled: reviewResult?.reviewed === true,
          reviewReason: reviewResult?.reason || ''
        });
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

  if (action === 'getReviewReminderPopupPayload') {
    (async () => {
      try {
        const result = await getReviewReminderPopupPayload(message.keys || []);
        sendResponse(result);
      } catch (e) {
        sendResponse({ success: false, items: [], error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'markReviewReminderNotified') {
    (async () => {
      try {
        const keys = normalizeReviewReminderKeys(message.keys, message.key);
        if (keys.length === 0) {
          sendResponse({ success: false, reason: 'missing_keys' });
          return;
        }
        await markReviewReminderNotified(keys);
        await scheduleReviewReminderAlarm();
        sendResponse({ success: true, keys });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'dismissEmptyReviewReminderPopup') {
    (async () => {
      try {
        clearActiveReviewReminderPopup();
        await scheduleReviewReminderAlarm();
        sendResponse({ success: true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'executeReviewReminderCardAction') {
    (async () => {
      try {
        const bookmarkId = String(message.bookmarkId || '').trim();
        const recommendAction = String(message.recommendAction || '').trim();
        const reminderKeys = normalizeReviewReminderKeys(message.keys, message.key);
        if (!bookmarkId || !recommendAction) {
          sendResponse({ success: false, reason: 'invalid_action' });
          return;
        }
        const result = await executeRecommendCardActionFromReminderPopup(
          recommendAction,
          bookmarkId,
          {
            scope: message.scope,
            delayMs: message.delayMs,
            postponeUntil: message.postponeUntil,
            timestamp: message.timestamp,
            source: 'review_reminder_popup'
          }
        );
        if (result?.success && reminderKeys.length > 0) {
          await markReviewReminderNotified(reminderKeys);
        }
        if (result?.success !== false) {
          clearActiveReviewReminderPopupItem(bookmarkId);
        }
        await scheduleReviewReminderAlarm();
        sendResponse({
          success: result?.success !== false,
          ...(result || {}),
          reminderKeys
        });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'openReviewReminderTarget') {
    (async () => {
      try {
        const keys = normalizeReviewReminderKeys(message.keys, message.key);
        if (message.focusPostponedArchive === true) {
          try {
            await browserAPI.storage.local.set({
              historyRequestedPostponedFocus: {
                section: 'archive',
                time: Date.now()
              }
            });
          } catch (_) {}
        }
        openView('recommend');
        if (keys.length > 0) {
          await markReviewReminderNotified(keys);
          await scheduleReviewReminderAlarm();
        }
        clearActiveReviewReminderPopup();
        sendResponse({ success: true, keys });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'openReviewReminderBookmark') {
    (async () => {
      try {
        const url = String(message.url || '').trim();
        const keys = normalizeReviewReminderKeys(message.keys, message.key);
        if (!url || !/^https?:\/\//i.test(url)) {
          sendResponse({ success: false, error: 'invalid_url' });
          return;
        }
        const tab = await browserAPI.tabs.create({ url });
        if (tab?.id != null) {
          noteAutoBookmarkNavigation({
            tabId: tab.id,
            bookmarkUrl: url,
            bookmarkId: message.bookmarkId || null,
            bookmarkTitle: message.title || '',
            timeStamp: Date.now(),
            source: 'review_reminder_popup'
          });
        }
        const normalizedBookmarkId = String(message.bookmarkId || '').trim();
        if (!normalizedBookmarkId) {
          await scheduleReviewReminderAlarm();
          sendResponse({ success: false, opened: true, reason: 'missing_bookmark_id', keys });
          return;
        }

        const reviewResult = await markPostponedBookmarkReviewedFromOpen(normalizedBookmarkId, {
          timestamp: Date.now(),
          source: 'review_reminder_popup'
        });
        if (reviewResult?.success === false || reviewResult?.reviewed !== true) {
          await scheduleReviewReminderAlarm();
          sendResponse({
            success: false,
            opened: true,
            reason: reviewResult?.reason || 'review_failed_after_open',
            keys
          });
          return;
        }
        if (keys.length > 0) {
          await markReviewReminderNotified(keys);
        }
        if (normalizedBookmarkId) {
          clearActiveReviewReminderPopupItem(normalizedBookmarkId);
        }
        await scheduleReviewReminderAlarm();
        sendResponse({
          success: true,
          keys,
          reviewHandled: reviewResult?.reviewed === true,
          reviewReason: reviewResult?.reason || ''
        });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
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

  if (action === 'executeRecommendCardAction') {
    (async () => {
      try {
        const result = await executeRecommendCardActionState(message || {});
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'updateHistoryCurrentCardData') {
    (async () => {
      try {
        const result = await updateHistoryCurrentCardDataState(message.cardData || [], message.expectedVersion);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'saveHistoryCurrentCardsState') {
    (async () => {
      try {
        const result = await runSerializedRecommendStateMutation(RECOMMEND_STATE_MUTATION_CHANNEL, async () => {
          return saveHistoryCurrentCardsState(
            message.cardIds || [],
            message.flippedIds || [],
            message.cardData || []
          );
        });
        sendResponse({ success: true, currentCards: result });
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

  if (action === 'runBrowsingHistoryCalibration') {
    (async () => {
      try {
        const payload = message?.payload || {};
        const ok = await runBrowsingHistoryCalibration({
          reason: payload.reason || 'manual',
          clearOnly: payload.clearOnly === true,
          requireIdle: payload.requireIdle === true
        });
        if (ok) {
          await resetBrowsingCalibrationState(payload.reason || 'manual');
        }
        sendResponse({ success: ok === true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'ensureBrowsingHistoryCalibrationOnUiOpen') {
    (async () => {
      try {
        const dirtyState = await getBrowsingHistoryOpenRefreshDirtyState();
        if (dirtyState.dirty !== true) {
          sendResponse({ success: true, calibrated: false, skipped: 'history-library-clean' });
          return;
        }

        // 书签访问正在走 1 秒合并的 URL 增量同步时，不抢跑一轮整段校准。
        // 同步完成会主动通知前端刷新；失败则保留 dirty，供下次打开或手动校准兜底。
        if (
          dirtyState.reason === BROWSING_HISTORY_BOOKMARK_VISIT_DIRTY_REASON
          && (urlUpdateTimer || urlUpdateInFlight || pendingBookmarkVisitScoreUrls.size > 0)
        ) {
          sendResponse({ success: true, calibrated: false, skipped: 'bookmark-url-sync-pending' });
          return;
        }

        const reason = dirtyState.reason === 'initial-open-refresh'
          ? 'ui-open-initial-history-refresh'
          : 'ui-open-dirty-history-refresh';
        const ok = await runBrowsingHistoryCalibration({
          reason,
          requireIdle: false
        });
        if (ok) {
          await resetBrowsingCalibrationState(reason);
        }
        sendResponse({ success: ok === true, calibrated: ok === true });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'ensureBrowsingHistoryBackgroundSyncAlarm') {
    (async () => {
      try {
        const result = await ensureHistoryBackgroundSyncAlarm({ force: true });
        sendResponse(result);
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'syncBrowsingHistoryCacheForUrls' || action === 'syncBrowsingHistoryCacheForBookmarkUrls') {
    (async () => {
      try {
        const payload = message?.payload || {};
        const result = await syncBrowsingHistoryCacheForUrls(payload.urls || [], {
          reason: payload.reason || 'manual-url-sync'
        });
        sendResponse(result);
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'purgeBrowsingHistoryCache') {
    (async () => {
      try {
        const result = await purgeBrowsingHistoryCache(message?.payload?.cutoffDateKey);
        sendResponse(result);
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'getBrowsingHistoryStats') {
    (async () => {
      try {
        const result = await getBrowsingHistoryStats();
        sendResponse(result);
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

        if (!url || typeof url !== 'string' || (!url.startsWith('http://') && !url.startsWith('https://'))) {
          sendResponse({ success: false, error: 'Invalid URL' });
          return;
        }

        await syncBrowsingHistoryCacheForUrls([url], {
          reason: 'attributed-bookmark-open-history-backfill',
          repairRecommendScores: false
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
          await updateSingleBookmarkScore(message.bookmarkId, { throwOnFailure: true });
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
        const result = await setRecommendBlockedState(message.blocked, {
          expectedVersion: message.expectedVersion
        });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
      } catch (e) {
        sendResponse({ success: false, error: e?.message || String(e) });
      }
    })();
    return true;
  }

  if (action === 'setRecommendPostponedState') {
    (async () => {
      try {
        const result = await setRecommendPostponedState(message.postponed, {
          expectedVersion: message.expectedVersion
        });
        sendResponse({ success: result?.success !== false, ...(result || {}) });
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

  if (action === 'trimRecommendFlippedBookmarks') {
    (async () => {
      try {
        const result = await trimRecommendFlippedBookmarksState(message.maxItems);
        sendResponse({ success: result?.success !== false, ...(result || {}) });
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
