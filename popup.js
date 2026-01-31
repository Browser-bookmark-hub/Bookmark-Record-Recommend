const browserAPI = (typeof chrome !== 'undefined' && chrome.runtime) ? chrome :
  (typeof browser !== 'undefined' ? browser : null);

const POPUP_RECOMMEND_CARD_COUNT = 3;
const popupRecommendLaterOptionLabels = {
  '3600000': { zh_CN: '1小时后', en: 'In 1 hour' },
  '86400000': { zh_CN: '明天', en: 'Tomorrow' },
  '259200000': { zh_CN: '3天后', en: 'In 3 days' },
  '604800000': { zh_CN: '1周后', en: 'In 1 week' }
};

let popupRecommendLang = 'zh_CN';
let popupRecommendCards = [];
const popupSkippedBookmarks = new Set();
let popupRecommendLoading = false;
let popupOpenCountRecorded = false;
let popupLastSaveTime = 0;
let popupCurrentLaterBookmark = null;
const popupFaviconRequestCache = new Map();

async function incrementPopupOpenCount() {
  if (popupOpenCountRecorded) return false;
  popupOpenCountRecorded = true;

  try {
    const result = await new Promise((resolve) => {
      browserAPI.storage.local.get('recommendRefreshSettings', resolve);
    });

    const DEFAULT_SETTINGS = {
      refreshEveryNOpens: 3,
      refreshAfterHours: 0,
      refreshAfterDays: 0,
      lastRefreshTime: 0,
      openCountSinceRefresh: 0
    };

    const settings = { ...DEFAULT_SETTINGS, ...(result?.recommendRefreshSettings || {}) };
    settings.openCountSinceRefresh = (settings.openCountSinceRefresh || 0) + 1;

    let shouldRefresh = false;
    const now = Date.now();

    if (settings.refreshEveryNOpens > 0 && settings.openCountSinceRefresh >= settings.refreshEveryNOpens) {
      shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterHours > 0 && settings.lastRefreshTime > 0) {
      const hoursSinceRefresh = (now - settings.lastRefreshTime) / 3600000;
      if (hoursSinceRefresh >= settings.refreshAfterHours) shouldRefresh = true;
    }

    if (!shouldRefresh && settings.refreshAfterDays > 0 && settings.lastRefreshTime > 0) {
      const daysSinceRefresh = (now - settings.lastRefreshTime) / 86400000;
      if (daysSinceRefresh >= settings.refreshAfterDays) shouldRefresh = true;
    }

    if (shouldRefresh) {
      settings.openCountSinceRefresh = 0;
      settings.lastRefreshTime = now;
    }

    await new Promise((resolve) => {
      browserAPI.storage.local.set({ recommendRefreshSettings: settings }, resolve);
    });

    return shouldRefresh;
  } catch (_) {
    return false;
  }
}

function showStatus(text, type = 'info') {
  const statusEl = document.getElementById('statusText');
  if (!statusEl) return;
  statusEl.textContent = text;
  if (type === 'success') statusEl.style.color = 'var(--theme-success-color)';
  else if (type === 'error') statusEl.style.color = 'var(--theme-error-color)';
  else statusEl.style.color = 'var(--theme-text-secondary)';
}

async function safeCreateTab({ url }) {
  if (browserAPI && browserAPI.tabs && browserAPI.tabs.create) {
    return browserAPI.tabs.create({ url });
  }
  window.open(url, '_blank');
}

function getRecentFaviconFallback() {
  return 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Cpath fill=%22%23999%22 d=%22M8 0l2.8 5.5 6.2 0.5-4.5 4 1.5 6-5.5-3.5-5.5 3.5 1.5-6-4.5-4 6.2-0.5z%22/%3E%3C/svg%3E';
}

function loadFaviconForRecent(imgElement, url) {
  try {
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
      imgElement.src = getRecentFaviconFallback();
      return;
    }

    const urlObj = new URL(url);
    const domain = urlObj.hostname;
    const faviconSources = [
      `${urlObj.protocol}//${domain}/favicon.ico`,
      `https://icons.duckduckgo.com/ip3/${domain}.ico`,
      `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
    ];

    let index = 0;
    const tryNext = () => {
      if (index >= faviconSources.length) {
        imgElement.src = getRecentFaviconFallback();
        return;
      }
      const testImg = new Image();
      const src = faviconSources[index];
      index += 1;

      let timeoutId = setTimeout(() => {
        testImg.onload = null;
        testImg.onerror = null;
        tryNext();
      }, 3000);

      testImg.onload = () => {
        clearTimeout(timeoutId);
        imgElement.src = src;
      };

      testImg.onerror = () => {
        clearTimeout(timeoutId);
        tryNext();
      };

      testImg.src = src;
    };

    imgElement.src = getRecentFaviconFallback();
    tryNext();
  } catch (_) {
    imgElement.src = getRecentFaviconFallback();
  }
}

function getInternalFaviconUrl(url) {
  try {
    const ua = navigator.userAgent || '';
    if (ua.includes('Edg/')) {
      return `edge://favicon/size/32@2x/${url}`;
    }
    if (ua.includes('Chrome/')) {
      return `chrome://favicon/size/32@2x/${url}`;
    }
  } catch (_) {}
  return null;
}

function getPopupFaviconFromBackground(url) {
  return new Promise((resolve) => {
    if (!browserAPI?.runtime?.sendMessage || !url) {
      resolve(null);
      return;
    }
    browserAPI.runtime.sendMessage({ action: 'getPopupFavicon', url }, (response) => {
      if (browserAPI.runtime.lastError) {
        resolve(null);
      } else {
        resolve(response?.dataUrl || null);
      }
    });
  });
}

function requestPopupFavicon(imgElement, url) {
  if (!imgElement) return;
  if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
    imgElement.src = getRecentFaviconFallback();
    return;
  }

  if (popupFaviconRequestCache.has(url)) {
    popupFaviconRequestCache.get(url).then((dataUrl) => {
      if (dataUrl && imgElement.isConnected) imgElement.src = dataUrl;
    });
    return;
  }

  const task = getPopupFaviconFromBackground(url).then((dataUrl) => {
    if (dataUrl) {
      if (imgElement.isConnected) imgElement.src = dataUrl;
      return dataUrl;
    }
    const internalUrl = getInternalFaviconUrl(url);
    if (internalUrl) {
      imgElement.onerror = () => {
        imgElement.onerror = null;
        loadFaviconForRecent(imgElement, url);
      };
      imgElement.src = internalUrl;
    } else {
      loadFaviconForRecent(imgElement, url);
    }
    return null;
  }).catch(() => {
    loadFaviconForRecent(imgElement, url);
    return null;
  });

  popupFaviconRequestCache.set(url, task);
}

function prefetchPopupFavicons(urls) {
  if (!browserAPI?.runtime?.sendMessage || !Array.isArray(urls) || urls.length === 0) return;
  browserAPI.runtime.sendMessage({ action: 'prefetchPopupFavicons', urls }, () => {});
}

async function prefetchNextPopupBatch(bookmarks, scoresCache, reviewData, postponedList, currentCardIds) {
  try {
    if (!bookmarks || bookmarks.length === 0) return;
    const [flippedList, blockedData] = await Promise.all([
      getPopupFlippedBookmarks(),
      getPopupBlockedBookmarks()
    ]);

    const now = Date.now();
    const flippedSet = new Set(flippedList || []);
    const blockedBookmarks = new Set(blockedData.bookmarks || []);
    const blockedFolders = new Set(blockedData.folders || []);
    const blockedDomains = new Set((blockedData.domains || []).map(normalizeDomain));
    const postponedSet = new Set(
      (postponedList || []).filter(item => item.postponeUntil > now).map(item => item.bookmarkId)
    );
    const currentSet = new Set(currentCardIds || []);

    const baseFilter = (bookmark) => {
      if (!bookmark.url) return false;
      if (flippedSet.has(bookmark.id)) return false;
      if (popupSkippedBookmarks.has(bookmark.id)) return false;
      if (blockedBookmarks.has(bookmark.id)) return false;
      if (postponedSet.has(bookmark.id)) return false;

      if (blockedFolders.size && bookmark.ancestorFolderIds) {
        for (const folderId of bookmark.ancestorFolderIds) {
          if (blockedFolders.has(folderId)) return false;
        }
      }

      if (blockedDomains.size && bookmark.domain) {
        const normalized = normalizeDomain(bookmark.domain);
        if (blockedDomains.has(normalized)) return false;
      }

      return true;
    };

    const available = bookmarks.filter(b => baseFilter(b) && !currentSet.has(b.id));
    if (!available.length) return;

    const candidates = available.map(b => {
      const cached = scoresCache?.[b.id];
      const basePriority = cached ? cached.S : 0.5;
      const priority = calculatePopupPriorityWithReview(basePriority, b.id, reviewData, postponedList);
      return { ...b, priority };
    });

    candidates.sort((a, b) => {
      const diff = b.priority - a.priority;
      if (Math.abs(diff) < 0.01) return Math.random() - 0.5;
      return diff;
    });

    const prefetchList = candidates
      .slice(0, POPUP_RECOMMEND_CARD_COUNT + 6)
      .map(item => item.url)
      .filter(Boolean);

    prefetchPopupFavicons(prefetchList);
  } catch (_) {}
}

async function updatePopupCardDataFavicons(bookmarks) {
  if (!bookmarks || bookmarks.length === 0) return;

  try {
    const currentCards = await getPopupCurrentCards();
    if (!currentCards || !currentCards.cardIds || currentCards.cardIds.length === 0) return;

    const existingMap = new Map();
    if (Array.isArray(currentCards.cardData)) {
      currentCards.cardData.forEach((data) => {
        if (data && data.id) existingMap.set(data.id, data);
      });
    }

    let changed = false;
    const cardData = await Promise.all(bookmarks.map(async (bookmark) => {
      if (!bookmark) return { id: null, title: '', url: '', favicon: null, priority: 0 };
      const existing = existingMap.get(bookmark.id) || {};
      const title = bookmark.title || existing.title || '';
      const url = bookmark.url || existing.url || '';
      let favicon = existing.favicon || existing.faviconUrl || null;

      if (!favicon && url) {
        favicon = await getPopupFaviconFromBackground(url);
      }

      const priority = typeof existing.priority === 'number'
        ? existing.priority
        : (typeof bookmark.priority === 'number' ? bookmark.priority : 0);

      if (title !== (existing.title || '')) changed = true;
      if (favicon && favicon !== (existing.favicon || existing.faviconUrl || null)) changed = true;

      return {
        id: bookmark.id,
        title,
        url,
        favicon,
        priority
      };
    }));

    if (!changed) return;

    await savePopupCurrentCards(currentCards.cardIds, currentCards.flippedIds || [], cardData);
  } catch (_) {}
}

function normalizeDomain(domain) {
  if (!domain) return '';
  return domain.toLowerCase().replace(/^www\./, '');
}

async function getPopupCurrentCards() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['popupCurrentCards'], (result) => {
      resolve(result.popupCurrentCards || null);
    });
  });
}

async function savePopupCurrentCards(cardIds, flippedIds, cardData = null) {
  popupLastSaveTime = Date.now();
  const data = {
    cardIds,
    flippedIds,
    timestamp: Date.now()
  };
  if (cardData) data.cardData = cardData;
  await browserAPI.storage.local.set({ popupCurrentCards: data });
}

async function markPopupCardFlipped(bookmarkId) {
  const currentCards = await getPopupCurrentCards();
  if (!currentCards) return false;
  if (!currentCards.flippedIds.includes(bookmarkId)) {
    currentCards.flippedIds.push(bookmarkId);
    await savePopupCurrentCards(currentCards.cardIds, currentCards.flippedIds);
  }
  return currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));
}

async function getPopupScoresCache() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_scores_cache'], (result) => {
      resolve(result.recommend_scores_cache || {});
    });
  });
}

async function requestComputeScores() {
  return new Promise((resolve) => {
    browserAPI.runtime.sendMessage({ action: 'computeBookmarkScores' }, (response) => {
      if (browserAPI.runtime.lastError) {
        resolve(false);
      } else {
        resolve(response?.success || false);
      }
    });
  });
}

async function getPopupFlippedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['flippedBookmarks'], (result) => {
      resolve(result.flippedBookmarks || []);
    });
  });
}

async function markPopupBookmarkFlipped(bookmarkId) {
  const flipped = await getPopupFlippedBookmarks();
  if (!flipped.includes(bookmarkId)) {
    flipped.push(bookmarkId);
    await browserAPI.storage.local.set({ flippedBookmarks: flipped });
  }

  const result = await new Promise((resolve) => {
    browserAPI.storage.local.get(['flipHistory'], resolve);
  });
  const flipHistory = result.flipHistory || [];
  flipHistory.push({ bookmarkId, timestamp: Date.now() });
  await browserAPI.storage.local.set({ flipHistory });
}

async function fetchAllBookmarksFlat() {
  const tree = await new Promise((resolve) => {
    browserAPI.bookmarks.getTree(resolve);
  });

  if (!tree || !tree.length) return [];

  const results = [];
  function traverse(nodes, ancestorFolderIds = []) {
    nodes.forEach(node => {
      if (node.url) {
        results.push({
          id: node.id,
          title: node.title || node.name || '',
          url: node.url,
          dateAdded: node.dateAdded,
          domain: normalizeDomain((() => {
            try { return new URL(node.url).hostname; } catch (_) { return ''; }
          })()),
          ancestorFolderIds
        });
      }
      if (node.children && node.children.length) {
        const nextAncestors = node.url ? ancestorFolderIds : [...ancestorFolderIds, node.id];
        traverse(node.children, nextAncestors);
      }
    });
  }
  traverse(tree, []);
  return results;
}

async function getPopupBlockedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_blocked'], (result) => {
      resolve(result.recommend_blocked || { bookmarks: [], folders: [], domains: [] });
    });
  });
}

async function blockPopupBookmark(bookmarkId) {
  try {
    const targetList = await new Promise((resolve) => {
    browserAPI.bookmarks.get(bookmarkId, resolve);
  });
  if (!targetList || !targetList.length) return false;

  const targetTitle = targetList[0].title || targetList[0].name || '';
    const allBookmarks = await fetchAllBookmarksFlat();
    const sameTitleBookmarks = allBookmarks.filter(b => b.title === targetTitle);

    const blocked = await getPopupBlockedBookmarks();
    let updated = false;
    sameTitleBookmarks.forEach(bookmark => {
      if (!blocked.bookmarks.includes(bookmark.id)) {
        blocked.bookmarks.push(bookmark.id);
        updated = true;
      }
    });

    if (updated) {
      await browserAPI.storage.local.set({ recommend_blocked: blocked });
    }
    return true;
  } catch (_) {
    return false;
  }
}

async function getPopupPostponedBookmarks() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_postponed'], (result) => {
      resolve(result.recommend_postponed || []);
    });
  });
}

async function postponeRecommendBookmark(bookmarkId, delayMs) {
  const postponed = await getPopupPostponedBookmarks();
  const now = Date.now();
  const existing = postponed.find(item => item.bookmarkId === bookmarkId);

  if (existing) {
    existing.postponeUntil = now + delayMs;
    existing.postponeCount = (existing.postponeCount || 0) + 1;
    existing.updatedAt = now;
  } else {
    postponed.push({
      bookmarkId,
      postponeUntil: now + delayMs,
      postponeCount: 1,
      createdAt: now,
      updatedAt: now
    });
  }

  await browserAPI.storage.local.set({ recommend_postponed: postponed });
}

async function getPopupReviewData() {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(['recommend_reviews'], (result) => {
      resolve(result.recommend_reviews || {});
    });
  });
}

async function recordPopupReview(bookmarkId) {
  const reviews = await getPopupReviewData();
  const now = Date.now();
  const existing = reviews[bookmarkId];

  if (existing) {
    const newInterval = Math.min(existing.interval * 2, 30);
    reviews[bookmarkId] = {
      lastReview: now,
      interval: newInterval,
      reviewCount: existing.reviewCount + 1,
      nextReview: now + newInterval * 24 * 60 * 60 * 1000
    };
  } else {
    reviews[bookmarkId] = {
      lastReview: now,
      interval: 1,
      reviewCount: 1,
      nextReview: now + 24 * 60 * 60 * 1000
    };
  }

  await browserAPI.storage.local.set({ recommend_reviews: reviews });
}

function getPopupReviewStatus(bookmarkId, reviewData) {
  const review = reviewData[bookmarkId];
  if (!review) return { priority: 1 };

  const now = Date.now();
  if (now >= review.nextReview) return { priority: 1.2 };

  const daysSinceReview = (now - review.lastReview) / (1000 * 60 * 60 * 24);
  if (daysSinceReview >= review.interval * 0.7) return { priority: 1.1 };

  return { priority: 0.9 };
}

function calculatePopupPriorityWithReview(basePriority, bookmarkId, reviewData, postponedData) {
  let priority = basePriority;
  const reviewStatus = getPopupReviewStatus(bookmarkId, reviewData);
  priority *= reviewStatus.priority || 1;

  const postponeInfo = postponedData.find(item => item.bookmarkId === bookmarkId);
  if (postponeInfo && postponeInfo.postponeCount > 0) {
    priority *= Math.pow(0.9, postponeInfo.postponeCount);
  }

  return Math.min(priority, 1.5);
}

function resetPopupRecommendCard(card, message) {
  card.classList.add('empty');
  card.classList.remove('flipped');
  card.dataset.bookmarkId = '';

  const titleEl = card.querySelector('.popup-recommend-title');
  if (titleEl) titleEl.textContent = message;
  const priorityEl = card.querySelector('.popup-recommend-priority');
  if (priorityEl) priorityEl.textContent = 'S = --';
  const favicon = card.querySelector('.popup-recommend-favicon');
  if (favicon) favicon.src = getRecentFaviconFallback();

  card.onclick = null;
  card.querySelectorAll('.popup-card-btn').forEach(btn => { btn.onclick = null; });
}

async function openPopupRecommendTarget(url) {
  if (!url) return;
  await safeCreateTab({ url });
}

function populatePopupRecommendCard(card, bookmark, cachedFaviconUrl = null) {
  card.classList.remove('empty');
  card.classList.remove('flipped');
  card.dataset.bookmarkId = bookmark.id;

  const titleEl = card.querySelector('.popup-recommend-title');
  if (titleEl) {
    titleEl.textContent = bookmark.title || bookmark.url || (popupRecommendLang === 'en' ? '(No title)' : '（无标题）');
  }

  const favicon = card.querySelector('.popup-recommend-favicon');
  if (favicon) {
    if (cachedFaviconUrl) {
      favicon.src = cachedFaviconUrl;
    } else {
      favicon.src = getRecentFaviconFallback();
      requestPopupFavicon(favicon, bookmark.url);
    }
  }

  const priorityEl = card.querySelector('.popup-recommend-priority');
  if (priorityEl) {
    priorityEl.textContent = `S = ${bookmark.priority.toFixed(2)}`;
  }

  card.onclick = async (event) => {
    if (event.target.closest('.popup-recommend-actions')) return;
    try {
      await markPopupBookmarkFlipped(bookmark.id);
      await recordPopupReview(bookmark.id);
      await openPopupRecommendTarget(bookmark.url);
      card.classList.add('flipped');
      const allFlipped = await markPopupCardFlipped(bookmark.id);
      if (allFlipped) {
        await refreshPopupRecommendCards(true);
      }
    } catch (_) {
      showStatus(popupRecommendLang === 'en' ? 'Open failed' : '打开失败', 'error');
    }
  };

  const blockBtn = card.querySelector('.popup-card-btn-block');
  if (blockBtn) {
    blockBtn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const success = await blockPopupBookmark(bookmark.id);
      showStatus(success ? (popupRecommendLang === 'en' ? 'Blocked' : '已屏蔽') : (popupRecommendLang === 'en' ? 'Block failed' : '屏蔽失败'), success ? 'success' : 'error');
      await refreshPopupRecommendCards(true);
    };
  }

  const laterBtn = card.querySelector('.popup-card-btn-later');
  if (laterBtn) {
    laterBtn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      popupCurrentLaterBookmark = bookmark;
      showPopupRecommendLaterOverlay();
    };
  }

  const skipBtn = card.querySelector('.popup-card-btn-skip');
  if (skipBtn) {
    skipBtn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      popupSkippedBookmarks.add(bookmark.id);
      await refreshPopupRecommendCards(true);
    };
  }
}

function showPopupRecommendLaterOverlay() {
  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
}

function hidePopupRecommendLaterOverlay() {
  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (!overlay) return;
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
}

async function refreshPopupRecommendCards(force = false) {
  if (popupRecommendLoading && !force) return;
  const cardsRoot = document.getElementById('bookmarkRecommendCards');
  if (!cardsRoot) return;
  const cards = cardsRoot.querySelectorAll('.popup-recommend-card');
  if (!cards.length) return;

  const shouldAutoRefresh = await incrementPopupOpenCount();
  if (shouldAutoRefresh && !force) {
    force = true;
  }

  popupRecommendLoading = true;

  try {
    const currentCards = await getPopupCurrentCards();
    const bookmarks = await fetchAllBookmarksFlat();
    const bookmarkMap = new Map(bookmarks.map(b => [b.id, b]));

    if (currentCards && currentCards.cardIds && currentCards.cardIds.length > 0 && !force) {
      const allFlipped = currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));
      if (!allFlipped) {
        const reviewData = await getPopupReviewData();
        const postponedList = await getPopupPostponedBookmarks();

        const cachedCardDataMap = new Map();
        if (currentCards.cardData && Array.isArray(currentCards.cardData)) {
          currentCards.cardData.forEach(data => {
            if (data && data.id) {
              cachedCardDataMap.set(data.id, {
                favicon: data.favicon || data.faviconUrl || null,
                priority: data.priority || 0,
                title: data.title || ''
              });
            }
          });
        }

        let scoresCache = await getPopupScoresCache();
        if (Object.keys(scoresCache).length === 0 && bookmarks.length > 0) {
          await requestComputeScores();
          scoresCache = await getPopupScoresCache();
        }

        popupRecommendCards = currentCards.cardIds.map(id => {
          const bookmark = bookmarkMap.get(id);
          if (bookmark) {
            const cached = scoresCache[id];
            const cachedData = cachedCardDataMap.get(id);
            const safeTitle = bookmark.title || bookmark.name || cachedData?.title || '';
            const safeUrl = bookmark.url || cachedData?.url || '';
            const basePriority = cached ? cached.S : (cachedData?.priority || 0.5);
            const priority = calculatePopupPriorityWithReview(basePriority, id, reviewData, postponedList);
            return { ...bookmark, title: safeTitle, url: safeUrl, priority, factors: cached || {} };
          }
          return null;
        }).filter(Boolean);

        prefetchPopupFavicons(popupRecommendCards.map(card => card.url).filter(Boolean));
        setTimeout(() => {
          prefetchNextPopupBatch(bookmarks, scoresCache, reviewData, postponedList, currentCards.cardIds);
        }, 0);
        updatePopupCardDataFavicons(popupRecommendCards);

        cards.forEach((card, index) => {
          const bookmark = popupRecommendCards[index];
          if (bookmark) {
            const cachedData = cachedCardDataMap.get(bookmark.id);
            populatePopupRecommendCard(card, bookmark, cachedData?.favicon || cachedData?.faviconUrl || null);
            if (currentCards.flippedIds.includes(bookmark.id)) {
              card.classList.add('flipped');
            }
          } else {
            resetPopupRecommendCard(card, '--');
          }
        });

        popupRecommendLoading = false;
        return;
      }
    }

    const [flippedList, blockedData, postponedList] = await Promise.all([
      getPopupFlippedBookmarks(),
      getPopupBlockedBookmarks(),
      getPopupPostponedBookmarks()
    ]);

    const now = Date.now();
    const flippedSet = new Set(flippedList || []);
    const blockedBookmarks = new Set(blockedData.bookmarks || []);
    const blockedFolders = new Set(blockedData.folders || []);
    const blockedDomains = new Set((blockedData.domains || []).map(normalizeDomain));
    const postponedSet = new Set(
      postponedList.filter(item => item.postponeUntil > now).map(item => item.bookmarkId)
    );

    const baseFilter = (bookmark) => {
      if (!bookmark.url) return false;
      if (flippedSet.has(bookmark.id)) return false;
      if (popupSkippedBookmarks.has(bookmark.id)) return false;
      if (blockedBookmarks.has(bookmark.id)) return false;
      if (postponedSet.has(bookmark.id)) return false;

      if (blockedFolders.size && bookmark.ancestorFolderIds) {
        for (const folderId of bookmark.ancestorFolderIds) {
          if (blockedFolders.has(folderId)) return false;
        }
      }

      if (blockedDomains.size && bookmark.domain) {
        const normalized = normalizeDomain(bookmark.domain);
        if (blockedDomains.has(normalized)) return false;
      }

      return true;
    };

    const currentCardIds = new Set(
      force && currentCards?.cardIds ? currentCards.cardIds : []
    );

    let availableBookmarks = bookmarks.filter((bookmark) =>
      baseFilter(bookmark) && !currentCardIds.has(bookmark.id)
    );

    if (availableBookmarks.length < POPUP_RECOMMEND_CARD_COUNT && currentCardIds.size > 0) {
      availableBookmarks = bookmarks.filter(baseFilter);
    }

    if (!availableBookmarks.length) {
      popupRecommendCards = [];
      await savePopupCurrentCards([], []);
      cards.forEach((card, index) => {
        const message = index === 0
          ? (popupRecommendLang === 'en' ? 'All bookmarks reviewed!' : '所有书签都已翻阅！')
          : '--';
        resetPopupRecommendCard(card, message);
      });
      popupRecommendLoading = false;
      return;
    }

    const reviewData = await getPopupReviewData();
    let scoresCache = await getPopupScoresCache();
    if (Object.keys(scoresCache).length === 0 && bookmarks.length > 0) {
      await requestComputeScores();
      scoresCache = await getPopupScoresCache();
    }

    const bookmarksWithPriority = availableBookmarks.map(b => {
      const cached = scoresCache[b.id];
      const basePriority = cached ? cached.S : 0.5;
      const priority = calculatePopupPriorityWithReview(basePriority, b.id, reviewData, postponedList);
      return { ...b, priority, factors: cached || {} };
    });

    bookmarksWithPriority.sort((a, b) => {
      if (b.priority === a.priority) return Math.random() - 0.5;
      return b.priority - a.priority;
    });

    popupRecommendCards = bookmarksWithPriority.slice(0, POPUP_RECOMMEND_CARD_COUNT);
    const prefetchList = bookmarksWithPriority
      .slice(0, POPUP_RECOMMEND_CARD_COUNT + 6)
      .map(item => item.url)
      .filter(Boolean);
    prefetchPopupFavicons(prefetchList);
    const newCardIds = popupRecommendCards.map(b => b.id);
    const cardData = popupRecommendCards.map(b => ({
      id: b.id,
      title: b.title || '',
      url: b.url,
      favicon: null,
      priority: b.priority
    }));
    await savePopupCurrentCards(newCardIds, [], cardData);
    updatePopupCardDataFavicons(popupRecommendCards);

    cards.forEach((card, index) => {
      const bookmark = popupRecommendCards[index];
      if (bookmark) {
        populatePopupRecommendCard(card, bookmark, null);
      } else {
        resetPopupRecommendCard(card, '--');
      }
    });
  } catch (_) {
    cards.forEach((card, index) => {
      const message = index === 0
        ? (popupRecommendLang === 'en' ? 'Load failed' : '推荐加载失败')
        : '--';
      resetPopupRecommendCard(card, message);
    });
  } finally {
    popupRecommendLoading = false;
  }
}

function updatePopupLanguage(lang) {
  popupRecommendLang = lang || 'zh_CN';
  const title = document.getElementById('recommendTitle');
  if (title) title.textContent = popupRecommendLang === 'en' ? 'Bookmark Recommend' : '书签推荐';

  const openRecordsBtn = document.getElementById('openRecordsBtn');
  if (openRecordsBtn) openRecordsBtn.textContent = popupRecommendLang === 'en' ? 'Records' : '记录';

  const openRecommendBtn = document.getElementById('openRecommendBtn');
  if (openRecommendBtn) openRecommendBtn.textContent = popupRecommendLang === 'en' ? 'Recommend' : '推荐';

  const laterTitle = document.getElementById('popupRecommendLaterTitle');
  if (laterTitle) laterTitle.textContent = popupRecommendLang === 'en' ? 'Remind later' : '稍后提醒';

  document.querySelectorAll('.popup-later-btn').forEach(btn => {
    const delay = btn.getAttribute('data-delay');
    const text = popupRecommendLaterOptionLabels[delay]?.[popupRecommendLang] || btn.textContent;
    btn.textContent = text;
  });
}

function setupPopupControls() {
  const openRecordsBtn = document.getElementById('openRecordsBtn');
  if (openRecordsBtn) {
    openRecordsBtn.addEventListener('click', async () => {
      const view = 'additions';
      try {
        localStorage.setItem('lastActiveView', view);
      } catch (_) {}
      try {
        await new Promise((resolve) => {
          browserAPI.storage.local.set({
            historyRequestedView: { view, time: Date.now() }
          }, resolve);
        });
      } catch (_) {}
      const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
      const url = `${baseUrl}?view=${view}`;
      await safeCreateTab({ url });
    });
  }

  const openRecommendBtn = document.getElementById('openRecommendBtn');
  if (openRecommendBtn) {
    openRecommendBtn.addEventListener('click', async () => {
      const view = 'recommend';
      try {
        localStorage.setItem('lastActiveView', view);
      } catch (_) {}
      try {
        await new Promise((resolve) => {
          browserAPI.storage.local.set({
            historyRequestedView: { view, time: Date.now() }
          }, resolve);
        });
      } catch (_) {}
      const baseUrl = browserAPI.runtime.getURL('history_html/history.html');
      const url = `${baseUrl}?view=${view}`;
      await safeCreateTab({ url });
    });
  }

  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await refreshPopupRecommendCards(true);
    });
  }

  const overlay = document.getElementById('popupRecommendLaterOverlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hidePopupRecommendLaterOverlay();
    });
  }

  const closeBtn = document.getElementById('popupRecommendLaterClose');
  if (closeBtn) {
    closeBtn.addEventListener('click', hidePopupRecommendLaterOverlay);
  }

  document.querySelectorAll('.popup-later-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const delayMs = Number(btn.getAttribute('data-delay') || 0);
      if (popupCurrentLaterBookmark && delayMs > 0) {
        await postponeRecommendBookmark(popupCurrentLaterBookmark.id, delayMs);
        showStatus(popupRecommendLang === 'en' ? 'Saved for later' : '已稍后提醒', 'success');
        hidePopupRecommendLaterOverlay();
        await refreshPopupRecommendCards(true);
      }
    });
  });
}

function setupStorageSync() {
  if (!browserAPI.storage || !browserAPI.storage.onChanged) return;
  browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.popupCurrentCards) {
      const now = Date.now();
      if (now - popupLastSaveTime < 500) return;
      const newValue = changes.popupCurrentCards.newValue;
      if (newValue && newValue.cardIds && newValue.flippedIds) {
        const allFlipped = newValue.cardIds.every(id => newValue.flippedIds.includes(id));
        if (allFlipped && newValue.cardIds.length > 0) {
          refreshPopupRecommendCards(true);
        }
      }
    }
  });
}

function initPopup() {
  setupPopupControls();
  setupStorageSync();

  browserAPI.storage.local.get(['preferredLang'], (data) => {
    updatePopupLanguage(data.preferredLang || 'zh_CN');
    refreshPopupRecommendCards();
  });
}

document.addEventListener('DOMContentLoaded', initPopup);
