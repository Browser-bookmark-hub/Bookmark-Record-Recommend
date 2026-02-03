// =============================================================================
// 全局变量和常量
// =============================================================================

let currentLang = 'zh_CN';
// [Init] Restore custom language from storage immediately
try {
    const saved = localStorage.getItem('historyViewerCustomLang');
    if (saved === 'en' || saved === 'zh_CN') {
        currentLang = saved;
        // console.log('[History Viewer] Restored language:', currentLang);
    } else {
        try {
            const ui = (chrome?.i18n?.getUILanguage?.() || '').toLowerCase();
            currentLang = ui.startsWith('zh') ? 'zh_CN' : 'en';
        } catch (e) {
        }
    }
} catch (e) { }

window.currentLang = currentLang; // 暴露给其他模块使用
// 允许外部页面限制可用视图（拆分插件时使用）
const DEFAULT_VIEWS = ['additions', 'recommend'];
const ALLOWED_VIEWS = (Array.isArray(window.__ALLOWED_VIEWS) && window.__ALLOWED_VIEWS.length)
    ? window.__ALLOWED_VIEWS
    : DEFAULT_VIEWS;
const DEFAULT_VIEW = (typeof window.__DEFAULT_VIEW === 'string' && ALLOWED_VIEWS.includes(window.__DEFAULT_VIEW))
    ? window.__DEFAULT_VIEW
    : ALLOWED_VIEWS[0];
const isViewAllowed = (view) => ALLOWED_VIEWS.includes(view);
let currentTheme = 'light';
// 从 localStorage 立即恢复视图，避免页面闪烁
// 从 URL 参数或 localStorage 恢复视图
let currentView = (() => {
    try {
        // 1. 优先尝试从 URL 参数获取
        // 注意：此时 window.location.search 可能已经可用
        const params = new URLSearchParams(window.location.search);
        const viewFromUrl = params.get('view');
        if (viewFromUrl) {
            console.log('[全局初始化] URL 参数中的视图:', viewFromUrl);
            return viewFromUrl;
        }

        // 2. 其次尝试从 localStorage 获取
        const saved = localStorage.getItem('lastActiveView');
        console.log('[全局初始化] localStorage中的视图:', saved);
        return saved || DEFAULT_VIEW;
    } catch (e) {
        console.error('[全局初始化] 读取视图失败:', e);
        return DEFAULT_VIEW;
    }
})();
// 尽早暴露给搜索模块，避免搜索模式短暂显示错误
try { window.currentView = currentView; } catch (_) { }
try {
    if (document?.documentElement) {
        document.documentElement.setAttribute('data-initial-view', currentView);
    }
} catch (_) { }

// 用于标记由拖拽操作处理过的移动，防止 applyIncrementalMoveToTree 重复处理
window.__dragMoveHandled = window.__dragMoveHandled || new Set();
console.log('[全局初始化] currentView初始值:', currentView);
let currentTimeFilter = 'all'; // 'all', 'year', 'month', 'day'
let allBookmarks = [];
let currentBookmarkData = null;
let browsingClickRankingStats = null; // 点击排行缓存（基于浏览器历史记录）

const bookmarkUrlSet = new Set();
const bookmarkTitleSet = new Set(); // 书签标题集合（用于标题匹配的实时刷新）
let pendingHistoryRefreshTimer = null;
let pendingHistoryRefreshForceFull = false;

const DATA_CACHE_KEYS = {
    additions: 'bb_cache_additions_v1'
};

let additionsCacheRestored = false;
let saveAdditionsCacheTimer = null;
let browsingHistoryRefreshPromise = null;

function readCachedValue(key) {
    return new Promise((resolve) => {
        const storageArea = getCacheStorageArea();
        if (storageArea) {
            storageArea.get([key], (result) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    console.warn('[Cache] 读取失败:', browserAPI.runtime.lastError.message);
                    resolve(null);
                    return;
                }
                resolve(result ? result[key] : null);
            });
            return;
        }

        try {
            const raw = localStorage.getItem(key);
            resolve(raw ? JSON.parse(raw) : null);
        } catch (error) {
            console.warn('[Cache] 读取 localStorage 失败:', error);
            resolve(null);
        }
    });
}

function writeCachedValue(key, value) {
    return new Promise((resolve) => {
        const storageArea = getCacheStorageArea();
        if (storageArea) {
            storageArea.set({ [key]: value }, () => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    console.warn('[Cache] 写入失败:', browserAPI.runtime.lastError.message);
                }
                resolve();
            });
            return;
        }

        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn('[Cache] 写入 localStorage 失败:', error);
        }
        resolve();
    });
}

function normalizeBookmarkCacheEntry(entry) {
    if (!entry || !entry.url) return null;
    const timestamp = typeof entry.dateAdded === 'number'
        ? entry.dateAdded
        : (entry.dateAdded instanceof Date ? entry.dateAdded.getTime() : Date.now());
    return {
        id: entry.id,
        title: entry.title || entry.url || '',
        url: entry.url || '',
        dateAdded: timestamp,
        parentId: entry.parentId || '',
        path: entry.path || ''
    };
}

async function ensureAdditionsCacheLoaded(skipRender) {
    if (additionsCacheRestored || allBookmarks.length > 0) {
        return;
    }
    try {
        const cached = await readCachedValue(DATA_CACHE_KEYS.additions);
        if (cached && Array.isArray(cached.bookmarks)) {
            allBookmarks = cached.bookmarks
                .map(normalizeBookmarkCacheEntry)
                .filter(Boolean);
            additionsCacheRestored = true;
            rebuildBookmarkUrlSet();
            console.log('[AdditionsCache] 已从缓存恢复记录:', allBookmarks.length);
            if (!skipRender) {
                renderAdditionsView();
            }
        }
    } catch (error) {
        console.warn('[AdditionsCache] 恢复失败:', error);
    }
}

async function persistAdditionsCache() {
    try {
        const payload = {
            timestamp: Date.now(),
            bookmarks: allBookmarks.map(normalizeBookmarkCacheEntry).filter(Boolean)
        };
        await writeCachedValue(DATA_CACHE_KEYS.additions, payload);
        console.log('[AdditionsCache] 已保存:', payload.bookmarks.length);
    } catch (error) {
        console.warn('[AdditionsCache] 保存失败:', error);
    }
}

function scheduleAdditionsCacheSave() {
    if (saveAdditionsCacheTimer) {
        clearTimeout(saveAdditionsCacheTimer);
    }
    saveAdditionsCacheTimer = setTimeout(() => {
        saveAdditionsCacheTimer = null;
        persistAdditionsCache();
    }, 600);
}

function handleAdditionsDataMutation(forceRender = true) {
    additionsCacheRestored = true;
    scheduleAdditionsCacheSave();
    if (forceRender && currentView === 'additions') {
        renderAdditionsView();
    }
}

function addBookmarkToAdditionsCache(bookmark) {
    const normalized = normalizeBookmarkCacheEntry(bookmark);
    if (!normalized) return;
    allBookmarks.push(normalized);
    addUrlToBookmarkSet(normalized.url);
    const normalizedTitle = normalizeBookmarkTitle(normalized.title);
    if (normalizedTitle) {
        bookmarkTitleSet.add(normalizedTitle);
    }
    handleAdditionsDataMutation(true);
}

function removeBookmarkFromAdditionsCache(bookmarkId) {
    if (!bookmarkId) return;
    const index = allBookmarks.findIndex(item => item.id === bookmarkId);
    if (index === -1) return;
    removeUrlFromBookmarkSet(allBookmarks[index].url);
    allBookmarks.splice(index, 1);
    handleAdditionsDataMutation(true);
}

function updateBookmarkInAdditionsCache(bookmarkId, changeInfo = {}) {
    if (!bookmarkId) return;
    const target = allBookmarks.find(item => item.id === bookmarkId);
    if (!target) return;
    const prevUrl = target.url;
    if (typeof changeInfo.title !== 'undefined') {
        target.title = changeInfo.title;
        const normalizedTitle = normalizeBookmarkTitle(changeInfo.title);
        if (normalizedTitle) {
            bookmarkTitleSet.add(normalizedTitle);
        }
    }
    if (typeof changeInfo.url !== 'undefined') {
        target.url = changeInfo.url;
        removeUrlFromBookmarkSet(prevUrl);
        addUrlToBookmarkSet(changeInfo.url);
    }
    handleAdditionsDataMutation(true);
}

function moveBookmarkInAdditionsCache(bookmarkId, moveInfo = {}) {
    if (!bookmarkId) return;
    const target = allBookmarks.find(item => item.id === bookmarkId);
    if (!target) return;
    if (typeof moveInfo.parentId !== 'undefined') {
        target.parentId = moveInfo.parentId;
    }
    handleAdditionsDataMutation(false);
}

function normalizeBookmarkTitle(title) {
    if (!title || typeof title !== 'string') return null;
    const trimmed = title.trim();
    return trimmed || null;
}

function normalizeBookmarkUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return null;
    }
    return url.trim();
}

function rebuildBookmarkUrlSet() {
    bookmarkUrlSet.clear();
    bookmarkTitleSet.clear();
    allBookmarks.forEach(item => {
        const normalized = normalizeBookmarkUrl(item.url);
        if (normalized) {
            bookmarkUrlSet.add(normalized);
        }
        const normalizedTitle = normalizeBookmarkTitle(item.title);
        if (normalizedTitle) {
            bookmarkTitleSet.add(normalizedTitle);
        }
    });
}

function addUrlToBookmarkSet(url) {
    const normalized = normalizeBookmarkUrl(url);
    if (normalized) {
        bookmarkUrlSet.add(normalized);
    }
}

function removeUrlFromBookmarkSet(url) {
    const normalized = normalizeBookmarkUrl(url);
    if (normalized) {
        bookmarkUrlSet.delete(normalized);
    }
}

function scheduleHistoryRefresh({ forceFull = false } = {}) {
    console.log('[History] 安排刷新，forceFull:', forceFull);
    pendingHistoryRefreshForceFull = pendingHistoryRefreshForceFull || forceFull;
    if (pendingHistoryRefreshTimer) {
        clearTimeout(pendingHistoryRefreshTimer);
    }
    pendingHistoryRefreshTimer = setTimeout(() => {
        console.log('[History] 执行刷新，forceFull:', pendingHistoryRefreshForceFull);
        pendingHistoryRefreshTimer = null;
        const shouldForce = pendingHistoryRefreshForceFull;
        pendingHistoryRefreshForceFull = false;
        refreshBrowsingHistoryData({ forceFull: shouldForce, silent: true });
    }, 500);
}

function handleHistoryVisited(result) {
    if (!result || !result.url) return;
    console.log('[History] onVisited:', result.url, 'title:', result.title);
    scheduleHistoryRefresh({ forceFull: false });
}

function handleHistoryVisitRemoved(details) {
    if (!details) return;
    console.log('[History] onVisitRemoved:', details);
    scheduleHistoryRefresh({ forceFull: true });
}

let historyRealtimeBound = false;
let messageListenerRegistered = false;
let historyPollingTimer = null;

function ensureHistoryPolling() {
    if (historyPollingTimer) return;
    // 兜底轮询：防止 onVisited/onVisitRemoved 在某些环境下不触发
    historyPollingTimer = setInterval(() => {
        try {
            if (currentView !== 'additions') return;
            refreshBrowsingHistoryData({ forceFull: false, silent: true });
        } catch (_) { }
    }, 120000); // 2分钟一次
}

function setupBrowsingHistoryRealtimeListeners() {
    if (historyRealtimeBound) {
        console.log('[History] 实时监听器已绑定，跳过');
        return;
    }
    if (!browserAPI.history) {
        console.warn('[History] 浏览器历史API不可用');
        ensureHistoryPolling();
        return;
    }
    if (browserAPI.history.onVisited && typeof browserAPI.history.onVisited.addListener === 'function') {
        console.log('[History] 绑定 onVisited 监听器');
        browserAPI.history.onVisited.addListener(handleHistoryVisited);
        historyRealtimeBound = true;
    }
    if (browserAPI.history.onVisitRemoved && typeof browserAPI.history.onVisitRemoved.addListener === 'function') {
        console.log('[History] 绑定 onVisitRemoved 监听器');
        browserAPI.history.onVisitRemoved.addListener(handleHistoryVisitRemoved);
    }
    if (!historyRealtimeBound) {
        ensureHistoryPolling();
    }
}

async function refreshBrowsingHistoryData(options = {}) {
    const { forceFull = false, silent = false } = options;
    const inst = window.browsingHistoryCalendarInstance;
    if (!inst || typeof inst.loadBookmarkData !== 'function') {
        return;
    }

    if (browsingHistoryRefreshPromise) {
        try {
            await browsingHistoryRefreshPromise;
        } catch (_) {
        }
    }

    const incremental = !forceFull && !!(inst.historyCacheMeta && inst.historyCacheMeta.lastSyncTime);
    browsingHistoryRefreshPromise = (async () => {
        try {
            await inst.loadBookmarkData({ incremental });

            if (typeof rebuildBookmarkUrlSet === 'function' && allBookmarks.length > 0) {
                rebuildBookmarkUrlSet();
            }

            if (typeof inst.render === 'function') {
                inst.render();
            }
            if (typeof inst.updateSelectModeButton === 'function') {
                inst.updateSelectModeButton();
            }

            browsingClickRankingStats = null;
        } catch (error) {
            if (!silent) {
                console.warn('[BrowsingHistory] 刷新失败:', error);
            }
            throw error;
        } finally {
            browsingHistoryRefreshPromise = null;
        }
    })();

    try {
        await browsingHistoryRefreshPromise;
    } catch (_) {
    }
}

// 预加载缓存
let cachedBookmarkTree = null;
let isPreloading = false;

// 图标预加载缓存
const preloadedIcons = new Map();
const iconPreloadQueue = [];

// Favicon 缓存管理（持久化 + 失败缓存）
const FaviconCache = {
    db: null,
    dbName: 'BookmarkFaviconCache',
    dbVersion: 1,
    storeName: 'favicons',
    failureStoreName: 'failures',
    memoryCache: new Map(), // {url: faviconDataUrl}
    failureCache: new Set(), // 失败的域名集合
    pendingRequests: new Map(), // 正在请求的URL，避免重复请求

    // 初始化 IndexedDB
    async init() {
        if (this.db) return;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => {
                reject(request.error);
            };

            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // 创建成功缓存的存储
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'domain' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                }

                // 创建失败缓存的存储
                if (!db.objectStoreNames.contains(this.failureStoreName)) {
                    const failureStore = db.createObjectStore(this.failureStoreName, { keyPath: 'domain' });
                    failureStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
            };
        });
    },

    // 检查URL是否为本地/内网/明显无效
    isInvalidUrl(url) {
        if (!url || typeof url !== 'string') return true;

        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.toLowerCase();

            // 本地地址
            if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
                return true;
            }

            // 内网地址
            if (hostname.match(/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/)) {
                return true;
            }

            // .local 域名
            if (hostname.endsWith('.local')) {
                return true;
            }

            // 文件协议等
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return true;
            }

            return false;
        } catch (e) {
            return true;
        }
    },

    // 从缓存获取favicon
    async get(url) {
        if (this.isInvalidUrl(url)) {
            return null;
        }

        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname;

            // 检查失败缓存
            if (this.failureCache.has(domain)) {
                return 'failed';
            }

            // 检查内存缓存
            if (this.memoryCache.has(domain)) {
                return this.memoryCache.get(domain);
            }

            // 从 IndexedDB 读取
            if (!this.db) await this.init();

            return new Promise((resolve) => {
                const transaction = this.db.transaction([this.storeName, this.failureStoreName], 'readonly');

                // 先检查失败缓存
                const failureStore = transaction.objectStore(this.failureStoreName);
                const failureRequest = failureStore.get(domain);

                failureRequest.onsuccess = () => {
                    if (failureRequest.result) {
                        // 检查失败缓存是否过期（7天）
                        const age = Date.now() - failureRequest.result.timestamp;
                        if (age < 7 * 24 * 60 * 60 * 1000) {
                            this.failureCache.add(domain);
                            resolve('failed');
                            return;
                        }
                    }

                    // 检查成功缓存
                    const store = transaction.objectStore(this.storeName);
                    const request = store.get(domain);

                    request.onsuccess = () => {
                        if (request.result) {
                            // 永久缓存，不检查过期（只有删除书签时才删除缓存）
                            this.memoryCache.set(domain, request.result.dataUrl);
                            resolve(request.result.dataUrl);
                        } else {
                            resolve(null);
                        }
                    };

                    request.onerror = () => resolve(null);
                };

                failureRequest.onerror = () => resolve(null);
            });
        } catch (e) {
            return null;
        }
    },

    // 保存favicon到缓存
    async save(url, dataUrl) {
        if (this.isInvalidUrl(url)) return;

        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname;

            // 更新内存缓存
            this.memoryCache.set(domain, dataUrl);

            // 保存到 IndexedDB
            if (!this.db) await this.init();

            const transaction = this.db.transaction([this.storeName], 'readwrite');
            const store = transaction.objectStore(this.storeName);

            store.put({
                domain: domain,
                dataUrl: dataUrl,
                timestamp: Date.now()
            });

            // 从失败缓存中移除（如果存在）
            this.failureCache.delete(domain);
            this.removeFailure(domain);

        } catch (e) {
            // 静默处理
        }
    },

    // 记录失败
    async saveFailure(url) {
        if (this.isInvalidUrl(url)) return;

        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname;

            // 更新内存缓存
            this.failureCache.add(domain);

            // 保存到 IndexedDB
            if (!this.db) await this.init();

            const transaction = this.db.transaction([this.failureStoreName], 'readwrite');
            const store = transaction.objectStore(this.failureStoreName);

            store.put({
                domain: domain,
                timestamp: Date.now()
            });

        } catch (e) {
            // 静默处理
        }
    },

    // 移除失败记录（当URL被修改时）
    async removeFailure(domain) {
        try {
            if (!this.db) await this.init();

            const transaction = this.db.transaction([this.failureStoreName], 'readwrite');
            const store = transaction.objectStore(this.failureStoreName);
            store.delete(domain);
        } catch (e) {
            // 静默失败
        }
    },

    // 清除特定URL的缓存（用于书签URL修改时）
    async clear(url) {
        if (this.isInvalidUrl(url)) return;

        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname;

            // 清除内存缓存
            this.memoryCache.delete(domain);
            this.failureCache.delete(domain);

            // 清除 IndexedDB
            if (!this.db) await this.init();

            const transaction = this.db.transaction([this.storeName, this.failureStoreName], 'readwrite');
            transaction.objectStore(this.storeName).delete(domain);
            transaction.objectStore(this.failureStoreName).delete(domain);

        } catch (e) {
            // 静默处理
        }
    },

    // 获取favicon（带缓存和请求合并）
    async fetch(url) {
        if (this.isInvalidUrl(url)) {
            return fallbackIcon;
        }

        try {
            const urlObj = new URL(url);
            const domain = urlObj.hostname;

            // 1. 检查缓存
            const cached = await this.get(url);
            if (cached === 'failed') {
                return fallbackIcon;
            }
            if (cached) {
                return cached;
            }

            // 2. 检查是否已有相同请求在进行中（避免重复请求）
            if (this.pendingRequests.has(domain)) {
                return this.pendingRequests.get(domain);
            }

            // 3. 发起新请求
            const requestPromise = this._fetchFavicon(url);
            this.pendingRequests.set(domain, requestPromise);

            try {
                const result = await requestPromise;
                return result;
            } finally {
                this.pendingRequests.delete(domain);
            }

        } catch (e) {
            return fallbackIcon;
        }
    },

    // 实际请求favicon - 多源降级策略
    // 注意：不再直接请求网站的 /favicon.ico，因为某些网站（如需要认证的网站）
    // 可能返回 HTML 页面而非图标，导致浏览器解析其中的 preload 标签并产生警告
    async _fetchFavicon(url) {
        return new Promise(async (resolve) => {
            try {
                const urlObj = new URL(url);
                const domain = urlObj.hostname;

                // 定义多个 favicon 源，按优先级尝试
                // 只使用第三方服务，避免直接请求可能返回 HTML 的网站
                const faviconSources = [
                    // 1. DuckDuckGo（全球可用，国内可访问，推荐首选）
                    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
                    // 2. Google S2（功能强大，但中国大陆被墙）
                    `https://www.google.com/s2/favicons?domain=${domain}&sz=32`
                ];

                // 尝试每个源
                for (let i = 0; i < faviconSources.length; i++) {
                    const faviconUrl = faviconSources[i];
                    const sourceName = ['DuckDuckGo', 'Google S2'][i];

                    const result = await this._tryLoadFavicon(faviconUrl, url, sourceName);
                    if (result && result !== fallbackIcon) {
                        resolve(result);
                        return;
                    }
                }

                // 所有源都失败，记录失败并返回 fallback（静默）
                this.saveFailure(url);
                resolve(fallbackIcon);

            } catch (e) {
                // 静默处理错误
                this.saveFailure(url);
                resolve(fallbackIcon);
            }
        });
    },

    // 尝试从单个源加载 favicon
    async _tryLoadFavicon(faviconUrl, originalUrl, sourceName) {
        return new Promise((resolve) => {
            const img = new Image();
            // 不设置 crossOrigin，避免 CORS 预检请求导致的错误
            // img.crossOrigin = 'anonymous';

            const timeout = setTimeout(() => {
                img.src = '';
                resolve(null); // 超时，尝试下一个源
            }, 3000); // 每个源最多等待3秒

            img.onload = () => {
                clearTimeout(timeout);

                // 检查是否是有效的图片（某些服务器返回1x1的占位图）
                if (img.width < 8 || img.height < 8) {
                    resolve(null);
                    return;
                }

                // 尝试转换为 Base64（可能因 CORS 失败，但不显示错误）
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    const dataUrl = canvas.toDataURL('image/png');

                    // 保存到缓存
                    this.save(originalUrl, dataUrl);
                    resolve(dataUrl);
                } catch (e) {
                    // CORS 限制，直接使用原 URL（静默处理，不输出日志）
                    this.save(originalUrl, faviconUrl);
                    resolve(faviconUrl);
                }
            };

            img.onerror = () => {
                clearTimeout(timeout);
                resolve(null); // 失败，尝试下一个源
            };

            img.src = faviconUrl;
        });
    }
};

// 浏览器 API 兼容性
const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;

function getCacheStorageArea() {
    try {
        if (browserAPI && browserAPI.storage && browserAPI.storage.local) {
            return browserAPI.storage.local;
        }
    } catch (_) {
        // ignore
    }
    return null;
}

// =============================================================================
// 辅助函数 - URL 处理
// =============================================================================

// 安全地获取网站图标 URL（同步版本，用于兼容旧代码）
// 注意：这个函数会触发后台异步加载，初次调用返回fallbackIcon
function getFaviconUrl(url) {
    if (!url) return fallbackIcon;

    // 验证是否是有效的 HTTP/HTTPS URL
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return fallbackIcon;
    }

    // 检查是否是无效URL
    if (FaviconCache.isInvalidUrl(url)) {
        return fallbackIcon;
    }

    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        // 【关键修复】先检查内存缓存（已预热）
        if (FaviconCache.memoryCache.has(domain)) {
            return FaviconCache.memoryCache.get(domain);
        }

        // 检查失败缓存
        if (FaviconCache.failureCache.has(domain)) {
            return fallbackIcon;
        }

        // 触发后台异步加载（不等待结果）
        // 注意：由于已预热缓存，
        // 这里只是作为兜底机制，处理动态添加的书签
        FaviconCache.fetch(url).then(dataUrl => {
            // 加载完成后，查找并更新所有使用这个URL的img标签
            if (dataUrl && dataUrl !== fallbackIcon) {
                updateFaviconImages(url, dataUrl);
            }
        });

        // 立即返回 fallback 图标作为占位符
        return fallbackIcon;
    } catch (error) {
        return fallbackIcon;
    }
}

// 更新页面上所有指定URL的favicon图片
function updateFaviconImages(url, dataUrl) {
    let updatedCount = 0;
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname;

        // 查找所有相关的img标签（通过data-favicon-domain或父元素的data-node-url/data-bookmark-url）
        const allImages = document.querySelectorAll('img.addition-icon, img.tracking-favicon, img.ranking-favicon, img.add-result-favicon, img.heatmap-detail-favicon, img.search-result-favicon');

        allImages.forEach(img => {
            // 优先检查 img 元素自身的 data-bookmark-url 属性（搜索结果场景）
            let itemUrl = img.dataset.bookmarkUrl;

            // 如果 img 自身没有，再检查父元素
            if (!itemUrl) {
                const item = img.closest('[data-node-url], [data-bookmark-url]');
                if (item) {
                    itemUrl = item.dataset.nodeUrl || item.dataset.bookmarkUrl;
                }
            }

            if (itemUrl) {
                try {
                    const itemDomain = new URL(itemUrl).hostname;
                    if (itemDomain === domain) {
                        // 更新图标
                        img.src = dataUrl;

                        // 如果图片之前是隐藏的（被黄色书签图标替代），现在显示它
                        if (img.style.display === 'none') {
                            img.style.display = '';
                            // 隐藏相邻的 fallback 图标（可能是 previousSibling 或在同一父容器中）
                            const prevSibling = img.previousElementSibling;
                            if (prevSibling && prevSibling.classList.contains('search-result-icon-box-inline')) {
                                prevSibling.style.display = 'none';
                            } else {
                                // 在父容器中查找 fallback 图标
                                const parent = img.parentElement;
                                if (parent) {
                                    const fallbackIcon = parent.querySelector('.search-result-icon-box-inline');
                                    if (fallbackIcon) {
                                        fallbackIcon.style.display = 'none';
                                    }
                                }
                            }
                        }

                        updatedCount++;
                    }
                } catch (e) {
                    // 忽略无效URL
                }
            }
        });
    } catch (e) {
        // 静默处理
    }
    return updatedCount;
}

// 全局图片错误处理（使用事件委托，避免CSP内联事件处理器）
function setupGlobalImageErrorHandler() {
    document.addEventListener('error', (e) => {
        if (e.target.tagName === 'IMG' &&
            (e.target.classList.contains('addition-icon') ||
                e.target.classList.contains('tracking-favicon') ||
                e.target.classList.contains('card-favicon') ||
                e.target.classList.contains('ranking-favicon') ||
                e.target.classList.contains('add-result-favicon') ||
                e.target.classList.contains('heatmap-detail-favicon') ||
                e.target.classList.contains('search-result-favicon'))) {
            // 只在src不是fallbackIcon时才替换，避免无限循环
            // fallbackIcon 是 data URL，不会加载失败
            if (e.target.src !== fallbackIcon && !e.target.src.startsWith('data:image/svg+xml')) {
                e.target.src = fallbackIcon;
            }
        }
    }, true); // 使用捕获阶段
}

// 异步获取favicon（推荐使用，支持完整缓存）
async function getFaviconUrlAsync(url) {
    if (!url) return fallbackIcon;

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        return fallbackIcon;
    }

    return await FaviconCache.fetch(url);
}

// Fallback 图标 - 星标书签图标
const fallbackIcon = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Cpath fill=%22%23999%22 d=%22M8 0l2.8 5.5 6.2 0.5-4.5 4 1.5 6-5.5-3.5-5.5 3.5 1.5-6-4.5-4 6.2-0.5z%22/%3E%3C/svg%3E';

// Edge/Chrome 内置页面 scheme 不同（仅用于展示/跳转提示）
const internalScheme = (navigator.userAgent || '').includes('Edg/') ? 'edge://' : 'chrome://';

// =============================================================================
// 国际化文本
// =============================================================================

const i18n = {pageTitle: {
        'zh_CN': '书签推荐 & 记录',
        'en': 'Bookmark Recommend & Records'
    },pageSubtitle: {
        'zh_CN': '',
        'en': ''
    },searchPlaceholder: {
        'zh_CN': '搜索书签、文件夹...',
        'en': 'Search bookmarks, folders...'
    },searchNoResults: {
        'zh_CN': '没有找到匹配的记录',
        'en': 'No results'
    },helpTooltip: {
        'zh_CN': '开源信息与快捷键',
        'en': 'Open Source Info & Shortcuts'
    },navAdditions: {
        'zh_CN': '书签记录',
        'en': 'Bookmark Records'
    },navRecommend: {
        'zh_CN': '书签推荐',
        'en': 'Bookmark Recommend'
    },additionsTabReview: {
        'zh_CN': '书签添加记录',
        'en': 'Bookmark additions'
    },additionsTabBrowsing: {
        'zh_CN': '书签浏览记录',
        'en': 'Browsing History'
    },additionsTabTracking: {
        'zh_CN': '时间捕捉',
        'en': 'Time Tracking'
    },trackingPanelDesc: {
        'zh_CN': '追踪书签页面的活跃浏览时间',
        'en': 'Track active browsing time on bookmark pages'
    },clearTrackingText: {
        'zh_CN': '清除',
        'en': 'Clear'
    },browsingTabHistory: {
        'zh_CN': '点击记录',
        'en': 'Click History'
    },browsingTabRanking: {
        'zh_CN': '点击排行',
        'en': 'Click Ranking'
    },browsingTabRelated: {
        'zh_CN': '关联记录',
        'en': 'Related History'
    },browsingRankingTitle: {
        'zh_CN': '点击排行',
        'en': 'Click Ranking'
    },browsingRankingDescription: {
        'zh_CN': '基于浏览器历史记录，按点击次数统计当前书签的热门程度。',
        'en': 'Based on browser history, rank your bookmarks by click counts.'
    },browsingRelatedTitle: {
        'zh_CN': '关联记录',
        'en': 'Related History'
    },browsingRelatedDescription: {
        'zh_CN': '显示浏览器历史记录，并用绿色边框凸显书签相关的记录。',
        'en': 'Shows browser history, highlighting bookmark-related entries with green borders.'
    },browsingRelatedBadgeText: {
        'zh_CN': '书签',
        'en': 'Bookmark'
    },browsingRelatedLoadingText: {
        'zh_CN': '正在读取历史记录...',
        'en': 'Loading history...'
    },browsingRelatedFilterDay: {
        'zh_CN': '当天',
        'en': 'Today'
    },browsingRelatedFilterWeek: {
        'zh_CN': '当周',
        'en': 'This Week'
    },browsingRelatedFilterMonth: {
        'zh_CN': '当月',
        'en': 'This Month'
    },browsingRelatedFilterYear: {
        'zh_CN': '当年',
        'en': 'This Year'
    },browsingRelatedFilterAll: {
        'zh_CN': '全部',
        'en': 'All'
    },calendarWeek: {
        'zh_CN': '第{0}周',
        'en': 'Week {0}'
    },calendarMonth: {
        'zh_CN': '{0}月',
        'en': 'Month {0}'
    },calendarMonthDay: {
        'zh_CN': '{0}月{1}日',
        'en': '{0}/{1}'
    },calendarYear: {
        'zh_CN': '{0}年',
        'en': 'Year {0}'
    },calendarYearMonthDay: {
        'zh_CN': '{0}年{1}月{2}日',
        'en': '{0}/{1}/{2}'
    },calendarWeekdays: {
        'zh_CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
        'en': ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    },calendarWeekdaysFull: {
        'zh_CN': ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
        'en': ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    },calendarMonthNames: {
        'zh_CN': ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'],
        'en': ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
    },calendarYearMonth: {
        'zh_CN': '{0}年{1}',
        'en': '{1} {0}'
    },calendarBookmarkCount: {
        'zh_CN': '{0}个',
        'en': '{0}'
    },calendarBookmarksCount: {
        'zh_CN': '{0}个书签',
        'en': '{0} bookmarks'
    },calendarTotalThisMonth: {
        'zh_CN': '本月共 {0} 个书签',
        'en': 'Total {0} bookmarks this month'
    },calendarTotalThisWeek: {
        'zh_CN': '本周共 {0} 个书签',
        'en': 'Total {0} bookmarks this week'
    },calendarTotalThisDay: {
        'zh_CN': '共 {0} 个书签',
        'en': 'Total {0} bookmarks'
    },calendarExpandMore: {
        'zh_CN': '展开更多 (还有{0}个)',
        'en': 'Show more ({0} more)'
    },browsingRankingFilterToday: {
        'zh_CN': '当天',
        'en': 'Today'
    },browsingRankingFilterWeek: {
        'zh_CN': '当周',
        'en': 'This week'
    },browsingRankingFilterMonth: {
        'zh_CN': '当月',
        'en': 'This month'
    },browsingRankingFilterYear: {
        'zh_CN': '当年',
        'en': 'This year'
    },browsingRankingFilterAll: {
        'zh_CN': '全部',
        'en': 'All'
    },browsingRankingEmptyTitle: {
        'zh_CN': '暂无点击记录',
        'en': 'No click records found'
    },browsingRankingEmptyDescription: {
        'zh_CN': '当前时间范围内尚未找到这些书签的访问记录。',
        'en': 'No visit records for your bookmarks were found in the selected time range.'
    },browsingRankingNotSupportedTitle: {
        'zh_CN': '当前环境不支持历史记录统计',
        'en': 'History statistics are not available in this environment'
    },browsingRankingNotSupportedDesc: {
        'zh_CN': '请确认扩展已获得浏览器的历史记录权限。',
        'en': 'Please ensure the extension has permission to access browser history.'
    },browsingRankingNoBookmarksTitle: {
        'zh_CN': '暂无书签可统计',
        'en': 'No bookmarks to analyze'
    },browsingCalendarLoading: {
        'zh_CN': '正在加载日历...',
        'en': 'Loading calendar...'
    },timeTrackingWidgetTitle: {
        'zh_CN': '时间捕捉',
        'en': 'Time Tracking'
    },timeTrackingWidgetEmpty: {
        'zh_CN': '暂无追踪中的书签',
        'en': 'No bookmarks being tracked'
    },timeTrackingWidgetMore: {
        'zh_CN': '还有 {count} 个...',
        'en': '{count} more...'
    },timeTrackingWidgetRankingTitle: {
        'zh_CN': '点击排行',
        'en': 'Click Ranking'
    },shortcutsModalTitle: {
        'zh_CN': '开源信息与快捷键',
        'en': 'Open Source Info & Shortcuts'
    },openSourceGithubLabel: {
        'zh_CN': 'GitHub 仓库:',
        'en': 'GitHub Repository:'
    },openSourceIssueLabel: {
        'zh_CN': '问题反馈:',
        'en': 'Feedback / Issues:'
    },openSourceIssueText: {
        'zh_CN': '提交问题',
        'en': 'Submit Issue'
    },shortcutsTitle: {
        'zh_CN': '当前可用快捷键',
        'en': 'Available Shortcuts'
    },shortcutsTableHeaderKey: {
        'zh_CN': '按键',
        'en': 'Key'
    },shortcutsTableHeaderAction: {
        'zh_CN': '功能',
        'en': 'Action'
    },shortcutsSettingsTooltip: {
        'zh_CN': '在浏览器中管理快捷键',
        'en': 'Manage shortcuts in browser'
    },shortcutAdditions: {
        'zh_CN': '打开「书签记录」视图',
        'en': 'Open "Bookmark Records" view'
    },shortcutRecommend: {
        'zh_CN': '打开「书签推荐」视图',
        'en': 'Open "Bookmark Recommend" view'
    },closeShortcutsText: {
        'zh_CN': '关闭',
        'en': 'Close'
    },error: {
        'zh_CN': '失败',
        'en': 'Error'
    },bookmarks: {
        'zh_CN': '书签',
        'en': 'bookmarks'
    },emptyAdditions: {
        'zh_CN': '暂无书签记录',
        'en': 'No bookmark records'
    },loading: {
        'zh_CN': '加载中...',
        'en': 'Loading...'
    },calendarLoading: {
        'zh_CN': '正在加载日历...',
        'en': 'Loading calendar...'
    },currentAscending: {
        'zh_CN': '当前：正序',
        'en': 'Current: Ascending'
    },currentDescending: {
        'zh_CN': '当前：倒序',
        'en': 'Current: Descending'
    },themeTooltip: {
        'zh_CN': '切换主题',
        'en': 'Toggle Theme'
    },langTooltip: {
        'zh_CN': '切换语言',
        'en': 'Switch Language'
    },bookmarkToolboxTitle: {
        'zh_CN': '书签工具箱',
        'en': 'Bookmark Toolbox'
    },trackingToggleOn: {
        'zh_CN': '开启',
        'en': 'On'
    },trackingToggleOff: {
        'zh_CN': '关闭',
        'en': 'Off'
    },trackingClearBtn: {
        'zh_CN': '清除记录',
        'en': 'Clear Records'
    },trackingBlockBtn: {
        'zh_CN': '屏蔽管理',
        'en': 'Block Manager'
    },trackingBlockModalTitle: {
        'zh_CN': '时间追踪屏蔽管理',
        'en': 'Time Tracking Block Manager'
    },trackingBlockedBookmarksTitle: {
        'zh_CN': '已屏蔽书签',
        'en': 'Blocked Bookmarks'
    },trackingBlockedFoldersTitle: {
        'zh_CN': '已屏蔽文件夹',
        'en': 'Blocked Folders'
    },trackingBlockedDomainsTitle: {
        'zh_CN': '已屏蔽域名',
        'en': 'Blocked Domains'
    },trackingBlockedBookmarksEmpty: {
        'zh_CN': '暂无已屏蔽书签',
        'en': 'No blocked bookmarks'
    },trackingBlockedFoldersEmpty: {
        'zh_CN': '暂无已屏蔽文件夹',
        'en': 'No blocked folders'
    },trackingBlockedDomainsEmpty: {
        'zh_CN': '暂无已屏蔽域名',
        'en': 'No blocked domains'
    },addTrackingBlockDomainModalTitle: {
        'zh_CN': '添加屏蔽域名（时间追踪）',
        'en': 'Add Block Domain (Time Tracking)'
    },selectTrackingBlockFolderModalTitle: {
        'zh_CN': '选择要屏蔽的文件夹（时间追踪）',
        'en': 'Select Folder to Block (Time Tracking)'
    },addTrackingBlockBookmarkModalTitle: {
        'zh_CN': '添加屏蔽书签（时间追踪）',
        'en': 'Add Block Bookmark (Time Tracking)'
    },trackingBlockBookmarkTabTracking: {
        'zh_CN': '正在追踪',
        'en': 'Tracking'
    },trackingBlockBookmarkTabRanking: {
        'zh_CN': '综合排行',
        'en': 'Ranking'
    },trackingBlockBookmarkTabTree: {
        'zh_CN': '搜索',
        'en': 'Search'
    },trackingCurrentTitle: {
        'zh_CN': '正在追踪的书签',
        'en': 'Currently Tracking'
    },trackingNoActive: {
        'zh_CN': '暂无正在追踪的书签',
        'en': 'No active tracking sessions'
    },trackingHeaderState: {
        'zh_CN': '状态',
        'en': 'Status'
    },trackingHeaderTitle: {
        'zh_CN': '书签',
        'en': 'Bookmark'
    },trackingHeaderTime: {
        'zh_CN': '综合时间（当前）',
        'en': 'Composite Time (Current)'
    },trackingHeaderWakes: {
        'zh_CN': '唤醒',
        'en': 'Wakes'
    },trackingHeaderRatio: {
        'zh_CN': '活跃',
        'en': 'Active'
    },trackingRankingTitle: {
        'zh_CN': '综合排行',
        'en': 'Ranking'
    },trackingRankingTypeComposite: {
        'zh_CN': '综合时间',
        'en': 'Composite Time'
    },trackingRankingTypeWakes: {
        'zh_CN': '唤醒次数',
        'en': 'Wake Count'
    },trackingRangeToday: {
        'zh_CN': '今天',
        'en': 'Today'
    },trackingRangeWeek: {
        'zh_CN': '本周',
        'en': 'This Week'
    },trackingRangeMonth: {
        'zh_CN': '本月',
        'en': 'This Month'
    },trackingRangeYear: {
        'zh_CN': '当年',
        'en': 'This Year'
    },trackingRangeAll: {
        'zh_CN': '全部',
        'en': 'All Time'
    },trackingNoData: {
        'zh_CN': '暂无活跃时间数据',
        'en': 'No active time data'
    },trackingClearRangeConfirm: {
        'zh_CN': '确定要清除{range}以前的综合排行数据吗？',
        'en': 'Are you sure you want to clear ranking data older than {range}?'
    },trackingClearCurrentConfirm: {
        'zh_CN': '确定要清除正在追踪的会话吗？',
        'en': 'Are you sure you want to clear current tracking sessions?'
    },trackingClearRange: {
        'zh_CN': { week: '一周', month: '一个月', year: '一年', all: '全部' },
        'en': { week: '1 week', month: '1 month', year: '1 year', all: 'all time' }
    },trackingClearedCount: {
        'zh_CN': '已清除 {count} 条记录',
        'en': 'Cleared {count} records'
    },trackingLoadFailed: {
        'zh_CN': '排行加载失败',
        'en': 'Failed to load ranking'
    },recommendViewTitle: {
        'zh_CN': '书签推荐',
        'en': 'Bookmark Recommendations'
    },recommendHelpTooltip: {
        'zh_CN': '帮助',
        'en': 'Help'
    },legendScore: {
        'zh_CN': '推荐分数',
        'en': 'Score'
    },legendRecall: {
        'zh_CN': '记忆度',
        'en': 'Recall'
    },recallDesc: {
        'zh_CN': '（FSRS遗忘曲线：复习后锐减，逐渐恢复）',
        'en': ' (FSRS curve: drops after review, gradually recovers)'
    },legendFreshness: {
        'zh_CN': '新鲜度',
        'en': 'Freshness'
    },legendColdness: {
        'zh_CN': '冷门度',
        'en': 'Coldness'
    },legendTimeDegree: {
        'zh_CN': '时间度',
        'en': 'Time Degree'
    },legendForgetting: {
        'zh_CN': '遗忘度',
        'en': 'Forgetting'
    },legendLaterReview: {
        'zh_CN': '待复习',
        'en': 'Later Review'
    },laterReviewDesc: {
        'zh_CN': '（手动添加后=1）',
        'en': '(=1 when manually added)'
    },presetDefault: {
        'zh_CN': '默认模式',
        'en': 'Default'
    },presetDefaultTip: {
        'zh_CN': '均衡推荐',
        'en': 'Balanced recommendation'
    },presetArchaeology: {
        'zh_CN': '考古模式',
        'en': 'Archaeology'
    },presetArchaeologyTip: {
        'zh_CN': '挖掘尘封已久的书签',
        'en': 'Dig up long-forgotten bookmarks'
    },presetConsolidate: {
        'zh_CN': '巩固模式',
        'en': 'Consolidate'
    },presetConsolidateTip: {
        'zh_CN': '经常访问但还没深入阅读的',
        'en': 'Frequently visited but not deeply read'
    },presetPriority: {
        'zh_CN': '优先巩固',
        'en': 'Priority'
    },presetPriorityTip: {
        'zh_CN': '优先复习手动添加的书签',
        'en': 'Prioritize manually added bookmarks'
    },presetWander: {
        'zh_CN': '漫游模式',
        'en': 'Wander'
    },presetWanderTip: {
        'zh_CN': '随机探索发现',
        'en': 'Random exploration'
    },resetFormulaText: {
        'zh_CN': '恢复默认',
        'en': 'Reset'
    },cardRefreshText: {
        'zh_CN': '刷新推荐',
        'en': 'Refresh'
    },refreshSettingsTitle: {
        'zh_CN': '自动刷新设置',
        'en': 'Auto Refresh Settings'
    },refreshEveryNOpensLabel: {
        'zh_CN': '每打开',
        'en': 'Every'
    },refreshEveryNOpensUnit: {
        'zh_CN': '次刷新',
        'en': 'opens, refresh'
    },refreshAfterHoursLabel: {
        'zh_CN': '距上次刷新超过',
        'en': 'After'
    },refreshAfterHoursUnit: {
        'zh_CN': '小时',
        'en': 'hours'
    },refreshAfterDaysLabel: {
        'zh_CN': '距上次刷新超过',
        'en': 'After'
    },refreshAfterDaysUnit: {
        'zh_CN': '天',
        'en': 'days'
    },refreshSettingsSave: {
        'zh_CN': '保存',
        'en': 'Save'
    },heatmapTitle: {
        'zh_CN': '复习热力图',
        'en': 'Review Heatmap'
    },heatmapLoading: {
        'zh_CN': '热力图数据加载中...',
        'en': 'Loading heatmap data...'
    },postponedTitle: {
        'zh_CN': '待复习',
        'en': 'To Review'
    },priorityModeBadge: {
        'zh_CN': '⚡优先',
        'en': '⚡Priority'
    },postponedEmptyText: {
        'zh_CN': '暂无待复习的书签',
        'en': 'No bookmarks to review'
    },addPostponedModalTitle: {
        'zh_CN': '添加到待复习',
        'en': 'Add to Review'
    },postponedAddBtnTitle: {
        'zh_CN': '添加书签到待复习',
        'en': 'Add bookmarks to review'
    },cardLaterTitle: {
        'zh_CN': '待复习',
        'en': 'To Review'
    },addTabFolder: {
        'zh_CN': '从文件夹',
        'en': 'From folder'
    },addTabSearch: {
        'zh_CN': '搜索书签',
        'en': 'Search bookmarks'
    },addTabDomain: {
        'zh_CN': '按域名',
        'en': 'By domain'
    },addFolderLabel: {
        'zh_CN': '选择文件夹：',
        'en': 'Choose folder:'
    },addCountLabel: {
        'zh_CN': '抽取数量：',
        'en': 'Count:'
    },addSelectAllLabel: {
        'zh_CN': '全部',
        'en': 'All'
    },addModeLabel: {
        'zh_CN': '抽取方式：',
        'en': 'Mode:'
    },addModeRandom: {
        'zh_CN': '随机',
        'en': 'Random'
    },addModeSequential: {
        'zh_CN': '顺序',
        'en': 'Sequential'
    },addIncludeSubfolders: {
        'zh_CN': '包含子文件夹',
        'en': 'Include subfolders'
    },addSearchPlaceholder: {
        'zh_CN': '搜索书签标题或URL...',
        'en': 'Search title or URL...'
    },addSearchEmpty: {
        'zh_CN': '输入关键词搜索书签',
        'en': 'Enter keyword to search bookmarks'
    },addSearchSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },addDomainSearchPlaceholder: {
        'zh_CN': '搜索域名...',
        'en': 'Search domain...'
    },addDomainLoading: {
        'zh_CN': '加载域名列表中...',
        'en': 'Loading domain list...'
    },addDomainSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },addDomainSelectedLabel: {
        'zh_CN': '个域名',
        'en': 'domains'
    },addPostponedCancelText: {
        'zh_CN': '取消',
        'en': 'Cancel'
    },addPostponedConfirmText: {
        'zh_CN': '添加',
        'en': 'Add'
    },blockManageTitle: {
        'zh_CN': '屏蔽管理',
        'en': 'Block Management'
    },blockedBookmarksTitle: {
        'zh_CN': '已屏蔽书签',
        'en': 'Blocked Bookmarks'
    },blockedBookmarksEmptyText: {
        'zh_CN': '暂无已屏蔽书签',
        'en': 'No blocked bookmarks'
    },blockedFoldersTitle: {
        'zh_CN': '已屏蔽文件夹',
        'en': 'Blocked Folders'
    },blockedDomainsTitle: {
        'zh_CN': '已屏蔽域名',
        'en': 'Blocked Domains'
    },blockedFoldersEmptyText: {
        'zh_CN': '暂无已屏蔽文件夹',
        'en': 'No blocked folders'
    },blockedDomainsEmptyText: {
        'zh_CN': '暂无已屏蔽域名',
        'en': 'No blocked domains'
    },addDomainModalTitle: {
        'zh_CN': '添加屏蔽域名',
        'en': 'Add Blocked Domain'
    },addDomainModalDesc: {
        'zh_CN': '输入要屏蔽的域名（如 example.com）：',
        'en': 'Enter domain to block (e.g. example.com):'
    },addDomainCancelBtn: {
        'zh_CN': '取消',
        'en': 'Cancel'
    },addDomainConfirmBtn: {
        'zh_CN': '添加',
        'en': 'Add'
    },selectFolderModalTitle: {
        'zh_CN': '选择要屏蔽的文件夹',
        'en': 'Select Folder to Block'
    },unnamedFolderLabel: {
        'zh_CN': '未命名文件夹',
        'en': 'Untitled folder'
    },laterRecommendLabel: {
        'zh_CN': '根据浏览习惯推荐',
        'en': 'Recommended based on browsing'
    },laterOrText: {
        'zh_CN': '或自定义',
        'en': 'or custom'
    }
,exportTooltip: {
        'zh_CN': '导出记录',
        'en': 'Export Records'
    },exportModalTitle: {
        'zh_CN': '导出书签记录',
        'en': 'Export Bookmarks'
    },exportScopeCurrent: {
        'zh_CN': '当前视图: ',
        'en': 'Current View: '
    },exportBtnProcessing: {
        'zh_CN': '正在处理...',
        'en': 'Processing...'
    },exportSuccessCopy: {
        'zh_CN': '已复制到剪贴板',
        'en': 'Copied to clipboard'
    },exportErrorNoFormat: {
        'zh_CN': '请至少选择一种导出格式',
        'en': 'Please select at least one format'
    },exportErrorNoData: {
        'zh_CN': '当前范围内没有可导出的书签',
        'en': 'No bookmarks to export in current scope'
    },exportRootTitle: {
        'zh_CN': '书签导出',
        'en': 'Bookmark Export'
    },calendarSelectMode: {
        'zh_CN': '勾选',
        'en': 'Select'
    },calendarLocateToday: {
        'zh_CN': '定位至今天',
        'en': 'Locate Today'
    },browsingExportTooltip: {
        'zh_CN': '导出记录',
        'en': 'Export Records'
    },browsingExportModalTitle: {
        'zh_CN': '导出点击记录',
        'en': 'Export Click History'
    }
};
window.i18n = i18n; // 暴露给其他模块使用

// =============================================================================
// 初始化
// =============================================================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log('历史查看器初始化...');

    // ========================================================================
    // 【关键步骤 -1】检测是否需要清除 localStorage（"恢复到初始状态"功能触发）
    // ========================================================================
    try {
        const resetCheck = await new Promise(resolve => {
            browserAPI.storage.local.get(['needClearLocalStorage'], result => resolve(result));
        });

        if (resetCheck && resetCheck.needClearLocalStorage === true) {
            console.log('[初始化] 检测到重置标志，正在清除 localStorage...');

            // 清除当前页面上下文的所有 localStorage
            localStorage.clear();

            // 移除重置标志（避免重复清除）
            await new Promise(resolve => {
                browserAPI.storage.local.remove(['needClearLocalStorage'], resolve);
            });

            console.log('[初始化] localStorage 已清除，重置标志已移除');
        }
    } catch (error) {
        console.warn('[初始化] 检测重置标志时出错:', error);
    }

    // ========================================================================
    // 【关键步骤 0】初始化 Favicon 缓存系统
    // ========================================================================
    try {
        await FaviconCache.init();
    } catch (error) {
        // 静默处理
    }


    // 设置全局图片错误处理（避免CSP内联事件处理器）
    setupGlobalImageErrorHandler();

    // ========================================================================
    // 【关键步骤 1】最优先：立即恢复并应用视图状态
    // ========================================================================
    const urlParams = new URLSearchParams(window.location.search);
    const viewParam = urlParams.get('view');
    let requestedView = null;
    try {
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['historyRequestedView'], resolve);
        });
        const payload = result?.historyRequestedView || null;
        const withinWindow = payload && typeof payload.time === 'number'
            ? (Date.now() - payload.time) < 15000
            : false;
        if (withinWindow && payload?.view) {
            requestedView = payload.view;
        }
    } catch (_) { }

    const updateViewParamInUrl = (view) => {
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('view', view);
            window.history.replaceState({}, '', url.toString());
        } catch (_) { }
    };

    // 优先级：URL参数 > localStorage > 默认值
    if (viewParam && ALLOWED_VIEWS.includes(viewParam)) {
        currentView = viewParam;
        console.log('[初始化] 从URL参数设置视图:', currentView);
        updateViewParamInUrl(currentView);
    } else if (requestedView && ALLOWED_VIEWS.includes(requestedView)) {
        currentView = requestedView;
        console.log('[初始化] 从popup请求设置视图:', currentView);
        updateViewParamInUrl(currentView);
    } else {
        const lastView = localStorage.getItem('lastActiveView');
        if (lastView && ALLOWED_VIEWS.includes(lastView)) {
            currentView = lastView;
            console.log('[初始化] 从localStorage恢复视图:', currentView);
        } else {
            currentView = DEFAULT_VIEW;
            console.log('[初始化] 使用默认视图:', currentView);
        }
        updateViewParamInUrl(currentView);
    }

    if (requestedView) {
        try {
            await new Promise(resolve => {
                browserAPI.storage.local.remove(['historyRequestedView'], resolve);
            });
        } catch (_) { }
    }

    // 如果popup请求打开刷新设置弹窗（推荐视图）
    try {
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['openRecommendRefreshSettings'], resolve);
        });
        if (result?.openRecommendRefreshSettings) {
            setTimeout(() => {
                try { showRefreshSettingsModal(); } catch (_) { }
            }, 200);
            browserAPI.storage.local.remove(['openRecommendRefreshSettings'], () => {});
        }
    } catch (_) { }

    // 立即应用视图状态到DOM
    try { window.currentView = currentView; } catch (_) { }
    console.log('[初始化] >>>立即应用视图状态<<<:', currentView);
    document.querySelectorAll('.nav-tab').forEach(tab => {
        if (tab.dataset.view === currentView) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });
    document.querySelectorAll('.view').forEach(view => {
        if (view.id === `${currentView}View`) {
            view.classList.add('active');
        } else {
            view.classList.remove('active');
        }
    });

    localStorage.setItem('lastActiveView', currentView);
    console.log('[初始化] 视图状态已应用完成');

    // [Search Context Boot] 首次加载时同步 SearchContextManager 的 view/tab/subTab。
    // 这里不能依赖 switchView()，因为初始化阶段是直接改 DOM 来显示视图。
    try {
        if (window.SearchContextManager && typeof window.SearchContextManager.updateContext === 'function') {
            let tab = null;
            let subTab = null;
            if (currentView === 'additions') {
                tab = localStorage.getItem('additionsActiveTab') || 'review';
                if (tab === 'browsing') {
                    subTab = localStorage.getItem('browsingActiveSubTab') || 'history';
                }
            }
            window.SearchContextManager.updateContext(currentView, tab, subTab);
        }
    } catch (_) { }

    // ========================================================================
    // 其他初始化
    // ========================================================================
    console.log('[URL参数] 完整URL:', window.location.href);
    console.log('[URL参数] viewParam:', viewParam);

    // 加载用户设置
    await loadUserSettings();

    // 初始化 UI（此时currentView已经是正确的值）
    initializeUI();

    // 初始化侧边栏收起功能
    initSidebarToggle();
    // 初始化时间捕捉/追踪相关功能（仅在允许 additions 视图时）
    if (isViewAllowed('additions')) {
        initTimeTrackingWidget();
        initTrackingBlockModal();
        initSelectTrackingBlockFolderModal();
        initAddTrackingBlockDomainModal();
        initAddTrackingBlockBookmarkModal();
    }

    // 注册消息监听
    setupRealtimeMessageListener();

    // 先加载基础数据
    console.log('[初始化] 加载基础数据...');
    await loadAllData();

    // 使用智能等待：尝试渲染，如果数据不完整则等待后重试
    // 初始化时强制刷新缓存，确保显示最新数据
    console.log('[初始化] 开始渲染当前视图:', currentView);

    // 根据当前视图渲染
    await renderCurrentView();

    // [View Sync] Ensure the URL param always wins after initial render (protect against late overrides)
    try {
        syncViewFromUrl('init');
        if (!window.__historyViewSyncBound) {
            window.__historyViewSyncBound = true;
            window.addEventListener('pageshow', () => syncViewFromUrl('pageshow'));
            window.addEventListener('popstate', () => syncViewFromUrl('popstate'));
        }
    } catch (_) { }

    // [Favicon Warmup] Preload favicon memory cache to avoid flicker when switching views
    try {
        const rawUrls = allBookmarks
            .map(b => b && b.url)
            .filter(url => url && !FaviconCache.isInvalidUrl(url));
        const MAX_WARMUP = 300;
        const warmUrls = rawUrls.length > MAX_WARMUP ? rawUrls.slice(0, MAX_WARMUP) : rawUrls;
        if (warmUrls.length) {
            setTimeout(async () => {
                try {
                    await warmupFaviconCache(warmUrls);
                    warmUrls.forEach((url) => {
                        try {
                            const domain = new URL(url).hostname;
                            const cached = FaviconCache.memoryCache.get(domain);
                            if (cached && cached !== fallbackIcon) {
                                updateFaviconImages(url, cached);
                            }
                        } catch (_) { }
                    });
                } catch (e) {
                    console.warn('[Favicon预热] 预热失败:', e);
                }
            }, 0);
        }
    } catch (_) { }

    try {
        const titleParam = urlParams.get('t');
        const typeParam = urlParams.get('type'); // 'hyperlink' 或 undefined

        if (titleParam && typeof titleParam === 'string' && titleParam.trim()) {
            // 根据type参数设置不同的标题格式
            if (typeParam === 'hyperlink') {
                // 超链接系统：使用 "Hyperlink N" 格式
                document.title = `Hyperlink ${titleParam.trim()}`;
            } else {
                // 书签系统：直接使用数字
                document.title = titleParam.trim();
            }
        }
    } catch (e) {
        console.warn('[初始化] 设置标题失败:', e);
    }

    // 并行预加载其他视图和图标（不阻塞）
    Promise.all([
        preloadAllViews(),
        preloadCommonIcons()
    ]).then(() => {
        console.log('[初始化] 所有资源预加载完成');
    }).catch(error => {
        console.error('[初始化] 预加载失败:', error);
    });

    // 监听存储变化（实时更新）
    browserAPI.storage.onChanged.addListener(handleStorageChange);

    // 监听书签API变化（实时更新书签树视图）
    setupBookmarkListener();
    if (isViewAllowed('additions') || isViewAllowed('recommend')) {
        setupBrowsingHistoryRealtimeListeners();
    }

    console.log('历史查看器初始化完成');
});

// =============================================================================
// 用户设置
// =============================================================================

// 检查是否有覆盖设置
function hasThemeOverride() {
    try {
        return localStorage.getItem('historyViewerHasCustomTheme') === 'true';
    } catch (e) {
        return false;
    }
}

function hasLangOverride() {
    try {
        return localStorage.getItem('historyViewerHasCustomLang') === 'true';
    } catch (e) {
        return false;
    }
}

// 获取覆盖设置
function getThemeOverride() {
    try {
        return localStorage.getItem('historyViewerCustomTheme');
    } catch (e) {
        return null;
    }
}

function getLangOverride() {
    try {
        return localStorage.getItem('historyViewerCustomLang');
    } catch (e) {
        return null;
    }
}

async function loadUserSettings() {
    return new Promise((resolve) => {
        browserAPI.storage.local.get(['preferredLang', 'currentTheme'], (result) => {
            const mainUILang = result.preferredLang || 'zh_CN';
            const prefersDark = typeof window !== 'undefined'
                && window.matchMedia
                && window.matchMedia('(prefers-color-scheme: dark)').matches;
            const mainUITheme = result.currentTheme || (prefersDark ? 'dark' : 'light');

            // 优先使用覆盖设置，否则使用主UI设置
            if (hasThemeOverride()) {
                currentTheme = getThemeOverride() || mainUITheme;
                console.log('[加载用户设置] 使用History Viewer的主题覆盖:', currentTheme);
            } else {
                currentTheme = mainUITheme;
                console.log('[加载用户设置] 跟随主UI主题:', currentTheme);
            }

            if (hasLangOverride()) {
                currentLang = getLangOverride() || mainUILang;
                window.currentLang = currentLang; // 同步到 window
                console.log('[加载用户设置] 使用History Viewer的语言覆盖:', currentLang);
            } else {
                currentLang = mainUILang;
                window.currentLang = currentLang; // 同步到 window
                console.log('[加载用户设置] 跟随主UI语言:', currentLang);
            }

            // 应用主题
            document.documentElement.setAttribute('data-theme', currentTheme);

            // 更新主题切换按钮图标
            const themeIcon = document.querySelector('#themeToggle i');
            if (themeIcon) {
                themeIcon.className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
            }

            // 应用语言
            applyLanguage();

            // 更新语言切换按钮文本
            const langText = document.querySelector('#langToggle .lang-text');
            if (langText) {
                langText.textContent = currentLang === 'zh_CN' ? 'EN' : '中';
            }

            resolve();
        });
    });
}

function applyLanguage() {
    document.getElementById('pageTitle').textContent = i18n.pageTitle[currentLang];
    const subtitleEl = document.getElementById('pageSubtitle');
    if (subtitleEl) {
        const subtitleText = (i18n.pageSubtitle && i18n.pageSubtitle[currentLang]) ? i18n.pageSubtitle[currentLang] : '';
        subtitleEl.textContent = subtitleText;
        subtitleEl.style.display = subtitleText ? '' : 'none';
    }

    // 搜索框 placeholder 由 SearchContextManager 统一控制
    try {
        if (window.SearchContextManager && typeof window.SearchContextManager.updateUI === 'function') {
            window.SearchContextManager.updateUI();
        } else {
            const searchInput = document.getElementById('searchInput');
            if (searchInput) searchInput.placeholder = i18n.searchPlaceholder[currentLang];
        }
    } catch (_) { }

    try {
        if (typeof renderSearchModeUI === 'function') {
            renderSearchModeUI();
        }
        if (typeof window.updateSearchUILanguage === 'function') {
            window.updateSearchUILanguage();
        }
    } catch (_) { }

    const navAdditionsText = document.getElementById('navAdditionsText');
    if (navAdditionsText) navAdditionsText.textContent = i18n.navAdditions[currentLang];
    const navRecommendText = document.getElementById('navRecommendText');
    if (navRecommendText) navRecommendText.textContent = i18n.navRecommend[currentLang];
    const bookmarkToolboxTitle = document.getElementById('bookmarkToolboxTitle');
    if (bookmarkToolboxTitle) bookmarkToolboxTitle.textContent = i18n.bookmarkToolboxTitle[currentLang];

    const timeTrackingWidgetTitle = document.getElementById('timeTrackingWidgetTitle');
    if (timeTrackingWidgetTitle) timeTrackingWidgetTitle.textContent = i18n.timeTrackingWidgetTitle[currentLang];
    const timeTrackingWidgetEmptyText = document.getElementById('timeTrackingWidgetEmptyText');
    if (timeTrackingWidgetEmptyText) timeTrackingWidgetEmptyText.textContent = i18n.timeTrackingWidgetEmpty[currentLang];

    const themeTooltip = document.getElementById('themeTooltip');
    if (themeTooltip) themeTooltip.textContent = i18n.themeTooltip[currentLang];
    const langTooltip = document.getElementById('langTooltip');
    if (langTooltip) langTooltip.textContent = i18n.langTooltip[currentLang];
    const helpTooltip = document.getElementById('helpTooltip');
    if (helpTooltip) helpTooltip.textContent = i18n.helpTooltip[currentLang];

    const shortcutsModalTitle = document.getElementById('shortcutsModalTitle');
    if (shortcutsModalTitle) shortcutsModalTitle.textContent = i18n.shortcutsModalTitle[currentLang];
    const openSourceGithubLabel = document.getElementById('openSourceGithubLabel');
    if (openSourceGithubLabel) openSourceGithubLabel.textContent = i18n.openSourceGithubLabel[currentLang];
    const openSourceIssueLabel = document.getElementById('openSourceIssueLabel');
    if (openSourceIssueLabel) openSourceIssueLabel.textContent = i18n.openSourceIssueLabel[currentLang];
    const openSourceIssueText = document.getElementById('openSourceIssueText');
    if (openSourceIssueText) openSourceIssueText.textContent = i18n.openSourceIssueText[currentLang];
    const closeShortcutsText = document.getElementById('closeShortcutsText');
    if (closeShortcutsText) closeShortcutsText.textContent = i18n.closeShortcutsText[currentLang];

    const additionsTabReview = document.getElementById('additionsTabReview');
    if (additionsTabReview) additionsTabReview.textContent = i18n.additionsTabReview[currentLang];
    const additionsTabBrowsing = document.getElementById('additionsTabBrowsing');
    if (additionsTabBrowsing) additionsTabBrowsing.textContent = i18n.additionsTabBrowsing[currentLang];
    const additionsTabTracking = document.getElementById('additionsTabTracking');
    if (additionsTabTracking) additionsTabTracking.textContent = i18n.additionsTabTracking[currentLang];

    const trackingPanelDesc = document.getElementById('trackingPanelDesc');
    if (trackingPanelDesc) trackingPanelDesc.textContent = i18n.trackingPanelDesc[currentLang];
    const clearTrackingText = document.getElementById('clearTrackingText');
    if (clearTrackingText) clearTrackingText.textContent = i18n.clearTrackingText[currentLang];

    const calendarLoadingText = document.getElementById('calendarLoadingText');
    if (calendarLoadingText) calendarLoadingText.textContent = i18n.calendarLoading[currentLang];
    const calendarSelectModeText = document.getElementById('calendarSelectModeText');
    if (calendarSelectModeText) calendarSelectModeText.textContent = i18n.calendarSelectMode[currentLang];
    const calendarLocateTodayText = document.getElementById('calendarLocateTodayText');
    if (calendarLocateTodayText) calendarLocateTodayText.textContent = i18n.calendarLocateToday[currentLang];
    const calendarExportTooltip = document.getElementById('calendarExportTooltip');
    if (calendarExportTooltip) calendarExportTooltip.textContent = i18n.exportTooltip[currentLang];
    const exportModalTitle = document.getElementById('exportModalTitle');
    if (exportModalTitle) exportModalTitle.textContent = i18n.exportModalTitle[currentLang];
    if (typeof updateBookmarkCalendarLanguage === 'function') {
        updateBookmarkCalendarLanguage();
    }
    if (typeof updateBrowsingHistoryCalendarLanguage === 'function') {
        updateBrowsingHistoryCalendarLanguage();
    }

    const browsingTabHistory = document.getElementById('browsingTabHistory');
    if (browsingTabHistory) browsingTabHistory.textContent = i18n.browsingTabHistory[currentLang];
    const browsingTabRanking = document.getElementById('browsingTabRanking');
    if (browsingTabRanking) browsingTabRanking.textContent = i18n.browsingTabRanking[currentLang];
    const browsingTabRelated = document.getElementById('browsingTabRelated');
    if (browsingTabRelated) browsingTabRelated.textContent = i18n.browsingTabRelated[currentLang];

    const browsingRankingTitle = document.getElementById('browsingRankingTitle');
    if (browsingRankingTitle) browsingRankingTitle.textContent = i18n.browsingRankingTitle[currentLang];
    const browsingRankingDescription = document.getElementById('browsingRankingDescription');
    if (browsingRankingDescription) browsingRankingDescription.textContent = i18n.browsingRankingDescription[currentLang];
    const browsingRankingFilterDay = document.getElementById('browsingRankingFilterDay');
    if (browsingRankingFilterDay) browsingRankingFilterDay.textContent = i18n.browsingRankingFilterToday[currentLang];
    const browsingRankingFilterWeek = document.getElementById('browsingRankingFilterWeek');
    if (browsingRankingFilterWeek) browsingRankingFilterWeek.textContent = i18n.browsingRankingFilterWeek[currentLang];
    const browsingRankingFilterMonth = document.getElementById('browsingRankingFilterMonth');
    if (browsingRankingFilterMonth) browsingRankingFilterMonth.textContent = i18n.browsingRankingFilterMonth[currentLang];
    const browsingRankingFilterYear = document.getElementById('browsingRankingFilterYear');
    if (browsingRankingFilterYear) browsingRankingFilterYear.textContent = i18n.browsingRankingFilterYear[currentLang];
    const browsingRankingFilterAll = document.getElementById('browsingRankingFilterAll');
    if (browsingRankingFilterAll) browsingRankingFilterAll.textContent = i18n.browsingRankingFilterAll[currentLang];

    const browsingRelatedTitle = document.getElementById('browsingRelatedTitle');
    if (browsingRelatedTitle) browsingRelatedTitle.textContent = i18n.browsingRelatedTitle[currentLang];
    const browsingRelatedDescription = document.getElementById('browsingRelatedDescription');
    if (browsingRelatedDescription) browsingRelatedDescription.textContent = i18n.browsingRelatedDescription[currentLang];
    const browsingRelatedLoadingText = document.getElementById('browsingRelatedLoadingText');
    if (browsingRelatedLoadingText) browsingRelatedLoadingText.textContent = i18n.browsingRelatedLoadingText[currentLang];
    const browsingRelatedFilterDay = document.getElementById('browsingRelatedFilterDay');
    if (browsingRelatedFilterDay) browsingRelatedFilterDay.textContent = i18n.browsingRelatedFilterDay[currentLang];
    const browsingRelatedFilterWeek = document.getElementById('browsingRelatedFilterWeek');
    if (browsingRelatedFilterWeek) browsingRelatedFilterWeek.textContent = i18n.browsingRelatedFilterWeek[currentLang];
    const browsingRelatedFilterMonth = document.getElementById('browsingRelatedFilterMonth');
    if (browsingRelatedFilterMonth) browsingRelatedFilterMonth.textContent = i18n.browsingRelatedFilterMonth[currentLang];
    const browsingRelatedFilterYear = document.getElementById('browsingRelatedFilterYear');
    if (browsingRelatedFilterYear) browsingRelatedFilterYear.textContent = i18n.browsingRelatedFilterYear[currentLang];
    const browsingRelatedFilterAll = document.getElementById('browsingRelatedFilterAll');
    if (browsingRelatedFilterAll) browsingRelatedFilterAll.textContent = i18n.browsingRelatedFilterAll[currentLang];
    const browsingCalendarLoadingText = document.getElementById('browsingCalendarLoadingText');
    if (browsingCalendarLoadingText) browsingCalendarLoadingText.textContent = i18n.browsingCalendarLoading[currentLang];
    const browsingExportTooltip = document.getElementById('browsingCalendarExportTooltip');
    if (browsingExportTooltip) browsingExportTooltip.textContent = i18n.browsingExportTooltip[currentLang];
    const browsingSelectModeText = document.getElementById('browsingCalendarSelectModeText');
    if (browsingSelectModeText) browsingSelectModeText.textContent = i18n.calendarSelectMode[currentLang];
    const browsingLocateTodayText = document.getElementById('browsingCalendarLocateTodayText');
    if (browsingLocateTodayText) browsingLocateTodayText.textContent = i18n.calendarLocateToday[currentLang];
    const browsingExportModalTitle = document.getElementById('browsingExportModalTitle');
    if (browsingExportModalTitle) browsingExportModalTitle.textContent = i18n.browsingExportModalTitle[currentLang];

    const trackingToggleText = document.getElementById('trackingToggleText');
    if (trackingToggleText) {
        trackingToggleText.textContent = trackingToggleText.classList.contains('active')
            ? i18n.trackingToggleOn[currentLang] : i18n.trackingToggleOff[currentLang];
    }
    const clearTrackingBtn = document.getElementById('clearTrackingBtn');
    if (clearTrackingBtn) clearTrackingBtn.title = i18n.trackingClearBtn[currentLang];
    const trackingBlockBtn = document.getElementById('trackingBlockBtn');
    if (trackingBlockBtn) trackingBlockBtn.title = i18n.trackingBlockBtn[currentLang];
    const trackingBlockText = document.getElementById('trackingBlockText');
    if (trackingBlockText) trackingBlockText.textContent = i18n.trackingBlockBtn[currentLang];

    const trackingBlockModalTitle = document.getElementById('trackingBlockModalTitle');
    if (trackingBlockModalTitle) trackingBlockModalTitle.textContent = i18n.trackingBlockModalTitle[currentLang];
    const trackingBlockedBookmarksTitle = document.getElementById('trackingBlockedBookmarksTitle');
    if (trackingBlockedBookmarksTitle) trackingBlockedBookmarksTitle.textContent = i18n.trackingBlockedBookmarksTitle[currentLang];
    const trackingBlockedFoldersTitle = document.getElementById('trackingBlockedFoldersTitle');
    if (trackingBlockedFoldersTitle) trackingBlockedFoldersTitle.textContent = i18n.trackingBlockedFoldersTitle[currentLang];
    const trackingBlockedDomainsTitle = document.getElementById('trackingBlockedDomainsTitle');
    if (trackingBlockedDomainsTitle) trackingBlockedDomainsTitle.textContent = i18n.trackingBlockedDomainsTitle[currentLang];
    const trackingBlockedBookmarksEmptyText = document.getElementById('trackingBlockedBookmarksEmptyText');
    if (trackingBlockedBookmarksEmptyText) trackingBlockedBookmarksEmptyText.textContent = i18n.trackingBlockedBookmarksEmpty[currentLang];
    const trackingBlockedFoldersEmptyText = document.getElementById('trackingBlockedFoldersEmptyText');
    if (trackingBlockedFoldersEmptyText) trackingBlockedFoldersEmptyText.textContent = i18n.trackingBlockedFoldersEmpty[currentLang];
    const trackingBlockedDomainsEmptyText = document.getElementById('trackingBlockedDomainsEmptyText');
    if (trackingBlockedDomainsEmptyText) trackingBlockedDomainsEmptyText.textContent = i18n.trackingBlockedDomainsEmpty[currentLang];
    const addTrackingBlockDomainModalTitle = document.getElementById('addTrackingBlockDomainModalTitle');
    if (addTrackingBlockDomainModalTitle) addTrackingBlockDomainModalTitle.textContent = i18n.addTrackingBlockDomainModalTitle[currentLang];
    const selectTrackingBlockFolderModalTitle = document.getElementById('selectTrackingBlockFolderModalTitle');
    if (selectTrackingBlockFolderModalTitle) selectTrackingBlockFolderModalTitle.textContent = i18n.selectTrackingBlockFolderModalTitle[currentLang];
    const addTrackingBlockBookmarkModalTitle = document.getElementById('addTrackingBlockBookmarkModalTitle');
    if (addTrackingBlockBookmarkModalTitle) addTrackingBlockBookmarkModalTitle.textContent = i18n.addTrackingBlockBookmarkModalTitle[currentLang];
    const trackingBlockBookmarkTabTracking = document.getElementById('trackingBlockBookmarkTabTracking');
    if (trackingBlockBookmarkTabTracking) trackingBlockBookmarkTabTracking.innerHTML = `<i class="fas fa-broadcast-tower"></i> ${i18n.trackingBlockBookmarkTabTracking[currentLang]}`;
    const trackingBlockBookmarkTabRanking = document.getElementById('trackingBlockBookmarkTabRanking');
    if (trackingBlockBookmarkTabRanking) trackingBlockBookmarkTabRanking.innerHTML = `<i class="fas fa-chart-bar"></i> ${i18n.trackingBlockBookmarkTabRanking[currentLang]}`;
    const trackingBlockBookmarkTabTree = document.getElementById('trackingBlockBookmarkTabTree');
    if (trackingBlockBookmarkTabTree) trackingBlockBookmarkTabTree.innerHTML = `<i class="fas fa-search"></i> ${i18n.trackingBlockBookmarkTabTree[currentLang]}`;

    const trackingCurrentTitle = document.getElementById('trackingCurrentTitle');
    if (trackingCurrentTitle) trackingCurrentTitle.textContent = i18n.trackingCurrentTitle[currentLang];
    const trackingNoActiveText = document.getElementById('trackingNoActiveText');
    if (trackingNoActiveText) trackingNoActiveText.textContent = i18n.trackingNoActive[currentLang];
    const trackingHeaderStateText = document.querySelector('#trackingHeaderState .tracking-header-text');
    if (trackingHeaderStateText) trackingHeaderStateText.textContent = i18n.trackingHeaderState[currentLang];
    const trackingHeaderTitle = document.getElementById('trackingHeaderTitle');
    if (trackingHeaderTitle) trackingHeaderTitle.textContent = i18n.trackingHeaderTitle[currentLang];
    const trackingHeaderTime = document.getElementById('trackingHeaderTime');
    if (trackingHeaderTime) trackingHeaderTime.textContent = i18n.trackingHeaderTime[currentLang];
    const trackingHeaderWakes = document.getElementById('trackingHeaderWakes');
    if (trackingHeaderWakes) trackingHeaderWakes.textContent = i18n.trackingHeaderWakes[currentLang];
    const trackingHeaderRatio = document.getElementById('trackingHeaderRatio');
    if (trackingHeaderRatio) trackingHeaderRatio.textContent = i18n.trackingHeaderRatio[currentLang];

    const trackingRankingTitle = document.getElementById('trackingRankingTitle');
    if (trackingRankingTitle) trackingRankingTitle.textContent = i18n.trackingRankingTitle[currentLang];
    const trackingRankingTypeComposite = document.getElementById('trackingRankingTypeComposite');
    if (trackingRankingTypeComposite) trackingRankingTypeComposite.textContent = i18n.trackingRankingTypeComposite[currentLang];
    const trackingRankingTypeWakes = document.getElementById('trackingRankingTypeWakes');
    if (trackingRankingTypeWakes) trackingRankingTypeWakes.textContent = i18n.trackingRankingTypeWakes[currentLang];
    const trackingRangeToday = document.getElementById('trackingRangeToday');
    if (trackingRangeToday) trackingRangeToday.textContent = i18n.trackingRangeToday[currentLang];
    const trackingRangeWeek = document.getElementById('trackingRangeWeek');
    if (trackingRangeWeek) trackingRangeWeek.textContent = i18n.trackingRangeWeek[currentLang];
    const trackingRangeMonth = document.getElementById('trackingRangeMonth');
    if (trackingRangeMonth) trackingRangeMonth.textContent = i18n.trackingRangeMonth[currentLang];
    const trackingRangeYear = document.getElementById('trackingRangeYear');
    if (trackingRangeYear) trackingRangeYear.textContent = i18n.trackingRangeYear[currentLang];
    const trackingRangeAll = document.getElementById('trackingRangeAll');
    if (trackingRangeAll) trackingRangeAll.textContent = i18n.trackingRangeAll[currentLang];
    const trackingNoDataText = document.getElementById('trackingNoDataText');
    if (trackingNoDataText) trackingNoDataText.textContent = i18n.trackingNoData[currentLang];

    const recommendViewTitle = document.getElementById('recommendViewTitle');
    if (recommendViewTitle) recommendViewTitle.textContent = i18n.recommendViewTitle[currentLang];
    const recommendHelpBtn = document.getElementById('recommendHelpBtn');
    if (recommendHelpBtn) recommendHelpBtn.title = i18n.recommendHelpTooltip[currentLang];
    const legendScore = document.getElementById('legendScore');
    if (legendScore) legendScore.textContent = i18n.legendScore[currentLang];
    const legendFreshness = document.getElementById('legendFreshness');
    if (legendFreshness) legendFreshness.textContent = i18n.legendFreshness[currentLang];
    const legendColdness = document.getElementById('legendColdness');
    if (legendColdness) legendColdness.textContent = i18n.legendColdness[currentLang];
    const legendTimeDegree = document.getElementById('legendTimeDegree');
    if (legendTimeDegree) legendTimeDegree.textContent = i18n.legendTimeDegree[currentLang];
    const legendForgetting = document.getElementById('legendForgetting');
    if (legendForgetting) legendForgetting.textContent = i18n.legendForgetting[currentLang];
    const legendLaterReview = document.getElementById('legendLaterReview');
    if (legendLaterReview) legendLaterReview.textContent = i18n.legendLaterReview[currentLang];
    const legendRecall = document.getElementById('legendRecall');
    if (legendRecall) legendRecall.textContent = i18n.legendRecall[currentLang];
    const recallDesc = document.getElementById('recallDesc');
    if (recallDesc) recallDesc.textContent = i18n.recallDesc[currentLang];
    const laterReviewDesc = document.getElementById('laterReviewDesc');
    if (laterReviewDesc) laterReviewDesc.textContent = i18n.laterReviewDesc[currentLang];

    document.querySelectorAll('.preset-btn').forEach(btn => {
        const id = btn.getAttribute('data-mode');
        const span = btn.querySelector('span');
        if (!span) return;
        if (id === 'default') {
            span.textContent = i18n.presetDefault[currentLang];
            btn.title = i18n.presetDefaultTip[currentLang];
        } else if (id === 'archaeology') {
            span.textContent = i18n.presetArchaeology[currentLang];
            btn.title = i18n.presetArchaeologyTip[currentLang];
        } else if (id === 'consolidate') {
            span.textContent = i18n.presetConsolidate[currentLang];
            btn.title = i18n.presetConsolidateTip[currentLang];
        } else if (id === 'wander') {
            span.textContent = i18n.presetWander[currentLang];
            btn.title = i18n.presetWanderTip[currentLang];
        } else if (id === 'priority') {
            span.textContent = i18n.presetPriority[currentLang];
            btn.title = i18n.presetPriorityTip[currentLang];
        }
    });

    const resetFormulaText = document.getElementById('resetFormulaText');
    if (resetFormulaText) resetFormulaText.textContent = i18n.resetFormulaText[currentLang];
    const cardRefreshText = document.getElementById('cardRefreshText');
    if (cardRefreshText) cardRefreshText.textContent = i18n.cardRefreshText[currentLang];

    const refreshSettingsTitle = document.getElementById('refreshSettingsTitle');
    if (refreshSettingsTitle) refreshSettingsTitle.textContent = i18n.refreshSettingsTitle[currentLang];
    const refreshEveryNOpensLabel = document.getElementById('refreshEveryNOpensLabel');
    if (refreshEveryNOpensLabel) refreshEveryNOpensLabel.textContent = i18n.refreshEveryNOpensLabel[currentLang];
    const refreshEveryNOpensUnit = document.getElementById('refreshEveryNOpensUnit');
    if (refreshEveryNOpensUnit) refreshEveryNOpensUnit.textContent = i18n.refreshEveryNOpensUnit[currentLang];
    const refreshAfterHoursLabel = document.getElementById('refreshAfterHoursLabel');
    if (refreshAfterHoursLabel) refreshAfterHoursLabel.textContent = i18n.refreshAfterHoursLabel[currentLang];
    const refreshAfterHoursUnit = document.getElementById('refreshAfterHoursUnit');
    if (refreshAfterHoursUnit) refreshAfterHoursUnit.textContent = i18n.refreshAfterHoursUnit[currentLang];
    const refreshAfterDaysLabel = document.getElementById('refreshAfterDaysLabel');
    if (refreshAfterDaysLabel) refreshAfterDaysLabel.textContent = i18n.refreshAfterDaysLabel[currentLang];
    const refreshAfterDaysUnit = document.getElementById('refreshAfterDaysUnit');
    if (refreshAfterDaysUnit) refreshAfterDaysUnit.textContent = i18n.refreshAfterDaysUnit[currentLang];
    const refreshSettingsSaveText = document.getElementById('refreshSettingsSaveText');
    if (refreshSettingsSaveText) refreshSettingsSaveText.textContent = i18n.refreshSettingsSave[currentLang];

    const heatmapTitle = document.getElementById('heatmapTitle');
    if (heatmapTitle) heatmapTitle.textContent = i18n.heatmapTitle[currentLang];
    const heatmapLoadingText = document.getElementById('heatmapLoadingText');
    if (heatmapLoadingText) heatmapLoadingText.textContent = i18n.heatmapLoading[currentLang];

    const postponedTitle = document.getElementById('postponedTitle');
    if (postponedTitle) postponedTitle.textContent = i18n.postponedTitle[currentLang];
    const priorityBadge = document.getElementById('postponedPriorityBadge');
    if (priorityBadge) priorityBadge.textContent = i18n.priorityModeBadge[currentLang];
    const postponedEmptyText = document.getElementById('postponedEmptyText');
    if (postponedEmptyText) postponedEmptyText.textContent = i18n.postponedEmptyText[currentLang];
    const addPostponedModalTitle = document.getElementById('addPostponedModalTitle');
    if (addPostponedModalTitle) addPostponedModalTitle.textContent = i18n.addPostponedModalTitle[currentLang];
    const postponedAddBtn = document.getElementById('postponedAddBtn');
    if (postponedAddBtn) postponedAddBtn.title = i18n.postponedAddBtnTitle[currentLang];

    const addTabFolder = document.getElementById('addTabFolder');
    if (addTabFolder) addTabFolder.textContent = i18n.addTabFolder[currentLang];
    const addTabSearch = document.getElementById('addTabSearch');
    if (addTabSearch) addTabSearch.textContent = i18n.addTabSearch[currentLang];
    const addTabDomain = document.getElementById('addTabDomain');
    if (addTabDomain) addTabDomain.textContent = i18n.addTabDomain[currentLang];
    const addFolderLabel = document.getElementById('addFolderLabel');
    if (addFolderLabel) addFolderLabel.textContent = i18n.addFolderLabel[currentLang];
    const addCountLabel = document.getElementById('addCountLabel');
    if (addCountLabel) addCountLabel.textContent = i18n.addCountLabel[currentLang];
    const addSelectAllLabel = document.getElementById('addSelectAllLabel');
    if (addSelectAllLabel) addSelectAllLabel.textContent = i18n.addSelectAllLabel[currentLang];
    const addModeLabel = document.getElementById('addModeLabel');
    if (addModeLabel) addModeLabel.textContent = i18n.addModeLabel[currentLang];
    const addModeRandom = document.getElementById('addModeRandom');
    if (addModeRandom) addModeRandom.textContent = i18n.addModeRandom[currentLang];
    const addModeSequential = document.getElementById('addModeSequential');
    if (addModeSequential) addModeSequential.textContent = i18n.addModeSequential[currentLang];
    const addIncludeSubfolders = document.getElementById('addIncludeSubfolders');
    if (addIncludeSubfolders) addIncludeSubfolders.textContent = i18n.addIncludeSubfolders[currentLang];
    const addSearchInput = document.getElementById('addSearchInput');
    if (addSearchInput) addSearchInput.placeholder = i18n.addSearchPlaceholder[currentLang];
    const addSearchEmpty = document.getElementById('addSearchEmpty');
    if (addSearchEmpty) addSearchEmpty.textContent = i18n.addSearchEmpty[currentLang];
    const addSearchSelectedText = document.getElementById('addSearchSelectedText');
    if (addSearchSelectedText) addSearchSelectedText.textContent = i18n.addSearchSelectedText[currentLang];
    const addDomainSearchInput = document.getElementById('addDomainSearchInput');
    if (addDomainSearchInput) addDomainSearchInput.placeholder = i18n.addDomainSearchPlaceholder[currentLang];
    const addDomainLoading = document.getElementById('addDomainLoading');
    if (addDomainLoading) addDomainLoading.textContent = i18n.addDomainLoading[currentLang];
    const addDomainSelectedText = document.getElementById('addDomainSelectedText');
    if (addDomainSelectedText) addDomainSelectedText.textContent = i18n.addDomainSelectedText[currentLang];
    const addDomainSelectedLabel = document.getElementById('addDomainSelectedLabel');
    if (addDomainSelectedLabel) addDomainSelectedLabel.textContent = i18n.addDomainSelectedLabel[currentLang];
    const addPostponedCancelBtn = document.getElementById('addPostponedCancelBtn');
    if (addPostponedCancelBtn) addPostponedCancelBtn.textContent = i18n.addPostponedCancelText[currentLang];
    const addPostponedConfirmBtn = document.getElementById('addPostponedConfirmBtn');
    if (addPostponedConfirmBtn) addPostponedConfirmBtn.textContent = i18n.addPostponedConfirmText[currentLang];

    document.querySelectorAll('.card-btn-later').forEach(btn => {
        btn.title = i18n.cardLaterTitle[currentLang];
    });

    const blockManageTitle = document.getElementById('blockManageTitle');
    if (blockManageTitle) blockManageTitle.textContent = i18n.blockManageTitle[currentLang];
    const blockedBookmarksTitle = document.getElementById('blockedBookmarksTitle');
    if (blockedBookmarksTitle) blockedBookmarksTitle.textContent = i18n.blockedBookmarksTitle[currentLang];
    const blockedBookmarksEmptyText = document.getElementById('blockedBookmarksEmptyText');
    if (blockedBookmarksEmptyText) blockedBookmarksEmptyText.textContent = i18n.blockedBookmarksEmptyText[currentLang];
    const blockedFoldersTitle = document.getElementById('blockedFoldersTitle');
    if (blockedFoldersTitle) blockedFoldersTitle.textContent = i18n.blockedFoldersTitle[currentLang];
    const blockedDomainsTitle = document.getElementById('blockedDomainsTitle');
    if (blockedDomainsTitle) blockedDomainsTitle.textContent = i18n.blockedDomainsTitle[currentLang];
    const blockedFoldersEmptyText = document.getElementById('blockedFoldersEmptyText');
    if (blockedFoldersEmptyText) blockedFoldersEmptyText.textContent = i18n.blockedFoldersEmptyText[currentLang];
    const blockedDomainsEmptyText = document.getElementById('blockedDomainsEmptyText');
    if (blockedDomainsEmptyText) blockedDomainsEmptyText.textContent = i18n.blockedDomainsEmptyText[currentLang];
    const addDomainModalTitle = document.getElementById('addDomainModalTitle');
    if (addDomainModalTitle) addDomainModalTitle.textContent = i18n.addDomainModalTitle[currentLang];
    const addDomainModalDesc = document.getElementById('addDomainModalDesc');
    if (addDomainModalDesc) addDomainModalDesc.textContent = i18n.addDomainModalDesc[currentLang];
    const addDomainCancelBtn = document.getElementById('addDomainCancelBtn');
    if (addDomainCancelBtn) addDomainCancelBtn.textContent = i18n.addDomainCancelBtn[currentLang];
    const addDomainConfirmBtn = document.getElementById('addDomainConfirmBtn');
    if (addDomainConfirmBtn) addDomainConfirmBtn.textContent = i18n.addDomainConfirmBtn[currentLang];
    const selectFolderModalTitle = document.getElementById('selectFolderModalTitle');
    if (selectFolderModalTitle) selectFolderModalTitle.textContent = i18n.selectFolderModalTitle[currentLang];

    const laterRecommendLabel = document.getElementById('laterRecommendLabel');
    if (laterRecommendLabel) laterRecommendLabel.textContent = i18n.laterRecommendLabel[currentLang];
    const laterOrText = document.getElementById('laterOrText');
    if (laterOrText) laterOrText.textContent = i18n.laterOrText[currentLang];

    const langText = document.querySelector('#langToggle .lang-text');
    if (langText) langText.textContent = currentLang === 'zh_CN' ? 'EN' : '中';

    const themeIcon = document.querySelector('#themeToggle i');
    if (themeIcon) {
        themeIcon.className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
}

// =============================================================================
// UI 初始化
// =============================================================================

function initializeUI() {
    // 导航标签切换
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => switchView(tab.dataset.view));
    });

    // 「书签温故」子视图标签
    if (typeof initAdditionsSubTabs === 'function') {
        initAdditionsSubTabs();
    }

    // 工具按钮
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    const langToggle = document.getElementById('langToggle');
    if (langToggle) langToggle.addEventListener('click', toggleLanguage);

    const helpToggle = document.getElementById('helpToggle');
    const shortcutsModal = document.getElementById('shortcutsModal');
    const closeShortcutsModal = document.getElementById('closeShortcutsModal');
    if (helpToggle && shortcutsModal) {
        helpToggle.addEventListener('click', () => {
            if (typeof updateShortcutsDisplay === 'function') {
                updateShortcutsDisplay();
            }
            shortcutsModal.classList.add('show');
        });
    }
    if (closeShortcutsModal && shortcutsModal) {
        closeShortcutsModal.addEventListener('click', () => {
            shortcutsModal.classList.remove('show');
        });
    }
    if (shortcutsModal) {
        shortcutsModal.addEventListener('click', (e) => {
            if (e.target === shortcutsModal) {
                shortcutsModal.classList.remove('show');
            }
        });
    }

    // 搜索
    const searchInputEl = document.getElementById('searchInput');
    if (searchInputEl && !searchInputEl.hasAttribute('data-search-bound')) {
        searchInputEl.addEventListener('input', handleSearch);
        searchInputEl.addEventListener('keydown', handleSearchKeydown);
        searchInputEl.addEventListener('focus', handleSearchInputFocus);
        searchInputEl.setAttribute('data-search-bound', 'true');
    }

    const searchResultsPanel = document.getElementById('searchResultsPanel');
    if (searchResultsPanel && !searchResultsPanel.hasAttribute('data-search-bound')) {
        searchResultsPanel.addEventListener('click', handleSearchResultsPanelClick);
        searchResultsPanel.addEventListener('mouseover', handleSearchResultsPanelMouseOver);
        searchResultsPanel.setAttribute('data-search-bound', 'true');
    }

    if (!document.documentElement.hasAttribute('data-search-outside-bound')) {
        document.addEventListener('click', handleSearchOutsideClick, true);
        document.documentElement.setAttribute('data-search-outside-bound', 'true');
    }

    console.log('[initializeUI] UI事件监听器初始化完成，当前视图:', currentView);
}
// =============================================================================
// 数据加载
// =============================================================================

async function loadAllData(options = {}) {
    const { skipRender = false } = options;
    console.log('[loadAllData] 开始加载所有数据...');

    try {
        await ensureAdditionsCacheLoaded(skipRender);

        const bookmarkTree = await loadBookmarkTree();
        allBookmarks = flattenBookmarkTree(bookmarkTree);
        rebuildBookmarkUrlSet();
        additionsCacheRestored = true;
        await persistAdditionsCache();
        cachedBookmarkTree = bookmarkTree;

        console.log('[loadAllData] 数据加载完成:', {
            书签总数: allBookmarks.length
        });

    } catch (error) {
        console.error('[loadAllData] 加载数据失败:', error);
        showError('加载数据失败');
    }
}

// 预加载所有视图的数据
async function preloadAllViews() {
    if (isPreloading) return;
    isPreloading = true;

    console.log('[预加载] 开始预加载所有视图...');

    try {
        // 预加载书签树（后台准备）
        if (!cachedBookmarkTree) {
            cachedBookmarkTree = await loadBookmarkTree();
            console.log('[预加载] 书签树已缓存');
        }

        console.log('[预加载] 所有视图数据预加载完成');
    } catch (error) {
        console.error('[预加载] 预加载失败:', error);
    } finally {
        isPreloading = false;
    }
}

// 预加载常见网站的图标
async function preloadCommonIcons() {
    console.log('[图标预加载] 开始预加载常见图标...');

    try {
        // 获取当前所有书签的 URL，过滤掉无效的
        const urls = allBookmarks
            .map(b => b.url)
            .filter(url => url && url.trim() && (url.startsWith('http://') || url.startsWith('https://')));

        if (urls.length === 0) {
            console.log('[图标预加载] 没有有效的 URL 需要预加载');
            return;
        }

        // 批量预加载（限制并发数）
        const batchSize = 10;
        const maxPreload = Math.min(urls.length, 50);

        for (let i = 0; i < maxPreload; i += batchSize) {
            const batch = urls.slice(i, i + batchSize);
            await Promise.all(batch.map(url => preloadIcon(url)));
        }

        console.log('[图标预加载] 完成，已预加载', maxPreload, '个图标');
    } catch (error) {
        console.error('[图标预加载] 失败:', error);
    }
}

// 预加载单个图标（使用新的缓存系统）
async function preloadIcon(url) {
    try {
        // 基本验证
        if (!url || FaviconCache.isInvalidUrl(url)) {
            return;
        }

        // 使用缓存系统获取favicon（会自动缓存）
        await FaviconCache.fetch(url);
    } catch (error) {
        console.warn('[图标预加载] URL 预加载失败:', url, error.message);
    }
}

// 【关键修复】预热 favicon 内存缓存（从 IndexedDB 批量加载）
// 用于解决切换视图时图标变成五角星的问题
async function warmupFaviconCache(bookmarkUrls) {
    if (!bookmarkUrls || bookmarkUrls.length === 0) return;

    try {
        console.log('[Favicon预热] 开始预热内存缓存，书签数量:', bookmarkUrls.length);

        // 初始化 IndexedDB（如果还没初始化）
        if (!FaviconCache.db) {
            await FaviconCache.init();
        }

        // 批量从 IndexedDB 读取所有域名的 favicon
        const domains = new Set();
        bookmarkUrls.forEach(url => {
            try {
                if (!FaviconCache.isInvalidUrl(url)) {
                    const domain = new URL(url).hostname;
                    domains.add(domain);
                }
            } catch (e) {
                // 忽略无效URL
            }
        });

        if (domains.size === 0) return;

        console.log('[Favicon预热] 需要预热的域名数:', domains.size);

        // 批量读取
        const transaction = FaviconCache.db.transaction([FaviconCache.storeName], 'readonly');
        const store = transaction.objectStore(FaviconCache.storeName);

        let loaded = 0;
        for (const domain of domains) {
            // 跳过已在内存缓存中的
            if (FaviconCache.memoryCache.has(domain)) continue;

            try {
                const request = store.get(domain);
                await new Promise((resolve) => {
                    request.onsuccess = () => {
                        if (request.result && request.result.dataUrl) {
                            FaviconCache.memoryCache.set(domain, request.result.dataUrl);
                            loaded++;
                        }
                        resolve();
                    };
                    request.onerror = () => resolve();
                });
            } catch (e) {
                // 忽略单个域名的错误
            }
        }

        console.log('[Favicon预热] 完成，从IndexedDB加载了', loaded, '个favicon到内存');
    } catch (error) {
        console.warn('[Favicon预热] 失败:', error);
    }
}

function loadBookmarkTree() {
    return new Promise((resolve) => {
        browserAPI.bookmarks.getTree((tree) => {
            resolve(tree[0]);
        });
    });
}

function flattenBookmarkTree(node, parentPath = '') {
    const bookmarks = [];
    const currentPath = parentPath ? `${parentPath}/${node.title}` : node.title;

    if (node.url) {
        bookmarks.push({
            id: node.id,
            title: node.title,
            url: node.url,
            dateAdded: node.dateAdded,
            path: currentPath,
            parentId: node.parentId
        });
    }

    if (node.children) {
        node.children.forEach(child => {
            bookmarks.push(...flattenBookmarkTree(child, currentPath));
        });
    }

    return bookmarks;
}

// =============================================================================
// 时间捕捉小组件更新
// =============================================================================

let timeTrackingWidgetInterval = null;

async function updateTimeTrackingWidget() {
    const widgetList = document.getElementById('timeTrackingWidgetList');
    const widgetTitle = document.getElementById('timeTrackingWidgetTitle');

    if (!widgetList) return;

    const emptyText = i18n.timeTrackingWidgetEmpty[currentLang];

    // 检查追踪是否开启
    let isTrackingEnabled = true;
    try {
        const enabledResponse = await browserAPI.runtime.sendMessage({ action: 'isTrackingEnabled' });
        if (enabledResponse && enabledResponse.success) {
            isTrackingEnabled = enabledResponse.enabled;
        }
    } catch (e) {
        console.warn('[时间捕捉小组件] 检查追踪状态失败:', e);
    }

    // [New] Determine Widget Mode (Tracking vs Ranking)
    // Logic: User preference overrides default. Default depends on tracking state.
    let widgetOneMode = localStorage.getItem('timeTrackingWidgetMode'); // 'tracking' or 'ranking'

    // If no preference, default based on tracking state
    if (!widgetOneMode) {
        widgetOneMode = isTrackingEnabled ? 'tracking' : 'ranking';
    }

    if (widgetOneMode === 'tracking') {
        // 模式：时间追踪 (Live OR Disabled)
        if (widgetTitle) widgetTitle.textContent = i18n.timeTrackingWidgetTitle[currentLang];

        // Check widget reference
        const w = document.getElementById('timeTrackingWidget');
        if (w) w.dataset.mode = 'tracking';

        if (isTrackingEnabled) {
            // 追踪开启: 显示实时列表 (Live)
            try {
                const response = await browserAPI.runtime.sendMessage({
                    action: 'getCurrentActiveSessions'
                });

                if (response && response.success && response.sessions && response.sessions.length > 0) {
                    const sessions = response.sessions;

                    // 按标题分组
                    const groupedSessions = new Map();
                    for (const session of sessions) {
                        const key = session.title || session.url;
                        if (!groupedSessions.has(key)) {
                            groupedSessions.set(key, []);
                        }
                        groupedSessions.get(key).push(session);
                    }

                    // 转换为显示数据
                    const displayItems = [];
                    for (const [groupKey, groupSessions] of groupedSessions) {
                        const totalCompositeMs = groupSessions.reduce((sum, s) => sum + (s.compositeMs || s.activeMs || 0), 0);
                        const stateOrder = ['active', 'visible', 'paused', 'background', 'sleeping'];
                        const bestState = groupSessions.reduce((best, s) => {
                            const bestIdx = stateOrder.indexOf(best);
                            const currIdx = stateOrder.indexOf(s.state);
                            return currIdx < bestIdx ? s.state : best;
                        }, 'sleeping');

                        displayItems.push({
                            title: groupSessions[0].title,
                            url: groupSessions[0].url,
                            state: bestState,
                            compositeMs: totalCompositeMs,
                            count: groupSessions.length
                        });
                    }

                    const maxShow = 5;
                    const showItems = displayItems.slice(0, maxShow);
                    const remaining = displayItems.length - maxShow;

                    widgetList.innerHTML = '';

                    showItems.forEach(item => {
                        const el = document.createElement('div');
                        el.className = 'time-tracking-widget-item';

                        const stateIcon = document.createElement('span');
                        stateIcon.className = 'item-state';
                        stateIcon.textContent = item.state === 'active' ? '🟢' :
                            (item.state === 'sleeping' ? '💤' :
                                (item.state === 'background' ? '⚪' :
                                    (item.state === 'visible' ? '🔵' : '🟡')));

                        const title = document.createElement('span');
                        title.className = 'item-title';
                        let titleText = item.title || new URL(item.url).hostname;
                        if (item.count > 1) titleText += ` (${item.count})`;
                        title.textContent = titleText;
                        title.title = item.title || item.url;

                        const time = document.createElement('span');
                        time.className = 'item-time';
                        time.textContent = formatActiveTime(item.compositeMs);

                        el.appendChild(stateIcon);
                        el.appendChild(title);
                        el.appendChild(time);
                        el.addEventListener('click', (e) => {
                            e.stopPropagation();
                            if (!item.url) return;
                            if (typeof window.openBookmarkNewTab === 'function') {
                                window.openBookmarkNewTab(item.url, { title: item.title || '', source: 'time_tracking_widget' });
                            } else if (browserAPI?.tabs?.create) {
                                browserAPI.tabs.create({ url: item.url });
                            } else {
                                window.open(item.url, '_blank');
                            }
                        });
                        widgetList.appendChild(el);
                    });

                    if (remaining > 0) {
                        const moreEl = document.createElement('div');
                        moreEl.className = 'time-tracking-widget-more';
                        moreEl.textContent = i18n.timeTrackingWidgetMore[currentLang].replace('{count}', remaining);
                        widgetList.appendChild(moreEl);
                    }
                } else {
                    showEmptyState();
                }
            } catch (error) {
                console.warn('[时间捕捉小组件] 获取数据失败:', error);
                showEmptyState();
            }
        } else {
            // 追踪关闭: 显示已停用状态 (Disabled)
            widgetList.innerHTML = '';

            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'time-tracking-widget-empty';
            emptyDiv.style.flexDirection = 'column';
            emptyDiv.style.gap = '8px';

            const text = document.createElement('span');
            text.textContent = currentLang === 'zh_CN' ? '时间追踪已关闭' : 'Time Tracking Disabled';

            emptyDiv.appendChild(text);
            widgetList.appendChild(emptyDiv);
        }
    } else {
        // 追踪关闭 / 强制排行：显示点击排行
        if (widgetTitle) widgetTitle.textContent = i18n.timeTrackingWidgetRankingTitle ? i18n.timeTrackingWidgetRankingTitle[currentLang] : (currentLang === 'zh_CN' ? '点击排行' : 'Click Ranking');

        // Check widget reference
        const w = document.getElementById('timeTrackingWidget');
        if (w) w.dataset.mode = 'ranking';

        try {
            const stats = await ensureBrowsingClickRankingStats();

            // Initialize User Preference Range
            if (!window.timeTrackingWidgetRankingRange) {
                window.timeTrackingWidgetRankingRange = localStorage.getItem('timeTrackingWidgetRankingRange') || 'day';
            }
            const currentRange = window.timeTrackingWidgetRankingRange;

            // Map range to localized text and count key
            const rangeConfig = {
                'day': { text: currentLang === 'zh_CN' ? '当日' : 'Today', key: 'dayCount' },
                'week': { text: currentLang === 'zh_CN' ? '当周' : 'This Week', key: 'weekCount' },
                'month': { text: currentLang === 'zh_CN' ? '当月' : 'This Month', key: 'monthCount' },
                'year': { text: currentLang === 'zh_CN' ? '当年' : 'This Year', key: 'yearCount' },
                'all': { text: currentLang === 'zh_CN' ? '全部' : 'All Time', key: 'allCount' }
            };
            const activeConfig = rangeConfig[currentRange] || rangeConfig['day'];

            // Fetch Items
            let items = [];
            if (stats && !stats.error && stats.items) {
                items = getBrowsingRankingItemsForRange(currentRange);
            }

            widgetList.innerHTML = '';

            if (items && items.length > 0) {
                const top5 = items.slice(0, 5);
                top5.forEach((item, index) => {
                    const el = document.createElement('div');
                    el.className = 'time-tracking-widget-item ranking-item';

                    const rankNum = document.createElement('span');
                    rankNum.className = 'item-rank';
                    rankNum.textContent = `${index + 1}`;

                    const title = document.createElement('span');
                    title.className = 'item-title';
                    try {
                        title.textContent = item.title || new URL(item.url).hostname;
                    } catch {
                        title.textContent = item.title || item.url;
                    }
                    title.title = item.title || item.url;

                    const count = document.createElement('span');
                    count.className = 'item-time';
                    count.textContent = `${item[activeConfig.key]}${currentLang === 'zh_CN' ? '次' : 'x'}`;

                    el.appendChild(rankNum);
                    el.appendChild(title);
                    el.appendChild(count);

                    // Specific click: Open URL
                    el.addEventListener('click', (e) => {
                        e.stopPropagation();
                        if (!item.url) return;
                        if (typeof window.openBookmarkNewTab === 'function') {
                            window.openBookmarkNewTab(item.url, { title: item.title || '', source: 'time_tracking_widget' });
                        } else if (browserAPI?.tabs?.create) {
                            browserAPI.tabs.create({ url: item.url });
                        } else {
                            window.open(item.url, '_blank');
                        }
                    });

                    widgetList.appendChild(el);
                });
            } else {
                // Empty State within Ranking
                const emptyDiv = document.createElement('div');
                emptyDiv.className = 'time-tracking-widget-empty';
                emptyDiv.innerHTML = `<span>${emptyText}</span>`;
                widgetList.appendChild(emptyDiv);
            }

            // Always show range switcher at bottom
            const rangeHint = document.createElement('div');
            rangeHint.className = 'time-tracking-widget-hint';
            rangeHint.textContent = `${activeConfig.text} >`; // Arrow to indicate switchable
            rangeHint.title = currentLang === 'zh_CN' ? '点击切换时间范围' : 'Click to switch range';

            rangeHint.addEventListener('click', (e) => {
                e.stopPropagation();
                // Cycle ranges: day -> week -> month -> year -> all -> day
                const ranges = ['day', 'week', 'month', 'year', 'all'];
                let idx = ranges.indexOf(window.timeTrackingWidgetRankingRange);
                if (idx < 0) idx = 0;
                const nextIdx = (idx + 1) % ranges.length;

                window.timeTrackingWidgetRankingRange = ranges[nextIdx];
                localStorage.setItem('timeTrackingWidgetRankingRange', window.timeTrackingWidgetRankingRange);

                updateTimeTrackingWidget();
            });

            widgetList.appendChild(rangeHint);

        } catch (error) {
            console.warn('[时间捕捉小组件] 获取点击排行数据失败:', error);
            showEmptyState();
        }
    }

    function showEmptyState() {
        widgetList.innerHTML = `<div class="time-tracking-widget-empty"><span>${emptyText}</span></div>`;
    }
}

function formatActiveTime(ms) {
    if (!ms || ms < 1000) return '0s';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
}

function startTimeTrackingWidgetRefresh() {
    if (timeTrackingWidgetInterval) {
        clearInterval(timeTrackingWidgetInterval);
    }
    updateTimeTrackingWidget();
    timeTrackingWidgetInterval = setInterval(updateTimeTrackingWidget, 1000);  // 1秒刷新，更实时
}

function stopTimeTrackingWidgetRefresh() {
    if (timeTrackingWidgetInterval) {
        clearInterval(timeTrackingWidgetInterval);
        timeTrackingWidgetInterval = null;
        console.log('[时间捕捉小组件] 已停止刷新（侧边栏收起）');
    }
}

function initTimeTrackingWidget() {
    const widget = document.getElementById('timeTrackingWidget');
    if (!widget) return;

    widget.addEventListener('click', (e) => {
        // Prevent if clicking specific interactive elements that didn't stop propagation (though most should)
        if (e.target.closest('.widget-header-action-btn') ||
            e.target.closest('.time-tracking-widget-hint') ||
            e.target.closest('.time-tracking-widget-item') ||
            e.target.closest('a')) return;

        switchView('additions');
        setTimeout(() => {
            const mode = widget.dataset.mode;
            if (mode === 'ranking') {
                // Navigate to Click Ranking View
                const range = window.timeTrackingWidgetRankingRange || localStorage.getItem('timeTrackingWidgetRankingRange') || 'day';
                try { localStorage.setItem('browsingRankingActiveRange', range); } catch (_) { }
                const browsingTab = document.getElementById('additionsTabBrowsing');
                if (browsingTab) {
                    browsingTab.click();
                    setTimeout(() => {
                        const rankingTab = document.getElementById('browsingTabRanking');
                        if (rankingTab) rankingTab.click();
                    }, 50);
                }
            } else {
                // Default: Navigate to Time Tracking View
                const trackingTab = document.getElementById('additionsTabTracking');
                if (trackingTab) {
                    trackingTab.click();
                }
            }
        }, 100);
    });

    // [New] Toggle Button
    const toggleViewBtn = document.getElementById('timeTrackingToggleViewBtn');
    if (toggleViewBtn) {
        toggleViewBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Prevent widget click navigation

            // Determine current mode to flip
            let currentMode = localStorage.getItem('timeTrackingWidgetMode');
            if (!currentMode) {
                // Check if widget has dataset mode updated by updateTimeTrackingWidget
                const w = document.getElementById('timeTrackingWidget');
                if (w && w.dataset.mode) {
                    currentMode = w.dataset.mode;
                } else {
                    currentMode = 'tracking'; // Fallback
                }
            }

            const newMode = currentMode === 'ranking' ? 'tracking' : 'ranking';
            localStorage.setItem('timeTrackingWidgetMode', newMode);

            updateTimeTrackingWidget();
        });
    }

    // 检查侧边栏状态，只有展开时才启动刷新
    const sidebar = document.getElementById('sidebar');
    const isCollapsed = sidebar && sidebar.classList.contains('collapsed');
    if (!isCollapsed) {
        startTimeTrackingWidgetRefresh();
    } else {
        console.log('[时间捕捉小组件] 侧边栏收起，跳过刷新启动');
    }
}

// =============================================================================
// 侧边栏收起功能
// =============================================================================

function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const toggleBtn = document.getElementById('sidebarToggle');

    if (!sidebar || !toggleBtn) {
        console.warn('[侧边栏] 找不到侧边栏或切换按钮');
        return;
    }

    // 根据当前实际 DOM 宽度更新侧边栏宽度 CSS 变量
    function syncSidebarWidth() {
        // 直接读取 sidebar 实际渲染宽度，兼容：
        // - 手动折叠/展开（.collapsed）
        // - 响应式 CSS 自动收缩
        const rect = sidebar.getBoundingClientRect();
        const widthPx = rect && rect.width ? `${rect.width}px` : '260px';
        document.documentElement.style.setProperty('--sidebar-width', widthPx);
    }

    // 更新小组件切换按钮显隐状态
    function updateWidgetToggleBtn() {
        const btn = document.getElementById('timeTrackingToggleViewBtn');
        if (btn) {
            // 覆盖手动收起 + 自动收缩（宽度阈值更高）
            const isClassCollapsed = sidebar.classList.contains('collapsed');
            const isVisuallyCollapsed = sidebar.offsetWidth < 230;
            btn.style.display = (isClassCollapsed || isVisuallyCollapsed) ? 'none' : '';
        }
    }

    // 从 localStorage 恢复侧边栏状态
    const savedState = localStorage.getItem('sidebarCollapsed');
    if (savedState === 'true') {
        sidebar.classList.add('collapsed');
        console.log('[侧边栏] 恢复收起状态');
    }
    // 恢复完状态后，同步一次真实宽度
    syncSidebarWidth();
    updateWidgetToggleBtn();

    // 点击切换按钮
    toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        sidebar.classList.toggle('collapsed');

        // 保存状态到 localStorage
        const isCollapsed = sidebar.classList.contains('collapsed');
        localStorage.setItem('sidebarCollapsed', isCollapsed.toString());

        // 更新 CSS 变量（用于弹窗定位）
        syncSidebarWidth();
        updateWidgetToggleBtn();

        // 控制时间捕捉小组件刷新：收起时停止，展开时恢复
        if (isCollapsed) {
            stopTimeTrackingWidgetRefresh();
        } else {
            startTimeTrackingWidgetRefresh();
        }

        console.log('[侧边栏]', isCollapsed ? '已收起' : '已展开');
    });

    // 窗口尺寸变化时，侧边栏可能被 CSS 自动收缩/展开，这里也同步一次宽度
    window.addEventListener('resize', () => {
        syncSidebarWidth();
        updateWidgetToggleBtn();
    });

    // 监听侧边栏真实尺寸变化，避免非 resize 场景下按钮状态错误
    try {
        if (window.ResizeObserver) {
            const ro = new ResizeObserver(() => updateWidgetToggleBtn());
            ro.observe(sidebar);
        }
    } catch (_) { }
}

// =============================================================================
// 视图切换
// =============================================================================

function switchView(view) {
    console.log('[switchView] 切换视图到:', view);

    const previousView = currentView;



    // [Locate Mode Isolation] If we are in "定位模式" (calendar selectMode), leaving the view
    // should behave like clicking the bottom-right "退出定位" button.
    try {
        if (previousView !== view) {
            if (window.bookmarkCalendarInstance && typeof window.bookmarkCalendarInstance.exitLocateMode === 'function') {
                window.bookmarkCalendarInstance.exitLocateMode();
            }
            if (window.browsingHistoryCalendarInstance && typeof window.browsingHistoryCalendarInstance.exitLocateMode === 'function') {
                window.browsingHistoryCalendarInstance.exitLocateMode();
            }

            // Safety: remove exit button if it somehow remains.
            const exitBtn = document.getElementById('exitLocateModeBtn');
            if (exitBtn) exitBtn.remove();
        }
    } catch (_) { }

    // 更新全局变量
    currentView = view;
    try { window.currentView = currentView; } catch (_) { }

    // 视图切换时隐藏搜索结果面板并清除搜索缓存（Phase 1 & 2 & 2.5）
    try {
        // [隔离增强] 确保清理搜索 UI 状态
        if (typeof cancelPendingMainSearchDebounce === 'function') cancelPendingMainSearchDebounce();
        if (typeof hideSearchResultsPanel === 'function') hideSearchResultsPanel();
        if (typeof toggleSearchModeMenu === 'function') toggleSearchModeMenu(false);
        if (typeof setSearchMode === 'function' && (view === 'additions' || view === 'recommend')) {
            setSearchMode(view, { switchView: false });
        } else if (typeof renderSearchModeUI === 'function') {
            renderSearchModeUI();
        }

        // [Search Isolation] Search box behaviors differ by view.
        // When leaving a view, clear the shared top search input to avoid leaking queries.
        if (previousView !== view && typeof window !== 'undefined' && typeof window.resetMainSearchUI === 'function') {
            window.resetMainSearchUI({ reason: 'switchView' });
        }

        if (window.SearchContextManager) {
            // For 'additions', we rely on sub-tab switching to refine context, 
            // but we set the main view here.
            window.SearchContextManager.updateContext(view);
        }

        // 当前仅保留「书签记录/推荐」，无需清理历史视图搜索缓存
    } catch (_) { }

    // 更新导航标签
    document.querySelectorAll('.nav-tab').forEach(tab => {
        if (tab.dataset.view === view) {
            tab.classList.add('active');
        } else {
            tab.classList.remove('active');
        }
    });

    // 更新视图容器
    document.querySelectorAll('.view').forEach(v => {
        if (v.id === `${view}View`) {
            v.classList.add('active');
        } else {
            v.classList.remove('active');
        }
    });

    // 保存到 localStorage
    localStorage.setItem('lastActiveView', view);
    console.log('[switchView] 已保存视图到localStorage:', view);

    try {
        const url = new URL(window.location.href);
        url.searchParams.set('view', view);
        window.history.replaceState({}, '', url.toString());
    } catch (_) { }

    // 渲染当前视图
    renderCurrentView();
}

function syncViewFromUrl(reason = 'sync') {
    try {
        const params = new URLSearchParams(window.location.search);
        const view = params.get('view');
        if (!view || !isViewAllowed(view)) return;
        if (view === currentView) return;
        console.log('[ViewSync] from URL ->', view, 'reason:', reason);
        switchView(view);
    } catch (_) { }
}

function renderCurrentView() {
    // 如果离开书签记录视图，停止时间捕捉实时刷新定时器
    if (currentView !== 'additions' && trackingRefreshInterval) {
        stopTrackingRefresh();
    }

    switch (currentView) {
        case 'additions':
            renderAdditionsView();
            break;
        case 'recommend':
            renderRecommendView();
            break;
    }
}

// =============================================================================
// 书签推荐视图
// =============================================================================

let recommendViewInitialized = false;

function renderRecommendView() {
    console.log('[书签推荐] 渲染推荐视图');

    // 确保搜索模式显示为“书签推荐”
    try {
        if (typeof setSearchMode === 'function') {
            setSearchMode('recommend', { switchView: false });
        }
    } catch (_) { }

    // 只初始化一次事件监听器
    if (!recommendViewInitialized) {
        // 初始化可折叠区域
        initCollapsibleSections();

        // 初始化公式输入框事件
        initFormulaInputs();

        // 初始化卡片交互
        initCardInteractions();

        // 初始化追踪开关
        initTrackingToggle();

        // 初始化稍后复习弹窗
        initLaterModal();

        // 初始化添加域名和文件夹弹窗
        initAddDomainModal();
        initSelectFolderModal();
        initBlockManageButtons();

        // 初始化时间追踪屏蔽管理
        initTrackingBlockModal();
        initSelectTrackingBlockFolderModal();
        initAddTrackingBlockDomainModal();

        // 初始化添加到稍后复习弹窗
        initAddToPostponedModal();

        recommendViewInitialized = true;
    }

    // 每次进入视图时加载数据
    loadRecommendData();
}

function initCollapsibleSections() {
    document.querySelectorAll('.collapsible .section-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // 避免点击追踪开关时触发折叠
            if (e.target.closest('.tracking-toggle')) return;
            // 避免点击输入框时触发折叠
            if (e.target.closest('input')) return;
            const section = header.closest('.collapsible');
            section.classList.toggle('collapsed');
        });
    });

    // 初始化拖拽排序
    initSectionDragSort();

    // 恢复保存的顺序
    restoreSectionOrder();
}

// 初始化折叠区域拖拽排序
function initSectionDragSort() {
    const container = document.getElementById('recommendSectionsContainer');
    if (!container) return;

    let draggedElement = null;
    let isDragging = false;
    let startY = 0;

    container.querySelectorAll('.draggable-section').forEach(section => {
        const header = section.querySelector('.section-header');
        if (!header) return;

        header.addEventListener('mousedown', (e) => {
            // 点击按钮或输入框时不触发拖拽
            if (e.target.closest('button') || e.target.closest('input')) return;

            startY = e.clientY;
            draggedElement = section;

            const onMouseMove = (e) => {
                if (!draggedElement) return;

                // 移动超过5px才开始拖拽
                if (!isDragging && Math.abs(e.clientY - startY) > 5) {
                    isDragging = true;
                    section.classList.add('dragging');
                }

                if (!isDragging) return;

                const sections = [...container.querySelectorAll('.draggable-section')];
                const afterElement = getDragAfterElement(container, e.clientY);

                sections.forEach(s => s.classList.remove('drag-over'));

                if (afterElement) {
                    afterElement.classList.add('drag-over');
                }
            };

            const onMouseUp = () => {
                if (isDragging && draggedElement) {
                    const sections = [...container.querySelectorAll('.draggable-section')];
                    const afterElement = sections.find(s => s.classList.contains('drag-over'));

                    sections.forEach(s => s.classList.remove('drag-over'));
                    draggedElement.classList.remove('dragging');

                    if (afterElement && afterElement !== draggedElement) {
                        container.insertBefore(draggedElement, afterElement);
                        saveSectionOrder();
                    }
                }

                draggedElement = null;
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}

function getDragAfterElement(container, y) {
    const sections = [...container.querySelectorAll('.draggable-section:not(.dragging)')];

    return sections.reduce((closest, section) => {
        const box = section.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;

        if (offset < 0 && offset > closest.offset) {
            return { offset, element: section };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

function saveSectionOrder() {
    const container = document.getElementById('recommendSectionsContainer');
    if (!container) return;

    const order = [...container.querySelectorAll('.draggable-section')]
        .map(s => s.dataset.sectionId);

    browserAPI.storage.local.set({ recommendSectionOrder: order });
    console.log('[书签推荐] 保存栏目顺序:', order);
}

function restoreSectionOrder() {
    browserAPI.storage.local.get(['recommendSectionOrder'], (result) => {
        if (!result.recommendSectionOrder) return;

        const container = document.getElementById('recommendSectionsContainer');
        if (!container) return;

        const order = result.recommendSectionOrder;
        const sections = [...container.querySelectorAll('.draggable-section')];

        order.forEach(id => {
            const section = sections.find(s => s.dataset.sectionId === id);
            if (section) {
                container.appendChild(section);
            }
        });

        console.log('[书签推荐] 恢复栏目顺序:', order);
    });
}

// 根据待复习数量决定是否折叠
function updatePostponedCollapse(count) {
    const section = document.querySelector('.recommend-postponed-section');
    if (!section) return;

    if (count === 0) {
        section.classList.add('collapsed');
    }
}

function initFormulaInputs() {
    // 权重输入框
    const weightInputs = document.querySelectorAll('.formula-weight');
    weightInputs.forEach(input => {
        input.addEventListener('click', () => {
            input.removeAttribute('readonly');
            input.select();
        });
        input.addEventListener('blur', () => {
            input.setAttribute('readonly', 'readonly');
            normalizeWeights();
        });
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
    });

    // 阈值输入框
    const thresholdInputs = document.querySelectorAll('.threshold-value');
    thresholdInputs.forEach(input => {
        input.addEventListener('blur', () => {
            saveFormulaConfig();
        });
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
    });

    // 恢复默认按钮
    const resetBtn = document.getElementById('resetFormulaBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', resetFormulaToDefault);
    }

    // 加载保存的配置
    loadFormulaConfig();
}

function normalizeWeights() {
    const w1 = parseFloat(document.getElementById('weightFreshness').value) || 0;
    const w2 = parseFloat(document.getElementById('weightColdness').value) || 0;
    const w3 = parseFloat(document.getElementById('weightTimeDegree').value) || 0;
    const w4 = parseFloat(document.getElementById('weightForgetting').value) || 0;
    const w5 = parseFloat(document.getElementById('weightLaterReview').value) || 0;

    const total = w1 + w2 + w3 + w4 + w5;
    if (total > 0 && Math.abs(total - 1) > 0.01) {
        document.getElementById('weightFreshness').value = (w1 / total).toFixed(2);
        document.getElementById('weightColdness').value = (w2 / total).toFixed(2);
        document.getElementById('weightTimeDegree').value = (w3 / total).toFixed(2);
        document.getElementById('weightForgetting').value = (w4 / total).toFixed(2);
        document.getElementById('weightLaterReview').value = (w5 / total).toFixed(2);
    }
    saveFormulaConfig();
}

function resetFormulaToDefault() {
    document.getElementById('weightFreshness').value = '0.15';
    document.getElementById('weightColdness').value = '0.15';
    document.getElementById('weightTimeDegree').value = '0.30';
    document.getElementById('weightForgetting').value = '0.20';
    document.getElementById('weightLaterReview').value = '0.20';

    document.getElementById('thresholdFreshness').value = '30';
    document.getElementById('thresholdColdness').value = '10';
    document.getElementById('thresholdTimeDegree').value = '5';
    document.getElementById('thresholdForgetting').value = '14';

    saveFormulaConfig();
}

async function saveFormulaConfig() {
    const config = {
        weights: {
            freshness: parseFloat(document.getElementById('weightFreshness').value) || 0.15,
            coldness: parseFloat(document.getElementById('weightColdness').value) || 0.15,
            shallowRead: parseFloat(document.getElementById('weightTimeDegree').value) || 0.30,
            forgetting: parseFloat(document.getElementById('weightForgetting').value) || 0.20,
            laterReview: parseFloat(document.getElementById('weightLaterReview').value) || 0.20
        },
        thresholds: {
            freshness: parseInt(document.getElementById('thresholdFreshness').value) || 30,
            coldness: parseInt(document.getElementById('thresholdColdness').value) || 10,
            shallowRead: parseInt(document.getElementById('thresholdTimeDegree').value) || 5,
            forgetting: parseInt(document.getElementById('thresholdForgetting').value) || 14
        }
    };
    await browserAPI.storage.local.set({ recommendFormulaConfig: config });
    // 权重/阈值变化时清除旧缓存，通知background.js重新计算所有书签S值
    if (typeof clearScoresCache === 'function') {
        await clearScoresCache();
    }
    // 发消息给background.js触发全量计算
    browserAPI.runtime.sendMessage({ action: 'computeBookmarkScores' }, (response) => {
        if (browserAPI.runtime.lastError) {
            console.warn('[书签推荐] 请求background计算S值失败:', browserAPI.runtime.lastError.message);
        } else {
            console.log('[书签推荐] background计算S值完成:', response?.success);
        }
    });
    console.log('[书签推荐] 保存公式配置，已请求background重新计算S值:', config);
}

function loadFormulaConfig() {
    browserAPI.storage.local.get(['recommendFormulaConfig'], (result) => {
        if (result.recommendFormulaConfig) {
            const config = result.recommendFormulaConfig;
            document.getElementById('weightFreshness').value = config.weights.freshness;
            document.getElementById('weightColdness').value = config.weights.coldness;
            document.getElementById('weightTimeDegree').value = config.weights.shallowRead;
            document.getElementById('weightForgetting').value = config.weights.forgetting;
            document.getElementById('weightLaterReview').value = config.weights.laterReview ?? 0.20;

            document.getElementById('thresholdFreshness').value = config.thresholds.freshness;
            document.getElementById('thresholdColdness').value = config.thresholds.coldness;
            document.getElementById('thresholdTimeDegree').value = config.thresholds.shallowRead;
            document.getElementById('thresholdForgetting').value = config.thresholds.forgetting;
            console.log('[书签推荐] 加载公式配置:', config);
        }
    });
}

// 当前推荐模式
let currentRecommendMode = 'default'; // 默认模式

// 预设模式配置（时间度权重增大，使用综合时间）
const presetModes = {
    // 默认模式：均衡推荐
    default: {
        weights: {
            freshness: 0.15,      // 新鲜度
            coldness: 0.15,       // 冷门度
            timeDegree: 0.30,     // 时间度（综合时间短=需要深入阅读）
            forgetting: 0.20,     // 遗忘因子
            laterReview: 0.20     // 待复习权重
        },
        thresholds: {
            freshness: 30,        // 30天内算新
            coldness: 10,         // 10次以下算冷门
            timeDegree: 5,        // 5分钟以下算浅读
            forgetting: 14        // 14天未访问算遗忘
        }
    },
    // 考古模式：挖掘尘封已久的书签
    archaeology: {
        weights: {
            freshness: 0.05,      // 新鲜度权重低
            coldness: 0.25,       // 冷门度高权重
            timeDegree: 0.20,     // 时间度
            forgetting: 0.35,     // 遗忘因子最高
            laterReview: 0.15     // 待复习权重
        },
        thresholds: {
            freshness: 90,        // 90天内算新
            coldness: 3,          // 3次以下算冷门
            timeDegree: 3,        // 3分钟以下算浅读
            forgetting: 30        // 30天未访问算遗忘
        }
    },
    // 巩固模式：经常访问但还没深入阅读的书签
    consolidate: {
        weights: {
            freshness: 0.15,      // 新鲜度
            coldness: 0.05,       // 冷门度低（推荐常用的）
            timeDegree: 0.40,     // 时间度高（推荐还没深入阅读的）
            forgetting: 0.20,     // 遗忘度稍高
            laterReview: 0.20     // 待复习权重
        },
        thresholds: {
            freshness: 14,        // 14天内算新
            coldness: 30,         // 30次以下算冷门（提高阈值，让常用书签也能被选中）
            timeDegree: 10,       // 10分钟以下算浅读
            forgetting: 7         // 7天未访问算遗忘
        }
    },
    // 漫游模式：随机探索
    wander: {
        weights: {
            freshness: 0.20,
            coldness: 0.15,
            timeDegree: 0.25,
            forgetting: 0.20,
            laterReview: 0.20
        },
        thresholds: {
            freshness: 21,
            coldness: 10,
            timeDegree: 5,
            forgetting: 14
        }
    },
    // 优先巩固模式：手动添加待复习时自动激活
    priority: {
        weights: {
            freshness: 0.05,
            coldness: 0.05,
            timeDegree: 0.10,
            forgetting: 0.10,
            laterReview: 0.70
        },
        thresholds: {
            freshness: 30,
            coldness: 10,
            timeDegree: 5,
            forgetting: 14
        }
    }
};

// =============================================================================
// 推荐卡片专用：弹窗管理
// =============================================================================

// 预加载 favicon（使用现有的 FaviconCache 系统）
function preloadHighResFavicons(urls) {
    urls.forEach(url => {
        if (url) FaviconCache.fetch(url);
    });
}

// 设置 favicon（使用现有的 FaviconCache 系统）
function setHighResFavicon(imgElement, url) {
    if (!url) {
        imgElement.src = fallbackIcon;
        return;
    }

    // 使用现有的 getFaviconUrl（会触发异步加载）
    imgElement.src = getFaviconUrl(url);

    // 异步获取更高质量版本
    getFaviconUrlAsync(url).then(dataUrl => {
        if (dataUrl && dataUrl !== fallbackIcon) {
            imgElement.src = dataUrl;
        }
    });
}

// 推荐卡片专用窗口 - 使用storage共享窗口ID（与popup同步）
async function getSharedRecommendWindowId() {
    return new Promise((resolve) => {
        browserAPI.storage.local.get(['recommendWindowId'], (result) => {
            resolve(result.recommendWindowId || null);
        });
    });
}

async function saveSharedRecommendWindowId(windowId) {
    await browserAPI.storage.local.set({ recommendWindowId: windowId });
}

// 监听storage变化，实现history和popup页面的实时同步
// 标志：用于防止 history 页面自己保存的变化触发重复刷新
let historyLastSaveTime = 0;
browserAPI.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.popupCurrentCards) {
        // 仅在推荐视图时处理
        if (currentView !== 'recommend') return;

        // 检查是否是 history 页面自己刚保存的（500ms内忽略）
        const now = Date.now();
        if (now - historyLastSaveTime < 500) {
            console.log('[卡片同步] 忽略本页面保存触发的变化');
            return;
        }

        const newValue = changes.popupCurrentCards.newValue;
        const oldValue = changes.popupCurrentCards.oldValue;

        if (newValue && newValue.cardIds) {
            // 检查卡片ID是否变化（popup刷新了卡片）
            const oldCardIds = oldValue?.cardIds || [];
            const newCardIds = newValue.cardIds || [];
            const cardIdsChanged = JSON.stringify(oldCardIds.sort()) !== JSON.stringify(newCardIds.sort());

            if (cardIdsChanged) {
                // 卡片ID变化（来自popup的刷新），同步更新HTML页面
                console.log('[卡片同步] popup刷新了卡片，同步更新HTML');
                syncCardsFromStorage(newValue);
                return;
            }

            // 检查是否全部勾选
            if (newValue.flippedIds) {
                const allFlipped = newValue.cardIds.every(id => newValue.flippedIds.includes(id));
                if (allFlipped && newValue.cardIds.length > 0) {
                    // 全部勾选（来自popup的操作），刷新获取新卡片
                    console.log('[卡片同步] popup完成翻牌，刷新卡片');
                    refreshRecommendCards(true);
                }
            }
        }
    }
});

// 从storage同步卡片显示（不重新计算，直接使用popup的数据）
async function syncCardsFromStorage(cardState) {
    try {
        const cardsRow = document.getElementById('cardsRow');
        if (!cardsRow) return;

        const cards = cardsRow.querySelectorAll('.recommend-card');
        if (cards.length === 0 || !cardState.cardData) return;

        const { cardIds, flippedIds, cardData } = cardState;

        // 获取S值缓存用于显示优先级
        const scoresCache = await getScoresCache();

        for (let index = 0; index < cards.length; index += 1) {
            if (index >= cardData.length) continue;

            const card = cards[index];
            const data = cardData[index] || {};
            const bookmarkId = cardIds[index];
            const isFlipped = flippedIds?.includes(bookmarkId);

            // 更新卡片内容
            card.dataset.bookmarkId = bookmarkId;

            const titleEl = card.querySelector('.card-title');
            if (titleEl) {
                let displayTitle = data.title || '';
                if (!displayTitle && bookmarkId) {
                    try {
                        const list = await new Promise(resolve => {
                            browserAPI.bookmarks.get(bookmarkId, resolve);
                        });
                        displayTitle = list?.[0]?.title || list?.[0]?.name || '';
                    } catch (_) {
                        displayTitle = '';
                    }
                }
                titleEl.textContent = displayTitle || data.url || '--';
            }

            // 更新favicon（三层降级：网站自己 → DuckDuckGo → Google S2）
            const favicon = card.querySelector('.card-favicon');
            if (favicon && data.url) {
                const cachedFavicon = data.favicon || data.faviconUrl || null;
                try {
                    // [打开页面时避免闪烁] 同步恢复只使用已缓存的 favicon，
                    // 不在此处触发异步刷新，避免“先方块后图标”的闪烁。
                    favicon.onerror = null;
                    if (cachedFavicon) {
                        favicon.src = cachedFavicon;
                    } else {
                        favicon.src = fallbackIcon;
                        // 仅预热缓存，不更新当前 DOM
                        FaviconCache.fetch(data.url).catch(() => { });
                    }
                } catch (e) {
                    favicon.src = fallbackIcon;
                }
            }

            // 更新优先级显示
            const priorityEl = card.querySelector('.card-priority');
            if (priorityEl) {
                const cached = scoresCache[bookmarkId];
                const priority = cached ? cached.S : 0;
                priorityEl.textContent = `S = ${priority.toFixed(3)}`;
            }

            // 更新翻阅状态
            if (isFlipped) {
                card.classList.add('flipped');
            } else {
                card.classList.remove('flipped');
            }

            card.classList.remove('empty');
        }

        console.log('[卡片同步] HTML页面已同步popup的卡片');
    } catch (e) {
        console.warn('[卡片同步] 同步失败:', e);
    }
}

// 在推荐窗口中打开链接
async function openInRecommendWindow(url) {
    if (!url) return;

    try {
        // 从storage获取共享的窗口ID
        let windowId = await getSharedRecommendWindowId();

        // 检查窗口是否存在
        if (windowId) {
            try {
                await browserAPI.windows.get(windowId);
                // 窗口存在，在其中打开新标签页
                const tab = await browserAPI.tabs.create({
                    windowId: windowId,
                    url: url,
                    active: true
                });
                try {
                    if (typeof window.reportExtensionBookmarkOpen === 'function' && tab && tab.id != null) {
                        await window.reportExtensionBookmarkOpen({ tabId: tab.id, url, source: 'recommend_window' });
                    }
                } catch (_) { }
                await browserAPI.windows.update(windowId, { focused: true });
                return;
            } catch (e) {
                // 窗口已关闭，清除保存的ID
                await saveSharedRecommendWindowId(null);
            }
        }

        // 创建新窗口
        const width = Math.min(1200, Math.round(screen.availWidth * 0.75));
        const height = Math.min(800, Math.round(screen.availHeight * 0.8));
        const left = Math.round((screen.availWidth - width) / 2);
        const top = Math.round((screen.availHeight - height) / 2);

        const win = await browserAPI.windows.create({
            url: url,
            type: 'normal',
            width, height, left, top,
            focused: true
        });
        try {
            const tabId = win?.tabs?.[0]?.id ?? null;
            if (typeof window.reportExtensionBookmarkOpen === 'function' && tabId != null) {
                await window.reportExtensionBookmarkOpen({ tabId, url, source: 'recommend_window' });
            }
        } catch (_) { }
        // 保存窗口ID到storage，供popup和history共享
        await saveSharedRecommendWindowId(win.id);

    } catch (error) {
        console.error('[推荐卡片] 打开窗口失败:', error);
        browserAPI.tabs.create({ url });
    }
}

function initCardInteractions() {
    // 刷新按钮（直接从缓存读取S值，选择新的Top3卡片）
    document.getElementById('cardRefreshBtn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        // S值已通过增量更新保持最新，直接从缓存刷新卡片
        await refreshRecommendCards(true);
    });

    // 刷新设置按钮
    document.getElementById('refreshSettingsBtn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showRefreshSettingsModal();
    });

    // 初始化刷新设置弹窗
    initRefreshSettingsModal();

    // 预设模式按钮
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const mode = btn.dataset.mode;
            applyPresetMode(mode);
        });
    });
}

// =============================================================================
// 【重要架构】全局链接点击兜底监听器 - 时间捕捉归因
// =============================================================================
// 本项目有两套独立的链接点击处理系统，互不干扰：
//   1. 书签系统（defaultOpenMode）- 处理 .tree-bookmark-link
//   2. 时间捕捉兜底（本监听器）- 处理其他所有 target="_blank" 链接
//
// ⚠️ 添加新功能时必须注意：
//   - 如果新增链接区域有自己的处理逻辑，必须在下面添加排除条件！
//   - 否则会导致链接被打开两次（本监听器 + 专用监听器都处理）
//   - 详见：.agent/workflows/link-click-handling.md
// =============================================================================
// 捕捉 extension 页面内的超链接打开（<a target="_blank">），统一走 tabs.create 以便做书签归因兜底
// 排除书签链接（.tree-bookmark-link）和超链接区域，让其走专门的处理逻辑
try {
    document.addEventListener('click', async (e) => {
        const anchor = e.target && typeof e.target.closest === 'function'
            ? e.target.closest('a[target="_blank"]')
            : null;
        if (!anchor) return;

        // 排除书签链接：书签链接有专门的处理逻辑（支持 defaultOpenMode 记忆）
        if (anchor.classList.contains('tree-bookmark-link')) return;

        // 排除超链接区域：如果新增独立处理的区域，请在此处添加排除条件

        const href = anchor.getAttribute('href') || '';
        if (!href || (!href.startsWith('http://') && !href.startsWith('https://'))) return;

        // 已被其他逻辑处理则跳过
        if (e.defaultPrevented) return;

        e.preventDefault();
        e.stopPropagation();

        const title = (anchor.textContent || '').trim();
        if (typeof window.openBookmarkNewTab === 'function') {
            await window.openBookmarkNewTab(href, { title, source: 'history_ui_link' });
        } else {
            window.open(href, '_blank');
        }
    }, true);
} catch (_) { }

// 应用预设模式
function applyPresetMode(mode) {
    if (!presetModes[mode]) return;

    // 如果已经是目标模式，不触发全量重算
    if (currentRecommendMode === mode) {
        console.log('[书签推荐] 已是当前模式，跳过重算:', mode);
        return;
    }

    currentRecommendMode = mode;
    const preset = presetModes[mode];

    // 更新按钮状态
    document.querySelectorAll('.preset-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });

    // 更新权重输入框
    const weightInputs = {
        freshness: document.getElementById('weightFreshness'),
        coldness: document.getElementById('weightColdness'),
        timeDegree: document.getElementById('weightTimeDegree'),
        forgetting: document.getElementById('weightForgetting'),
        laterReview: document.getElementById('weightLaterReview')
    };

    // 设置权重值
    weightInputs.freshness.value = preset.weights.freshness;
    weightInputs.coldness.value = preset.weights.coldness;
    weightInputs.timeDegree.value = preset.weights.timeDegree;
    weightInputs.forgetting.value = preset.weights.forgetting;
    weightInputs.laterReview.value = preset.weights.laterReview;

    // 处理优先模式和用户覆盖
    const priorityModeBtn = document.getElementById('priorityModeBtn');

    if (mode === 'priority') {
        // 优先模式：橙色显示
        for (const input of Object.values(weightInputs)) {
            input.style.color = '#ff6b35';
            input.style.fontWeight = 'bold';
        }
        // 清除用户覆盖标记
        if (priorityModeBtn) {
            delete priorityModeBtn.dataset.userOverride;
        }
    } else {
        // 其他模式：正常显示
        for (const input of Object.values(weightInputs)) {
            input.style.color = '';
            input.style.fontWeight = '';
        }
        // 设置用户覆盖标记（防止自动切换回优先模式）
        if (priorityModeBtn && priorityModeBtn.style.display !== 'none') {
            priorityModeBtn.dataset.userOverride = 'true';
        }
    }

    // 更新阈值输入框
    document.getElementById('thresholdFreshness').value = preset.thresholds.freshness;
    document.getElementById('thresholdColdness').value = preset.thresholds.coldness;
    document.getElementById('thresholdTimeDegree').value = preset.thresholds.timeDegree;
    document.getElementById('thresholdForgetting').value = preset.thresholds.forgetting;

    // 保存配置（saveFormulaConfig 内部会触发全量重算）
    saveFormulaConfig().then(() => {
        // 重算完成后刷新推荐卡片
        refreshRecommendCards();
    });

    const modeNames = { default: '默认', archaeology: '考古', consolidate: '巩固', wander: '漫游', priority: '优先巩固' };
    console.log(`[书签推荐] 切换到${modeNames[mode] || mode}模式`);
}

function initTrackingToggle() {
    // 可能会在多个入口被调用（recommend view / tracking tab），避免重复绑定导致一次点击触发两次反向切换
    if (initTrackingToggle._initialized) return;

    const toggleBtn = document.getElementById('trackingToggleBtn');
    if (toggleBtn) {
        initTrackingToggle._initialized = true;
        let userInteracted = false;

        const setToggleUi = (isActive) => {
            toggleBtn.classList.toggle('active', !!isActive);
            const textEl = document.getElementById('trackingToggleText');
            if (textEl) {
                textEl.textContent = isActive
                    ? i18n.trackingToggleOn[currentLang]
                    : i18n.trackingToggleOff[currentLang];
            }

            // 更新公式中的T项（时间度）
            const termT = document.getElementById('termTimeDegree');
            if (termT) {
                termT.classList.toggle('disabled', !isActive);
            }
        };

        toggleBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            userInteracted = true;
            const isActive = !toggleBtn.classList.contains('active');
            setToggleUi(isActive);

            // 通知 background.js 更新追踪状态
            try {
                await browserAPI.runtime.sendMessage({
                    action: 'setTrackingEnabled',
                    enabled: isActive
                });
                // 立即刷新左下角小组件
                updateTimeTrackingWidget();
            } catch (error) {
                console.warn('[书签推荐] 设置追踪状态失败:', error);
            }
        });

        // 加载保存的状态
        browserAPI.runtime.sendMessage({ action: 'isTrackingEnabled' }, (response) => {
            if (response && response.success) {
                // 如果用户已经点击过，不用“初始化回包”覆盖用户最新操作（避免看起来像“点不动”）
                if (userInteracted) return;
                const isActive = response.enabled;
                setToggleUi(isActive);
            }
        });
    }

    // 排行类型选择器（综合时间 / 唤醒次数）
    const rankingTypeSelect = document.getElementById('trackingRankingType');
    if (rankingTypeSelect) {
        rankingTypeSelect.addEventListener('change', () => {
            loadActiveTimeRanking();
        });
    }

    // 时间范围选择器
    const rangeSelect = document.getElementById('trackingRankingRange');
    if (rangeSelect) {
        rangeSelect.addEventListener('change', () => {
            loadActiveTimeRanking();
        });
    }

    // 清除记录按钮 - 改为下拉菜单
    const clearBtn = document.getElementById('clearTrackingBtn');
    if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showTrackingClearMenu(clearBtn);
        });
    }

    // 状态说明弹窗（使用事件委托，支持动态创建的图标）
    const stateModal = document.getElementById('trackingStateModal');
    const closeStateModalBtn = document.getElementById('closeTrackingStateModal');
    const trackingHeaderState = document.getElementById('trackingHeaderState');

    if (trackingHeaderState && stateModal) {
        trackingHeaderState.addEventListener('click', (e) => {
            if (e.target.classList.contains('tracking-state-help')) {
                e.stopPropagation();
                stateModal.classList.add('show');
                updateTrackingStateModalI18n();
            }
        });

        if (closeStateModalBtn) {
            closeStateModalBtn.addEventListener('click', () => {
                stateModal.classList.remove('show');
            });
        }

        // 点击背景关闭
        stateModal.addEventListener('click', (e) => {
            if (e.target === stateModal) {
                stateModal.classList.remove('show');
            }
        });
    }

    // 公式说明弹窗
    const formulaHelpBtn = document.getElementById('formulaHelpBtn');
    const formulaHelpModal = document.getElementById('formulaHelpModal');
    const closeFormulaHelpBtn = document.getElementById('closeFormulaHelpModal');

    if (formulaHelpBtn && formulaHelpModal) {
        formulaHelpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            formulaHelpModal.classList.add('show');
            updateFormulaHelpModalI18n();
        });

        if (closeFormulaHelpBtn) {
            closeFormulaHelpBtn.addEventListener('click', () => {
                formulaHelpModal.classList.remove('show');
            });
        }

        formulaHelpModal.addEventListener('click', (e) => {
            if (e.target === formulaHelpModal) {
                formulaHelpModal.classList.remove('show');
            }
        });
    }
}

// 更新状态说明弹窗的国际化文本
function updateTrackingStateModalI18n() {
    const isEn = currentLang === 'en';

    // 标题
    const title = document.getElementById('trackingStateModalTitle');
    if (title) title.textContent = isEn ? 'Time Tracking State Guide' : '时间捕捉状态说明';

    // 表头（图标在第一列）
    document.getElementById('stateTableHeaderIcon').textContent = isEn ? 'Icon' : '图标';
    document.getElementById('stateTableHeaderState').textContent = isEn ? 'State' : '状态';
    document.getElementById('stateTableHeaderCondition').textContent = isEn ? 'Condition' : '条件';
    document.getElementById('stateTableHeaderRate').textContent = isEn ? 'Rate' : '计时倍率';
    document.getElementById('stateTableHeaderExample').textContent = isEn ? 'Example' : '例子';

    // 表格内容
    document.getElementById('stateActiveLabel').textContent = isEn ? 'Active' : '活跃';
    document.getElementById('stateActiveCondition').textContent = isEn ? 'Current tab + Window focus + User active' : '当前标签 + 窗口焦点 + 用户活跃';
    document.getElementById('stateActiveExample').textContent = isEn ? 'Reading, scrolling, typing' : '正在阅读、滚动页面、打字';

    document.getElementById('stateIdleLabel').textContent = isEn ? 'Idle Focus' : '前台静止';
    document.getElementById('stateIdleCondition').textContent = isEn ? 'Current tab + Window focus + User idle' : '当前标签 + 窗口焦点 + 用户空闲';
    document.getElementById('stateIdleExample').textContent = isEn ? 'Watching video, thinking' : '静止观看视频、思考内容';

    document.getElementById('stateVisibleLabel').textContent = isEn ? 'Visible Ref' : '可见参考';
    document.getElementById('stateVisibleCondition').textContent = isEn ? 'Current tab + No window focus + User active' : '当前标签 + 窗口无焦点 + 用户活跃';
    document.getElementById('stateVisibleExample').textContent = isEn ? 'Split-screen reference, comparing code' : '分屏参考文档、对照代码';

    document.getElementById('stateBackgroundLabel').textContent = isEn ? 'Background' : '后台';
    document.getElementById('stateBackgroundCondition').textContent = isEn ? 'Not current tab + User active' : '非当前标签 + 用户活跃';
    document.getElementById('stateBackgroundExample').textContent = isEn ? 'Idle tab, background music' : '挂机、后台播放音乐';

    document.getElementById('stateSleepLabel').textContent = isEn ? 'Sleep' : '睡眠';
    document.getElementById('stateSleepCondition').textContent = isEn ? 'User idle (any tab)' : '用户空闲（任何标签）';
    document.getElementById('stateSleepExample').textContent = isEn ? 'Away from computer, screen locked, tab auto-sleep' : '离开电脑、锁屏、页面自动睡眠';

    // 综合时间公式
    const formulaEl = document.getElementById('trackingStateFormula');
    if (formulaEl) {
        formulaEl.textContent = isEn
            ? 'Composite = Active×1.0 + Idle×0.8 + Visible×0.5 + Background×0.1'
            : '综合时间 = 活跃×1.0 + 前台静止×0.8 + 可见参考×0.5 + 后台×0.1';
    }
}

// 更新公式说明弹窗的国际化文本
function updateFormulaHelpModalI18n() {
    const isEn = currentLang === 'en';

    // 标题
    const title = document.getElementById('formulaHelpModalTitle');
    if (title) title.textContent = isEn ? 'Formula Explanation' : '权重公式说明';

    // 通用公式
    const generalTitle = document.getElementById('formulaHelpGeneralTitle');
    if (generalTitle) generalTitle.textContent = isEn ? 'General Formula' : '通用公式';

    const codeEl = document.querySelector('.formula-help-code code');
    if (codeEl) codeEl.textContent = isEn
        ? 'Factor = 1 / (1 + (value / threshold)^0.7)'
        : '因子值 = 1 / (1 + (实际值 / 阈值)^0.7)';

    // 公式特点
    const featuresTitle = document.getElementById('formulaHelpFeaturesTitle');
    if (featuresTitle) featuresTitle.textContent = isEn ? 'Features' : '公式特点';

    document.getElementById('formulaHelpFeature1').innerHTML = isEn
        ? '<strong>At threshold = 0.5</strong>: When value equals threshold, factor is exactly 0.5'
        : '<strong>阈值处 = 0.5</strong>：当实际值等于阈值时，因子值正好是0.5';
    document.getElementById('formulaHelpFeature2').innerHTML = isEn
        ? '<strong>Smooth decay</strong>: Power function (^0.7) makes decay more gradual, avoiding hard cutoff'
        : '<strong>平滑衰减</strong>：使用幂函数(^0.7)使衰减更平缓，避免硬截断';
    document.getElementById('formulaHelpFeature3').innerHTML = isEn
        ? '<strong>Never zero</strong>: Even very large values retain small differentiation'
        : '<strong>永不归零</strong>：即使数值很大，仍保留微小区分度';
    document.getElementById('formulaHelpFeature4').innerHTML = isEn
        ? '<strong>Large value friendly</strong>: 1000 clicks still has 0.02 differentiation'
        : '<strong>大数值友好</strong>：1000次点击仍有0.02的区分度';

    // 效果示例
    const exampleTitle = document.getElementById('formulaHelpExampleTitle');
    if (exampleTitle) exampleTitle.textContent = isEn ? 'Examples' : '效果示例';

    document.getElementById('formulaHelpTableValue').textContent = isEn ? 'Value/Threshold' : '实际值/阈值';
    document.getElementById('formulaHelpTableResult').textContent = isEn ? 'Factor' : '因子值';
    document.getElementById('formulaHelpTableMeaning').textContent = isEn ? 'Meaning' : '含义';

    document.getElementById('formulaHelpThreshold').textContent = isEn ? '1×(threshold)' : '1×(阈值)';
    document.getElementById('formulaHelpMeaning1').textContent = isEn ? 'Highest priority' : '最高优先';
    document.getElementById('formulaHelpMeaning2').textContent = isEn ? 'Higher' : '较高';
    document.getElementById('formulaHelpMeaning3').textContent = isEn ? 'Medium' : '中等';
    document.getElementById('formulaHelpMeaning4').textContent = isEn ? 'Lower' : '较低';
    document.getElementById('formulaHelpMeaning5').textContent = isEn ? 'Very low' : '很低';
    document.getElementById('formulaHelpMeaning6').textContent = isEn ? 'Minimal but distinct' : '极低但仍有区分';

    // 注意事项
    const notesTitle = document.getElementById('formulaHelpNotesTitle');
    if (notesTitle) notesTitle.textContent = isEn ? 'Notes' : '注意事项';

    document.getElementById('formulaHelpNote1').innerHTML = isEn
        ? '<strong>F, C, T</strong> use inverse mode: larger value = smaller factor (e.g., more clicks = lower coldness)'
        : '<strong>F、C、T</strong> 使用 inverse 模式：值越大，因子越小（如点击越多，冷门度越低）';
    document.getElementById('formulaHelpNote2').innerHTML = isEn
        ? '<strong>D</strong> uses direct mode: more unvisited days = higher forgetting'
        : '<strong>D</strong> 使用正向模式：未访问天数越多，遗忘度越高';
    document.getElementById('formulaHelpNote3').innerHTML = isEn
        ? '<strong>L</strong> is boolean: manually added = 1, otherwise = 0'
        : '<strong>L</strong> 是布尔值：手动添加=1，否则=0';
}

// 推荐卡片数据
let recommendCards = [];
let trackingRefreshInterval = null;
let rankingRefreshInterval = null;  // 排行榜刷新定时器
const TRACKING_REFRESH_INTERVAL = 1000; // 1秒刷新一次当前会话，更实时
const RANKING_REFRESH_INTERVAL = 1000; // 1秒刷新一次排行榜，与正在追踪同步

// 书签推荐诊断缓存
const RECOMMEND_SCORE_DEBUG_CACHE_TTL_MS = 60 * 1000;
const recommendScoreDebugCache = new Map();
const recommendScoreDebugInFlight = new Map();

// 跳过和屏蔽数据
let skippedBookmarks = new Set(); // 本次会话跳过的书签（内存，刷新页面后清空）
let recommendScoresComputeRetryTimer = null;
let recommendScoresComputeRetryCount = 0;

// 获取当前显示的卡片状态（与popup共享）
async function getHistoryCurrentCards() {
    return new Promise((resolve) => {
        browserAPI.storage.local.get(['popupCurrentCards'], (result) => {
            resolve(result.popupCurrentCards || null);
        });
    });
}

// 保存当前显示的卡片状态（与popup共享）
async function saveHistoryCurrentCards(cardIds, flippedIds, cardData = null) {
    // 标记本次保存时间，防止触发循环刷新
    historyLastSaveTime = Date.now();

    const dataToSave = {
        popupCurrentCards: {
            cardIds: cardIds,
            flippedIds: flippedIds,
            timestamp: Date.now()
        }
    };
    // 如果提供了卡片数据（包含url和favicon），也保存它们
    if (cardData && cardData.length > 0) {
        dataToSave.popupCurrentCards.cardData = cardData;
    }
    await browserAPI.storage.local.set(dataToSave);
}

// 异步获取并保存当前卡片的数据（含priority和favicon，供popup使用）
async function saveCardFaviconsToStorage(bookmarks) {
    if (!bookmarks || bookmarks.length === 0) return;

    try {
        // 获取当前保存的卡片状态
        const currentCards = await getHistoryCurrentCards();
        if (!currentCards || !currentCards.cardIds) return;

        // 为每个卡片获取favicon data URL和priority
        const cardData = await Promise.all(bookmarks.map(async (bookmark) => {
            if (!bookmark || !bookmark.url) {
                return { id: bookmark?.id, title: bookmark?.title || bookmark?.name || '', url: null, favicon: null, priority: 0 };
            }
            try {
                const faviconUrl = await FaviconCache.fetch(bookmark.url);
                const favicon = faviconUrl !== fallbackIcon ? faviconUrl : null;
                return {
                    id: bookmark.id,
                    title: bookmark.title || bookmark.name || '',
                    url: bookmark.url,
                    favicon,
                    faviconUrl: favicon, // 兼容旧字段
                    priority: bookmark.priority || 0
                };
            } catch (e) {
                return {
                    id: bookmark.id,
                    title: bookmark.title || bookmark.name || '',
                    url: bookmark.url,
                    favicon: null,
                    faviconUrl: null,
                    priority: bookmark.priority || 0
                };
            }
        }));

        // 更新storage中的卡片数据
        currentCards.cardData = cardData;
        historyLastSaveTime = Date.now(); // 防止触发循环刷新
        await browserAPI.storage.local.set({ popupCurrentCards: currentCards });
    } catch (error) {
        // 静默处理错误
    }
}

// 标记卡片为已勾选，并检查是否全部勾选
async function markHistoryCardFlipped(bookmarkId) {
    const currentCards = await getHistoryCurrentCards();
    if (!currentCards) return false;

    // 添加到已勾选列表
    if (!currentCards.flippedIds.includes(bookmarkId)) {
        currentCards.flippedIds.push(bookmarkId);
        await saveHistoryCurrentCards(currentCards.cardIds, currentCards.flippedIds);
    }

    // 检查是否全部勾选
    const allFlipped = currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));
    return allFlipped;
}

// 更新单个卡片显示
function updateCardDisplay(card, bookmark, isFlipped = false) {
    card.classList.remove('empty');
    if (isFlipped) {
        card.classList.add('flipped');
    } else {
        card.classList.remove('flipped');
    }
    card.querySelector('.card-title').textContent = bookmark.title || bookmark.name || bookmark.url;
    card.querySelector('.card-priority').textContent = `S = ${bookmark.priority.toFixed(3)}`;
    card.dataset.url = bookmark.url;
    card.dataset.bookmarkId = bookmark.id;

    // 设置 favicon
    const favicon = card.querySelector('.card-favicon');
    if (favicon && bookmark.url) {
        setHighResFavicon(favicon, bookmark.url);
    }

    // 诊断面板（右上角）
    card.classList.remove('debug-open');
    const debugOverlay = card.querySelector('.recommend-debug');
    if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
    const debugPre = card.querySelector('.recommend-debug-pre');
    if (debugPre) debugPre.textContent = '--';

    const closeDebug = () => {
        card.classList.remove('debug-open');
        if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
    };

    const openDebug = async () => {
        if (!debugOverlay || !debugPre) return;
        card.classList.add('debug-open');
        debugOverlay.setAttribute('aria-hidden', 'false');
        debugPre.textContent = currentLang === 'en' ? 'Loading...' : '加载中...';

        const cached = getCachedRecommendScoreDebug(bookmark.id);
        if (cached) {
            debugPre.textContent = formatRecommendScoreDebugText(cached);
            if (cached?.factors && typeof cached.factors.S === 'number') {
                bookmark.priority = cached.factors.S;
                bookmark.factors = cached.factors;
            }
            syncRecommendScoreFromDebug(bookmark.id, cached);
        } else {
            debugPre.textContent = currentLang === 'en' ? 'Loading...' : '加载中...';
        }

        const debug = await getFreshRecommendScoreDebug(bookmark.id);
        if (!debug) {
            if (!cached) {
                debugPre.textContent = currentLang === 'en' ? 'Load failed.' : '加载失败。';
            }
            return;
        }
        setCachedRecommendScoreDebug(bookmark.id, debug);
        debugPre.textContent = formatRecommendScoreDebugText(debug);
        if (debug?.factors && typeof debug.factors.S === 'number') {
            bookmark.priority = debug.factors.S;
            bookmark.factors = debug.factors;
        }
        syncRecommendScoreFromDebug(bookmark.id, debug);
    };

    const debugBtn = card.querySelector('.card-debug-btn');
    if (debugBtn) {
        debugBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (card.classList.contains('debug-open')) {
                closeDebug();
            } else {
                openDebug();
            }
        };
    }

    const debugCloseBtn = card.querySelector('.recommend-debug-close-btn');
    if (debugCloseBtn) {
        debugCloseBtn.onclick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            closeDebug();
        };
    }

    // 点击卡片主体：打开链接 + 标记为已翻过 + 记录复习
    card.onclick = async (e) => {
        if (e.target.closest('.card-actions')) return;
        if (e.target.closest('.card-debug-btn')) return;
        if (e.target.closest('.recommend-debug')) return;

        if (bookmark.url) {
            await markBookmarkFlipped(bookmark.id);
            await recordReview(bookmark.id);
            await openInRecommendWindow(bookmark.url);
            card.classList.add('flipped');

            // 更新本地卡片勾选状态（storage监听器会自动处理刷新）
            await markHistoryCardFlipped(bookmark.id);
        }
    };

    // 按钮事件：稍后复习
    const btnLater = card.querySelector('.card-btn-later');
    if (btnLater) {
        btnLater.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            showLaterModal(bookmark);
        };
    }

    // 按钮事件：跳过本次
    const btnSkip = card.querySelector('.card-btn-skip');
    if (btnSkip) {
        btnSkip.onclick = async (e) => {
            e.stopPropagation();
            e.preventDefault();
            skippedBookmarks.add(bookmark.id);
            await refreshRecommendCards(true);
        };
    }

    // 按钮事件：永久屏蔽
    const btnBlock = card.querySelector('.card-btn-block');
    if (btnBlock) {
        btnBlock.onclick = async (e) => {
            e.stopPropagation();
            e.preventDefault();
            await blockBookmark(bookmark.id);
            await loadBlockedLists();
            await refreshRecommendCards(true);
        };
    }
}

// 设置卡片为空状态
function setCardEmpty(card) {
    card.classList.add('empty');
    card.querySelector('.card-title').textContent = '--';
    card.querySelector('.card-priority').textContent = 'S = --';
    const favicon = card.querySelector('.card-favicon');
    if (favicon) {
        favicon.src = fallbackIcon;
    }
    card.onclick = null;

    const actions = card.querySelector('.card-actions');
    if (actions) {
        actions.querySelectorAll('.card-btn').forEach(btn => {
            btn.onclick = null;
        });
    }

    card.classList.remove('debug-open');
    const debugOverlay = card.querySelector('.recommend-debug');
    if (debugOverlay) debugOverlay.setAttribute('aria-hidden', 'true');
    const debugPre = card.querySelector('.recommend-debug-pre');
    if (debugPre) debugPre.textContent = '--';
    const debugBtn = card.querySelector('.card-debug-btn');
    if (debugBtn) debugBtn.onclick = null;
    const debugCloseBtn = card.querySelector('.recommend-debug-close-btn');
    if (debugCloseBtn) debugCloseBtn.onclick = null;
}



function getCachedRecommendScoreDebug(bookmarkId) {
    const entry = recommendScoreDebugCache.get(bookmarkId);
    if (!entry) return null;
    if ((Date.now() - entry.time) > RECOMMEND_SCORE_DEBUG_CACHE_TTL_MS) {
        recommendScoreDebugCache.delete(bookmarkId);
        return null;
    }
    return entry.debug || null;
}

function setCachedRecommendScoreDebug(bookmarkId, debug) {
    if (!bookmarkId || !debug) return;
    recommendScoreDebugCache.set(bookmarkId, { time: Date.now(), debug });
}

function getFreshRecommendScoreDebug(bookmarkId) {
    if (!bookmarkId) return Promise.resolve(null);
    const key = String(bookmarkId);
    if (recommendScoreDebugInFlight.has(key)) {
        return recommendScoreDebugInFlight.get(key);
    }
    const promise = requestRecommendScoreDebug(key)
        .catch(() => null)
        .finally(() => {
            recommendScoreDebugInFlight.delete(key);
        });
    recommendScoreDebugInFlight.set(key, promise);
    return promise;
}

function updateRecommendCardScoreDisplay(bookmarkId, newS) {
    if (!bookmarkId || !Number.isFinite(newS)) return;
    const id = String(bookmarkId);
    const cards = document.querySelectorAll(`.recommend-card[data-bookmark-id="${id}"]`);
    if (!cards || !cards.length) return;
    cards.forEach((card) => {
        const priorityEl = card.querySelector('.card-priority');
        if (priorityEl) {
            priorityEl.textContent = `S = ${newS.toFixed(3)}`;
        }
    });
}

function syncRecommendScoreFromDebug(bookmarkId, debug, options = {}) {
    if (!bookmarkId || !debug) return null;
    const cachedS = (typeof debug?.storage?.cachedEntry?.S === 'number') ? debug.storage.cachedEntry.S : null;
    const computedS = (typeof debug?.factors?.S === 'number') ? debug.factors.S : null;
    const nextS = (cachedS != null) ? cachedS : computedS;
    if (!Number.isFinite(nextS)) return null;

    if (options && options.scoreEl) {
        try {
            options.scoreEl.textContent = nextS.toFixed(3);
        } catch (_) { }
    }

    updateRecommendCardScoreDisplay(bookmarkId, nextS);

    try {
        if (typeof window.updateRecommendSearchScoreCache === 'function') {
            const updated = window.updateRecommendSearchScoreCache(bookmarkId, nextS);
            if (!updated && typeof window.invalidateRecommendSearchIndex === 'function') {
                window.invalidateRecommendSearchIndex();
            }
        } else if (typeof window.invalidateRecommendSearchIndex === 'function') {
            window.invalidateRecommendSearchIndex();
        }
    } catch (_) { }

    return nextS;
}

function requestRecommendScoreDebug(bookmarkId) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(null);
        }, 3500);

        if (!browserAPI?.runtime?.sendMessage || !bookmarkId) {
            clearTimeout(timer);
            resolve(null);
            return;
        }

        browserAPI.runtime.sendMessage({ action: 'getBookmarkScoreDebug', bookmarkId }, (response) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (browserAPI.runtime.lastError) {
                resolve(null);
            } else if (response?.success && response?.debug) {
                resolve(response.debug);
            } else {
                resolve(null);
            }
        });
    });
}

function formatRecommendDebugTime(ts) {
    const t = Number(ts || 0);
    if (!t) return '--';
    try {
        const locale = currentLang === 'en' ? 'en-US' : 'zh-CN';
        return new Date(t).toLocaleString(locale);
    } catch (_) {
        return String(t);
    }
}

function formatRecommendScoreDebugText(debug) {
    const isEn = currentLang === 'en';
    const lines = [];
    if (!debug) {
        return isEn ? 'No debug data.' : '没有诊断数据。';
    }

    const f = debug.factors || {};
    const h = debug.matches?.history || {};
    const t = debug.matches?.tracking || {};
    const raw = debug.raw || {};
    const w = debug.weightsUsed || {};
    const th = debug.config?.thresholds || {};
    const storage = debug.storage || {};
    const cachedS = typeof storage.cachedEntry?.S === 'number' ? storage.cachedEntry.S : null;

    const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : '--');
    const fmtDays = (v) => (typeof v === 'number' ? v.toFixed(2) : '--');

    if (cachedS != null && typeof f.S === 'number') {
        if (isEn) {
            lines.push(`S=${cachedS.toFixed(3)} (old)  S=${f.S.toFixed(3)} (new)`);
        } else {
            lines.push(`S=${cachedS.toFixed(3)}（旧）  S=${f.S.toFixed(3)}（新）`);
        }
    } else {
        lines.push(`S=${fmt(f.S)}`);
    }
    lines.push(`F=${fmt(f.F)} C=${fmt(f.C)} T=${fmt(f.T)} D=${fmt(f.D)} L=${fmt(f.L)} R=${fmt(f.R)}`);
    lines.push(`AddedΔ=${fmtDays(raw.daysSinceAdded)}d  LastVisitΔ=${fmtDays(raw.daysSinceLastVisit)}d  T(min)=${fmtDays(raw.compositeMinutes)}`);
    lines.push('');

    lines.push(`History: ${h.type || 'none'}  visits=${h.visitCount ?? 0}  last=${formatRecommendDebugTime(h.lastVisitTime)}`);
    lines.push(`Tracking: ${t.type || 'none'}  ms=${t.compositeMs ?? 0}${t.ignoredTitleHit ? '  (ignored title hit)' : ''}`);
    lines.push('');

    lines.push(`WeightsUsed: w1=${fmt(w.w1)} w2=${fmt(w.w2)} w3=${fmt(w.w3)} w4=${fmt(w.w4)} w5=${fmt(w.w5)}`);
    lines.push(`Thresholds: freshness=${th.freshness ?? '--'} coldness=${th.coldness ?? '--'} shallowRead=${th.shallowRead ?? '--'} forgetting=${th.forgetting ?? '--'}`);
    lines.push('');

    lines.push(`Cache: mode=${storage.cacheMode || '--'} algo=v${storage.algoVersion || '--'} cachedS=${cachedS == null ? '--' : cachedS.toFixed(3)} time=${storage.recommendScoresTime || 0}`);
    if (storage.staleMeta?.staleAt) {
        lines.push(`StaleMeta: at=${formatRecommendDebugTime(storage.staleMeta.staleAt)} reason=${storage.staleMeta.reason || ''}`);
    }

    if (Array.isArray(debug.notes) && debug.notes.length) {
        lines.push('');
        lines.push(isEn ? 'Notes:' : '备注:');
        debug.notes.forEach((note) => lines.push(`- ${note}`));
    }

    return lines.join('\n');
}

// 推荐搜索：二级 UI 预览（不影响推荐卡片）
let recommendSearchPreviewActive = false;
let recommendSearchModalItem = null;

function closeRecommendSearchModal() {
    const modal = document.getElementById('recommendSearchModal');
    if (!modal) return;
    modal.classList.remove('show');
    recommendSearchPreviewActive = false;
}

function initRecommendSearchModal() {
    const modal = document.getElementById('recommendSearchModal');
    if (!modal || modal.hasAttribute('data-bound')) return;
    modal.setAttribute('data-bound', 'true');

    const closeBtn = document.getElementById('recommendSearchModalClose');
    const closeBtn2 = document.getElementById('recommendSearchModalCloseBtn');
    const laterBtn = document.getElementById('recommendSearchModalLaterBtn');
    const skipBtn = document.getElementById('recommendSearchModalSkipBtn');
    const blockBtn = document.getElementById('recommendSearchModalBlockBtn');
    const openBtn = document.getElementById('recommendSearchModalOpenBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeRecommendSearchModal);
    if (closeBtn2) closeBtn2.addEventListener('click', closeRecommendSearchModal);

    if (laterBtn) {
        laterBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const item = recommendSearchModalItem;
            if (!item) return;
            closeRecommendSearchModal();
            showLaterModal(item);
        });
    }

    if (skipBtn) {
        skipBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const item = recommendSearchModalItem;
            if (!item || !item.id) return;
            skippedBookmarks.add(item.id);
            await refreshRecommendCards(true);
            closeRecommendSearchModal();
        });
    }

    if (blockBtn) {
        blockBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const item = recommendSearchModalItem;
            if (!item || !item.id) return;
            await blockBookmark(item.id);
            await loadBlockedLists();
            await refreshRecommendCards(true);
            closeRecommendSearchModal();
        });
    }

    if (openBtn) {
        openBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            const item = recommendSearchModalItem;
            if (!item || !item.url) return;
            await openInRecommendWindow(item.url);
            closeRecommendSearchModal();
        });
    }

    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeRecommendSearchModal();
    });
}

async function showRecommendSearchResultCard(item) {
    initRecommendSearchModal();
    const modal = document.getElementById('recommendSearchModal');
    if (!modal) return;

    const faviconEl = document.getElementById('recommendSearchModalFavicon');
    const titleEl = document.getElementById('recommendSearchModalItemTitle');
    const urlEl = document.getElementById('recommendSearchModalItemUrl');
    const scoreEl = document.getElementById('recommendSearchModalItemScore');
    const debugPre = document.getElementById('recommendSearchModalDebugPre');
    const openBtn = document.getElementById('recommendSearchModalOpenBtn');
    const laterBtn = document.getElementById('recommendSearchModalLaterBtn');
    const skipBtn = document.getElementById('recommendSearchModalSkipBtn');
    const blockBtn = document.getElementById('recommendSearchModalBlockBtn');

    const bookmarkId = item && (item.id || item.bookmarkId);
    const priority = (item && Number.isFinite(item.scoreS)) ? item.scoreS
        : (item && Number.isFinite(item.S)) ? item.S
            : (item && Number.isFinite(item.priority)) ? item.priority
                : 0.5;

    const bookmark = {
        id: bookmarkId,
        title: item?.title || item?.name || '',
        name: item?.title || item?.name || '',
        url: item?.url || '',
        priority
    };

    // 如果搜索结果缺失 URL，尝试从书签 API 回填
    if (bookmarkId && !bookmark.url) {
        try {
            const nodes = await browserAPI.bookmarks.get(bookmarkId);
            const node = Array.isArray(nodes) ? nodes[0] : null;
            if (node && node.url) {
                bookmark.url = node.url;
                if (!bookmark.title) {
                    bookmark.title = node.title || '';
                    bookmark.name = node.title || '';
                }
            }
        } catch (_) { }
    }

    // 尝试补充 factors / S
    if (bookmarkId) {
        try {
            const result = await browserAPI.storage.local.get(['recommend_scores_cache']);
            const cached = result?.recommend_scores_cache?.[bookmarkId];
            if (cached && Number.isFinite(cached.S)) {
                bookmark.priority = cached.S;
                bookmark.factors = cached;
                try {
                    if (typeof window.updateRecommendSearchScoreCache === 'function') {
                        window.updateRecommendSearchScoreCache(bookmarkId, cached.S);
                    }
                } catch (_) { }
            }
        } catch (_) { }
    }

    if (titleEl) {
        titleEl.textContent = bookmark.title || (currentLang === 'zh_CN' ? '（无标题）' : '(Untitled)');
    }
    if (urlEl) {
        urlEl.textContent = bookmark.url || '--';
        if (bookmark.url) {
            urlEl.setAttribute('href', bookmark.url);
            urlEl.setAttribute('title', bookmark.url);
            urlEl.onclick = (e) => {
                e.preventDefault();
                openInRecommendWindow(bookmark.url);
            };
        } else {
            urlEl.setAttribute('href', '#');
            urlEl.removeAttribute('title');
            urlEl.onclick = null;
        }
    }
    if (scoreEl) {
        const scoreValue = Number.isFinite(bookmark.priority) ? bookmark.priority : priority;
        scoreEl.textContent = Number.isFinite(scoreValue) ? scoreValue.toFixed(3) : '--';
    }
    if (faviconEl) {
        setHighResFavicon(faviconEl, bookmark.url);
    }

    if (debugPre) {
        const cached = getCachedRecommendScoreDebug(bookmark.id);
        if (cached) {
            debugPre.textContent = formatRecommendScoreDebugText(cached);
            if (cached?.factors && typeof cached.factors.S === 'number') {
                bookmark.priority = cached.factors.S;
                bookmark.factors = cached.factors;
            }
            syncRecommendScoreFromDebug(bookmark.id, cached, { scoreEl });
        } else {
            debugPre.textContent = currentLang === 'en' ? 'Loading...' : '加载中...';
        }

        const debug = await getFreshRecommendScoreDebug(bookmark.id);
        if (!debug) {
            if (!cached) {
                debugPre.textContent = currentLang === 'en' ? 'Load failed.' : '加载失败。';
            }
        } else {
            setCachedRecommendScoreDebug(bookmark.id, debug);
            debugPre.textContent = formatRecommendScoreDebugText(debug);
            if (debug?.factors && typeof debug.factors.S === 'number') {
                bookmark.priority = debug.factors.S;
                bookmark.factors = debug.factors;
            }
            syncRecommendScoreFromDebug(bookmark.id, debug, { scoreEl });
        }
    }

    if (openBtn) {
        openBtn.disabled = !bookmark.url;
    }
    if (laterBtn) laterBtn.disabled = !bookmark.id;
    if (skipBtn) skipBtn.disabled = !bookmark.id;
    if (blockBtn) blockBtn.disabled = !bookmark.id;

    recommendSearchModalItem = bookmark;

    modal.classList.add('show');
    recommendSearchPreviewActive = true;
}

try {
    window.showRecommendSearchResultCard = showRecommendSearchResultCard;
} catch (_) { }
// 获取已屏蔽书签
async function getBlockedBookmarks() {
    try {
        const result = await browserAPI.storage.local.get('recommend_blocked');
        return result.recommend_blocked || { bookmarks: [], folders: [], domains: [] };
    } catch (e) {
        console.error('[屏蔽] 获取屏蔽数据失败:', e);
        return { bookmarks: [], folders: [], domains: [] };
    }
}

// 屏蔽书签（按标题匹配，同名书签一起屏蔽）
async function blockBookmark(bookmarkId) {
    try {
        // 获取当前书签信息
        const bookmarks = await new Promise(resolve => {
            browserAPI.bookmarks.get(bookmarkId, resolve);
        });
        if (!bookmarks || bookmarks.length === 0) return false;
        const targetBookmark = bookmarks[0];
        const targetTitle = targetBookmark.title;

        // 获取所有书签
        const allBookmarks = await new Promise(resolve => {
            browserAPI.bookmarks.getTree(tree => {
                const result = [];
                function traverse(nodes) {
                    for (const node of nodes) {
                        if (node.url) result.push(node);
                        if (node.children) traverse(node.children);
                    }
                }
                traverse(tree);
                resolve(result);
            });
        });

        // 找到所有同标题的书签
        const sameTitle = allBookmarks.filter(b => b.title === targetTitle);

        const blocked = await getBlockedBookmarks();
        let blockedCount = 0;

        for (const b of sameTitle) {
            if (!blocked.bookmarks.includes(b.id)) {
                blocked.bookmarks.push(b.id);
                blockedCount++;
            }
        }

        await browserAPI.storage.local.set({ recommend_blocked: blocked });
        console.log('[屏蔽] 已屏蔽书签:', targetTitle, '共', blockedCount, '个');
        return true;
    } catch (e) {
        console.error('[屏蔽] 屏蔽书签失败:', e);
        return false;
    }
}

// 恢复屏蔽的书签
async function unblockBookmark(bookmarkId) {
    try {
        const blocked = await getBlockedBookmarks();
        blocked.bookmarks = blocked.bookmarks.filter(id => id !== bookmarkId);
        await browserAPI.storage.local.set({ recommend_blocked: blocked });
        console.log('[屏蔽] 已恢复书签:', bookmarkId);
        // 恢复后触发S值计算（该书签之前没有缓存）
        browserAPI.runtime.sendMessage({ action: 'updateBookmarkScore', bookmarkId });
        return true;
    } catch (e) {
        console.error('[屏蔽] 恢复书签失败:', e);
        return false;
    }
}

// 获取稍后复习数据
async function getPostponedBookmarks() {
    try {
        const result = await browserAPI.storage.local.get('recommend_postponed');
        return result.recommend_postponed || [];
    } catch (e) {
        console.error('[稍后] 获取稍后复习数据失败:', e);
        return [];
    }
}

// 添加稍后复习
async function postponeBookmark(bookmarkId, delayMs) {
    try {
        const postponed = await getPostponedBookmarks();
        const existing = postponed.find(p => p.bookmarkId === bookmarkId);
        const now = Date.now();

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
        console.log('[稍后] 已推迟书签:', bookmarkId, '延迟:', delayMs / 3600000, '小时');
        return true;
    } catch (e) {
        console.error('[稍后] 推迟书签失败:', e);
        return false;
    }
}

// 取消稍后复习
async function cancelPostpone(bookmarkId) {
    try {
        let postponed = await getPostponedBookmarks();
        const hadManualPostponed = postponed.some(p => p.manuallyAdded);

        postponed = postponed.filter(p => p.bookmarkId !== bookmarkId);
        await browserAPI.storage.local.set({ recommend_postponed: postponed });
        console.log('[稍后] 已取消推迟:', bookmarkId);

        // 检查取消后是否还有手动添加的待复习
        const hasManualPostponed = postponed.some(p => p.manuallyAdded);

        // 如果手动待复习从有变无，后续 loadPostponedList 会触发模式切换和全量重算
        // 此时不需要增量更新，避免重复计算
        if (hadManualPostponed && !hasManualPostponed && currentRecommendMode === 'priority') {
            console.log('[稍后] 待复习将清空，跳过增量更新（后续会全量重算）');
        } else {
            // L因子变化，发消息给background.js更新该书签的S值
            browserAPI.runtime.sendMessage({ action: 'updateBookmarkScore', bookmarkId });
        }

        return true;
    } catch (e) {
        console.error('[稍后] 取消推迟失败:', e);
        return false;
    }
}

// 清理过期的稍后复习记录
async function cleanExpiredPostponed() {
    try {
        let postponed = await getPostponedBookmarks();
        const now = Date.now();
        const before = postponed.length;
        postponed = postponed.filter(p => p.postponeUntil > now);
        if (postponed.length !== before) {
            await browserAPI.storage.local.set({ recommend_postponed: postponed });
            console.log('[稍后] 清理过期记录:', before - postponed.length, '条');
        }
    } catch (e) {
        console.error('[稍后] 清理过期记录失败:', e);
    }
}

// 稍后复习弹窗相关
let currentLaterBookmark = null;
let currentLaterRecommendedDays = 3; // P值推荐的天数

// 根据P值计算推荐间隔天数
function calculateRecommendedDays(priority, factors) {
    // P值高 → 更需要复习 → 间隔短
    // P值低 → 不太需要 → 间隔长
    const maxDays = 14;
    const minDays = 1;

    // 使用二次函数使分布更平滑
    let intervalDays = minDays + (maxDays - minDays) * Math.pow(1 - priority, 1.5);

    // 根据单个因子微调
    if (factors) {
        // D(遗忘度)特别高：很久没看了，缩短间隔
        if (factors.D > 0.8) intervalDays *= 0.7;
        // T(时间度/浅阅读)特别高：几乎没读过，缩短间隔
        if (factors.T > 0.9) intervalDays *= 0.8;
        // C(冷门度)特别高：很少点击，缩短间隔
        if (factors.C > 0.9) intervalDays *= 0.85;
    }

    return Math.max(minDays, Math.round(intervalDays));
}

// 格式化推荐天数显示
function formatRecommendDays(days) {
    const isZh = currentLang !== 'en';
    if (days === 1) {
        return isZh ? '明天' : 'Tomorrow';
    } else if (days <= 7) {
        return isZh ? `${days} 天后` : `${days} days`;
    } else if (days <= 14) {
        const weeks = Math.round(days / 7);
        return isZh ? `${weeks} 周后` : `${weeks} week${weeks > 1 ? 's' : ''}`;
    } else {
        return isZh ? `${days} 天后` : `${days} days`;
    }
}

function showLaterModal(bookmark) {
    currentLaterBookmark = bookmark;
    const modal = document.getElementById('laterModal');
    if (!modal) return;

    // 计算P值推荐的间隔
    if (bookmark.priority !== undefined && bookmark.factors) {
        currentLaterRecommendedDays = calculateRecommendedDays(bookmark.priority, bookmark.factors);
    } else {
        currentLaterRecommendedDays = 3; // 默认3天
    }

    // 更新推荐按钮显示
    const recommendDaysEl = document.getElementById('laterRecommendDays');
    if (recommendDaysEl) {
        recommendDaysEl.textContent = formatRecommendDays(currentLaterRecommendedDays);
    }

    modal.classList.add('show');
    console.log('[稍后] 显示弹窗:', bookmark.id, bookmark.title, '推荐间隔:', currentLaterRecommendedDays, '天');
}

function hideLaterModal() {
    const modal = document.getElementById('laterModal');
    if (modal) {
        modal.classList.remove('show');
    }
    currentLaterBookmark = null;
}

function initLaterModal() {
    const modal = document.getElementById('laterModal');
    if (!modal) return;

    // 关闭按钮
    const closeBtn = document.getElementById('laterModalClose');
    if (closeBtn) {
        closeBtn.onclick = hideLaterModal;
    }

    // 点击背景关闭
    modal.onclick = (e) => {
        if (e.target === modal) {
            hideLaterModal();
        }
    };

    // P值推荐按钮
    const recommendBtn = document.getElementById('laterRecommendBtn');
    if (recommendBtn) {
        recommendBtn.onclick = async () => {
            if (!currentLaterBookmark) return;

            const delayMs = currentLaterRecommendedDays * 24 * 60 * 60 * 1000;
            await postponeBookmark(currentLaterBookmark.id, delayMs);
            hideLaterModal();
            await loadPostponedList();
            await refreshRecommendCards();
        };
    }

    // 自定义选项按钮
    const options = modal.querySelectorAll('.later-option');
    options.forEach(option => {
        option.onclick = async () => {
            if (!currentLaterBookmark) return;

            const delayMs = parseInt(option.dataset.delay);
            await postponeBookmark(currentLaterBookmark.id, delayMs);
            hideLaterModal();
            await loadPostponedList();
            await refreshRecommendCards();
        };
    });
}

// =============================================================================
// 自动刷新设置
// =============================================================================

const DEFAULT_REFRESH_SETTINGS = {
    refreshEveryNOpens: 3,      // 默认每3次打开刷新
    refreshAfterHours: 0,       // 0=禁用
    refreshAfterDays: 0,        // 0=禁用
    lastRefreshTime: 0,
    openCountSinceRefresh: 0
};

async function getRefreshSettings() {
    try {
        const result = await browserAPI.storage.local.get('recommendRefreshSettings');
        return { ...DEFAULT_REFRESH_SETTINGS, ...result.recommendRefreshSettings };
    } catch (e) {
        console.error('[刷新设置] 读取失败:', e);
        return { ...DEFAULT_REFRESH_SETTINGS };
    }
}

async function saveRefreshSettings(settings) {
    try {
        await browserAPI.storage.local.set({ recommendRefreshSettings: settings });
        console.log('[刷新设置] 已保存:', settings);
    } catch (e) {
        console.error('[刷新设置] 保存失败:', e);
    }
}

// checkAutoRefresh 已移除：S值通过增量更新机制保持最新，不再需要定时全量重算
// 保留刷新设置UI用于记录上次刷新时间

function showRefreshSettingsModal() {
    const modal = document.getElementById('refreshSettingsModal');
    if (!modal) return;

    loadRefreshSettingsToUI();
    modal.classList.add('show');
}

function hideRefreshSettingsModal() {
    const modal = document.getElementById('refreshSettingsModal');
    if (modal) {
        modal.classList.remove('show');
    }
}

async function loadRefreshSettingsToUI() {
    const settings = await getRefreshSettings();

    // 每N次打开
    const everyNEnabled = document.getElementById('refreshEveryNOpensEnabled');
    const everyNValue = document.getElementById('refreshEveryNOpensValue');
    if (everyNEnabled) everyNEnabled.checked = settings.refreshEveryNOpens > 0;
    if (everyNValue) everyNValue.value = settings.refreshEveryNOpens || 3;

    // 超过X小时
    const hoursEnabled = document.getElementById('refreshAfterHoursEnabled');
    const hoursValue = document.getElementById('refreshAfterHoursValue');
    if (hoursEnabled) hoursEnabled.checked = settings.refreshAfterHours > 0;
    if (hoursValue) hoursValue.value = settings.refreshAfterHours || 1;

    // 超过X天
    const daysEnabled = document.getElementById('refreshAfterDaysEnabled');
    const daysValue = document.getElementById('refreshAfterDaysValue');
    if (daysEnabled) daysEnabled.checked = settings.refreshAfterDays > 0;
    if (daysValue) daysValue.value = settings.refreshAfterDays || 1;

    // 更新状态显示
    updateRefreshSettingsStatus(settings);
}

async function saveRefreshSettingsFromUI() {
    const settings = await getRefreshSettings();

    // 每N次打开
    const everyNEnabled = document.getElementById('refreshEveryNOpensEnabled');
    const everyNValue = document.getElementById('refreshEveryNOpensValue');
    settings.refreshEveryNOpens = everyNEnabled?.checked ? parseInt(everyNValue?.value) || 3 : 0;

    // 超过X小时
    const hoursEnabled = document.getElementById('refreshAfterHoursEnabled');
    const hoursValue = document.getElementById('refreshAfterHoursValue');
    settings.refreshAfterHours = hoursEnabled?.checked ? parseInt(hoursValue?.value) || 1 : 0;

    // 超过X天
    const daysEnabled = document.getElementById('refreshAfterDaysEnabled');
    const daysValue = document.getElementById('refreshAfterDaysValue');
    settings.refreshAfterDays = daysEnabled?.checked ? parseInt(daysValue?.value) || 1 : 0;

    await saveRefreshSettings(settings);
    hideRefreshSettingsModal();
}

function updateRefreshSettingsStatus(settings) {
    const statusEl = document.getElementById('refreshSettingsStatus');
    if (!statusEl) return;

    const isZh = currentLang !== 'en';
    const parts = [];

    // 上次刷新时间
    if (settings.lastRefreshTime > 0) {
        const elapsed = Date.now() - settings.lastRefreshTime;
        const minutes = Math.floor(elapsed / 60000);
        const hours = Math.floor(elapsed / 3600000);
        const days = Math.floor(elapsed / 86400000);

        let timeStr;
        if (days > 0) {
            timeStr = isZh ? `${days} 天前` : `${days} day${days > 1 ? 's' : ''} ago`;
        } else if (hours > 0) {
            timeStr = isZh ? `${hours} 小时前` : `${hours} hour${hours > 1 ? 's' : ''} ago`;
        } else {
            timeStr = isZh ? `${minutes} 分钟前` : `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
        }
        parts.push(isZh ? `上次刷新: ${timeStr}` : `Last refresh: ${timeStr}`);
    } else {
        parts.push(isZh ? '尚未刷新' : 'Not refreshed yet');
    }

    // 打开次数
    if (settings.refreshEveryNOpens > 0) {
        const count = settings.openCountSinceRefresh || 0;
        parts.push(isZh
            ? `已打开 ${count} / ${settings.refreshEveryNOpens} 次`
            : `Opened ${count} / ${settings.refreshEveryNOpens} times`);
    }

    statusEl.textContent = parts.join(' | ');
}

function initRefreshSettingsModal() {
    const modal = document.getElementById('refreshSettingsModal');
    if (!modal) return;

    // 关闭按钮
    const closeBtn = document.getElementById('refreshSettingsClose');
    if (closeBtn) {
        closeBtn.onclick = hideRefreshSettingsModal;
    }

    // 点击背景关闭
    modal.onclick = (e) => {
        if (e.target === modal) {
            hideRefreshSettingsModal();
        }
    };

    // 保存按钮
    const saveBtn = document.getElementById('refreshSettingsSaveBtn');
    if (saveBtn) {
        saveBtn.onclick = saveRefreshSettingsFromUI;
    }
}

let addBlockDomainSelected = new Set();
let addBlockDomainData = [];

// 初始化添加域名弹窗
function initAddDomainModal() {
    const modal = document.getElementById('addDomainModal');
    if (!modal) return;

    const closeBtn = document.getElementById('addDomainModalClose');
    const cancelBtn = document.getElementById('addDomainCancelBtn');
    const confirmBtn = document.getElementById('addDomainConfirmBtn');
    const searchInput = document.getElementById('addBlockDomainSearchInput');

    const hideModal = () => {
        modal.classList.remove('show');
        if (searchInput) searchInput.value = '';
    };

    if (closeBtn) closeBtn.onclick = hideModal;
    if (cancelBtn) cancelBtn.onclick = hideModal;

    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };

    // 搜索输入
    let searchTimer = null;
    if (searchInput) {
        searchInput.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                filterBlockDomainList(searchInput.value);
            }, 200);
        };
        // Allow Enter to confirm
        searchInput.onkeypress = (e) => {
            if (e.key === 'Enter') confirmBtn.click();
        };
    }

    if (confirmBtn) {
        confirmBtn.onclick = async () => {
            const selectedDomains = Array.from(addBlockDomainSelected);

            // Allow manual entry if not in list
            const inputVal = searchInput ? searchInput.value.trim() : '';
            if (inputVal && !addBlockDomainSelected.has(inputVal)) {
                if (inputVal.includes('.') || inputVal.includes('localhost')) {
                    selectedDomains.push(inputVal);
                }
            }

            if (selectedDomains.length > 0) {
                for (const domain of selectedDomains) {
                    await blockDomain(domain);
                }
                hideModal();
                await loadBlockedLists();
                await refreshRecommendCards();
            } else {
                const isZh = currentLang === 'zh_CN';
                alert(isZh ? '请选择或输入要屏蔽的域名' : 'Please select or enter a domain to block');
            }
        };
    }
}

// 初始化选择文件夹弹窗
function initSelectFolderModal() {
    const modal = document.getElementById('selectFolderModal');
    if (!modal) return;

    const closeBtn = document.getElementById('selectFolderModalClose');

    const hideModal = () => {
        modal.classList.remove('show');
    };

    if (closeBtn) closeBtn.onclick = hideModal;

    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };
}

// 显示添加域名弹窗
async function showAddDomainModal() {
    const modal = document.getElementById('addDomainModal');
    if (modal) {
        addBlockDomainSelected.clear();
        updateBlockDomainCount();
        const searchInput = document.getElementById('addBlockDomainSearchInput');
        if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
        }

        modal.classList.add('show');
        await loadBlockDomainList();
    }
}

// 加载屏蔽域名列表
async function loadBlockDomainList() {
    const listEl = document.getElementById('addBlockDomainList');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';
    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载中...' : 'Loading...'}</div>`;

    try {
        const allBookmarks = await getAllBookmarksFlat();
        const blocked = await getBlockedBookmarks();
        const blockedDomains = new Set(blocked.domains);

        const domainMap = new Map();
        for (const b of allBookmarks) {
            if (!b.url) continue;
            try {
                const url = new URL(b.url);
                const domain = url.hostname;
                if (!domainMap.has(domain)) {
                    domainMap.set(domain, { count: 0 });
                }
                domainMap.get(domain).count++;
            } catch { }
        }

        const validDomains = [];
        for (const [domain, data] of domainMap.entries()) {
            if (!blockedDomains.has(domain)) {
                validDomains.push([domain, data]);
            }
        }

        addBlockDomainData = validDomains.sort((a, b) => b[1].count - a[1].count);
        renderBlockDomainList(addBlockDomainData);

    } catch (e) {
        console.error('Failed to load domains', e);
        const isZh = currentLang === 'zh_CN';
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
}

// 渲染屏蔽域名列表
function renderBlockDomainList(domains) {
    const listEl = document.getElementById('addBlockDomainList');
    if (!listEl) return;

    const displayDomains = domains.slice(0, 100);
    const isZh = currentLang === 'zh_CN';

    if (displayDomains.length === 0) {
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '没有可屏蔽的新域名' : 'No new domains to block'}</div>`;
        return;
    }

    listEl.innerHTML = displayDomains.map(([domain, data]) => `
        <div class="add-domain-item ${addBlockDomainSelected.has(domain) ? 'selected' : ''}" data-domain="${escapeHtml(domain)}">
            <input type="checkbox" ${addBlockDomainSelected.has(domain) ? 'checked' : ''}>
            <div class="add-domain-info">
                <div class="add-domain-name">${escapeHtml(domain)}</div>
                <div class="add-domain-count">${data.count} ${isZh ? '个书签' : 'bookmarks'}</div>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.add-domain-item').forEach(item => {
        item.addEventListener('click', () => {
            const domain = item.dataset.domain;
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (addBlockDomainSelected.has(domain)) {
                addBlockDomainSelected.delete(domain);
                item.classList.remove('selected');
                checkbox.checked = false;
            } else {
                addBlockDomainSelected.add(domain);
                item.classList.add('selected');
                checkbox.checked = true;
            }
            updateBlockDomainCount();
        });
    });
}

// 过滤屏蔽域名列表
function filterBlockDomainList(keyword) {
    if (!keyword.trim()) {
        renderBlockDomainList(addBlockDomainData);
        return;
    }
    const keywordLower = keyword.toLowerCase();
    const filtered = addBlockDomainData.filter(([domain]) =>
        domain.toLowerCase().includes(keywordLower)
    );
    renderBlockDomainList(filtered);
}

// 更新选中数量
function updateBlockDomainCount() {
    const el = document.getElementById('addBlockDomainSelectedCount');
    if (el) el.textContent = addBlockDomainSelected.size;
}

// 显示选择文件夹弹窗
async function showSelectFolderModal() {
    const modal = document.getElementById('selectFolderModal');
    const container = document.getElementById('folderTreeContainer');
    if (!modal || !container) return;

    // 获取已屏蔽的文件夹
    const blocked = await getBlockedBookmarks();
    const blockedFolderSet = new Set(blocked.folders);

    // 获取所有文件夹
    const tree = await new Promise(resolve => {
        browserAPI.bookmarks.getTree(resolve);
    });

    // 生成文件夹树HTML
    container.innerHTML = '';

    function countBookmarks(node) {
        let count = 0;
        if (node.url) count = 1;
        if (node.children) {
            for (const child of node.children) {
                count += countBookmarks(child);
            }
        }
        return count;
    }

    function renderFolders(nodes, parentEl, depth = 0) {
        const isZh = currentLang === 'zh_CN';
        const unnamedFolder = i18n.unnamedFolderLabel ? i18n.unnamedFolderLabel[currentLang] : '未命名文件夹';
        for (const node of nodes) {
            if (!node.url && node.children) { // 是文件夹
                if (blockedFolderSet.has(node.id)) continue; // 已屏蔽的不显示

                const bookmarkCount = countBookmarks(node);

                // 创建节点包装
                const nodeWrapper = document.createElement('div');
                nodeWrapper.className = 'folder-tree-node';

                const item = document.createElement('div');
                item.className = 'folder-tree-item';
                item.innerHTML = `
                    <i class="fas fa-folder"></i>
                    <span>${escapeHtml(node.title || unnamedFolder)}</span>
                    <span class="folder-count">${bookmarkCount}</span>
                `;
                item.onclick = async () => {
                    await blockFolder(node.id);
                    modal.classList.remove('show');
                    await loadBlockedLists();
                    await refreshRecommendCards();
                };
                nodeWrapper.appendChild(item);

                // 检查是否有子文件夹
                const childFolders = node.children.filter(c => !c.url && c.children && !blockedFolderSet.has(c.id));
                if (childFolders.length > 0) {
                    const childrenContainer = document.createElement('div');
                    childrenContainer.className = 'folder-tree-children';
                    renderFolders(node.children, childrenContainer, depth + 1);
                    nodeWrapper.appendChild(childrenContainer);
                }

                parentEl.appendChild(nodeWrapper);
            }
        }
    }

    renderFolders(tree, container);
    modal.classList.add('show');
}

// 初始化屏蔽管理添加按钮
function initBlockManageButtons() {
    const addFolderBtn = document.getElementById('addBlockFolderBtn');
    const addDomainBtn = document.getElementById('addBlockDomainBtn');

    if (addFolderBtn) {
        addFolderBtn.onclick = () => showSelectFolderModal();
    }

    if (addDomainBtn) {
        addDomainBtn.onclick = () => showAddDomainModal();
    }
}

// =============================================================================
// 时间追踪屏蔽管理
// =============================================================================

let trackingBlockDomainSelected = new Set();
let trackingBlockDomainData = [];

// 获取时间追踪屏蔽列表
async function getTrackingBlocked() {
    try {
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['timetracking_blocked'], resolve);
        });
        return result.timetracking_blocked || {
            bookmarks: [],
            folders: [],
            domains: []
        };
    } catch (e) {
        return { bookmarks: [], folders: [], domains: [] };
    }
}

function normalizeTrackingDomain(domain) {
    if (!domain || typeof domain !== 'string') return '';
    return domain.trim().toLowerCase().replace(/^www\./, '');
}

function normalizeTrackingUrl(url) {
    if (!url || typeof url !== 'string') return null;
    try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol)) return null;
        let normalized = parsed.origin + parsed.pathname;
        if (parsed.search) {
            normalized += parsed.search;
        }
        normalized = normalized.replace(/\/+$/, '');
        return normalized.toLowerCase();
    } catch {
        return null;
    }
}

let trackingBookmarkCache = {
    loadedAt: 0,
    idToParents: new Map(),
    urlToIds: new Map()
};

async function getTrackingBookmarkCache() {
    const now = Date.now();
    if (trackingBookmarkCache.loadedAt && (now - trackingBookmarkCache.loadedAt) < 60 * 1000) {
        return trackingBookmarkCache;
    }

    const idToParents = new Map();
    const urlToIds = new Map();

    try {
        const tree = await browserAPI.bookmarks.getTree();
        const traverse = (nodes, ancestors = []) => {
            for (const node of nodes) {
                if (node.url) {
                    idToParents.set(node.id, ancestors);
                    const normalizedUrl = normalizeTrackingUrl(node.url);
                    if (normalizedUrl) {
                        if (!urlToIds.has(normalizedUrl)) {
                            urlToIds.set(normalizedUrl, new Set());
                        }
                        urlToIds.get(normalizedUrl).add(node.id);
                    }
                }
                if (node.children) {
                    const nextAncestors = node.url ? ancestors : [...ancestors, node.id];
                    traverse(node.children, nextAncestors);
                }
            }
        };
        traverse(tree, []);
    } catch (e) {
        console.warn('[时间追踪屏蔽] 构建书签缓存失败:', e);
    }

    trackingBookmarkCache = {
        loadedAt: now,
        idToParents,
        urlToIds
    };

    return trackingBookmarkCache;
}

async function getTrackingBlockedSets() {
    const blocked = await getTrackingBlocked();
    return {
        bookmarks: new Set(blocked.bookmarks || []),
        folders: new Set(blocked.folders || []),
        domains: new Set((blocked.domains || []).map(normalizeTrackingDomain).filter(Boolean))
    };
}

function isBookmarkIdBlockedByFolders(bookmarkId, blockedFolders, cache) {
    if (!bookmarkId || blockedFolders.size === 0) return false;
    const parentIds = cache.idToParents.get(bookmarkId) || [];
    for (const parentId of parentIds) {
        if (blockedFolders.has(parentId)) return true;
    }
    return false;
}

async function isTrackingItemBlocked(item, blockedSets, cache) {
    if (item.bookmarkId && blockedSets.bookmarks.has(item.bookmarkId)) {
        return true;
    }

    if (item.bookmarkId && isBookmarkIdBlockedByFolders(item.bookmarkId, blockedSets.folders, cache)) {
        return true;
    }

    if (item.url && blockedSets.domains.size > 0) {
        try {
            const domain = normalizeTrackingDomain(new URL(item.url).hostname);
            if (domain && blockedSets.domains.has(domain)) {
                return true;
            }
        } catch { }
    }

    if (!item.bookmarkId && item.url) {
        const normalizedUrl = normalizeTrackingUrl(item.url);
        if (normalizedUrl && cache.urlToIds.has(normalizedUrl)) {
            for (const id of cache.urlToIds.get(normalizedUrl)) {
                if (blockedSets.bookmarks.has(id)) return true;
                if (isBookmarkIdBlockedByFolders(id, blockedSets.folders, cache)) return true;
            }
        }
    }

    return false;
}

// 检查书签是否被时间追踪屏蔽
async function isTrackingBlocked(bookmark) {
    const blocked = await getTrackingBlocked();
    const blockedDomains = new Set((blocked.domains || []).map(normalizeTrackingDomain).filter(Boolean));

    // 检查书签ID
    if (blocked.bookmarks.includes(bookmark.id)) {
        return true;
    }

    // 检查文件夹
    if (bookmark.parentId && blocked.folders.includes(bookmark.parentId)) {
        return true;
    }
    if (bookmark.ancestorFolderIds && bookmark.ancestorFolderIds.length > 0) {
        for (const folderId of bookmark.ancestorFolderIds) {
            if (blocked.folders.includes(folderId)) return true;
        }
    }

    // 检查域名
    if (bookmark.url) {
        try {
            const url = new URL(bookmark.url);
            if (blockedDomains.has(normalizeTrackingDomain(url.hostname))) {
                return true;
            }
        } catch { }
    }

    return false;
}

// 屏蔽/恢复书签（时间追踪）
async function blockTrackingBookmark(bookmarkId) {
    try {
        const blocked = await getTrackingBlocked();
        if (!blocked.bookmarks.includes(bookmarkId)) {
            blocked.bookmarks.push(bookmarkId);
            await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function unblockTrackingBookmark(bookmarkId) {
    try {
        const blocked = await getTrackingBlocked();
        blocked.bookmarks = blocked.bookmarks.filter(id => id !== bookmarkId);
        await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        return true;
    } catch (e) {
        return false;
    }
}

// 屏蔽/恢复文件夹（时间追踪）
async function blockTrackingFolder(folderId) {
    try {
        const blocked = await getTrackingBlocked();
        if (!blocked.folders.includes(folderId)) {
            blocked.folders.push(folderId);
            await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function unblockTrackingFolder(folderId) {
    try {
        const blocked = await getTrackingBlocked();
        blocked.folders = blocked.folders.filter(id => id !== folderId);
        await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        return true;
    } catch (e) {
        return false;
    }
}

// 屏蔽/恢复域名（时间追踪）
async function blockTrackingDomain(domain) {
    try {
        const blocked = await getTrackingBlocked();
        const normalized = normalizeTrackingDomain(domain);
        if (!normalized) return false;
        if (!blocked.domains.includes(normalized)) {
            blocked.domains.push(normalized);
            await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function unblockTrackingDomain(domain) {
    try {
        const blocked = await getTrackingBlocked();
        const normalized = normalizeTrackingDomain(domain);
        blocked.domains = blocked.domains.filter(d => d !== normalized);
        await browserAPI.storage.local.set({ timetracking_blocked: blocked });
        return true;
    } catch (e) {
        return false;
    }
}

// 初始化时间追踪屏蔽管理弹窗
function initTrackingBlockModal() {
    const modal = document.getElementById('trackingBlockModal');
    const blockBtn = document.getElementById('trackingBlockBtn');
    const closeBtn = document.getElementById('trackingBlockModalClose');
    const addFolderBtn = document.getElementById('addTrackingBlockFolderBtn');
    const addDomainBtn = document.getElementById('addTrackingBlockDomainBtn');
    const addBookmarkBtn = document.getElementById('addTrackingBlockBookmarkBtn');

    console.log('[时间追踪屏蔽] 初始化屏蔽管理弹窗, modal:', !!modal, ', blockBtn:', !!blockBtn);

    if (!modal) {
        console.warn('[时间追踪屏蔽] 弹窗元素未找到');
        return;
    }

    // 打开弹窗
    if (blockBtn) {
        blockBtn.onclick = async () => {
            console.log('[时间追踪屏蔽] 点击屏蔽按钮');
            await loadTrackingBlockedLists();
            modal.classList.add('show');
        };
        console.log('[时间追踪屏蔽] 屏蔽按钮事件已绑定');
    } else {
        console.warn('[时间追踪屏蔽] 屏蔽按钮元素未找到');
    }

    // 关闭弹窗
    const hideModal = () => modal.classList.remove('show');
    if (closeBtn) closeBtn.onclick = hideModal;
    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };

    // 添加书签按钮
    if (addBookmarkBtn) {
        addBookmarkBtn.onclick = () => showAddTrackingBlockBookmarkModal();
    }

    // 添加文件夹按钮
    if (addFolderBtn) {
        addFolderBtn.onclick = () => showSelectTrackingBlockFolderModal();
    }

    // 添加域名按钮
    if (addDomainBtn) {
        addDomainBtn.onclick = () => showAddTrackingBlockDomainModal();
    }
}

// 加载时间追踪屏蔽列表
async function loadTrackingBlockedLists() {
    const blocked = await getTrackingBlocked();

    // 加载已屏蔽书签
    await loadTrackingBlockedBookmarksList(blocked.bookmarks);

    // 加载已屏蔽文件夹
    await loadTrackingBlockedFoldersList(blocked.folders);

    // 加载已屏蔽域名
    await loadTrackingBlockedDomainsList(blocked.domains);
}

// 加载已屏蔽书签列表（时间追踪）
async function loadTrackingBlockedBookmarksList(bookmarkIds) {
    const listEl = document.getElementById('trackingBlockedBookmarksList');
    const countEl = document.getElementById('trackingBlockedBookmarksCount');
    const emptyEl = document.getElementById('trackingBlockedBookmarksEmpty');
    if (!listEl) return;

    // 更新计数
    if (countEl) countEl.textContent = bookmarkIds.length;

    // 清空列表
    const items = listEl.querySelectorAll('.block-item');
    items.forEach(item => item.remove());

    if (bookmarkIds.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    const isZh = currentLang === 'zh_CN';

    for (const id of bookmarkIds) {
        try {
            const bookmarks = await new Promise(resolve => {
                browserAPI.bookmarks.get(id, resolve);
            });
            if (!bookmarks || bookmarks.length === 0) continue;
            const bookmark = bookmarks[0];

            const item = document.createElement('div');
            item.className = 'block-item';
            item.innerHTML = `
                <img class="block-item-icon" src="${getFaviconUrl(bookmark.url)}" alt="">
                <div class="block-item-info">
                    <div class="block-item-title">${escapeHtml(bookmark.title || bookmark.url)}</div>
                </div>
                <button class="block-item-btn">${isZh ? '恢复' : 'Restore'}</button>
            `;

            const btn = item.querySelector('.block-item-btn');
            btn.onclick = async () => {
                await unblockTrackingBookmark(id);
                await loadTrackingBlockedLists();
            };

            listEl.appendChild(item);
        } catch (e) { }
    }
}

// 加载已屏蔽文件夹列表（时间追踪）
async function loadTrackingBlockedFoldersList(folderIds) {
    const listEl = document.getElementById('trackingBlockedFoldersList');
    const countEl = document.getElementById('trackingBlockedFoldersCount');
    const emptyEl = document.getElementById('trackingBlockedFoldersEmpty');
    if (!listEl) return;

    if (countEl) countEl.textContent = folderIds.length;

    const items = listEl.querySelectorAll('.block-item');
    items.forEach(item => item.remove());

    if (folderIds.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    const isZh = currentLang === 'zh_CN';

    for (const id of folderIds) {
        try {
            const folders = await new Promise(resolve => {
                browserAPI.bookmarks.get(id, resolve);
            });
            if (!folders || folders.length === 0) continue;
            const folder = folders[0];

            const item = document.createElement('div');
            item.className = 'block-item';
            item.innerHTML = `
                <i class="fas fa-folder block-item-icon" style="font-size: 18px; color: var(--warning);"></i>
                <div class="block-item-info">
                    <div class="block-item-title">${escapeHtml(folder.title)}</div>
                </div>
                <button class="block-item-btn" data-id="${id}">${isZh ? '恢复' : 'Restore'}</button>
            `;

            const btn = item.querySelector('.block-item-btn');
            btn.onclick = async () => {
                await unblockTrackingFolder(id);
                await loadTrackingBlockedLists();
            };

            listEl.appendChild(item);
        } catch (e) { }
    }
}

// 加载已屏蔽域名列表（时间追踪）
async function loadTrackingBlockedDomainsList(domains) {
    const listEl = document.getElementById('trackingBlockedDomainsList');
    const countEl = document.getElementById('trackingBlockedDomainsCount');
    const emptyEl = document.getElementById('trackingBlockedDomainsEmpty');
    if (!listEl) return;

    if (countEl) countEl.textContent = domains.length;

    const items = listEl.querySelectorAll('.block-item');
    items.forEach(item => item.remove());

    if (domains.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    const isZh = currentLang === 'zh_CN';

    for (const domain of domains) {
        const item = document.createElement('div');
        item.className = 'block-item';
        item.innerHTML = `
            <i class="fas fa-globe block-item-icon" style="font-size: 18px; color: var(--accent-primary);"></i>
            <div class="block-item-info">
                <div class="block-item-title">${escapeHtml(domain)}</div>
            </div>
            <button class="block-item-btn" data-domain="${domain}">${isZh ? '恢复' : 'Restore'}</button>
        `;

        const btn = item.querySelector('.block-item-btn');
        btn.onclick = async () => {
            await unblockTrackingDomain(domain);
            await loadTrackingBlockedLists();
        };

        listEl.appendChild(item);
    }
}

// 显示选择文件夹弹窗（时间追踪）
async function showSelectTrackingBlockFolderModal() {
    const modal = document.getElementById('selectTrackingBlockFolderModal');
    const container = document.getElementById('trackingBlockFolderTreeContainer');
    if (!modal || !container) return;

    // 获取已屏蔽的文件夹
    const blocked = await getTrackingBlocked();
    const blockedFolderSet = new Set(blocked.folders);

    // 获取所有文件夹
    const tree = await new Promise(resolve => {
        browserAPI.bookmarks.getTree(resolve);
    });

    // 生成文件夹树HTML
    container.innerHTML = '';

    function countBookmarks(node) {
        let count = 0;
        if (node.url) count = 1;
        if (node.children) {
            for (const child of node.children) {
                count += countBookmarks(child);
            }
        }
        return count;
    }

    function renderFolders(nodes, parentEl, depth = 0) {
        const isZh = currentLang === 'zh_CN';
        const unnamedFolder = i18n.unnamedFolderLabel ? i18n.unnamedFolderLabel[currentLang] : '未命名文件夹';
        for (const node of nodes) {
            if (!node.url && node.children) {
                if (blockedFolderSet.has(node.id)) continue;

                const bookmarkCount = countBookmarks(node);

                const nodeWrapper = document.createElement('div');
                nodeWrapper.className = 'folder-tree-node';

                const item = document.createElement('div');
                item.className = 'folder-tree-item';
                item.innerHTML = `
                    <i class="fas fa-folder"></i>
                    <span>${escapeHtml(node.title || unnamedFolder)}</span>
                    <span class="folder-count">${bookmarkCount}</span>
                `;
                item.onclick = async () => {
                    await blockTrackingFolder(node.id);
                    modal.classList.remove('show');
                    await loadTrackingBlockedLists();
                };
                nodeWrapper.appendChild(item);

                const childFolders = node.children.filter(c => !c.url && c.children && !blockedFolderSet.has(c.id));
                if (childFolders.length > 0) {
                    const childrenContainer = document.createElement('div');
                    childrenContainer.className = 'folder-tree-children';
                    renderFolders(node.children, childrenContainer, depth + 1);
                    nodeWrapper.appendChild(childrenContainer);
                }

                parentEl.appendChild(nodeWrapper);
            }
        }
    }

    renderFolders(tree, container);
    modal.classList.add('show');
}

// 初始化选择文件夹弹窗（时间追踪）
function initSelectTrackingBlockFolderModal() {
    const modal = document.getElementById('selectTrackingBlockFolderModal');
    if (!modal) return;

    const closeBtn = document.getElementById('selectTrackingBlockFolderModalClose');

    const hideModal = () => modal.classList.remove('show');

    if (closeBtn) closeBtn.onclick = hideModal;

    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };
}

// 显示添加域名弹窗（时间追踪）
async function showAddTrackingBlockDomainModal() {
    const modal = document.getElementById('addTrackingBlockDomainModal');
    if (modal) {
        trackingBlockDomainSelected.clear();
        updateTrackingBlockDomainCount();
        const searchInput = document.getElementById('addTrackingBlockDomainSearchInput');
        if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
        }

        modal.classList.add('show');
        await loadTrackingBlockDomainList();
    }
}

// 加载屏蔽域名列表（时间追踪）
async function loadTrackingBlockDomainList() {
    const listEl = document.getElementById('addTrackingBlockDomainList');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';
    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载中...' : 'Loading...'}</div>`;

    try {
        const allBookmarks = await getAllBookmarksFlat();
        const blocked = await getTrackingBlocked();
        const blockedDomains = new Set((blocked.domains || []).map(normalizeTrackingDomain).filter(Boolean));

        const domainMap = new Map();
        for (const b of allBookmarks) {
            if (!b.url) continue;
            try {
                const url = new URL(b.url);
                const domain = normalizeTrackingDomain(url.hostname);
                if (!domain) continue;
                if (!domainMap.has(domain)) {
                    domainMap.set(domain, { count: 0 });
                }
                domainMap.get(domain).count++;
            } catch { }
        }

        const validDomains = [];
        for (const [domain, data] of domainMap.entries()) {
            if (!blockedDomains.has(domain)) {
                validDomains.push([domain, data]);
            }
        }

        trackingBlockDomainData = validDomains.sort((a, b) => b[1].count - a[1].count);
        renderTrackingBlockDomainList(trackingBlockDomainData);

    } catch (e) {
        console.error('Failed to load domains', e);
        const isZh = currentLang === 'zh_CN';
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
}

// 渲染屏蔽域名列表（时间追踪）
function renderTrackingBlockDomainList(domains) {
    const listEl = document.getElementById('addTrackingBlockDomainList');
    if (!listEl) return;

    const displayDomains = domains.slice(0, 100);
    const isZh = currentLang === 'zh_CN';

    if (displayDomains.length === 0) {
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '没有可屏蔽的新域名' : 'No new domains to block'}</div>`;
        return;
    }

    listEl.innerHTML = displayDomains.map(([domain, data]) => `
        <div class="add-domain-item ${trackingBlockDomainSelected.has(domain) ? 'selected' : ''}" data-domain="${escapeHtml(domain)}">
            <input type="checkbox" ${trackingBlockDomainSelected.has(domain) ? 'checked' : ''}>
            <div class="add-domain-info">
                <div class="add-domain-name">${escapeHtml(domain)}</div>
                <div class="add-domain-count">${data.count} ${isZh ? '个书签' : 'bookmarks'}</div>
            </div>
        </div>
    `).join('');

    listEl.querySelectorAll('.add-domain-item').forEach(item => {
        item.addEventListener('click', () => {
            const domain = item.dataset.domain;
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (trackingBlockDomainSelected.has(domain)) {
                trackingBlockDomainSelected.delete(domain);
                item.classList.remove('selected');
                checkbox.checked = false;
            } else {
                trackingBlockDomainSelected.add(domain);
                item.classList.add('selected');
                checkbox.checked = true;
            }
            updateTrackingBlockDomainCount();
        });
    });
}

// 过滤屏蔽域名列表（时间追踪）
function filterTrackingBlockDomainList(keyword) {
    if (!keyword.trim()) {
        renderTrackingBlockDomainList(trackingBlockDomainData);
        return;
    }
    const keywordLower = keyword.toLowerCase();
    const filtered = trackingBlockDomainData.filter(([domain]) =>
        domain.toLowerCase().includes(keywordLower)
    );
    renderTrackingBlockDomainList(filtered);
}

// 更新选中数量（时间追踪）
function updateTrackingBlockDomainCount() {
    const el = document.getElementById('addTrackingBlockDomainSelectedCount');
    if (el) el.textContent = trackingBlockDomainSelected.size;
}

// 初始化添加域名弹窗（时间追踪）
function initAddTrackingBlockDomainModal() {
    const modal = document.getElementById('addTrackingBlockDomainModal');
    if (!modal) return;

    const closeBtn = document.getElementById('addTrackingBlockDomainModalClose');
    const cancelBtn = document.getElementById('addTrackingBlockDomainCancelBtn');
    const confirmBtn = document.getElementById('addTrackingBlockDomainConfirmBtn');
    const searchInput = document.getElementById('addTrackingBlockDomainSearchInput');

    const hideModal = () => {
        modal.classList.remove('show');
        if (searchInput) searchInput.value = '';
    };

    if (closeBtn) closeBtn.onclick = hideModal;
    if (cancelBtn) cancelBtn.onclick = hideModal;

    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };

    // 搜索输入
    let searchTimer = null;
    if (searchInput) {
        searchInput.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                filterTrackingBlockDomainList(searchInput.value);
            }, 200);
        };
        searchInput.onkeypress = (e) => {
            if (e.key === 'Enter') confirmBtn.click();
        };
    }

    if (confirmBtn) {
        confirmBtn.onclick = async () => {
            const selectedDomains = Array.from(trackingBlockDomainSelected);

            // Allow manual entry if not in list
            const inputVal = searchInput ? searchInput.value.trim() : '';
            if (inputVal && !trackingBlockDomainSelected.has(inputVal)) {
                if (inputVal.includes('.') || inputVal.includes('localhost')) {
                    selectedDomains.push(inputVal);
                }
            }

            if (selectedDomains.length > 0) {
                for (const domain of selectedDomains) {
                    await blockTrackingDomain(domain);
                }
                hideModal();
                await loadTrackingBlockedLists();
            } else {
                const isZh = currentLang === 'zh_CN';
                alert(isZh ? '请选择或输入要屏蔽的域名' : 'Please select or enter a domain to block');
            }
        };
    }
}

// =============================================================================
// 时间追踪添加屏蔽书签弹窗
// =============================================================================

let trackingBlockBookmarkSelected = new Set();

// 显示添加屏蔽书签弹窗（时间追踪）
async function showAddTrackingBlockBookmarkModal() {
    const modal = document.getElementById('addTrackingBlockBookmarkModal');
    if (!modal) return;

    trackingBlockBookmarkSelected.clear();
    updateTrackingBlockBookmarkCount();

    // 重置标签页
    const tabs = modal.querySelectorAll('.add-postponed-tab');
    const panels = modal.querySelectorAll('.add-postponed-panel');
    tabs.forEach(t => t.classList.remove('active'));
    panels.forEach(p => p.classList.remove('active'));
    tabs[0]?.classList.add('active');
    panels[0]?.classList.add('active');

    modal.classList.add('show');

    // 加载正在追踪的书签
    await loadTrackingBlockBookmarkTrackingList();
}

// 加载正在追踪的书签列表
async function loadTrackingBlockBookmarkTrackingList() {
    const listEl = document.getElementById('addTrackingBlockBookmarkTrackingList');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';
    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载中...' : 'Loading...'}</div>`;

    try {
        const response = await browserAPI.runtime.sendMessage({
            action: 'getCurrentActiveSessions'
        });

        if (!response?.success || !response.sessions?.length) {
            listEl.innerHTML = `<div class="add-results-empty">${isZh ? '暂无正在追踪的书签' : 'No active tracking sessions'}</div>`;
            return;
        }

        const blockedSets = await getTrackingBlockedSets();
        const cache = await getTrackingBookmarkCache();

        // 按标题分组去重
        const uniqueBookmarks = new Map();
        for (const session of response.sessions) {
            const key = session.title || session.url;
            if (!uniqueBookmarks.has(key)) {
                uniqueBookmarks.set(key, {
                    id: session.bookmarkId,
                    url: session.url,
                    title: session.title || session.url
                });
            }
        }

        const items = Array.from(uniqueBookmarks.values());
        const blockedFlags = await Promise.all(
            items.map(item => isTrackingItemBlocked(item, blockedSets, cache))
        );
        const filteredItems = items.filter((_, index) => !blockedFlags[index]);

        if (filteredItems.length === 0) {
            listEl.innerHTML = `<div class="add-results-empty">${isZh ? '所有正在追踪的书签都已被屏蔽' : 'All tracking sessions are already blocked'}</div>`;
            return;
        }

        renderTrackingBlockBookmarkList(listEl, filteredItems);

    } catch (e) {
        console.error('[时间追踪屏蔽] 加载正在追踪书签失败:', e);
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
}

// 加载综合排行书签列表
async function loadTrackingBlockBookmarkRankingList() {
    const listEl = document.getElementById('addTrackingBlockBookmarkRankingList');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';
    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载中...' : 'Loading...'}</div>`;

    try {
        const statsResponse = await browserAPI.runtime.sendMessage({ action: 'getTrackingStats' });

        if (!statsResponse?.success || !statsResponse.stats) {
            listEl.innerHTML = `<div class="add-results-empty">${isZh ? '暂无排行数据' : 'No ranking data'}</div>`;
            return;
        }

        const blockedSets = await getTrackingBlockedSets();
        const cache = await getTrackingBookmarkCache();

        // 转换为数组
        const items = Object.values(statsResponse.stats).map(stat => ({
            id: stat.bookmarkId || null,
            url: stat.url,
            title: stat.title || stat.url
        }));
        const blockedFlags = await Promise.all(
            items.map(item => isTrackingItemBlocked(item, blockedSets, cache))
        );
        const filteredItems = items.filter((_, index) => !blockedFlags[index]);

        if (filteredItems.length === 0) {
            listEl.innerHTML = `<div class="add-results-empty">${isZh ? '没有可屏蔽的书签' : 'No bookmarks to block'}</div>`;
            return;
        }

        renderTrackingBlockBookmarkList(listEl, filteredItems.slice(0, 50));

    } catch (e) {
        console.error('[时间追踪屏蔽] 加载综合排行失败:', e);
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
}

// 搜索书签树
async function searchTrackingBlockBookmarks(keyword) {
    const listEl = document.getElementById('addTrackingBlockBookmarkTreeList');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';

    if (!keyword.trim()) {
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '输入关键词搜索书签' : 'Enter keyword to search bookmarks'}</div>`;
        return;
    }

    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '搜索中...' : 'Searching...'}</div>`;

    try {
        const allBookmarks = await getAllBookmarksFlat();
        const keywordLower = keyword.toLowerCase();

        const blockedSets = await getTrackingBlockedSets();
        const cache = await getTrackingBookmarkCache();

        const matchedBookmarks = [];
        for (const b of allBookmarks) {
            if (!b.url) continue; // 跳过文件夹
            const matches = (b.title && b.title.toLowerCase().includes(keywordLower)) ||
                (b.url && b.url.toLowerCase().includes(keywordLower));
            if (!matches) continue;
            const blocked = await isTrackingItemBlocked({ bookmarkId: b.id, url: b.url }, blockedSets, cache);
            if (blocked) continue;
            matchedBookmarks.push(b);
        }

        if (matchedBookmarks.length === 0) {
            listEl.innerHTML = `<div class="add-results-empty">${isZh ? '未找到匹配的书签' : 'No matching bookmarks found'}</div>`;
            return;
        }

        const items = matchedBookmarks.slice(0, 50).map(b => ({
            id: b.id,
            url: b.url,
            title: b.title || b.url
        }));

        renderTrackingBlockBookmarkList(listEl, items);

    } catch (e) {
        console.error('[时间追踪屏蔽] 搜索书签失败:', e);
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '搜索失败' : 'Search failed'}</div>`;
    }
}

// 渲染书签列表
function renderTrackingBlockBookmarkList(listEl, items) {
    const isZh = currentLang === 'zh_CN';

    listEl.innerHTML = items.map(item => {
        const faviconUrl = getFaviconUrl(item.url);
        const displayTitle = item.title.length > 50 ? item.title.substring(0, 50) + '...' : item.title;
        const itemKey = item.id || item.url; // 用ID或URL作为唯一标识
        const isSelected = trackingBlockBookmarkSelected.has(itemKey);

        return `
            <div class="add-bookmark-item ${isSelected ? 'selected' : ''}" data-key="${escapeHtml(itemKey)}" data-id="${item.id || ''}" data-url="${escapeHtml(item.url || '')}">
                <input type="checkbox" ${isSelected ? 'checked' : ''}>
                <img class="add-bookmark-favicon" src="${faviconUrl}" alt="">
                <div class="add-bookmark-info">
                    <div class="add-bookmark-title">${escapeHtml(displayTitle)}</div>
                </div>
            </div>
        `;
    }).join('');

    // 绑定点击事件
    listEl.querySelectorAll('.add-bookmark-item').forEach(itemEl => {
        itemEl.addEventListener('click', () => {
            const key = itemEl.dataset.key;
            const checkbox = itemEl.querySelector('input[type="checkbox"]');
            if (trackingBlockBookmarkSelected.has(key)) {
                trackingBlockBookmarkSelected.delete(key);
                itemEl.classList.remove('selected');
                checkbox.checked = false;
            } else {
                trackingBlockBookmarkSelected.add(key);
                itemEl.classList.add('selected');
                checkbox.checked = true;
            }
            updateTrackingBlockBookmarkCount();
        });
    });
}

// 更新选中数量
function updateTrackingBlockBookmarkCount() {
    const el = document.getElementById('addTrackingBlockBookmarkSelectedCount');
    if (el) el.textContent = trackingBlockBookmarkSelected.size;
}

// 初始化添加屏蔽书签弹窗（时间追踪）
function initAddTrackingBlockBookmarkModal() {
    const modal = document.getElementById('addTrackingBlockBookmarkModal');
    if (!modal) return;

    const closeBtn = document.getElementById('addTrackingBlockBookmarkModalClose');
    const cancelBtn = document.getElementById('addTrackingBlockBookmarkCancelBtn');
    const confirmBtn = document.getElementById('addTrackingBlockBookmarkConfirmBtn');
    const searchInput = document.getElementById('addTrackingBlockBookmarkSearchInput');
    const tabs = modal.querySelectorAll('.add-postponed-tab');
    const panels = modal.querySelectorAll('.add-postponed-panel');

    const hideModal = () => {
        modal.classList.remove('show');
        trackingBlockBookmarkSelected.clear();
        if (searchInput) searchInput.value = '';
    };

    if (closeBtn) closeBtn.onclick = hideModal;
    if (cancelBtn) cancelBtn.onclick = hideModal;


    modal.onclick = (e) => {
        if (e.target === modal) hideModal();
    };

    // 标签页切换
    tabs.forEach(tab => {
        tab.addEventListener('click', async () => {
            const tabName = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            panels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            modal.querySelector(`.add-postponed-panel[data-panel="${tabName}"]`)?.classList.add('active');

            // 加载对应的数据
            if (tabName === 'tracking') {
                await loadTrackingBlockBookmarkTrackingList();
            } else if (tabName === 'ranking') {
                await loadTrackingBlockBookmarkRankingList();
            }
            // tree 面板通过搜索框触发
        });
    });

    // 搜索输入
    let searchTimer = null;
    if (searchInput) {
        searchInput.oninput = () => {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(() => {
                searchTrackingBlockBookmarks(searchInput.value);
            }, 300);
        };
    }

    // 确认按钮
    if (confirmBtn) {
        confirmBtn.onclick = async () => {
            if (trackingBlockBookmarkSelected.size === 0) {
                const isZh = currentLang === 'zh_CN';
                alert(isZh ? '请选择要屏蔽的书签' : 'Please select bookmarks to block');
                return;
            }

            // 遍历选中项，根据ID或URL来屏蔽
            for (const key of trackingBlockBookmarkSelected) {
                // 如果key是书签ID格式（数字字符串），则按ID屏蔽
                // 否则按URL生成的域名屏蔽（简化处理：直接屏蔽书签ID）
                if (key) {
                    await blockTrackingBookmark(key);
                }
            }

            hideModal();
            await loadTrackingBlockedLists();
        };
    }
}

// 在屏蔽管理弹窗中绑定添加书签按钮
function bindAddTrackingBlockBookmarkBtn() {
    const addBookmarkBtn = document.getElementById('addTrackingBlockBookmarkBtn');
    if (addBookmarkBtn) {
        addBookmarkBtn.onclick = () => showAddTrackingBlockBookmarkModal();
    }
}

// =============================================================================
// 添加到稍后复习弹窗
// =============================================================================

let addPostponedSelectedFolder = null;
let addPostponedSearchSelected = new Set();
let addPostponedDomainSelected = new Set();
let addPostponedDomainData = []; // 保存完整的域名数据用于过滤

function initAddToPostponedModal() {
    const modal = document.getElementById('addToPostponedModal');
    const addBtn = document.getElementById('postponedAddBtn');
    const closeBtn = document.getElementById('addPostponedModalClose');
    const cancelBtn = document.getElementById('addPostponedCancelBtn');
    const confirmBtn = document.getElementById('addPostponedConfirmBtn');
    const tabs = modal?.querySelectorAll('.add-postponed-tab');
    const panels = modal?.querySelectorAll('.add-postponed-panel');

    if (!modal || !addBtn) return;

    // 打开弹窗
    addBtn.onclick = (e) => {
        e.stopPropagation();
        resetAddPostponedModal();
        modal.classList.add('show');
    };

    // 关闭弹窗
    const hideModal = () => modal.classList.remove('show');
    closeBtn?.addEventListener('click', hideModal);
    cancelBtn?.addEventListener('click', hideModal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) hideModal();
    });

    // 标签切换
    tabs?.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            tabs.forEach(t => t.classList.remove('active'));
            panels?.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            modal.querySelector(`.add-postponed-panel[data-panel="${tabName}"]`)?.classList.add('active');
        });
    });

    // 文件夹选择按钮
    const folderSelectBtn = document.getElementById('addFolderSelectBtn');
    folderSelectBtn?.addEventListener('click', () => {
        showAddFolderPicker();
    });

    // "全部"复选框逻辑
    const selectAllCheckbox = document.getElementById('addFolderSelectAll');
    const countInput = document.getElementById('addFolderCount');
    const modeRow = document.getElementById('addModeRow');
    selectAllCheckbox?.addEventListener('change', () => {
        if (selectAllCheckbox.checked) {
            countInput.disabled = true;
            modeRow.style.display = 'none';
            // 自动设置为顺序模式
            const sequentialRadio = document.querySelector('input[name="addFolderMode"][value="sequential"]');
            if (sequentialRadio) sequentialRadio.checked = true;
        } else {
            countInput.disabled = false;
            modeRow.style.display = 'flex';
        }
    });

    // 搜索书签输入框
    const searchInput = document.getElementById('addSearchInput');
    let searchTimer = null;
    searchInput?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
            searchBookmarksForAdd(searchInput.value);
        }, 300);
    });

    // 标签切换时加载域名列表
    tabs?.forEach(tab => {
        tab.addEventListener('click', async () => {
            if (tab.dataset.tab === 'domain') {
                await loadDomainList();
            }
        });
    });

    // 域名搜索输入框
    const domainSearchInput = document.getElementById('addDomainSearchInput');
    let domainSearchTimer = null;
    domainSearchInput?.addEventListener('input', () => {
        clearTimeout(domainSearchTimer);
        domainSearchTimer = setTimeout(() => {
            filterDomainList(domainSearchInput.value);
        }, 200);
    });

    // 确认添加
    confirmBtn?.addEventListener('click', async () => {
        await confirmAddToPostponed();
        hideModal();
    });
}

function resetAddPostponedModal() {
    addPostponedSelectedFolder = null;
    addPostponedSearchSelected.clear();
    addPostponedDomainSelected.clear();

    const isZh = currentLang === 'zh_CN';

    // 重置文件夹选择
    const folderName = document.getElementById('addFolderSelectedName');
    if (folderName) folderName.textContent = isZh ? '点击选择文件夹' : 'Click to select folder';

    // 重置"全部"复选框
    const selectAllCheckbox = document.getElementById('addFolderSelectAll');
    const countInput = document.getElementById('addFolderCount');
    const modeRow = document.getElementById('addModeRow');
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    if (countInput) countInput.disabled = false;
    if (modeRow) modeRow.style.display = 'flex';

    // 重置搜索
    const searchInput = document.getElementById('addSearchInput');
    const searchResults = document.getElementById('addSearchResults');
    const searchCount = document.getElementById('addSearchSelectedCount');
    if (searchInput) searchInput.value = '';
    if (searchResults) searchResults.innerHTML = `<div class="add-results-empty">${isZh ? '输入关键词搜索书签' : 'Enter keyword to search bookmarks'}</div>`;
    if (searchCount) searchCount.textContent = '0';

    // 重置域名
    const domainSearchInput = document.getElementById('addDomainSearchInput');
    const domainList = document.getElementById('addDomainList');
    const domainCount = document.getElementById('addDomainSelectedCount');
    if (domainSearchInput) domainSearchInput.value = '';
    if (domainList) domainList.innerHTML = `<div class="add-results-empty">${isZh ? '切换到此标签加载域名' : 'Switch to this tab to load domains'}</div>`;
    if (domainCount) domainCount.textContent = '0';
    addPostponedDomainData = [];

    // 重置到第一个标签
    const modal = document.getElementById('addToPostponedModal');
    const tabs = modal?.querySelectorAll('.add-postponed-tab');
    const panels = modal?.querySelectorAll('.add-postponed-panel');
    tabs?.forEach((t, i) => t.classList.toggle('active', i === 0));
    panels?.forEach((p, i) => p.classList.toggle('active', i === 0));
}

// 显示文件夹选择器
function showAddFolderPicker() {
    const panel = document.querySelector('.add-postponed-panel[data-panel="folder"]');
    if (!panel) return;

    // 检查是否已存在选择器
    let treeContainer = panel.querySelector('.add-folder-tree');
    if (treeContainer) {
        treeContainer.remove();
        return;
    }

    // 创建树形选择器
    treeContainer = document.createElement('div');
    treeContainer.className = 'add-folder-tree';

    // 获取书签树
    browserAPI.bookmarks.getTree().then(tree => {
        const rootNodes = tree[0]?.children || [];
        treeContainer.innerHTML = renderFolderTree(rootNodes);

        // 绑定点击事件
        treeContainer.querySelectorAll('.add-folder-tree-item').forEach(item => {
            item.addEventListener('click', () => {
                treeContainer.querySelectorAll('.add-folder-tree-item').forEach(i => i.classList.remove('selected'));
                item.classList.add('selected');
                addPostponedSelectedFolder = {
                    id: item.dataset.id,
                    title: item.dataset.title
                };
                const folderName = document.getElementById('addFolderSelectedName');
                if (folderName) folderName.textContent = item.dataset.title;
            });
        });
    });

    // 插入到第一行后面
    const firstRow = panel.querySelector('.add-panel-row');
    firstRow?.insertAdjacentElement('afterend', treeContainer);
}

function renderFolderTree(nodes, level = 0) {
    const isZh = currentLang === 'zh_CN';

    function countBookmarks(node) {
        let count = 0;
        if (node.url) count = 1;
        if (node.children) {
            for (const child of node.children) {
                count += countBookmarks(child);
            }
        }
        return count;
    }

    let html = '';
    for (const node of nodes) {
        if (!node.url) { // 只显示文件夹
            const hasChildren = node.children?.some(c => !c.url);
            const bookmarkCount = countBookmarks(node);
            html += `<div class="folder-tree-node">`;
            html += `<div class="add-folder-tree-item" data-id="${node.id}" data-title="${escapeHtml(node.title || '未命名')}">
                <i class="fas fa-folder"></i>
                <span>${escapeHtml(node.title || (isZh ? '未命名' : 'Untitled'))}</span>
                <span class="folder-count">${bookmarkCount}</span>
            </div>`;
            if (hasChildren) {
                html += `<div class="folder-tree-children">${renderFolderTree(node.children, level + 1)}</div>`;
            }
            html += `</div>`;
        }
    }
    return html;
}

// 搜索书签
async function searchBookmarksForAdd(keyword) {
    const resultsEl = document.getElementById('addSearchResults');
    const countEl = document.getElementById('addSearchSelectedCount');
    if (!resultsEl) return;

    if (!keyword.trim()) {
        resultsEl.innerHTML = `<div class="add-results-empty">${currentLang === 'zh_CN' ? '输入关键词搜索书签' : 'Enter keyword to search bookmarks'}</div>`;
        return;
    }

    try {
        const results = await browserAPI.bookmarks.search(keyword);
        const bookmarks = results.filter(b => b.url).slice(0, 50);

        if (bookmarks.length === 0) {
            resultsEl.innerHTML = `<div class="add-results-empty">${currentLang === 'zh_CN' ? '未找到匹配的书签' : 'No bookmarks found'}</div>`;
            return;
        }

        resultsEl.innerHTML = bookmarks.map(b => `
            <div class="add-result-item ${addPostponedSearchSelected.has(b.id) ? 'selected' : ''}" data-id="${b.id}">
                <input type="checkbox" class="add-result-checkbox" ${addPostponedSearchSelected.has(b.id) ? 'checked' : ''}>
                <img class="add-result-favicon" src="${getFaviconUrl(b.url)}">
                <div class="add-result-info">
                    <div class="add-result-title">${escapeHtml(b.title || b.url)}</div>
                    <div class="add-result-url">${escapeHtml(b.url)}</div>
                </div>
            </div>
        `).join('');

        // 绑定点击事件
        resultsEl.querySelectorAll('.add-result-item').forEach(item => {
            item.addEventListener('click', () => {
                const id = item.dataset.id;
                const checkbox = item.querySelector('.add-result-checkbox');
                if (addPostponedSearchSelected.has(id)) {
                    addPostponedSearchSelected.delete(id);
                    item.classList.remove('selected');
                    checkbox.checked = false;
                } else {
                    addPostponedSearchSelected.add(id);
                    item.classList.add('selected');
                    checkbox.checked = true;
                }
                countEl.textContent = addPostponedSearchSelected.size;
            });
        });
    } catch (e) {
        console.error('[添加到稍后] 搜索失败:', e);
    }
}

// 加载域名列表
async function loadDomainList() {
    const listEl = document.getElementById('addDomainList');
    const countEl = document.getElementById('addDomainSelectedCount');
    const searchInput = document.getElementById('addDomainSearchInput');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';
    listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载中...' : 'Loading...'}</div>`;
    if (searchInput) searchInput.value = '';

    try {
        const allBookmarks = await getAllBookmarksFlat();

        // 统计每个域名的书签数量
        const domainMap = new Map(); // domain -> { count, bookmarkIds }
        for (const b of allBookmarks) {
            if (!b.url) continue;
            try {
                const url = new URL(b.url);
                const domain = url.hostname;
                if (!domainMap.has(domain)) {
                    domainMap.set(domain, { count: 0, bookmarkIds: [] });
                }
                domainMap.get(domain).count++;
                domainMap.get(domain).bookmarkIds.push(b.id);
            } catch {
                // 忽略无效URL
            }
        }

        // 按数量排序并保存
        addPostponedDomainData = Array.from(domainMap.entries())
            .sort((a, b) => b[1].count - a[1].count);

        renderDomainList(addPostponedDomainData);
    } catch (e) {
        console.error('[添加到待复习] 加载域名列表失败:', e);
        const isZh = currentLang === 'zh_CN';
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '加载失败' : 'Failed to load'}</div>`;
    }
}

// 过滤域名列表
function filterDomainList(keyword) {
    if (!keyword.trim()) {
        renderDomainList(addPostponedDomainData);
        return;
    }

    const keywordLower = keyword.toLowerCase();
    const filtered = addPostponedDomainData.filter(([domain]) =>
        domain.toLowerCase().includes(keywordLower)
    );
    renderDomainList(filtered);
}

// 渲染域名列表
function renderDomainList(domains) {
    const listEl = document.getElementById('addDomainList');
    const countEl = document.getElementById('addDomainSelectedCount');
    if (!listEl) return;

    const isZh = currentLang === 'zh_CN';

    if (domains.length === 0) {
        listEl.innerHTML = `<div class="add-results-empty">${isZh ? '没有找到匹配的域名' : 'No matching domains'}</div>`;
        return;
    }

    // 最多显示100个
    const displayDomains = domains.slice(0, 100);

    listEl.innerHTML = displayDomains.map(([domain, data]) => `
        <div class="add-domain-item ${addPostponedDomainSelected.has(domain) ? 'selected' : ''}" data-domain="${escapeHtml(domain)}">
            <input type="checkbox" ${addPostponedDomainSelected.has(domain) ? 'checked' : ''}>
            <div class="add-domain-info">
                <div class="add-domain-name">${escapeHtml(domain)}</div>
                <div class="add-domain-count">${data.count} ${isZh ? '个书签' : 'bookmarks'}</div>
            </div>
        </div>
    `).join('');

    // 绑定点击事件
    listEl.querySelectorAll('.add-domain-item').forEach(item => {
        item.addEventListener('click', () => {
            const domain = item.dataset.domain;
            const checkbox = item.querySelector('input[type="checkbox"]');
            if (addPostponedDomainSelected.has(domain)) {
                addPostponedDomainSelected.delete(domain);
                item.classList.remove('selected');
                checkbox.checked = false;
            } else {
                addPostponedDomainSelected.add(domain);
                item.classList.add('selected');
                checkbox.checked = true;
            }
            countEl.textContent = addPostponedDomainSelected.size;
        });
    });
}

// 获取所有书签（扁平化）
async function getAllBookmarksFlat() {
    const tree = await browserAPI.bookmarks.getTree();
    const bookmarks = [];

    function traverse(nodes, ancestors = []) {
        for (const node of nodes) {
            if (node.url) {
                bookmarks.push({ ...node, ancestorFolderIds: ancestors });
            }
            if (node.children) {
                const nextAncestors = node.url ? ancestors : [...ancestors, node.id];
                traverse(node.children, nextAncestors);
            }
        }
    }

    traverse(tree, []);
    return bookmarks;
}

// 确认添加到待复习
async function confirmAddToPostponed() {
    const activePanel = document.querySelector('.add-postponed-panel.active');
    if (!activePanel) return;

    const panelType = activePanel.dataset.panel;
    let bookmarkIds = [];
    const isZh = currentLang === 'zh_CN';

    if (panelType === 'folder') {
        // 从文件夹抽取
        if (!addPostponedSelectedFolder) {
            alert(isZh ? '请先选择一个文件夹' : 'Please select a folder first');
            return;
        }

        const selectAll = document.getElementById('addFolderSelectAll')?.checked;
        const count = selectAll ? Infinity : (parseInt(document.getElementById('addFolderCount')?.value) || 5);
        const mode = selectAll ? 'sequential' : (document.querySelector('input[name="addFolderMode"]:checked')?.value || 'random');
        const includeSubfolders = document.getElementById('addFolderIncludeSubfolders')?.checked ?? true;

        // 获取文件夹内的书签
        const folderBookmarks = await getBookmarksFromFolder(addPostponedSelectedFolder.id, includeSubfolders);

        if (folderBookmarks.length === 0) {
            alert(isZh ? '该文件夹中没有书签' : 'No bookmarks in this folder');
            return;
        }

        // 根据模式抽取
        if (mode === 'random') {
            // 随机打乱
            const shuffled = [...folderBookmarks].sort(() => Math.random() - 0.5);
            bookmarkIds = shuffled.slice(0, count).map(b => b.id);
        } else {
            // 顺序抽取（全部或指定数量）
            bookmarkIds = folderBookmarks.slice(0, count).map(b => b.id);
        }

    } else if (panelType === 'search') {
        bookmarkIds = Array.from(addPostponedSearchSelected);
        if (bookmarkIds.length === 0) {
            alert(isZh ? '请先搜索并选择书签' : 'Please search and select bookmarks first');
            return;
        }
    } else if (panelType === 'domain') {
        const selectedDomains = Array.from(addPostponedDomainSelected);
        if (selectedDomains.length === 0) {
            alert(isZh ? '请先选择域名' : 'Please select domains first');
            return;
        }
        // 获取所有选中域名的书签
        const allBookmarks = await getAllBookmarksFlat();
        for (const b of allBookmarks) {
            if (!b.url) continue;
            try {
                const url = new URL(b.url);
                if (selectedDomains.includes(url.hostname)) {
                    bookmarkIds.push(b.id);
                }
            } catch {
                // 忽略
            }
        }
        if (bookmarkIds.length === 0) {
            alert(isZh ? '所选域名没有书签' : 'No bookmarks for selected domains');
            return;
        }
    }

    if (bookmarkIds.length === 0) {
        return;
    }

    // 添加到待复习队列（手动添加的书签会获得优先级提升）
    const postponed = await getPostponedBookmarks();
    const now = Date.now();
    let addedCount = 0;

    // 处理"全部"选项
    const selectAllCheckbox = document.getElementById('addFolderSelectAll');
    const isSelectAll = selectAllCheckbox?.checked;

    // 生成分组信息
    let groupInfo = null;
    if (panelType === 'folder' && addPostponedSelectedFolder) {
        groupInfo = {
            type: 'folder',
            id: `folder_${addPostponedSelectedFolder.id}_${now}`,
            name: addPostponedSelectedFolder.title,
            folderId: addPostponedSelectedFolder.id
        };
    } else if (panelType === 'domain') {
        const selectedDomains = Array.from(addPostponedDomainSelected);
        const domainName = selectedDomains.length === 1 ? selectedDomains[0] : `${selectedDomains.length} ${isZh ? '个域名' : 'domains'}`;
        groupInfo = {
            type: 'domain',
            id: `domain_${now}`,
            name: domainName
        };
    }

    for (const id of bookmarkIds) {
        // 检查是否已存在
        const existing = postponed.find(p => p.bookmarkId === id);
        if (!existing) {
            postponed.push({
                bookmarkId: id,
                addedAt: now,
                postponeUntil: now, // 立即可用，不设置延迟
                manuallyAdded: true, // 标记为手动添加，用于优先级提升
                groupId: groupInfo?.id || null,
                groupType: groupInfo?.type || 'single',
                groupName: groupInfo?.name || null
            });
            addedCount++;
        } else if (!existing.manuallyAdded) {
            // 如果已存在但不是手动添加的，更新为手动添加
            existing.manuallyAdded = true;
            existing.postponeUntil = now;
            existing.groupId = groupInfo?.id || null;
            existing.groupType = groupInfo?.type || 'single';
            existing.groupName = groupInfo?.name || null;
        }
    }

    await browserAPI.storage.local.set({ recommend_postponed: postponed });
    console.log(`[添加到待复习] 已添加 ${addedCount} 个书签（手动添加，优先级提升）`);

    // 刷新列表（可能触发模式切换和全量重算）
    // 注意：loadPostponedList 会检测是否需要切换到优先模式，如果切换则会全量重算
    // 所以这里不需要额外调用 updateMultipleBookmarkScores，避免重复计算
    await loadPostponedList();
    await refreshRecommendCards(true); // 强制刷新推荐卡片

    // 显示成功提示
    const msg = isZh
        ? `已添加 ${bookmarkIds.length} 个书签到待复习`
        : `Added ${bookmarkIds.length} bookmark(s) to review`;

    // 使用临时提示而不是 alert
    showToast(msg);
}

// 显示临时提示
function showToast(message, duration = 2000) {
    // 移除已存在的toast
    const existing = document.querySelector('.toast-message');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast-message';
    toast.textContent = message;
    toast.style.cssText = `
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 99999;
        animation: fadeInUp 0.3s ease;
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOutDown 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// 从文件夹获取书签
async function getBookmarksFromFolder(folderId, includeSubfolders = true) {
    const bookmarks = [];

    async function traverse(nodeId) {
        const children = await browserAPI.bookmarks.getChildren(nodeId);
        for (const child of children) {
            if (child.url) {
                bookmarks.push(child);
            } else if (includeSubfolders && child.id) {
                // bookmarks.getChildren 返回的文件夹节点通常不带 children 属性
                await traverse(child.id);
            }
        }
    }

    await traverse(folderId);
    return bookmarks;
}

async function loadRecommendData() {
    console.log('[书签推荐] 加载推荐数据');

    // 检查是否需要自动刷新（基于打开次数或时间）
    const shouldAutoRefresh = await checkAndIncrementOpenCount();

    // 根据检查结果决定是否强制刷新
    await refreshRecommendCards(shouldAutoRefresh);

    // 加载稍后复习队列
    await loadPostponedList();

    // 加载热力图
    await loadHeatmapData();

    // 加载屏蔽列表
    await loadBlockedLists();
}

// 检查并增加打开次数，返回是否需要自动刷新
async function checkAndIncrementOpenCount() {
    try {
        const settings = await getRefreshSettings();
        const now = Date.now();
        let shouldRefresh = false;

        // 增加打开次数
        settings.openCountSinceRefresh = (settings.openCountSinceRefresh || 0) + 1;
        console.log('[自动刷新] 打开次数:', settings.openCountSinceRefresh);

        // 检查是否达到刷新条件
        // 1. 每N次打开刷新
        if (settings.refreshEveryNOpens > 0 && settings.openCountSinceRefresh >= settings.refreshEveryNOpens) {
            console.log('[自动刷新] 达到打开次数阈值，触发刷新');
            shouldRefresh = true;
        }

        // 2. 超过X小时刷新
        if (!shouldRefresh && settings.refreshAfterHours > 0 && settings.lastRefreshTime > 0) {
            const hoursSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60);
            if (hoursSinceRefresh >= settings.refreshAfterHours) {
                console.log('[自动刷新] 超过小时阈值，触发刷新');
                shouldRefresh = true;
            }
        }

        // 3. 超过X天刷新
        if (!shouldRefresh && settings.refreshAfterDays > 0 && settings.lastRefreshTime > 0) {
            const daysSinceRefresh = (now - settings.lastRefreshTime) / (1000 * 60 * 60 * 24);
            if (daysSinceRefresh >= settings.refreshAfterDays) {
                console.log('[自动刷新] 超过天数阈值，触发刷新');
                shouldRefresh = true;
            }
        }

        // 保存更新后的设置
        await saveRefreshSettings(settings);

        // 更新状态显示
        updateRefreshSettingsStatus(settings);

        return shouldRefresh;
    } catch (e) {
        console.error('[自动刷新] 检查失败:', e);
        return false;
    }
}

// 加载待复习队列
async function loadPostponedList() {
    const listEl = document.getElementById('postponedList');
    const countEl = document.getElementById('postponedCount');
    const emptyEl = document.getElementById('postponedEmpty');
    if (!listEl) return;

    try {
        const postponed = await getPostponedBookmarks();
        const now = Date.now();

        // 过滤：手动添加的 或 未到期的
        const activePostponed = postponed.filter(p => p.manuallyAdded || p.postponeUntil > now);

        // 更新计数
        if (countEl) countEl.textContent = activePostponed.length;

        // 更新优先模式按钮和权重显示
        const priorityBadge = document.getElementById('postponedPriorityBadge');
        const priorityModeBtn = document.getElementById('priorityModeBtn');
        const hasManualPostponed = activePostponed.some(p => p.manuallyAdded);

        if (priorityBadge) {
            priorityBadge.style.display = hasManualPostponed ? 'inline-flex' : 'none';
        }

        // 优先模式按钮显示/隐藏
        if (priorityModeBtn) {
            if (hasManualPostponed) {
                priorityModeBtn.style.display = 'inline-flex';
                // 如果当前不是用户主动选择的其他模式，自动切换到优先模式
                if (!priorityModeBtn.dataset.userOverride) {
                    applyPresetMode('priority');
                }
            } else {
                priorityModeBtn.style.display = 'none';
                // 待复习清空后，如果当前是优先模式，切换回默认
                if (currentRecommendMode === 'priority') {
                    applyPresetMode('default');
                }
                delete priorityModeBtn.dataset.userOverride;
            }
        }

        // 根据数量决定是否折叠
        updatePostponedCollapse(activePostponed.length);

        // 清空列表（保留空状态元素）
        const items = listEl.querySelectorAll('.postponed-item, .postponed-group');
        items.forEach(item => item.remove());

        if (activePostponed.length === 0) {
            if (emptyEl) emptyEl.style.display = 'block';
            return;
        }

        if (emptyEl) emptyEl.style.display = 'none';

        // 按分组整理书签
        const groups = new Map(); // groupId -> items[]
        const singles = []; // 没有分组的单个书签
        const delayedItems = []; // 通过卡片⏰按钮添加的延迟书签

        for (const p of activePostponed) {
            if (p.groupId && p.manuallyAdded) {
                if (!groups.has(p.groupId)) {
                    groups.set(p.groupId, {
                        type: p.groupType,
                        name: p.groupName,
                        items: []
                    });
                }
                groups.get(p.groupId).items.push(p);
            } else if (p.manuallyAdded && !p.groupId) {
                singles.push(p);
            } else {
                delayedItems.push(p);
            }
        }

        // 渲染分组
        for (const [groupId, group] of groups) {
            await renderPostponedGroup(listEl, groupId, group);
        }

        // 渲染单个书签
        for (const p of singles) {
            await renderPostponedItem(listEl, p);
        }

        // 渲染延迟书签
        for (const p of delayedItems) {
            await renderPostponedItem(listEl, p);
        }

    } catch (e) {
        console.error('[待复习] 加载待复习列表失败:', e);
    }
}

// 渲染分组
async function renderPostponedGroup(container, groupId, group) {
    const isZh = currentLang === 'zh_CN';
    const icon = group.type === 'folder' ? 'fa-folder' : 'fa-globe';
    const typeLabel = group.type === 'folder'
        ? (isZh ? '文件夹' : 'Folder')
        : (isZh ? '域名' : 'Domain');

    const groupEl = document.createElement('div');
    groupEl.className = 'postponed-group';
    groupEl.dataset.groupId = groupId;

    groupEl.innerHTML = `
        <div class="postponed-group-header">
            <div class="postponed-group-info">
                <i class="fas ${icon} postponed-group-icon"></i>
                <span class="postponed-group-name">${escapeHtml(group.name)}</span>
                <span class="postponed-group-count">${group.items.length}</span>
                <span class="postponed-group-type">${typeLabel}</span>
            </div>
            <div class="postponed-group-actions">
                <button class="postponed-group-btn expand" title="${isZh ? '展开' : 'Expand'}">
                    <i class="fas fa-chevron-down"></i>
                </button>
                <button class="postponed-group-btn cancel" title="${isZh ? '取消全部' : 'Cancel All'}">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        </div>
        <div class="postponed-group-items" style="display: none;"></div>
    `;

    const header = groupEl.querySelector('.postponed-group-header');
    const itemsContainer = groupEl.querySelector('.postponed-group-items');
    const expandBtn = groupEl.querySelector('.postponed-group-btn.expand');
    const cancelBtn = groupEl.querySelector('.postponed-group-btn.cancel');

    // 展开/折叠
    header.onclick = async (e) => {
        if (e.target.closest('.postponed-group-btn')) return;
        toggleGroupExpand();
    };

    expandBtn.onclick = (e) => {
        e.stopPropagation();
        toggleGroupExpand();
    };

    async function toggleGroupExpand() {
        const isExpanded = itemsContainer.style.display !== 'none';
        if (isExpanded) {
            itemsContainer.style.display = 'none';
            expandBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
            expandBtn.title = isZh ? '展开' : 'Expand';
        } else {
            // 首次展开时渲染子项
            if (itemsContainer.children.length === 0) {
                for (const p of group.items) {
                    await renderPostponedItem(itemsContainer, p, true);
                }
            }
            itemsContainer.style.display = 'block';
            expandBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
            expandBtn.title = isZh ? '收起' : 'Collapse';
        }
    }

    // 取消全部
    cancelBtn.onclick = async (e) => {
        e.stopPropagation();
        for (const p of group.items) {
            await cancelPostpone(p.bookmarkId);
        }
        await loadPostponedList();
        await refreshRecommendCards();
    };

    container.appendChild(groupEl);
}

// 渲染单个待复习项
async function renderPostponedItem(container, p, isGroupChild = false) {
    try {
        const bookmarks = await new Promise(resolve => {
            browserAPI.bookmarks.get(p.bookmarkId, resolve);
        });
        if (!bookmarks || bookmarks.length === 0) return;
        const bookmark = bookmarks[0];

        const item = document.createElement('div');
        item.className = 'postponed-item' + (isGroupChild ? ' group-child' : '');
        item.style.cursor = 'pointer';

        const isZh = currentLang === 'zh_CN';
        const isManuallyAdded = p.manuallyAdded;
        const manualBadge = (isManuallyAdded && !isGroupChild)
            ? `<span class="postponed-item-badge manual">${isZh ? '优先' : 'Priority'}</span>`
            : '';
        const timeOrManual = isManuallyAdded
            ? (isZh ? '手动添加，优先推荐' : 'Manually added, priority boost')
            : formatPostponeTime(p.postponeUntil);

        item.innerHTML = `
            <img class="postponed-item-icon" src="${getFaviconUrl(bookmark.url)}" alt="">
            <div class="postponed-item-info">
                <div class="postponed-item-title">${manualBadge}${escapeHtml(bookmark.title || bookmark.url)}</div>
                <div class="postponed-item-meta">
                    <span class="postponed-item-time">${timeOrManual}</span>
                    ${!isManuallyAdded && p.postponeCount > 1 ? `<span class="postponed-item-count">(${isZh ? '已推迟' + p.postponeCount + '次' : 'postponed ' + p.postponeCount + ' times'})</span>` : ''}
                </div>
            </div>
            <button class="postponed-item-btn" data-id="${p.bookmarkId}">${isZh ? '取消' : 'Cancel'}</button>
        `;

        // 点击整个item = 提前复习
        item.onclick = async (e) => {
            if (e.target.closest('.postponed-item-btn')) return;
            console.log('[提前复习]', bookmark.id, bookmark.title);
            await cancelPostpone(p.bookmarkId);
            await recordReview(p.bookmarkId);
            await openInRecommendWindow(bookmark.url);
            await loadPostponedList();
        };

        // 取消按钮事件
        const btn = item.querySelector('.postponed-item-btn');
        btn.onclick = async (e) => {
            e.stopPropagation();
            await cancelPostpone(p.bookmarkId);
            await loadPostponedList();
            await refreshRecommendCards();
        };

        container.appendChild(item);
    } catch (e) {
        console.error('[待复习] 获取书签信息失败:', e);
    }
}

// 格式化推迟时间
function formatPostponeTime(timestamp) {
    const now = Date.now();
    const diff = timestamp - now;
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return currentLang === 'en' ? `${days} day${days > 1 ? 's' : ''} later` : `${days}天后`;
    } else if (hours > 0) {
        return currentLang === 'en' ? `${hours} hour${hours > 1 ? 's' : ''} later` : `${hours}小时后`;
    } else {
        const mins = Math.max(1, Math.floor(diff / 60000));
        return currentLang === 'en' ? `${mins} minute${mins > 1 ? 's' : ''} later` : `${mins}分钟后`;
    }
}

// 加载屏蔽列表
async function loadBlockedLists() {
    const blocked = await getBlockedBookmarks();

    // 加载已屏蔽书签
    await loadBlockedBookmarksList(blocked.bookmarks);

    // 加载已屏蔽文件夹
    await loadBlockedFoldersList(blocked.folders);

    // 加载已屏蔽域名
    await loadBlockedDomainsList(blocked.domains);
}

// 加载已屏蔽书签列表（相同标题合并显示）
async function loadBlockedBookmarksList(bookmarkIds) {
    const listEl = document.getElementById('blockedBookmarksList');
    const countEl = document.getElementById('blockedBookmarksCount');
    const emptyEl = document.getElementById('blockedBookmarksEmpty');
    if (!listEl) return;

    // 更新计数
    if (countEl) countEl.textContent = bookmarkIds.length;

    // 清空列表
    const items = listEl.querySelectorAll('.block-item, .block-group');
    items.forEach(item => item.remove());

    if (bookmarkIds.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    // 获取所有书签信息并按标题分组
    const titleGroups = new Map(); // title -> [{id, bookmark}]

    for (const id of bookmarkIds) {
        try {
            const bookmarks = await new Promise(resolve => {
                browserAPI.bookmarks.get(id, resolve);
            });
            if (!bookmarks || bookmarks.length === 0) continue;
            const bookmark = bookmarks[0];
            const title = bookmark.title || bookmark.url;

            if (!titleGroups.has(title)) {
                titleGroups.set(title, []);
            }
            titleGroups.get(title).push({ id, bookmark });
        } catch (e) {
            // 书签可能已被删除
        }
    }

    const isZh = currentLang === 'zh_CN';

    // 渲染分组
    for (const [title, group] of titleGroups) {
        const firstBookmark = group[0].bookmark;
        const count = group.length;
        const allIds = group.map(g => g.id);

        const item = document.createElement('div');
        item.className = 'block-item';

        const countBadge = count > 1
            ? `<span class="block-item-count">${count}</span>`
            : '';

        item.innerHTML = `
            <img class="block-item-icon" src="${getFaviconUrl(firstBookmark.url)}" alt="">
            <div class="block-item-info">
                <div class="block-item-title">${escapeHtml(title)}</div>
            </div>
            ${countBadge}
            <button class="block-item-btn">${isZh ? '恢复' : 'Restore'}</button>
        `;

        const btn = item.querySelector('.block-item-btn');
        btn.onclick = async () => {
            // 恢复所有同标题的书签
            for (const id of allIds) {
                await unblockBookmark(id);
            }
            await loadBlockedLists();
            await refreshRecommendCards();
        };

        listEl.appendChild(item);
    }
}

// 加载已屏蔽文件夹列表
async function loadBlockedFoldersList(folderIds) {
    const listEl = document.getElementById('blockedFoldersList');
    const countEl = document.getElementById('blockedFoldersCount');
    const emptyEl = document.getElementById('blockedFoldersEmpty');
    if (!listEl) return;

    if (countEl) countEl.textContent = folderIds.length;

    const items = listEl.querySelectorAll('.block-item');
    items.forEach(item => item.remove());

    if (folderIds.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    for (const id of folderIds) {
        try {
            const folders = await new Promise(resolve => {
                browserAPI.bookmarks.get(id, resolve);
            });
            if (!folders || folders.length === 0) continue;
            const folder = folders[0];

            const item = document.createElement('div');
            item.className = 'block-item';
            item.innerHTML = `
                <i class="fas fa-folder block-item-icon" style="font-size: 18px; color: var(--warning);"></i>
                <div class="block-item-info">
                    <div class="block-item-title">${escapeHtml(folder.title)}</div>
                </div>
                <button class="block-item-btn" data-id="${id}">${currentLang === 'en' ? 'Restore' : '恢复'}</button>
            `;

            const btn = item.querySelector('.block-item-btn');
            btn.onclick = async () => {
                await unblockFolder(id);
                await loadBlockedLists();
                await refreshRecommendCards();
            };

            listEl.appendChild(item);
        } catch (e) { }
    }
}

// 加载已屏蔽域名列表
async function loadBlockedDomainsList(domains) {
    const listEl = document.getElementById('blockedDomainsList');
    const countEl = document.getElementById('blockedDomainsCount');
    const emptyEl = document.getElementById('blockedDomainsEmpty');
    if (!listEl) return;

    if (countEl) countEl.textContent = domains.length;

    const items = listEl.querySelectorAll('.block-item');
    items.forEach(item => item.remove());

    if (domains.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    for (const domain of domains) {
        const item = document.createElement('div');
        item.className = 'block-item';
        item.innerHTML = `
            <i class="fas fa-globe block-item-icon" style="font-size: 18px; color: var(--accent-primary);"></i>
            <div class="block-item-info">
                <div class="block-item-title">${escapeHtml(domain)}</div>
            </div>
            <button class="block-item-btn" data-domain="${domain}">${currentLang === 'en' ? 'Restore' : '恢复'}</button>
        `;

        const btn = item.querySelector('.block-item-btn');
        btn.onclick = async () => {
            await unblockDomain(domain);
            await loadBlockedLists();
            await refreshRecommendCards();
        };

        listEl.appendChild(item);
    }
}

// 屏蔽/恢复文件夹
async function blockFolder(folderId) {
    try {
        const blocked = await getBlockedBookmarks();
        if (!blocked.folders.includes(folderId)) {
            blocked.folders.push(folderId);
            await browserAPI.storage.local.set({ recommend_blocked: blocked });
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function unblockFolder(folderId) {
    try {
        const blocked = await getBlockedBookmarks();
        blocked.folders = blocked.folders.filter(id => id !== folderId);
        await browserAPI.storage.local.set({ recommend_blocked: blocked });
        return true;
    } catch (e) {
        return false;
    }
}

// 屏蔽/恢复域名
async function blockDomain(domain) {
    try {
        const blocked = await getBlockedBookmarks();
        if (!blocked.domains.includes(domain)) {
            blocked.domains.push(domain);
            await browserAPI.storage.local.set({ recommend_blocked: blocked });
        }
        return true;
    } catch (e) {
        return false;
    }
}

async function unblockDomain(domain) {
    try {
        const blocked = await getBlockedBookmarks();
        blocked.domains = blocked.domains.filter(d => d !== domain);
        await browserAPI.storage.local.set({ recommend_blocked: blocked });
        return true;
    } catch (e) {
        return false;
    }
}

// =============================================================================
// Phase 4: 权重公式计算 S = (w1×F + w2×C + w3×T + w4×D + w5×L) × R
// S = Score（推荐分数），值越高越优先推荐
// R = Recall（记忆度），基于遗忘曲线，复习后锐减，逐渐恢复
// =============================================================================

// ===== 书签推荐缓存机制（仅 storage.local） =====
// 所有S值计算已迁移到 background.js
// 这里只保留缓存读写函数

// 从 storage.local 获取所有缓存的S值
async function getScoresCache() {
    try {
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['recommend_scores_cache'], resolve);
        });
        return result.recommend_scores_cache || {};
    } catch (e) {
        console.warn('[缓存] 读取S值缓存失败:', e);
        return {};
    }
}

// 保存所有S值到 storage.local
async function saveScoresCache(cache) {
    try {
        await browserAPI.storage.local.set({
            recommend_scores_cache: cache,
            recommend_scores_time: Date.now()
        });
        console.log('[缓存] S值缓存已保存:', Object.keys(cache).length, '个书签');
    } catch (e) {
        // 检测是否是配额问题
        if (e.message && (e.message.includes('QUOTA') || e.message.includes('quota'))) {
            console.warn('[缓存] 存储配额已满，尝试清理旧数据...');
            await cleanupStorageQuota();
            // 重试一次
            try {
                await browserAPI.storage.local.set({
                    recommend_scores_cache: cache,
                    recommend_scores_time: Date.now()
                });
                console.log('[缓存] 清理后保存成功');
            } catch (e2) {
                console.error('[缓存] 清理后仍然失败，请手动清理浏览器数据');
                showStorageFullWarning();
            }
        } else {
            console.warn('[缓存] 保存S值缓存失败:', e);
        }
    }
}

// 清理存储配额（当存储满时调用）
async function cleanupStorageQuota() {
    try {
        // 1. 清理超过1000条的已翻阅记录
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['flippedBookmarks'], resolve);
        });
        if (result.flippedBookmarks && result.flippedBookmarks.length > 1000) {
            const trimmed = result.flippedBookmarks.slice(-1000);
            await browserAPI.storage.local.set({ flippedBookmarks: trimmed });
            console.log('[清理] 已翻阅记录从', result.flippedBookmarks.length, '条缩减到', trimmed.length, '条');
        }

        // 2. 清理过期的稍后复习记录（7天前）
        const postponed = await getPostponedBookmarks();
        const now = Date.now();
        const validPostponed = postponed.filter(p => p.manuallyAdded || p.postponeUntil > now - 7 * 24 * 60 * 60 * 1000);
        if (validPostponed.length < postponed.length) {
            await browserAPI.storage.local.set({ recommend_postponed: validPostponed });
            console.log('[清理] 过期稍后复习记录已清理:', postponed.length - validPostponed.length, '条');
        }

    } catch (e) {
        console.error('[清理] 清理存储失败:', e);
    }
}

// 显示存储满警告
function showStorageFullWarning() {
    const isZh = currentLang === 'zh_CN';
    const msg = isZh
        ? '存储空间已满，部分数据可能无法保存。请在浏览器设置中清理扩展数据。'
        : 'Storage is full. Some data may not be saved. Please clear extension data in browser settings.';

    if (typeof showToast === 'function') {
        showToast(msg, 5000);
    } else {
        console.error('[存储] ' + msg);
    }
}

// 获取单个书签的缓存S值
async function getCachedScore(bookmarkId) {
    const cache = await getScoresCache();
    return cache[bookmarkId] || null;
}

// 清除缓存
async function clearScoresCache() {
    await browserAPI.storage.local.remove(['recommend_scores_cache', 'recommend_scores_time']);
    console.log('[缓存] 已清除S值缓存');
}

// ===== P1: 缓存机制 =====
// 综合时间排行静态缓存（"全部"范围，按标题和URL双索引）
let trackingRankingCache = {
    byTitle: new Map(),   // 标题 -> { compositeMs, url }
    byUrl: new Map(),     // URL -> { compositeMs, title }
    loaded: false
};
let historyDataCache = null;
let historyCacheTime = 0;
const STATS_CACHE_TTL = 60000; // 1分钟缓存

// ===== P0: 加载综合时间排行缓存（"全部"范围）=====
async function loadTrackingRankingCache() {
    if (trackingRankingCache.loaded) {
        return trackingRankingCache;
    }

    try {
        const response = await browserAPI.runtime.sendMessage({
            action: 'getActiveSessions',
            startTime: 0,  // 全部范围
            endTime: Date.now()
        });

        if (response && response.success && response.sessions) {
            // 按标题聚合综合时间（与排行榜逻辑一致）
            const titleStats = new Map();
            for (const session of response.sessions) {
                const key = session.title || session.url;
                if (!titleStats.has(key)) {
                    titleStats.set(key, {
                        url: session.url,
                        title: session.title || session.url,
                        compositeMs: 0
                    });
                }
                const stat = titleStats.get(key);
                const sessionComposite = session.compositeMs ||
                    ((session.activeMs || 0) +
                        (session.idleFocusMs || session.pauseTotalMs || 0) * 0.8 +
                        (session.visibleMs || 0) * 0.5 +
                        (session.backgroundMs || 0) * 0.1);
                stat.compositeMs += sessionComposite;
            }

            // 构建双索引
            trackingRankingCache.byTitle.clear();
            trackingRankingCache.byUrl.clear();
            for (const [key, stat] of titleStats) {
                trackingRankingCache.byTitle.set(stat.title, stat);
                if (stat.url) {
                    trackingRankingCache.byUrl.set(stat.url, stat);
                }
            }
            trackingRankingCache.loaded = true;
            console.log('[T值缓存] 已加载综合时间排行:', titleStats.size, '条记录');
        }
    } catch (e) {
        console.warn('[T值缓存] 加载失败:', e);
    }
    return trackingRankingCache;
}

// 清除T值缓存（在数据变化时调用）
function clearTrackingRankingCache() {
    trackingRankingCache.byTitle.clear();
    trackingRankingCache.byUrl.clear();
    trackingRankingCache.loaded = false;
}

// ===== P0: 从静态缓存获取书签的综合时间（标题或URL匹配）=====
async function getTrackingDataFromDB() {
    // 确保缓存已加载
    await loadTrackingRankingCache();

    // 返回兼容旧格式的对象（供 batchGetBookmarkStats 使用）
    const result = {};
    for (const [url, stat] of trackingRankingCache.byUrl) {
        result[url] = {
            compositeMs: stat.compositeMs,
            title: stat.title
        };
    }
    return result;
}

// 根据书签获取综合时间（标题或URL匹配，并集）
async function getBookmarkCompositeTime(bookmark) {
    await loadTrackingRankingCache();

    // 优先URL匹配
    if (bookmark.url && trackingRankingCache.byUrl.has(bookmark.url)) {
        return trackingRankingCache.byUrl.get(bookmark.url).compositeMs;
    }

    // 其次标题匹配
    if (bookmark.title && trackingRankingCache.byTitle.has(bookmark.title)) {
        return trackingRankingCache.byTitle.get(bookmark.title).compositeMs;
    }

    return 0;
}

// ===== P2: 批量获取历史记录（URL+标题并集匹配，与点击记录一致）=====
let historyDataLoadingPromise = null; // 防止并发加载

async function getBatchHistoryData() {
    const now = Date.now();
    // 检查缓存
    if (historyDataCache && (now - historyCacheTime) < STATS_CACHE_TTL) {
        return historyDataCache;
    }

    // 如果正在加载，等待加载完成
    if (historyDataLoadingPromise) {
        return historyDataLoadingPromise;
    }

    // 开始加载，设置Promise锁
    historyDataLoadingPromise = (async () => {
        try {
            if (!browserAPI?.history?.search) {
                return { original: new Map(), title: new Map() };
            }

            const historyItems = await new Promise((resolve) => {
                browserAPI.history.search({
                    text: '',
                    startTime: 0,
                    maxResults: 50000
                }, (results) => {
                    if (browserAPI.runtime?.lastError) {
                        resolve([]);
                    } else {
                        resolve(results || []);
                    }
                });
            });

            const originalMap = new Map();  // URL映射
            const titleMap = new Map();    // 标题映射（与点击记录一致的并集匹配）

            for (const item of historyItems) {
                if (item.url) {
                    const data = {
                        visitCount: item.visitCount || 0,
                        lastVisitTime: item.lastVisitTime || 0
                    };
                    // URL映射
                    originalMap.set(item.url, data);

                    // 标题映射
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
            }

            // 更新缓存（URL + 标题，与点击记录一致）
            historyDataCache = { original: originalMap, title: titleMap };
            historyCacheTime = Date.now();
            console.log('[权重计算] 历史数据已加载:', originalMap.size, '条URL,', titleMap.size, '条标题');
            return historyDataCache;
        } catch (e) {
            console.warn('[权重计算] 批量获取历史数据失败:', e);
            return { original: new Map(), title: new Map() };
        } finally {
            historyDataLoadingPromise = null; // 清除锁
        }
    })();

    return historyDataLoadingPromise;
}

// 获取书签的访问统计数据（保留用于单个查询场景）
async function getBookmarkVisitStats(url) {
    try {
        if (!browserAPI?.history?.getVisits) {
            return { visitCount: 0, lastVisitTime: 0 };
        }

        const visits = await new Promise((resolve) => {
            browserAPI.history.getVisits({ url }, (results) => {
                if (browserAPI.runtime?.lastError) {
                    resolve([]);
                } else {
                    resolve(results || []);
                }
            });
        });

        return {
            visitCount: visits.length,
            lastVisitTime: visits.length > 0 ? Math.max(...visits.map(v => v.visitTime)) : 0
        };
    } catch (e) {
        return { visitCount: 0, lastVisitTime: 0 };
    }
}

// =============================================================================
// Phase 4.1: 复习曲线（简化版SM-2）
// =============================================================================

// 获取复习数据
async function getReviewData() {
    try {
        const result = await browserAPI.storage.local.get('recommend_reviews');
        return result.recommend_reviews || {};
    } catch (e) {
        console.error('[复习] 获取复习数据失败:', e);
        return {};
    }
}

// 记录一次复习
async function recordReview(bookmarkId) {
    try {
        const reviews = await getReviewData();
        const existing = reviews[bookmarkId];
        const now = Date.now();

        // 如果是手动添加的书签，复习后清除标记
        const postponed = await getPostponedBookmarks();
        const postponeInfo = postponed.find(p => p.bookmarkId === bookmarkId);
        if (postponeInfo && postponeInfo.manuallyAdded) {
            postponeInfo.manuallyAdded = false;
            await browserAPI.storage.local.set({ recommend_postponed: postponed });
            console.log('[复习] 已清除手动添加标记:', bookmarkId);
        }

        if (existing) {
            // 简化版SM-2：每次复习间隔翻倍，最大30天
            const newInterval = Math.min(existing.interval * 2, 30);
            reviews[bookmarkId] = {
                lastReview: now,
                interval: newInterval,
                reviewCount: existing.reviewCount + 1,
                nextReview: now + newInterval * 24 * 60 * 60 * 1000
            };
        } else {
            // 首次复习，间隔1天
            reviews[bookmarkId] = {
                lastReview: now,
                interval: 1,
                reviewCount: 1,
                nextReview: now + 1 * 24 * 60 * 60 * 1000
            };
        }

        await browserAPI.storage.local.set({ recommend_reviews: reviews });
        console.log('[复习] 已记录复习:', bookmarkId, '下次间隔:', reviews[bookmarkId].interval, '天');

        // R因子变化，发消息给background.js更新S值
        browserAPI.runtime.sendMessage({ action: 'updateBookmarkScore', bookmarkId });

        return reviews[bookmarkId];
    } catch (e) {
        console.error('[复习] 记录复习失败:', e);
        return null;
    }
}

// 获取书签的复习状态
function getReviewStatus(bookmarkId, reviewData) {
    const review = reviewData[bookmarkId];
    if (!review) return { status: 'new', label: '新书签' };

    const now = Date.now();
    const daysSinceReview = (now - review.lastReview) / (1000 * 60 * 60 * 24);

    if (now >= review.nextReview) {
        return { status: 'due', label: '待复习', priority: 1.2 };
    } else if (daysSinceReview >= review.interval * 0.7) {
        return { status: 'soon', label: '即将到期', priority: 1.1 };
    } else {
        return { status: 'reviewed', label: '已复习', priority: 0.8 };
    }
}

// 计算带复习状态的优先级（用于保存的卡片恢复）
function calculatePriorityWithReview(basePriority, bookmarkId, reviewData, postponeData) {
    let priority = basePriority;

    // 复习状态加成
    const reviewStatus = getReviewStatus(bookmarkId, reviewData);
    priority *= reviewStatus.priority || 1.0;

    // 惩罚因子：被多次推迟的书签降低优先级（不影响手动添加的）
    if (postponeData) {
        const postponeInfo = postponeData.find(p => p.bookmarkId === bookmarkId);
        if (postponeInfo && !postponeInfo.manuallyAdded && postponeInfo.postponeCount > 0) {
            const penaltyFactor = Math.pow(0.9, postponeInfo.postponeCount);
            priority *= penaltyFactor;
        }
    }

    return Math.min(priority, 1.5); // 最高1.5
}

// 启动时间捕捉实时刷新（当前会话1秒刷新，排行榜10秒刷新）
function startTrackingRefresh() {
    // 清除已有定时器
    if (trackingRefreshInterval) {
        clearInterval(trackingRefreshInterval);
    }
    if (rankingRefreshInterval) {
        clearInterval(rankingRefreshInterval);
    }

    // 当前会话状态实时刷新（1秒）
    trackingRefreshInterval = setInterval(() => {
        if (currentView === 'additions') {
            const trackingPanel = document.getElementById('additionsTrackingPanel');
            if (trackingPanel && trackingPanel.classList.contains('active')) {
                // 只刷新当前会话（实时显示计时）
                loadCurrentTrackingSessions();
            }
        }
    }, TRACKING_REFRESH_INTERVAL);

    // 排行榜定时刷新（10秒）
    rankingRefreshInterval = setInterval(() => {
        if (currentView === 'additions') {
            const trackingPanel = document.getElementById('additionsTrackingPanel');
            if (trackingPanel && trackingPanel.classList.contains('active')) {
                // 刷新排行榜
                loadActiveTimeRanking();
            }
        }
    }, RANKING_REFRESH_INTERVAL);
}

// 停止实时刷新
function stopTrackingRefresh() {
    if (trackingRefreshInterval) {
        clearInterval(trackingRefreshInterval);
        trackingRefreshInterval = null;
    }
    if (rankingRefreshInterval) {
        clearInterval(rankingRefreshInterval);
        rankingRefreshInterval = null;
    }
}

function compareRecommendPriority(a, b) {
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

// 刷新推荐卡片（三卡并排）
// 获取已翻过的书签ID列表
async function getFlippedBookmarks() {
    return new Promise((resolve) => {
        browserAPI.storage.local.get(['flippedBookmarks'], (result) => {
            resolve(result.flippedBookmarks || []);
        });
    });
}

// 标记书签为已翻过，并记录翻牌时间
async function markBookmarkFlipped(bookmarkId) {
    console.log('[翻牌] 标记书签:', bookmarkId);

    const flipped = await getFlippedBookmarks();
    if (!flipped.includes(bookmarkId)) {
        flipped.push(bookmarkId);
        await browserAPI.storage.local.set({ flippedBookmarks: flipped });
        console.log('[翻牌] flippedBookmarks 已更新:', flipped.length, '个');
    }

    // 记录翻牌时间（用于热力图）
    const result = await new Promise(resolve => {
        browserAPI.storage.local.get(['flipHistory'], resolve);
    });
    const flipHistory = result.flipHistory || [];
    flipHistory.push({
        bookmarkId,
        timestamp: Date.now()
    });
    await browserAPI.storage.local.set({ flipHistory });
    console.log('[翻牌] flipHistory 已更新:', flipHistory.length, '条记录');

    // 立即刷新热力图
    if (currentView === 'recommend') {
        await loadHeatmapData();
    }
}

async function refreshRecommendCards(force = false) {
    const cardsRow = document.getElementById('cardsRow');
    if (!cardsRow) return;

    const cards = cardsRow.querySelectorAll('.recommend-card');

    // 清除所有卡片的 flipped 状态
    cards.forEach(card => card.classList.remove('flipped'));

    try {
        // 获取所有书签（用于后续查找）
        const bookmarks = await new Promise((resolve) => {
            browserAPI.bookmarks.getTree((tree) => {
                const allBookmarks = [];
                function traverse(nodes) {
                    for (const node of nodes) {
                        if (node.url) {
                            allBookmarks.push(node);
                        }
                        if (node.children) {
                            traverse(node.children);
                        }
                    }
                }
                traverse(tree);
                resolve(allBookmarks);
            });
        });
        const bookmarkMap = new Map(bookmarks.map(b => [b.id, b]));

        // 一次性获取所有缓存的S值
        let scoresCache = await getScoresCache();

        // 如果S值缓存为空，请求background.js全量计算
        if (Object.keys(scoresCache).length === 0 && bookmarks.length > 0) {
            console.log('[书签推荐] S值缓存为空，请求background计算...');
            const computed = await new Promise(resolve => {
                browserAPI.runtime.sendMessage({ action: 'computeBookmarkScores' }, (response) => {
                    if (browserAPI.runtime.lastError) return resolve(false);
                    resolve(!!(response?.computed || response?.success));
                });
            });

            if (!computed) {
                recommendScoresComputeRetryCount += 1;
                if (recommendScoresComputeRetryCount <= 8) {
                    if (recommendScoresComputeRetryTimer) clearTimeout(recommendScoresComputeRetryTimer);
                    recommendScoresComputeRetryTimer = setTimeout(() => {
                        recommendScoresComputeRetryTimer = null;
                        refreshRecommendCards(true);
                    }, 1500);
                }
                // 计算尚未完成：保持 UI 稳定，避免空白/闪烁
                cards.forEach((card, index) => {
                    card.classList.add('empty');
                    const titleEl = card.querySelector('.card-title');
                    const priorityEl = card.querySelector('.card-priority');
                    if (titleEl) {
                        titleEl.textContent = index === 0
                            ? (currentLang === 'en' ? 'Computing...' : '计算中...')
                            : '--';
                    }
                    if (priorityEl) priorityEl.textContent = '';
                    card.onclick = null;
                });
                return;
            }

            recommendScoresComputeRetryCount = 0;
            scoresCache = await getScoresCache();
        }

        // 检查是否有已保存的卡片状态（与popup共享）
        const currentCards = await getHistoryCurrentCards();
        const postponed = await getPostponedBookmarks();
        const reviewData = await getReviewData();

        // 如果有保存的卡片且不是全部勾选且不是强制刷新，则显示保存的卡片
        if (currentCards && currentCards.cardIds && currentCards.cardIds.length > 0 && !force) {
            const allFlipped = currentCards.cardIds.every(id => currentCards.flippedIds.includes(id));

            if (!allFlipped) {
                // 恢复保存的卡片，直接使用缓存（支持 cardData 回填 title/url）
                const cachedCardDataMap = new Map();
                if (currentCards.cardData && Array.isArray(currentCards.cardData)) {
                    currentCards.cardData.forEach(data => {
                        if (data && data.id) cachedCardDataMap.set(data.id, data);
                    });
                }

                const savedBookmarks = currentCards.cardIds
                    .map(id => bookmarkMap.get(id) || cachedCardDataMap.get(id) || null)
                    .filter(Boolean);

                recommendCards = savedBookmarks.map(bookmark => {
                    const cached = scoresCache[bookmark.id];
                    const cachedMeta = cachedCardDataMap.get(bookmark.id);
                    const safeTitle = bookmark.title || bookmark.name || cachedMeta?.title || '';
                    const safeUrl = bookmark.url || cachedMeta?.url || '';
                    const reviewStatus = getReviewStatus(bookmark.id, reviewData);
                    if (cached) {
                        return { ...bookmark, title: safeTitle, url: safeUrl, priority: cached.S, factors: cached, reviewStatus };
                    }
                    // 缓存不存在时返回默认值
                    return { ...bookmark, title: safeTitle, url: safeUrl, priority: 0.5, factors: {}, reviewStatus };
                });

                // 更新卡片显示
                cards.forEach((card, index) => {
                    if (index < recommendCards.length) {
                        const bookmark = recommendCards[index];
                        updateCardDisplay(card, bookmark, currentCards.flippedIds.includes(bookmark.id));
                    } else {
                        setCardEmpty(card);
                    }
                });
                return;
            }
        }

        // 获取已翻过的书签
        const flippedBookmarks = await getFlippedBookmarks();
        const flippedSet = new Set(flippedBookmarks);

        // 获取已屏蔽的书签、文件夹、域名
        const blocked = await getBlockedBookmarks();
        const blockedBookmarkSet = new Set(blocked.bookmarks);
        const blockedFolderSet = new Set(blocked.folders);
        const blockedDomainSet = new Set(blocked.domains);

        // 获取稍后复习的书签（未到期的，但手动添加的不排除）
        const now = Date.now();
        const postponedSet = new Set(
            postponed.filter(p => p.postponeUntil > now && !p.manuallyAdded).map(p => p.bookmarkId)
        );

        // 检查书签是否在屏蔽的文件夹中
        const isInBlockedFolder = (bookmark) => {
            if (blockedFolderSet.size === 0) return false;
            if (bookmark.parentId && blockedFolderSet.has(bookmark.parentId)) return true;
            const ancestorFolderIds = bookmark.ancestorFolderIds || [];
            for (const folderId of ancestorFolderIds) {
                if (blockedFolderSet.has(folderId)) return true;
            }
            return false;
        };

        // 检查书签是否在屏蔽的域名中
        const isBlockedDomain = (bookmark) => {
            if (blockedDomainSet.size === 0 || !bookmark.url) return false;
            try {
                const url = new URL(bookmark.url);
                return blockedDomainSet.has(url.hostname);
            } catch {
                return false;
            }
        };

        // 基础过滤：已翻过、已跳过、已屏蔽、稀后复习
        const baseFilter = (b) =>
            !flippedSet.has(b.id) &&
            !skippedBookmarks.has(b.id) &&
            !blockedBookmarkSet.has(b.id) &&
            !isInBlockedFolder(b) &&
            !isBlockedDomain(b) &&
            !postponedSet.has(b.id);

        // 刷新时跳过当前显示的卡片（force=true时）
        const currentCardIds = new Set(
            force && currentCards?.cardIds ? currentCards.cardIds : []
        );

        // 先尝试排除当前卡片
        let availableBookmarks = bookmarks.filter(b =>
            baseFilter(b) && !currentCardIds.has(b.id)
        );

        // 如果排除后不足3个，则不排除当前卡片
        if (availableBookmarks.length < 3 && currentCardIds.size > 0) {
            availableBookmarks = bookmarks.filter(baseFilter);
        }

        if (availableBookmarks.length === 0) {
            await saveHistoryCurrentCards([], []);
            cards.forEach((card) => {
                card.classList.add('empty');
                card.querySelector('.card-title').textContent =
                    currentLang === 'en' ? 'All bookmarks reviewed!' : '所有书签都已翻阅！';
                card.querySelector('.card-priority').textContent = '';
                card.onclick = null;
            });
            return;
        }

        // 从缓存读取所有可用书签的S值，直接排序取top3
        // S值通过增量更新机制保持最新，或在手动刷新时全量重算
        const bookmarksWithPriority = availableBookmarks.map(b => {
            const cached = scoresCache[b.id];
            const reviewStatus = getReviewStatus(b.id, reviewData);
            if (cached) {
                return { ...b, priority: cached.S, factors: cached, reviewStatus };
            }
            // 缓存不存在时返回默认值（新书签或首次使用）
            return { ...b, priority: 0.5, factors: {}, reviewStatus };
        });

        // 按优先级排序（高优先级在前），S值相近时使用稳定规则
        bookmarksWithPriority.sort(compareRecommendPriority);
        recommendCards = bookmarksWithPriority.slice(0, 3);

        // 保存新的卡片状态
        const newCardIds = recommendCards.map(b => b.id);
        await saveHistoryCurrentCards(newCardIds, []);

        // 预加载当前3个 + 下一批6个的 favicon（并行）
        const urlsToPreload = bookmarksWithPriority.slice(0, 9).map(b => b.url).filter(Boolean);
        preloadHighResFavicons(urlsToPreload);

        // 异步保存favicon URLs到storage（供popup使用，不阻塞UI）
        saveCardFaviconsToStorage(recommendCards);

        // 更新卡片显示
        cards.forEach((card, index) => {
            if (index < recommendCards.length) {
                const bookmark = recommendCards[index];
                updateCardDisplay(card, bookmark, false);
            } else {
                setCardEmpty(card);
            }
        });

        // 更新刷新时间（手动刷新时）
        if (force) {
            const settings = await getRefreshSettings();
            settings.lastRefreshTime = Date.now();
            settings.openCountSinceRefresh = 0;
            await saveRefreshSettings(settings);
            console.log('[刷新] 已更新刷新时间');
        }

    } catch (error) {
        console.error('[书签推荐] 刷新卡片失败:', error);
        cards.forEach(card => {
            card.classList.add('empty');
            card.querySelector('.card-title').textContent =
                currentLang === 'en' ? 'Load failed' : '加载失败';
        });
    }
}

// 缓存当前追踪列表的会话 ID，用于判断是否需要完整刷新
let lastTrackingSessionIds = [];
// 记录展开状态的分组
let expandedTrackingGroups = new Set();

async function loadCurrentTrackingSessions() {
    const trackingCurrentList = document.getElementById('trackingCurrentList');
    const trackingCurrentCount = document.getElementById('trackingCurrentCount');
    if (!trackingCurrentList) return;

    try {
        const response = await browserAPI.runtime.sendMessage({
            action: 'getCurrentActiveSessions'
        });

        if (response && response.success && response.sessions) {
            let sessions = response.sessions;

            // 过滤掉被时间追踪屏蔽的会话
            const blockedSets = await getTrackingBlockedSets();
            const cache = await getTrackingBookmarkCache();
            const blockedFlags = await Promise.all(
                sessions.map(session => isTrackingItemBlocked(session, blockedSets, cache))
            );
            sessions = sessions.filter((_, index) => !blockedFlags[index]);

            // 更新计数
            if (trackingCurrentCount) {
                trackingCurrentCount.textContent = sessions.length;
            }

            if (sessions.length === 0) {
                lastTrackingSessionIds = [];
                trackingCurrentList.innerHTML = `
                    <tr class="tracking-empty-row">
                        <td colspan="5">${i18n.trackingNoActive[currentLang]}</td>
                    </tr>
                `;
                return;
            }

            // 按标题分组（标题相同视为同一书签）
            const groupedSessions = new Map();
            for (const session of sessions) {
                const key = session.title || session.url;
                if (!groupedSessions.has(key)) {
                    groupedSessions.set(key, []);
                }
                groupedSessions.get(key).push(session);
            }

            // 检查会话列表是否有变化（新增/删除会话）
            const currentIds = sessions.map(s => s.tabId).sort().join(',');
            const lastIds = lastTrackingSessionIds.sort().join(',');
            const needsFullRender = currentIds !== lastIds;

            // 截断标题函数
            const truncateTitle = (title, maxLen = 45) => {
                if (!title) return '';
                return title.length > maxLen ? title.substring(0, maxLen) + '...' : title;
            };

            if (needsFullRender) {
                // 会话列表有变化，需要完整渲染
                lastTrackingSessionIds = sessions.map(s => s.tabId);

                let html = '';
                for (const [groupKey, groupSessions] of groupedSessions) {
                    const isMultiple = groupSessions.length > 1;
                    const isExpanded = expandedTrackingGroups.has(groupKey);

                    // 使用第一个会话作为代表
                    const primarySession = groupSessions[0];

                    // 计算分组的汇总数据
                    const totalCompositeMs = groupSessions.reduce((sum, s) => sum + (s.compositeMs || s.activeMs || 0), 0);
                    const totalWakeCount = groupSessions.reduce((sum, s) => sum + (s.wakeCount || 0), 0);
                    const avgActiveRatio = groupSessions.reduce((sum, s) => sum + (s.activeRatio || 0), 0) / groupSessions.length;

                    // 确定显示的状态（优先显示最活跃的状态）
                    const stateOrder = ['active', 'visible', 'paused', 'background', 'sleeping'];
                    const bestState = groupSessions.reduce((best, s) => {
                        const bestIdx = stateOrder.indexOf(best);
                        const currIdx = stateOrder.indexOf(s.state);
                        return currIdx < bestIdx ? s.state : best;
                    }, 'sleeping');

                    const stateIcon = bestState === 'active' ? '🟢' :
                        (bestState === 'sleeping' ? '💤' :
                            (bestState === 'background' ? '⚪' :
                                (bestState === 'visible' ? '🔵' : '🟡')));

                    const compositeTime = formatActiveTime(totalCompositeMs);
                    const activeRatio = Math.round(avgActiveRatio * 100);
                    const displayTitle = truncateTitle(primarySession.title || primarySession.url);
                    const faviconUrl = getFaviconUrl(primarySession.url);

                    // 判断是否有任一会话处于挂机状态
                    const hasIdle = groupSessions.some(s => s.isIdle);
                    // 活跃率颜色：挂机=橙色，否则按梯度绿色
                    const ratioColorClass = hasIdle ? 'ratio-idle' : `ratio-level-${Math.min(Math.floor(activeRatio / 20), 5)}`;
                    // 唤醒次数高亮（≥15次用橙色）
                    const wakesHighlight = totalWakeCount >= 15 ? 'wakes-highlight' : '';
                    // 综合时间梯度蓝色
                    const timeGradientClass = `time-level-${getTimeGradientLevel(totalCompositeMs)}`;

                    // 主行（分组头）
                    const groupBadge = isMultiple ?
                        `<span class="tracking-group-badge" data-group-key="${escapeHtml(groupKey)}">${groupSessions.length}</span>` : '';
                    const expandIcon = isMultiple ?
                        `<span class="tracking-expand-icon ${isExpanded ? 'expanded' : ''}" data-group-key="${escapeHtml(groupKey)}">▶</span>` : '';

                    html += `
                        <tr class="tracking-group-header ${isMultiple ? 'has-children' : ''}" 
                            data-tab-id="${primarySession.tabId}" 
                            data-bookmark-url="${escapeHtml(primarySession.url)}"
                            data-group-key="${escapeHtml(groupKey)}">
                            <td><span class="tracking-state">${stateIcon}</span></td>
                            <td>
                                <div class="tracking-title-cell">
                                    ${expandIcon}
                                    <img class="tracking-favicon" src="${faviconUrl}" alt="">
                                    <span class="tracking-title" title="${escapeHtml(primarySession.title || primarySession.url)}">${escapeHtml(displayTitle)}</span>
                                    ${groupBadge}
                                </div>
                            </td>
                            <td><span class="tracking-time ${timeGradientClass}">${compositeTime}</span></td>
                            <td><span class="tracking-wakes ${wakesHighlight}">${totalWakeCount}${currentLang === 'en' ? 'x' : '次'}</span></td>
                            <td>
                                <div class="tracking-ratio-cell">
                                    <span class="tracking-ratio ${ratioColorClass}">${activeRatio}%</span>
                                </div>
                            </td>
                        </tr>
                    `;

                    // 展开的子行（仅当有多个且展开时显示）
                    if (isMultiple && isExpanded) {
                        for (const session of groupSessions) {
                            const subStateIcon = session.state === 'active' ? '🟢' :
                                (session.state === 'sleeping' ? '💤' :
                                    (session.state === 'background' ? '⚪' :
                                        (session.state === 'visible' ? '🔵' : '🟡')));
                            const subCompositeTime = formatActiveTime(session.compositeMs || session.activeMs);
                            const subActiveRatio = Math.round(session.activeRatio * 100);
                            // 活跃率颜色：挂机=橙色，否则按梯度绿色
                            const subRatioColorClass = session.isIdle ? 'ratio-idle' : `ratio-level-${Math.min(Math.floor(subActiveRatio / 20), 5)}`;
                            // 唤醒次数高亮（≥15次用橙色）
                            const subWakesHighlight = (session.wakeCount || 0) >= 15 ? 'wakes-highlight' : '';
                            // 综合时间梯度蓝色
                            const subTimeGradientClass = `time-level-${getTimeGradientLevel(session.compositeMs || session.activeMs)}`;

                            // 计算会话开始时间
                            const startTimestamp = Date.now() - (session.totalMs || 0);
                            const startDate = new Date(startTimestamp);
                            const month = startDate.getMonth() + 1;
                            const day = startDate.getDate();
                            const timeStr = startDate.toLocaleTimeString(currentLang === 'en' ? 'en-US' : 'zh-CN', {
                                hour: '2-digit',
                                minute: '2-digit'
                            });
                            const dateTimeStr = currentLang === 'en'
                                ? `${month}/${day} ${timeStr}`
                                : `${month}月${day}日 ${timeStr}`;
                            const startLabel = currentLang === 'en' ? `Started ${dateTimeStr}` : `开始于 ${dateTimeStr}`;

                            html += `
                                <tr class="tracking-group-child" 
                                    data-tab-id="${session.tabId}" 
                                    data-bookmark-url="${escapeHtml(session.url)}"
                                    data-group-key="${escapeHtml(groupKey)}">
                                    <td><span class="tracking-state">${subStateIcon}</span></td>
                                    <td>
                                        <div class="tracking-title-cell tracking-child-title">
                                            <span class="tracking-window-label">${startLabel}</span>
                                        </div>
                                    </td>
                                    <td><span class="tracking-time ${subTimeGradientClass}">${subCompositeTime}</span></td>
                                    <td><span class="tracking-wakes ${subWakesHighlight}">${session.wakeCount || 0}${currentLang === 'en' ? 'x' : '次'}</span></td>
                                    <td>
                                        <div class="tracking-ratio-cell">
                                            <span class="tracking-ratio ${subRatioColorClass}">${subActiveRatio}%</span>
                                        </div>
                                    </td>
                                </tr>
                            `;
                        }
                    }
                }

                trackingCurrentList.innerHTML = html;

                // 点击展开/折叠分组
                trackingCurrentList.querySelectorAll('.tracking-group-header.has-children').forEach(row => {
                    row.addEventListener('click', (e) => {
                        const groupKey = row.dataset.groupKey;
                        // 如果点击的是展开图标或徽章，切换展开状态
                        if (e.target.classList.contains('tracking-expand-icon') ||
                            e.target.classList.contains('tracking-group-badge') ||
                            e.target.classList.contains('tracking-title-cell')) {
                            if (expandedTrackingGroups.has(groupKey)) {
                                expandedTrackingGroups.delete(groupKey);
                            } else {
                                expandedTrackingGroups.add(groupKey);
                            }
                            // 重新渲染
                            lastTrackingSessionIds = []; // 强制完整刷新
                            loadCurrentTrackingSessions();
                        } else {
                            // 点击其他区域，切换到对应标签页
                            const tabId = parseInt(row.dataset.tabId);
                            if (tabId) {
                                browserAPI.tabs.update(tabId, { active: true });
                            }
                        }
                    });
                });

                // 点击子行切换到对应标签页
                trackingCurrentList.querySelectorAll('.tracking-group-child').forEach(row => {
                    row.addEventListener('click', () => {
                        const tabId = parseInt(row.dataset.tabId);
                        if (tabId) {
                            browserAPI.tabs.update(tabId, { active: true });
                        }
                    });
                });

                // 单个会话的行也可以点击切换
                trackingCurrentList.querySelectorAll('.tracking-group-header:not(.has-children)').forEach(row => {
                    row.addEventListener('click', () => {
                        const tabId = parseInt(row.dataset.tabId);
                        if (tabId) {
                            browserAPI.tabs.update(tabId, { active: true });
                        }
                    });
                });
            } else {
                // 会话列表没变，只更新时间、状态等动态数据
                for (const [groupKey, groupSessions] of groupedSessions) {
                    const row = trackingCurrentList.querySelector(`tr.tracking-group-header[data-group-key="${CSS.escape(groupKey)}"]`);
                    if (row) {
                        const isMultiple = groupSessions.length > 1;

                        // 计算分组的汇总数据
                        const totalCompositeMs = groupSessions.reduce((sum, s) => sum + (s.compositeMs || s.activeMs || 0), 0);
                        const totalWakeCount = groupSessions.reduce((sum, s) => sum + (s.wakeCount || 0), 0);
                        const avgActiveRatio = groupSessions.reduce((sum, s) => sum + (s.activeRatio || 0), 0) / groupSessions.length;

                        // 确定显示的状态
                        const stateOrder = ['active', 'visible', 'paused', 'background', 'sleeping'];
                        const bestState = groupSessions.reduce((best, s) => {
                            const bestIdx = stateOrder.indexOf(best);
                            const currIdx = stateOrder.indexOf(s.state);
                            return currIdx < bestIdx ? s.state : best;
                        }, 'sleeping');

                        const stateIcon = bestState === 'active' ? '🟢' :
                            (bestState === 'sleeping' ? '💤' :
                                (bestState === 'background' ? '⚪' :
                                    (bestState === 'visible' ? '🔵' : '🟡')));

                        const compositeTime = formatActiveTime(totalCompositeMs);
                        const activeRatio = Math.round(avgActiveRatio * 100);

                        // 更新主行
                        const stateEl = row.querySelector('.tracking-state');
                        if (stateEl) stateEl.textContent = stateIcon;

                        const timeEl = row.querySelector('.tracking-time');
                        if (timeEl) timeEl.textContent = compositeTime;

                        const wakesEl = row.querySelector('.tracking-wakes');
                        if (wakesEl) wakesEl.textContent = `${totalWakeCount}${currentLang === 'en' ? 'x' : '次'}`;

                        const ratioEl = row.querySelector('.tracking-ratio');
                        if (ratioEl) ratioEl.textContent = `${activeRatio}%`;
                    }

                    // 更新子行
                    if (expandedTrackingGroups.has(groupKey)) {
                        for (const session of groupSessions) {
                            const childRow = trackingCurrentList.querySelector(`tr.tracking-group-child[data-tab-id="${session.tabId}"]`);
                            if (childRow) {
                                const subStateIcon = session.state === 'active' ? '🟢' :
                                    (session.state === 'sleeping' ? '💤' :
                                        (session.state === 'background' ? '⚪' :
                                            (session.state === 'visible' ? '🔵' : '🟡')));
                                const subCompositeTime = formatActiveTime(session.compositeMs || session.activeMs);
                                const subActiveRatio = Math.round(session.activeRatio * 100);

                                const stateEl = childRow.querySelector('.tracking-state');
                                if (stateEl) stateEl.textContent = subStateIcon;

                                const timeEl = childRow.querySelector('.tracking-time');
                                if (timeEl) timeEl.textContent = subCompositeTime;

                                const wakesEl = childRow.querySelector('.tracking-wakes');
                                if (wakesEl) wakesEl.textContent = `${session.wakeCount || 0}${currentLang === 'en' ? 'x' : '次'}`;

                                const ratioEl = childRow.querySelector('.tracking-ratio');
                                if (ratioEl) ratioEl.textContent = `${subActiveRatio}%`;
                            }
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.warn('[书签推荐] 加载追踪会话失败:', error);
    }
}

// HTML 转义函数
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// 使用全局tooltip元素，附加到body，避免层级问题
let globalTooltipElement = null;
let tooltipHideTimer = null;

function initFastTooltips() {
    // 创建全局tooltip元素（如果不存在）
    if (!globalTooltipElement) {
        globalTooltipElement = document.createElement('div');
        globalTooltipElement.className = 'global-tooltip';
        document.body.appendChild(globalTooltipElement);
    }

    const buttons = document.querySelectorAll('.diff-header .diff-edit-btn.icon-only[title]');

    buttons.forEach(btn => {
        // 保存原始title并移除（防止浏览器原生tooltip）
        const tooltipText = btn.getAttribute('title');
        btn.dataset.tooltipText = tooltipText;
        btn.removeAttribute('title');

        btn.addEventListener('mouseenter', (e) => {
            if (tooltipHideTimer) {
                clearTimeout(tooltipHideTimer);
                tooltipHideTimer = null;
            }

            const text = btn.dataset.tooltipText;
            if (!text) return;

            globalTooltipElement.textContent = text;

            // 计算位置（按钮上方居中）
            const rect = btn.getBoundingClientRect();
            const tooltipRect = globalTooltipElement.getBoundingClientRect();

            let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
            let top = rect.top - 8 - globalTooltipElement.offsetHeight;

            // 确保不超出视口
            if (left < 8) left = 8;
            if (left + tooltipRect.width > window.innerWidth - 8) {
                left = window.innerWidth - tooltipRect.width - 8;
            }
            if (top < 8) {
                // 如果上方空间不足，显示在下方
                top = rect.bottom + 8;
            }

            globalTooltipElement.style.left = left + 'px';
            globalTooltipElement.style.top = top + 'px';
            globalTooltipElement.classList.add('visible');
        });

        btn.addEventListener('mouseleave', () => {
            tooltipHideTimer = setTimeout(() => {
                globalTooltipElement.classList.remove('visible');
            }, 100);
        });

        // 当按钮title动态更新时，同步更新dataset
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'title') {
                    const newTitle = btn.getAttribute('title');
                    if (newTitle) {
                        btn.dataset.tooltipText = newTitle;
                        btn.removeAttribute('title');
                    }
                }
            });
        });
        observer.observe(btn, { attributes: true });
    });
}

// =============================================================================
// 复习热力图 (GitHub 风格，当前月份在左)
// =============================================================================

async function loadHeatmapData() {
    const container = document.getElementById('heatmapContainer');
    if (!container) return;

    try {
        // 从 storage 获取翻牌历史记录
        const result = await new Promise(resolve => {
            browserAPI.storage.local.get(['flipHistory'], resolve);
        });
        const flipHistory = result.flipHistory || [];

        // 按日期统计翻牌次数
        const dailyCounts = new Map();
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 辅助函数：获取本地日期字符串 (YYYY-MM-DD)
        const getLocalDateKey = (d) => {
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        // 初始化最近 52 周 + 本周的天数
        const daysToShow = 52 * 7 + today.getDay();
        for (let i = daysToShow - 1; i >= 0; i--) {
            const date = new Date(today);
            date.setDate(date.getDate() - i);
            const key = getLocalDateKey(date);
            dailyCounts.set(key, 0);
        }

        // 统计每天的翻牌次数
        for (const flip of flipHistory) {
            if (!flip.timestamp) continue;
            const date = new Date(flip.timestamp);
            const key = getLocalDateKey(date);
            if (dailyCounts.has(key)) {
                dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
            }
        }

        // 渲染热力图（反转顺序，当前月份在左）
        renderHeatmap(container, dailyCounts);

    } catch (error) {
        console.error('[热力图] 加载失败:', error);
        container.innerHTML = `<div class="empty-state"><div class="empty-state-title">${currentLang === 'en' ? 'Failed to load heatmap' : '热力图加载失败'
            }</div></div>`;
    }
}

function renderHeatmap(container, dailyCounts) {
    const isEn = currentLang === 'en';
    const dayNames = isEn ? ['', 'Mon', '', 'Wed', '', 'Fri', ''] :
        ['', '一', '', '三', '', '五', ''];
    const monthNames = isEn ?
        ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] :
        ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];

    // 找出最大值用于计算颜色深度
    const counts = Array.from(dailyCounts.values());
    const maxCount = Math.max(...counts, 1);
    const totalReviews = counts.reduce((a, b) => a + b, 0);

    // 计算今天的复习次数
    const todayKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
    const todayReviews = dailyCounts.get(todayKey) || 0;

    // 按月分组数据
    const monthsData = new Map(); // year-month -> { year, month, days: [], totalCount }
    const entries = Array.from(dailyCounts.entries()).sort();

    for (const [dateStr, count] of entries) {
        const [year, month, day] = dateStr.split('-').map(Number);
        const date = new Date(year, month - 1, day);
        const dayOfWeek = date.getDay();
        const monthKey = `${year}-${month}`;

        if (!monthsData.has(monthKey)) {
            monthsData.set(monthKey, { year, month, days: [], totalCount: 0 });
        }

        monthsData.get(monthKey).days.push({ date: dateStr, count, dayOfWeek, day });
        monthsData.get(monthKey).totalCount += count;
    }

    // 构建显示顺序：当前月 + 今年12个月(1-12正序)
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const monthsArray = [];

    // 第一个：当前月份
    const currentMonthKey = `${currentYear}-${currentMonth}`;
    const currentMonthData = monthsData.get(currentMonthKey) || { year: currentYear, month: currentMonth, days: [], totalCount: 0 };
    monthsArray.push(currentMonthData);

    // 后面12个：今年1月、2月、3月...12月（正序）
    for (let m = 1; m <= 12; m++) {
        const key = `${currentYear}-${m}`;
        const data = monthsData.get(key) || { year: currentYear, month: m, days: [], totalCount: 0 };
        monthsArray.push(data);
    }

    console.log('[热力图] 月份顺序:', monthsArray.map(m => m.month).join(', '));

    // 生成 HTML
    let html = `<div class="heatmap-year-view">`;
    html += `<div class="heatmap-scroll-container">`;
    html += `<div class="heatmap-months-row">`;

    for (let idx = 0; idx < monthsArray.length; idx++) {
        const monthData = monthsArray[idx];
        const { year, month, days, totalCount } = monthData;
        const monthLabel = monthNames[month - 1];

        // idx=1 时在当前月份后添加分隔线，后面每3个月添加分隔线
        if (idx === 1) {
            // 当前月份与12个月之间的分隔线
            html += `<div class="heatmap-quarter-divider current-divider"></div>`;
        } else if (idx > 1 && (idx - 1) % 3 === 0) {
            // 12个月内部的季度分隔线（4月、7月、10月前）
            html += `<div class="heatmap-quarter-divider"></div>`;
        }

        // 获取一周开始日(中文:周一=1, 英文:周日=0)，与书签添加记录日历保持一致
        const weekStartDay = (typeof currentLang !== 'undefined' && currentLang === 'zh_CN') ? 1 : 0;

        // 获取这个月第一天是星期几
        const firstDay = new Date(year, month - 1, 1);
        const firstDayOfWeek = firstDay.getDay();

        // 获取这个月的天数
        const daysInMonth = new Date(year, month, 0).getDate();
        const dayCountMap = new Map(days.map(d => [d.day, d]));

        // 构建日历网格（横向7列）
        const calendarDays = [];

        // 填充第一行前面的空白（根据周开始日调整）
        const blankCells = (firstDayOfWeek - weekStartDay + 7) % 7;
        for (let i = 0; i < blankCells; i++) {
            calendarDays.push({ empty: true });
        }

        // 填充每一天
        for (let d = 1; d <= daysInMonth; d++) {
            const dayData = dayCountMap.get(d);
            if (dayData) {
                calendarDays.push(dayData);
            } else {
                calendarDays.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, count: 0, day: d });
            }
        }

        // 填充最后一行的空白
        while (calendarDays.length % 7 !== 0) {
            calendarDays.push({ empty: true });
        }

        // 判断是否是当前月份
        const isCurrentMonth = year === currentYear && month === currentMonth;
        const currentClass = isCurrentMonth ? ' current-month' : '';

        html += `<div class="heatmap-month-block${currentClass}" data-year="${year}" data-month="${month}">`;
        html += `<div class="heatmap-month-header">${monthLabel}</div>`;
        html += `<div class="heatmap-calendar">`;

        // 当天日期字符串，用于判断是否高亮
        const todayStr = `${currentYear}-${String(currentMonth).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

        // 按行输出（每行7个）
        for (let i = 0; i < calendarDays.length; i += 7) {
            html += '<div class="heatmap-row">';
            for (let j = 0; j < 7; j++) {
                const day = calendarDays[i + j];
                if (!day || day.empty) {
                    html += '<div class="heatmap-cell empty"></div>';
                } else {
                    // 固定阈值：0 / 1-15 / 16-50 / 51-150 / 151+
                    const level = day.count === 0 ? 0 :
                        day.count <= 15 ? 1 :
                            day.count <= 50 ? 2 :
                                day.count <= 150 ? 3 : 4;
                    // 判断是否是当天
                    const isToday = day.date === todayStr;
                    const todayClass = isToday ? ' today' : '';
                    if (day.count > 0) {
                        const [y, m, dd] = day.date.split('-').map(Number);
                        const tooltip = isEn ?
                            `${day.count} review${day.count !== 1 ? 's' : ''}, ${m}-${dd}` :
                            `${day.count}次, ${m}-${dd}`;
                        html += `<div class="heatmap-cell level-${level}${todayClass}" data-date="${day.date}" data-tooltip="${tooltip}"></div>`;
                    } else {
                        html += `<div class="heatmap-cell level-0${todayClass}" data-date="${day.date}"></div>`;
                    }
                }
            }
            html += '</div>';
        }

        html += `</div>`;
        html += `<div class="heatmap-month-count">${totalCount}</div>`;
        html += `</div>`;
    }

    html += `</div></div>`;

    // 底部统计和图例
    html += `
        <div class="heatmap-footer">
            <span class="heatmap-stats">${isEn ? 'Today' : '今天'} ${todayReviews} ${isEn ? 'reviews' : '次'}</span>
            <div class="heatmap-footer-right">
                <div class="heatmap-legend">
                    <span>${isEn ? 'Less' : '少'}</span>
                    <div class="heatmap-cell level-0"></div>
                    <div class="heatmap-cell level-1"></div>
                    <div class="heatmap-cell level-2"></div>
                    <div class="heatmap-cell level-3"></div>
                    <div class="heatmap-cell level-4"></div>
                    <span>${isEn ? 'More' : '多'}</span>
                </div>
                <button class="heatmap-help-btn" id="heatmapHelpBtn" title="${isEn ? 'Level description' : '等级说明'}">
                    <i class="fas fa-question-circle"></i>
                </button>
            </div>
        </div>
    </div>`;

    container.innerHTML = html;

    // 确保滚动条在最左边，显示当前月份
    const scrollContainer = container.querySelector('.heatmap-scroll-container');
    if (scrollContainer) {
        scrollContainer.scrollLeft = 0;
    }

    // 创建或获取全局tooltip元素
    let globalTooltip = document.getElementById('heatmapGlobalTooltip');
    if (!globalTooltip) {
        globalTooltip = document.createElement('div');
        globalTooltip.id = 'heatmapGlobalTooltip';
        globalTooltip.className = 'heatmap-global-tooltip';
        document.body.appendChild(globalTooltip);
    }

    // 绑定日期格子点击事件和tooltip事件
    container.querySelectorAll('.heatmap-cell[data-date]').forEach(cell => {
        cell.style.cursor = 'pointer';
        cell.addEventListener('click', (e) => {
            e.stopPropagation();
            // 点击时隐藏tooltip
            globalTooltip.classList.remove('visible');
            const date = cell.dataset.date;
            showHeatmapDateDetail(date);
        });

        // 鼠标进入时显示tooltip
        cell.addEventListener('mouseenter', (e) => {
            const tooltipText = cell.dataset.tooltip;
            if (!tooltipText) return;

            // 先设置内容并临时显示以获取正确尺寸
            globalTooltip.textContent = tooltipText;
            globalTooltip.style.visibility = 'hidden';
            globalTooltip.style.display = 'block';

            // 计算位置：在cell正上方居中
            const rect = cell.getBoundingClientRect();
            const tooltipRect = globalTooltip.getBoundingClientRect();
            let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
            let top = rect.top - tooltipRect.height - 8;

            // 防止超出左右边界
            if (left < 5) left = 5;
            if (left + tooltipRect.width > window.innerWidth - 5) {
                left = window.innerWidth - tooltipRect.width - 5;
            }

            // 如果上方空间不够，显示在下方
            if (top < 5) {
                top = rect.bottom + 8;
            }

            globalTooltip.style.left = left + 'px';
            globalTooltip.style.top = top + 'px';
            globalTooltip.style.visibility = '';
            globalTooltip.style.display = '';
            globalTooltip.classList.add('visible');
        });

        // 鼠标离开时隐藏tooltip
        cell.addEventListener('mouseleave', () => {
            globalTooltip.classList.remove('visible');
        });
    });

    // 绑定月份点击事件（进入月视图）
    container.querySelectorAll('.heatmap-month-block').forEach(block => {
        block.style.cursor = 'pointer';
        block.addEventListener('click', (e) => {
            // 如果点击的是日期格子，不触发月份点击
            if (e.target.closest('.heatmap-cell[data-date]')) return;
            const year = parseInt(block.dataset.year);
            const month = parseInt(block.dataset.month);
            showHeatmapMonthDetail(year, month);
        });
    });

    // 绑定帮助按钮点击事件
    const helpBtn = document.getElementById('heatmapHelpBtn');
    if (helpBtn) {
        helpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            showHeatmapLevelHelp(helpBtn);
        });
    }
}

// 显示热力图等级说明
function showHeatmapLevelHelp(anchorBtn) {
    const isEn = currentLang === 'en';

    // 如果已存在，先移除
    const existing = document.getElementById('heatmapLevelPopup');
    if (existing) {
        existing.remove();
        return;
    }

    const popup = document.createElement('div');
    popup.id = 'heatmapLevelPopup';
    popup.className = 'heatmap-level-popup';
    popup.innerHTML = `
        <div class="heatmap-level-title">${isEn ? 'Review Level' : '复习等级说明'}</div>
        <div class="heatmap-level-list">
            <div class="heatmap-level-row">
                <div class="heatmap-cell level-0"></div>
                <span>0 ${isEn ? 'reviews' : '次'}</span>
            </div>
            <div class="heatmap-level-row">
                <div class="heatmap-cell level-1"></div>
                <span>1-15 ${isEn ? 'reviews' : '次'}</span>
            </div>
            <div class="heatmap-level-row">
                <div class="heatmap-cell level-2"></div>
                <span>16-50 ${isEn ? 'reviews' : '次'}</span>
            </div>
            <div class="heatmap-level-row">
                <div class="heatmap-cell level-3"></div>
                <span>51-150 ${isEn ? 'reviews' : '次'}</span>
            </div>
            <div class="heatmap-level-row">
                <div class="heatmap-cell level-4"></div>
                <span>151+ ${isEn ? 'reviews' : '次'}</span>
            </div>
        </div>
    `;

    document.body.appendChild(popup);

    // 定位到按钮上方
    const rect = anchorBtn.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    popup.style.right = (window.innerWidth - rect.right) + 'px';

    // 点击其他地方关闭
    const closeHandler = (e) => {
        if (!popup.contains(e.target) && e.target !== anchorBtn) {
            popup.remove();
            document.removeEventListener('click', closeHandler);
        }
    };
    setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

// 显示热力图日期详情（二级UI）
async function showHeatmapDateDetail(dateStr) {
    const isEn = currentLang === 'en';
    const container = document.getElementById('heatmapContainer');
    if (!container) return;

    // 获取翻牌历史
    const result = await new Promise(resolve => {
        browserAPI.storage.local.get(['flipHistory'], resolve);
    });
    const flipHistory = result.flipHistory || [];

    // 筛选当天的记录
    const dayRecords = flipHistory.filter(flip => {
        if (!flip.timestamp) return false;
        const date = new Date(flip.timestamp);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}` === dateStr;
    });

    // 获取书签信息
    const bookmarkMap = new Map();
    try {
        const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
        const flatten = (nodes) => {
            for (const node of nodes) {
                if (node.url) bookmarkMap.set(node.id, node);
                if (node.children) flatten(node.children);
            }
        };
        flatten(tree);
    } catch (e) {
        console.warn('[热力图] 获取书签失败:', e);
    }

    // 格式化日期
    const [year, month, day] = dateStr.split('-').map(Number);
    const dateLabel = isEn ? `${month}/${day}/${year}` : `${year}年${month}月${day}日`;

    // 生成详情HTML
    let html = `
        <div class="heatmap-detail-view">
            <div class="heatmap-detail-header">
                <button class="heatmap-back-btn" id="heatmapBackBtn">
                    <i class="fas fa-arrow-left"></i>
                    <span>${isEn ? 'Back' : '返回'}</span>
                </button>
                <span class="heatmap-detail-title">${dateLabel}</span>
                <span class="heatmap-detail-count">${dayRecords.length} ${isEn ? 'reviews' : '次复习'}</span>
            </div>
            <div class="heatmap-detail-list">
    `;

    if (dayRecords.length === 0) {
        html += `<div class="heatmap-detail-empty">${isEn ? 'No reviews on this day' : '当天没有复习记录'}</div>`;
    } else {
        // 按时间倒序排列
        dayRecords.sort((a, b) => b.timestamp - a.timestamp);

        for (const record of dayRecords) {
            const bookmark = bookmarkMap.get(record.bookmarkId);
            const time = new Date(record.timestamp);
            const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;

            if (bookmark) {
                html += `
                    <div class="heatmap-detail-item" data-url="${escapeHtml(bookmark.url)}">
                        <img class="heatmap-detail-favicon" src="${getFaviconUrl(bookmark.url)}">
                        <div class="heatmap-detail-info">
                            <div class="heatmap-detail-item-title">${escapeHtml(bookmark.title || bookmark.url)}</div>
                            <div class="heatmap-detail-item-url">${escapeHtml(bookmark.url)}</div>
                        </div>
                        <span class="heatmap-detail-time">${timeStr}</span>
                    </div>
                `;
            } else {
                html += `
                    <div class="heatmap-detail-item deleted">
                        <i class="fas fa-bookmark heatmap-detail-favicon-icon"></i>
                        <div class="heatmap-detail-info">
                            <div class="heatmap-detail-item-title">${isEn ? 'Bookmark deleted' : '书签已删除'}</div>
                            <div class="heatmap-detail-item-url">ID: ${record.bookmarkId}</div>
                        </div>
                        <span class="heatmap-detail-time">${timeStr}</span>
                    </div>
                `;
            }
        }
    }

    html += `</div></div>`;

    container.innerHTML = html;

    // 绑定返回按钮
    document.getElementById('heatmapBackBtn').addEventListener('click', () => {
        loadHeatmapData();
    });

    // 绑定书签点击事件
    container.querySelectorAll('.heatmap-detail-item[data-url]').forEach(item => {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
            const url = item.dataset.url;
            if (url) window.open(url, '_blank');
        });
    });
}

// 显示热力图月份详情（书签复习排行）
async function showHeatmapMonthDetail(year, month) {
    const isEn = currentLang === 'en';
    const container = document.getElementById('heatmapContainer');
    if (!container) return;

    // 获取翻牌历史
    const result = await new Promise(resolve => {
        browserAPI.storage.local.get(['flipHistory'], resolve);
    });
    const flipHistory = result.flipHistory || [];

    // 筛选当月的记录，按书签ID统计次数
    const bookmarkCountMap = new Map(); // bookmarkId -> { count, lastTime }
    for (const flip of flipHistory) {
        if (!flip.timestamp || !flip.bookmarkId) continue;
        const date = new Date(flip.timestamp);
        if (date.getFullYear() === year && date.getMonth() + 1 === month) {
            if (!bookmarkCountMap.has(flip.bookmarkId)) {
                bookmarkCountMap.set(flip.bookmarkId, { count: 0, lastTime: 0 });
            }
            const stat = bookmarkCountMap.get(flip.bookmarkId);
            stat.count++;
            if (flip.timestamp > stat.lastTime) stat.lastTime = flip.timestamp;
        }
    }

    // 获取书签信息
    const bookmarkMap = new Map();
    try {
        const tree = await new Promise(resolve => browserAPI.bookmarks.getTree(resolve));
        const flatten = (nodes) => {
            for (const node of nodes) {
                if (node.url) bookmarkMap.set(node.id, node);
                if (node.children) flatten(node.children);
            }
        };
        flatten(tree);
    } catch (e) {
        console.warn('[热力图] 获取书签失败:', e);
    }

    const monthNames = isEn ?
        ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] :
        ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
    const monthLabel = isEn ? `${monthNames[month - 1]} ${year}` : `${year}年${monthNames[month - 1]}`;

    const totalCount = Array.from(bookmarkCountMap.values()).reduce((sum, s) => sum + s.count, 0);

    // 按复习次数排序
    const sortedBookmarks = Array.from(bookmarkCountMap.entries())
        .sort((a, b) => b[1].count - a[1].count);

    // 生成详情HTML
    let html = `
        <div class="heatmap-detail-view">
            <div class="heatmap-detail-header">
                <button class="heatmap-back-btn" id="heatmapBackBtn">
                    <i class="fas fa-arrow-left"></i>
                    <span>${isEn ? 'Back' : '返回'}</span>
                </button>
                <span class="heatmap-detail-title">${monthLabel} ${isEn ? 'Ranking' : '复习排行'}</span>
                <span class="heatmap-detail-count">${totalCount} ${isEn ? 'reviews' : '次复习'}</span>
            </div>
            <div class="heatmap-detail-list">
    `;

    if (sortedBookmarks.length === 0) {
        html += `<div class="heatmap-detail-empty">${isEn ? 'No reviews this month' : '当月没有复习记录'}</div>`;
    } else {
        let rank = 0;
        for (const [bookmarkId, stat] of sortedBookmarks) {
            rank++;
            const bookmark = bookmarkMap.get(bookmarkId);

            if (bookmark) {
                html += `
                    <div class="heatmap-detail-item heatmap-ranking-item" data-url="${escapeHtml(bookmark.url)}">
                        <span class="heatmap-rank ${rank <= 3 ? 'top-' + rank : ''}">${rank}</span>
                        <img class="heatmap-detail-favicon" src="${getFaviconUrl(bookmark.url)}">
                        <div class="heatmap-detail-info">
                            <div class="heatmap-detail-item-title">${escapeHtml(bookmark.title || bookmark.url)}</div>
                            <div class="heatmap-detail-item-url">${escapeHtml(bookmark.url)}</div>
                        </div>
                        <span class="heatmap-review-count">${stat.count} ${isEn ? 'times' : '次'}</span>
                    </div>
                `;
            } else {
                html += `
                    <div class="heatmap-detail-item heatmap-ranking-item deleted">
                        <span class="heatmap-rank">${rank}</span>
                        <i class="fas fa-bookmark heatmap-detail-favicon-icon"></i>
                        <div class="heatmap-detail-info">
                            <div class="heatmap-detail-item-title">${isEn ? 'Bookmark deleted' : '书签已删除'}</div>
                            <div class="heatmap-detail-item-url">ID: ${bookmarkId}</div>
                        </div>
                        <span class="heatmap-review-count">${stat.count} ${isEn ? 'times' : '次'}</span>
                    </div>
                `;
            }
        }
    }

    html += `</div></div>`;

    container.innerHTML = html;

    // 绑定返回按钮
    document.getElementById('heatmapBackBtn').addEventListener('click', () => {
        loadHeatmapData();
    });

    // 绑定书签点击事件
    container.querySelectorAll('.heatmap-detail-item[data-url]').forEach(item => {
        item.style.cursor = 'pointer';
        item.addEventListener('click', () => {
            const url = item.dataset.url;
            if (url) window.open(url, '_blank');
        });
    });
}

// =============================================================================
// 清除记录菜单
// =============================================================================

function showTrackingClearMenu(anchorEl) {
    // 移除已有菜单
    const existingMenu = document.getElementById('trackingClearMenu');
    if (existingMenu) existingMenu.remove();

    const isEn = currentLang === 'en';
    const rangeLabels = i18n.trackingClearRange[currentLang];

    const menu = document.createElement('div');
    menu.id = 'trackingClearMenu';
    menu.className = 'tracking-clear-menu';
    menu.innerHTML = `
        <div class="tracking-clear-menu-title">${isEn ? 'Clear Current Sessions' : '清除正在追踪'}</div>
        <div class="tracking-clear-menu-item" data-action="current">${isEn ? 'Clear all current sessions' : '清除全部当前会话'}</div>
        <div class="tracking-clear-menu-divider"></div>
        <div class="tracking-clear-menu-title">${isEn ? 'Clear Ranking Data' : '清除综合排行'}</div>
        <div class="tracking-clear-menu-item" data-action="ranking" data-range="week">${isEn ? 'Older than 1 week' : '一周以前'}</div>
        <div class="tracking-clear-menu-item" data-action="ranking" data-range="month">${isEn ? 'Older than 1 month' : '一个月以前'}</div>
        <div class="tracking-clear-menu-item" data-action="ranking" data-range="year">${isEn ? 'Older than 1 year' : '一年以前'}</div>
        <div class="tracking-clear-menu-item danger" data-action="ranking" data-range="all">${isEn ? 'Clear all' : '清除全部'}</div>
    `;

    // 定位菜单
    const rect = anchorEl.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;

    document.body.appendChild(menu);

    // 点击菜单项
    menu.querySelectorAll('.tracking-clear-menu-item').forEach(item => {
        item.addEventListener('click', async () => {
            const action = item.dataset.action;
            const range = item.dataset.range;

            if (action === 'current') {
                if (!confirm(i18n.trackingClearCurrentConfirm[currentLang])) {
                    menu.remove();
                    return;
                }
                try {
                    await browserAPI.runtime.sendMessage({ action: 'clearCurrentTrackingSessions' });
                    await loadCurrentTrackingSessions();
                    console.log('[时间捕捉] 正在追踪的会话已清除');
                } catch (e) {
                    console.error('[时间捕捉] 清除失败:', e);
                }
            } else if (action === 'ranking') {
                const rangeLabel = rangeLabels[range];
                const confirmMsg = i18n.trackingClearRangeConfirm[currentLang].replace('{range}', rangeLabel);
                if (!confirm(confirmMsg)) {
                    menu.remove();
                    return;
                }
                try {
                    const response = await browserAPI.runtime.sendMessage({
                        action: 'clearTrackingStatsByRange',
                        range: range
                    });
                    if (response && response.success) {
                        const msg = i18n.trackingClearedCount[currentLang].replace('{count}', response.cleared);
                        console.log('[时间捕捉]', msg);
                        await loadActiveTimeRanking();
                    }
                } catch (e) {
                    console.error('[时间捕捉] 清除失败:', e);
                }
            }
            menu.remove();
        });
    });

    // 点击外部关闭
    const closeMenu = (e) => {
        if (!menu.contains(e.target) && e.target !== anchorEl) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// =============================================================================
// 综合排行
// =============================================================================

async function loadActiveTimeRanking() {
    const container = document.getElementById('trackingRankingList');
    if (!container) return;

    // 排行榜刷新时，清除T值缓存，下次计算S值时会获取最新数据
    clearTrackingRankingCache();

    try {
        // 获取排行类型（综合时间 / 唤醒次数）
        const rankingTypeSelect = document.getElementById('trackingRankingType');
        const rankingType = rankingTypeSelect ? rankingTypeSelect.value : 'composite';

        // 获取时间范围
        const rangeSelect = document.getElementById('trackingRankingRange');
        const range = rangeSelect ? rangeSelect.value : 'week';

        // 并行获取：已保存的统计 + 当前正在追踪的会话
        const [statsResponse, sessionsResponse] = await Promise.all([
            browserAPI.runtime.sendMessage({ action: 'getTrackingStats' }),
            browserAPI.runtime.sendMessage({ action: 'getCurrentActiveSessions' })
        ]);

        // 合并数据：已保存的 + 当前正在追踪的
        const titleStats = new Map();

        // 1. 先加载已保存的统计
        if (statsResponse?.success && statsResponse.stats) {
            for (const stat of Object.values(statsResponse.stats)) {
                const key = stat.title || stat.url;
                titleStats.set(key, {
                    url: stat.url,
                    title: stat.title || stat.url,
                    totalCompositeMs: stat.totalCompositeMs || 0,
                    wakeCount: stat.totalWakeCount || 0,
                    sessionCount: stat.sessionCount || 0,
                    lastUpdate: stat.lastUpdate
                });
            }
        }

        // 2. 再加上当前正在追踪的会话（只加尚未保存的部分，避免与 trackingStats 重复）
        if (sessionsResponse?.success && sessionsResponse.sessions) {
            // 按标题分组，计算每组尚未保存的总和
            const groupedByTitle = new Map();
            for (const session of sessionsResponse.sessions) {
                const key = session.title || session.url;
                if (!groupedByTitle.has(key)) {
                    groupedByTitle.set(key, {
                        url: session.url,
                        title: session.title || session.url,
                        unsavedCompositeMs: 0,
                        unsavedWakeCount: 0
                    });
                }
                const group = groupedByTitle.get(key);
                // 使用 unsavedCompositeMs（尚未保存的时间），避免重复
                group.unsavedCompositeMs += session.unsavedCompositeMs || 0;
                group.unsavedWakeCount += session.unsavedWakeCount || 0;
            }

            // 合并到排行榜
            for (const [key, group] of groupedByTitle) {
                if (titleStats.has(key)) {
                    const existing = titleStats.get(key);
                    existing.totalCompositeMs += group.unsavedCompositeMs;
                    existing.wakeCount += group.unsavedWakeCount;
                } else {
                    titleStats.set(key, {
                        url: group.url,
                        title: group.title,
                        totalCompositeMs: group.unsavedCompositeMs,
                        wakeCount: group.unsavedWakeCount,
                        sessionCount: 1,
                        lastUpdate: Date.now()
                    });
                }
            }
        }

        if (titleStats.size === 0) {
            container.innerHTML = `<div class="tracking-empty">${i18n.trackingNoData[currentLang]}</div>`;
            return;
        }

        // 过滤掉被时间追踪屏蔽的项目
        const blockedSets = await getTrackingBlockedSets();
        const cache = await getTrackingBookmarkCache();
        const items = Array.from(titleStats.values());
        const blockedFlags = await Promise.all(
            items.map(item => isTrackingItemBlocked(item, blockedSets, cache))
        );

        // 根据排行类型排序，并过滤掉被屏蔽的项目
        const sorted = items
            .filter((_, index) => !blockedFlags[index])
            .sort((a, b) => {
                if (rankingType === 'wakes') {
                    return b.wakeCount - a.wakeCount;
                }
                return b.totalCompositeMs - a.totalCompositeMs;
            })
            .slice(0, 10);

        // Expose to global for Search (Phase 4)
        window.activeTimeRankingStats = { items: sorted };

        if (sorted.length === 0) {
            container.innerHTML = `<div class="tracking-empty">${i18n.trackingNoData[currentLang]}</div>`;
            return;
        }

        // 计算最大值用于进度条（根据排行类型）
        const maxValue = rankingType === 'wakes'
            ? sorted[0].wakeCount
            : sorted[0].totalCompositeMs;

        // 截断标题函数
        const truncateTitle = (title, maxLen = 45) => {
            if (!title) return '';
            return title.length > maxLen ? title.substring(0, maxLen) + '...' : title;
        };

        // 唤醒次数高频阈值（根据时间范围）
        const wakeThresholds = {
            'today': 15,
            'week': 50,
            'month': 100,
            'year': 500,
            'all': 1000
        };
        const wakeThreshold = wakeThresholds[range] || 15;

        // 渲染列表
        container.innerHTML = sorted.map((item, index) => {
            const compositeTime = formatActiveTime(item.totalCompositeMs);
            // 根据排行类型计算进度条宽度
            const barWidth = maxValue > 0
                ? ((rankingType === 'wakes' ? item.wakeCount : item.totalCompositeMs) / maxValue * 100)
                : 0;
            const displayTitle = truncateTitle(item.title || item.url);
            const faviconUrl = getFaviconUrl(item.url);

            // 高亮逻辑：根据排行类型选择主要指标的高亮
            let wakeHighlight = '';
            let timeHighlight = '';
            if (rankingType === 'wakes') {
                // 唤醒次数排行：唤醒次数用强调色（primary），时间正常显示
                wakeHighlight = 'ranking-primary';
                timeHighlight = `time-level-${getTimeGradientLevel(item.totalCompositeMs, range)}`;
            } else {
                // 综合时间排行：高频唤醒用橙色，时间用梯度蓝色
                wakeHighlight = item.wakeCount >= wakeThreshold ? 'wakes-highlight' : '';
                timeHighlight = `time-level-${getTimeGradientLevel(item.totalCompositeMs, range)} ranking-primary`;
            }

            return `
                <div class="tracking-ranking-item" data-url="${escapeHtml(item.url)}" data-bookmark-url="${escapeHtml(item.url)}">
                    <span class="ranking-number">${index + 1}</span>
                    <img class="ranking-favicon" src="${faviconUrl}" alt="">
                    <div class="ranking-info">
                        <div class="ranking-title" title="${escapeHtml(item.title || item.url)}">${escapeHtml(displayTitle)}</div>
                        <div class="ranking-bar">
                            <div class="ranking-bar-fill" style="width: ${barWidth}%"></div>
                        </div>
                    </div>
                    <span class="ranking-wakes ${wakeHighlight}">${item.wakeCount}${currentLang === 'en' ? 'x' : '次'}</span>
                    <span class="ranking-time ${timeHighlight}">${compositeTime}</span>
                </div>
            `;
        }).join('');

        // 点击打开对应URL
        container.querySelectorAll('.tracking-ranking-item').forEach(item => {
            item.addEventListener('click', () => {
                const url = item.dataset.url;
                if (url) {
                    browserAPI.tabs.create({ url });
                }
            });
        });

        // Phase 4.7: 重新应用搜索高亮（列表刷新后保持筛选状态）
        if (isTrackingRankingSearchActive()) {
            highlightTrackingRankingMatches();
        }

    } catch (error) {
        console.error('[综合排行] 加载失败:', error);
        container.innerHTML = `<div class="tracking-empty">${i18n.trackingLoadFailed[currentLang]}</div>`;
    }
}

// 获取综合时间的梯度级别（用于蓝色深浅）
// range: 'today', 'week', 'month', 'year', 'all', 'current'（正在追踪）
// Level 0-4: 正常梯度蓝色，Level 5: 极端使用（深紫色）
function getTimeGradientLevel(ms, range = 'today') {
    const minutes = (ms || 0) / 60000;
    const hours = minutes / 60;

    // 根据时间范围使用不同的阈值
    if (range === 'week') {
        // 本周：30分钟、2小时、5小时、10小时、20小时（极端）
        if (minutes < 30) return 0;
        if (hours < 2) return 1;
        if (hours < 5) return 2;
        if (hours < 10) return 3;
        if (hours < 20) return 4;
        return 5;  // 极端：20小时+
    } else if (range === 'month') {
        // 本月：2小时、10小时、30小时、60小时、100小时（极端）
        if (hours < 2) return 0;
        if (hours < 10) return 1;
        if (hours < 30) return 2;
        if (hours < 60) return 3;
        if (hours < 100) return 4;
        return 5;  // 极端：100小时+
    } else if (range === 'year' || range === 'all') {
        // 本年/全部：10小时、50小时、150小时、300小时、500小时（极端）
        if (hours < 10) return 0;
        if (hours < 50) return 1;
        if (hours < 150) return 2;
        if (hours < 300) return 3;
        if (hours < 500) return 4;
        return 5;  // 极端：500小时+
    } else {
        // 今日/正在追踪（current）：1分钟、5分钟、15分钟、30分钟、2小时（极端）
        if (minutes < 1) return 0;
        if (minutes < 5) return 1;
        if (minutes < 15) return 2;
        if (minutes < 30) return 3;
        if (hours < 2) return 4;
        return 5;  // 极端：2小时+
    }
}

// =============================================================================
// 时间捕捉搜索筛选 (Phase 4.7)
// =============================================================================

// 时间捕捉搜索状态
let trackingRankingSearchQuery = '';
let trackingRankingSearchTokens = null;

/**
 * 检查时间捕捉搜索是否激活
 */
function isTrackingRankingSearchActive() {
    return Boolean(trackingRankingSearchTokens && trackingRankingSearchTokens.length > 0);
}

/**
 * 应用时间捕捉关键词筛选
 */
function applyTrackingRankingKeywordFilter(query, tokens) {
    trackingRankingSearchQuery = String(query || '').trim();
    trackingRankingSearchTokens = Array.isArray(tokens) ? tokens : null;

    // 高亮匹配项
    highlightTrackingRankingMatches();

    // 更新指示器状态
    applyTrackingRankingIndicatorState();

    // 更新退出按钮
    if (typeof window.updateSearchFilterExitButton === 'function') {
        window.updateSearchFilterExitButton();
    }
}

/**
 * 清除时间捕捉搜索筛选
 */
function clearTrackingRankingSearchFilter() {
    trackingRankingSearchQuery = '';
    trackingRankingSearchTokens = null;

    // 清除高亮
    clearTrackingRankingHighlight();

    // 更新指示器状态
    applyTrackingRankingIndicatorState();

    // 更新退出按钮
    if (typeof window.updateSearchFilterExitButton === 'function') {
        window.updateSearchFilterExitButton();
    }
}

/**
 * 在列表中高亮匹配项
 */
function highlightTrackingRankingMatches() {
    const container = document.getElementById('trackingRankingList');
    if (!container) return;

    const tokens = trackingRankingSearchTokens;
    if (!tokens || tokens.length === 0) {
        clearTrackingRankingHighlight();
        return;
    }

    const items = container.querySelectorAll('.tracking-ranking-item');
    let firstMatch = null;

    items.forEach(item => {
        const url = (item.dataset.url || '').toLowerCase();
        const titleEl = item.querySelector('.ranking-title');
        const title = (titleEl ? titleEl.textContent : '').toLowerCase();

        const isMatch = tokens.every(token =>
            url.includes(token) || title.includes(token)
        );

        if (isMatch) {
            item.classList.add('search-match-highlight');
            if (!firstMatch) firstMatch = item;
        } else {
            item.classList.remove('search-match-highlight');
        }
    });

    // 滚动到第一个匹配项
    if (firstMatch) {
        firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // 更新列表容器的边框样式
    setListSearchFilterHighlight('trackingRankingList', true);
}

/**
 * 清除时间捕捉高亮
 */
function clearTrackingRankingHighlight() {
    const container = document.getElementById('trackingRankingList');
    if (!container) return;

    container.querySelectorAll('.tracking-ranking-item').forEach(item => {
        item.classList.remove('search-match-highlight');
    });

    setListSearchFilterHighlight('trackingRankingList', false);
}

/**
 * 更新时间捕捉搜索指示器状态
 */
function applyTrackingRankingIndicatorState() {
    try {
        const active = isTrackingRankingSearchActive();
        setListSearchFilterHighlight('trackingRankingList', active);

        // 可选：在 header 中添加指示器（如果需要）
    } catch (_) { }
}

// 导出到 window
try {
    window.isTrackingRankingSearchActive = isTrackingRankingSearchActive;
    window.applyTrackingRankingKeywordFilter = applyTrackingRankingKeywordFilter;
    window.clearTrackingRankingSearchFilter = clearTrackingRankingSearchFilter;
} catch (_) { }

// =============================================================================
// 书签温故视图
// =============================================================================

function renderAdditionsView() {
    const container = document.getElementById('additionsList');

    // 【修复】容器已被删除（在UI重构中），直接返回
    if (!container) {
        console.log('[renderAdditionsView] additionsList容器不存在，跳过渲染');
        return;
    }

    if (allBookmarks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-bookmark"></i></div>
                <div class="empty-state-title">${i18n.emptyAdditions[currentLang]}</div>
            </div>
        `;
        return;
    }

    // 按时间范围分组（年、月、日）
    const groupedByTime = groupBookmarksByTime(allBookmarks, currentTimeFilter);

    // 过滤
    const filtered = filterBookmarks(groupedByTime);

    container.innerHTML = renderBookmarkGroups(filtered, currentTimeFilter);

    // 绑定折叠/展开事件
    attachAdditionGroupEvents();
}

// 初始化「书签温故」子视图标签和行为
function initAdditionsSubTabs() {
    const tabs = document.querySelectorAll('.additions-tab');
    const reviewPanel = document.getElementById('additionsReviewPanel');
    const browsingPanel = document.getElementById('additionsBrowsingPanel');
    const trackingPanel = document.getElementById('additionsTrackingPanel');

    if (!tabs.length || !reviewPanel || !browsingPanel) {
        console.warn('[initAdditionsSubTabs] 主标签或面板缺失');
        return;
    }

    let browsingHistoryInitialized = false;
    let trackingInitialized = false;

    // 标签切换函数
    const switchToTab = (target, shouldSave = true) => {
        // [Fixed] Exit Locate Mode when leaving the current view (Search Isolation)
        // 1. Check Bookmark Calendar
        if (window.bookmarkCalendarInstance && window.bookmarkCalendarInstance.selectMode) {
            if (typeof window.bookmarkCalendarInstance.exitLocateMode === 'function') {
                window.bookmarkCalendarInstance.exitLocateMode();
            }
        }
        // 2. Check Browsing History Calendar
        if (window.browsingHistoryCalendarInstance && window.browsingHistoryCalendarInstance.selectMode) {
            if (typeof window.browsingHistoryCalendarInstance.exitLocateMode === 'function') {
                window.browsingHistoryCalendarInstance.exitLocateMode();
            }
        }

        // 切换标签高亮
        tabs.forEach(t => t.classList.remove('active'));
        const targetTab = document.querySelector(`.additions-tab[data-tab="${target}"]`);
        if (targetTab) targetTab.classList.add('active');

        // 切换子视图
        reviewPanel.classList.remove('active');
        browsingPanel.classList.remove('active');
        if (trackingPanel) trackingPanel.classList.remove('active');

        // [Fixed] Update Search Context immediately (for both click and restore)
        // IMPORTANT: initAdditionsSubTabs() runs on page init even when the active view is not "additions".
        // If we update context here unconditionally, it will overwrite the main search placeholder on refresh
        if (window.SearchContextManager && currentView === 'additions') {
            let subTab = null;
            if (target === 'browsing') {
                subTab = localStorage.getItem('browsingActiveSubTab') || 'history';
            }
            window.SearchContextManager.updateContext('additions', target, subTab);
        }

        if (target === 'review') {
            reviewPanel.classList.add('active');
            try {
                // If switching back to Review, force refresh might be good but just rendering is enough
                // Note: The calendar's state is preserved unless refreshed.
                // We exited locate mode above, so it will be clean.
                renderAdditionsView();
            } catch (error) {
                console.warn('[initAdditionsSubTabs] 渲染书签添加记录失败:', error);
            }
        } else if (target === 'browsing') {
            browsingPanel.classList.add('active');
            // 初始化浏览记录日历（首次点击时）
            if (!browsingHistoryInitialized) {
                browsingHistoryInitialized = true;
                try {
                    initBrowsingHistoryCalendar();
                } catch (e) {
                    console.error('[Additions] 初始化浏览记录日历失败:', e);
                }
            } else {
                refreshBrowsingHistoryData({ forceFull: false, silent: true });
            }
        } else if (target === 'tracking' && trackingPanel) {
            trackingPanel.classList.add('active');
            // 初始化时间捕捉（首次点击时）
            if (!trackingInitialized) {
                trackingInitialized = true;
                initTrackingToggle();
            }
            // 每次切换到标签时加载最新数据
            loadCurrentTrackingSessions();
            loadActiveTimeRanking();
            // 启动当前会话的实时刷新（排行榜不定时刷新）
            startTrackingRefresh();
        }

        // 保存当前状态
        if (shouldSave) {
            localStorage.setItem('additionsActiveTab', target);
        }
    };

    // 绑定点击事件
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchToTab(tab.dataset.tab, true);
        });
    });

    // 恢复上次选中的标签
    const savedTab = localStorage.getItem('additionsActiveTab');
    if (savedTab && ['review', 'browsing', 'tracking'].includes(savedTab)) {
        switchToTab(savedTab, false);
    }

    // 初始化浏览记录的子标签
    initBrowsingSubTabs();
}

// 初始化浏览记录子标签
function initBrowsingSubTabs() {
    const subTabs = document.querySelectorAll('.browsing-sub-tab');
    const historyPanel = document.getElementById('browsingHistoryPanel');
    const rankingPanel = document.getElementById('browsingRankingPanel');
    const relatedPanel = document.getElementById('browsingRelatedPanel');
    let browsingRankingInitialized = false;
    let browsingRelatedInitialized = false;

    if (!subTabs.length || !historyPanel || !rankingPanel || !relatedPanel) {
        console.warn('[initBrowsingSubTabs] 子标签或面板缺失');
        return;
    }

    // 子标签切换函数
    const switchToSubTab = (target, shouldSave = true) => {
        // [Fixed] Exit Locate Mode when switching sub-tabs (Search Isolation)
        if (window.browsingHistoryCalendarInstance && window.browsingHistoryCalendarInstance.selectMode) {
            if (typeof window.browsingHistoryCalendarInstance.exitLocateMode === 'function') {
                window.browsingHistoryCalendarInstance.exitLocateMode();
            }
        }

        // 切换子标签高亮
        subTabs.forEach(t => t.classList.remove('active'));
        const targetTab = document.querySelector(`.browsing-sub-tab[data-sub-tab="${target}"]`);
        if (targetTab) targetTab.classList.add('active');

        // [Fixed] Update Search Context immediately (for both click and restore)
        // Guard: only affect global search when "additions" view is active.
        if (window.SearchContextManager && currentView === 'additions') {
            window.SearchContextManager.updateContext('additions', 'browsing', target);
        }

        // 切换子面板
        historyPanel.classList.remove('active');
        rankingPanel.classList.remove('active');
        relatedPanel.classList.remove('active');

        if (target === 'history') {
            historyPanel.classList.add('active');
            refreshBrowsingHistoryData({ forceFull: false, silent: true });
        } else if (target === 'ranking') {
            rankingPanel.classList.add('active');
            if (!browsingRankingInitialized) {
                browsingRankingInitialized = true;
                try {
                    initBrowsingClickRanking();
                } catch (e) {
                    console.error('[initBrowsingSubTabs] 初始化点击排行失败:', e);
                }
            } else {
                refreshBrowsingHistoryData({ forceFull: false, silent: true });
                browsingClickRankingStats = null;
                refreshActiveBrowsingRankingIfVisible();
            }
        } else if (target === 'related') {
            relatedPanel.classList.add('active');
            if (!browsingRelatedInitialized) {
                browsingRelatedInitialized = true;
                try {
                    initBrowsingRelatedHistory();
                } catch (e) {
                    console.error('[initBrowsingSubTabs] 初始化书签关联记录失败:', e);
                }
            } else {
                refreshBrowsingRelatedHistory();
            }
        }

        // 保存当前状态
        if (shouldSave) {
            localStorage.setItem('browsingActiveSubTab', target);
        }
    };

    // 绑定点击事件
    subTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchToSubTab(tab.dataset.subTab, true);
        });
    });

    // 恢复上次选中的子标签
    const savedSubTab = localStorage.getItem('browsingActiveSubTab');
    if (savedSubTab && ['history', 'ranking', 'related'].includes(savedSubTab)) {
        switchToSubTab(savedSubTab, false);
    }
}

/*
 * ============================================================================
 * 以下「书签点击排行」相关代码已注释，UI已删除，等待重构
 * ============================================================================
 */

/*
// 基于浏览器历史记录的“书签点击排行榜”（书签温故第二个子视图）
function loadBookmarkClickRankingForAdditions(container) {
    if (!container) return;
 
    container.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-clock"></i></div>
            <div class="empty-state-title">${currentLang === 'zh_CN' ? '正在读取历史记录...' : 'Loading history...'}</div>
        </div>
    `;
 
    if (!browserAPI || !browserAPI.history || typeof browserAPI.history.getVisits !== 'function') {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-ban"></i></div>
                <div class="empty-state-title">${currentLang === 'zh_CN' ? '当前环境不支持历史记录统计' : 'History statistics are not available in this environment'}</div>
                <div class="empty-state-description">${currentLang === 'zh_CN' ? '请确认扩展已获得浏览器的历史记录权限。' : 'Please ensure the extension has permission to access browser history.'}</div>
            </div>
        `;
        return;
    }
 
    if (!Array.isArray(allBookmarks) || allBookmarks.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-bookmark"></i></div>
                <div class="empty-state-title">${currentLang === 'zh_CN' ? '暂无书签可统计' : 'No bookmarks to analyze'}</div>
            </div>
        `;
        return;
    }
 
    // 仅统计有效的 HTTP/HTTPS 书签，限制数量避免开销过大
    const candidates = allBookmarks
        .filter(b => b.url && (b.url.startsWith('http://') || b.url.startsWith('https://')))
        .slice(0, 150);
 
    if (!candidates.length) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-bookmark"></i></div>
                <div class="empty-state-title">${currentLang === 'zh_CN' ? '暂无可统计的书签' : 'No bookmarks available for statistics'}</div>
            </div>
        `;
        return;
    }
 
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
 
    const rankingMap = new Map(); // url -> stats
    let pending = candidates.length;
 
    const finishIfDone = () => {
        pending -= 1;
        if (pending > 0) return;
 
        const items = Array.from(rankingMap.values())
            // 只保留至少有一次访问的
            .filter(item =>
                item.last1d ||
                item.last3d ||
                item.last7d ||
                item.last30d ||
                item.last90d ||
                item.last180d ||
                item.last365d
            );
 
        if (!items.length) {
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-clock"></i></div>
                    <div class="empty-state-title">${currentLang === 'zh_CN' ? '暂无点击记录' : 'No click records found'}</div>
                    <div class="empty-state-description">${currentLang === 'zh_CN' ? '浏览器历史记录中尚未找到这些书签的访问记录。' : 'No visit records for these bookmarks were found in browser history.'}</div>
                </div>
            `;
            return;
        }
 
        // 排序：优先最近 7 天，再看 30 天
        items.sort((a, b) => {
            if (b.last7d !== a.last7d) return b.last7d - a.last7d;
            if (b.last30d !== a.last30d) return b.last30d - a.last30d;
            return (b.last365d || 0) - (a.last365d || 0);
        });
 
        renderBookmarkClickRankingList(container, items.slice(0, 50));
    };
 
    candidates.forEach(bookmark => {
        try {
            browserAPI.history.getVisits({ url: bookmark.url }, (visits) => {
                const runtime = browserAPI.runtime;
                if (runtime && runtime.lastError) {
                    finishIfDone();
                    return;
                }
 
                const key = bookmark.url;
                let info = rankingMap.get(key);
                if (!info) {
                    info = {
                        url: bookmark.url,
                        title: bookmark.title || bookmark.url,
                        lastVisitTime: 0,
                        last1d: 0,
                        last3d: 0,
                        last7d: 0,
                        last30d: 0,
                        last90d: 0,
                        last180d: 0,
                        last365d: 0
                    };
                    rankingMap.set(key, info);
                }
 
                if (Array.isArray(visits)) {
                    visits.forEach(v => {
                        const t = typeof v.visitTime === 'number' ? v.visitTime : 0;
                        if (!t) return;
 
                        if (t > info.lastVisitTime) {
                            info.lastVisitTime = t;
                        }
 
                        const diff = now - t;
                        if (diff <= oneDay) info.last1d += 1;
                        if (diff <= 3 * oneDay) info.last3d += 1;
                        if (diff <= 7 * oneDay) info.last7d += 1;
                        if (diff <= 30 * oneDay) info.last30d += 1;
                        if (diff <= 90 * oneDay) info.last90d += 1;
                        if (diff <= 180 * oneDay) info.last180d += 1;
                        if (diff <= 365 * oneDay) info.last365d += 1;
                    });
                }
 
                finishIfDone();
            });
        } catch (e) {
            finishIfDone();
        }
    });
}
 
function renderBookmarkClickRankingList(container, items) {
    container.innerHTML = '';
 
    items.forEach(entry => {
        const row = document.createElement('div');
        row.className = 'addition-item ranking-item';
        row.dataset.url = entry.url;
 
        const icon = document.createElement('img');
        icon.className = 'addition-icon';
        icon.src = getFaviconUrl(entry.url);
        icon.alt = '';
 
        const info = document.createElement('div');
        info.className = 'addition-info';
 
        const titleLink = document.createElement('a');
        titleLink.className = 'addition-title';
        titleLink.href = entry.url;
        titleLink.target = '_blank';
        titleLink.rel = 'noopener noreferrer';
        titleLink.textContent = entry.title;
 
        const urlDiv = document.createElement('div');
        urlDiv.className = 'addition-url';
        urlDiv.textContent = entry.url;
 
        info.appendChild(titleLink);
        info.appendChild(urlDiv);
 
        const counts = document.createElement('div');
        counts.className = 'ranking-counts';
        counts.textContent = currentLang === 'zh_CN'
            ? `7天：${entry.last7d}，30天：${entry.last30d}`
            : `7 days: ${entry.last7d}, 30 days: ${entry.last30d}`;
 
        const header = document.createElement('div');
        header.className = 'ranking-item-header';
        header.appendChild(info);
        header.appendChild(counts);
 
        const detail = document.createElement('div');
        detail.className = 'ranking-detail';
        detail.style.display = 'none';
 
        const lastVisitText = entry.lastVisitTime
            ? new Date(entry.lastVisitTime).toLocaleString()
            : (currentLang === 'zh_CN' ? '无访问记录' : 'No visits');
 
        if (currentLang === 'zh_CN') {
            detail.textContent =
                `1天：${entry.last1d}，3天：${entry.last3d}，7天：${entry.last7d}，` +
                `30天：${entry.last30d}，90天：${entry.last90d}，180天：${entry.last180d}，365天：${entry.last365d}；` +
                `最近访问：${lastVisitText}`;
        } else {
            detail.textContent =
                `1 day: ${entry.last1d}, 3 days: ${entry.last3d}, 7 days: ${entry.last7d}, ` +
                `30 days: ${entry.last30d}, 90 days: ${entry.last90d}, 180 days: ${entry.last180d}, 365 days: ${entry.last365d}; ` +
                `Last visit: ${lastVisitText}`;
        }
 
        row.appendChild(icon);
        row.appendChild(header);
        row.appendChild(detail);
 
        // 整行可点击：展开/收起详细统计，同时打开书签
        row.addEventListener('click', (e) => {
            // 如果直接点击的是标题链接，让浏览器默认打开，不拦截
            if (e.target === titleLink) {
                return;
            }
 
            e.preventDefault();
 
            // 切换详情可见性
            const visible = detail.style.display === 'block';
            detail.style.display = visible ? 'none' : 'block';
 
            // 打开对应书签
            try {
                if (browserAPI && browserAPI.tabs && typeof browserAPI.tabs.create === 'function') {
                    browserAPI.tabs.create({ url: entry.url });
                } else {
                    window.open(entry.url, '_blank');
                }
            } catch (err) {
                console.warn('[Additions] 打开书签失败:', err);
            }
        });
 
        container.appendChild(row);
    });
}
*/

/*
 * ============================================================================
 * 以上「书签点击排行」相关代码已注释，UI已删除，等待重构
 * ============================================================================
 */

// 基于浏览器历史记录的「点击排行」（书签浏览记录子视图）

function getBrowsingClickRankingBoundaries() {
    const now = new Date();
    const nowMs = now.getTime();

    // 当天起始（本地时区）
    const dayStartDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayStart = dayStartDate.getTime();

    // 与「点击记录」日历保持一致：
    // - 中文使用周一作为一周开始
    // - 其他语言使用周日作为一周开始
    const weekStartDay = currentLang === 'zh_CN' ? 1 : 0; // 0=周日,1=周一,...
    const weekStartDate = new Date(dayStartDate);
    const currentDay = weekStartDate.getDay(); // 0-6 (周日-周六)
    let diff = currentDay - weekStartDay;
    if (diff < 0) diff += 7;
    weekStartDate.setDate(weekStartDate.getDate() - diff);
    const weekStart = weekStartDate.getTime();

    // 当月起始
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    // 当年起始
    const yearStart = new Date(now.getFullYear(), 0, 1).getTime();

    return { now: nowMs, dayStart, weekStart, monthStart, yearStart };
}

async function ensureBrowsingClickRankingStats() {
    if (browsingClickRankingStats) {
        return browsingClickRankingStats;
    }

    // 如果历史记录 API 完全不可用，直接标记为不支持
    if (!browserAPI || !browserAPI.history || typeof browserAPI.history.search !== 'function') {
        browsingClickRankingStats = { items: [], error: 'noHistoryApi' };
        return browsingClickRankingStats;
    }

    // 确保「点击记录」日历已初始化
    try {
        if (typeof initBrowsingHistoryCalendar === 'function' && !window.browsingHistoryCalendarInstance) {
            initBrowsingHistoryCalendar();
        }
    } catch (e) {
        console.warn('[BrowsingRanking] 初始化 BrowsingHistoryCalendar 失败:', e);
    }

    // 等待日历数据（基于 bookmarksByDate）
    const waitForCalendarData = async () => {
        const start = Date.now();
        const timeout = 5000;
        while (Date.now() - start < timeout) {
            const inst = window.browsingHistoryCalendarInstance;
            if (inst && inst.bookmarksByDate && inst.bookmarksByDate.size > 0) {
                return inst;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return window.browsingHistoryCalendarInstance || null;
    };

    const calendar = await waitForCalendarData();

    if (!calendar || !calendar.bookmarksByDate) {
        browsingClickRankingStats = { items: [], error: 'noBookmarks' };
        return browsingClickRankingStats;
    }

    // 如果完全没有任何点击记录，则视为无数据
    if (calendar.bookmarksByDate.size === 0) {
        browsingClickRankingStats = { items: [], error: 'noBookmarks' };
        return browsingClickRankingStats;
    }

    const boundaries = getBrowsingClickRankingBoundaries();

    // ✨ 通过书签 API 获取 URL 和标题集合，用于构建书签标识映射
    // 与「书签关联记录」和「点击记录」保持一致，使用 URL 或标题的并集匹配
    let bookmarkData;
    try {
        bookmarkData = await getBookmarkUrlsAndTitles();
    } catch (error) {
        console.warn('[BrowsingRanking] 获取书签URL和标题失败:', error);
        browsingClickRankingStats = { items: [], error: 'noBookmarks' };
        return browsingClickRankingStats;
    }

    const bookmarkInfoByUrl = bookmarkData && bookmarkData.info ? bookmarkData.info : null;
    if (!bookmarkInfoByUrl || bookmarkInfoByUrl.size === 0) {
        browsingClickRankingStats = { items: [], error: 'noBookmarks' };
        return browsingClickRankingStats;
    }

    // 构建 URL/标题 -> 书签主键的映射
    // 标题相同的书签合并为同一个统计项（共享 bookmarkKey）
    const bookmarkKeyMap = new Map(); // url or title (normalized) -> bookmarkKey
    const bookmarkInfoMap = new Map(); // bookmarkKey -> { url, title, urls: [] }

    let bookmarkKeyCounter = 0;
    for (const [url, info] of bookmarkInfoByUrl.entries()) {
        const normalizedUrl = url;
        const normalizedTitle = info && typeof info.title === 'string' ? info.title.trim() : '';

        // 检查是否已有相同标题的书签
        let bookmarkKey = null;
        if (normalizedTitle) {
            bookmarkKey = bookmarkKeyMap.get(`title:${normalizedTitle}`);
        }

        if (bookmarkKey) {
            // 标题相同，复用已有的 bookmarkKey，添加 URL 映射
            bookmarkKeyMap.set(`url:${normalizedUrl}`, bookmarkKey);
            // 记录额外的 URL
            const existingInfo = bookmarkInfoMap.get(bookmarkKey);
            if (existingInfo && existingInfo.urls) {
                existingInfo.urls.push(normalizedUrl);
            }
        } else {
            // 创建新的 bookmarkKey
            bookmarkKey = `bm_${bookmarkKeyCounter++}`;
            bookmarkKeyMap.set(`url:${normalizedUrl}`, bookmarkKey);
            if (normalizedTitle) {
                bookmarkKeyMap.set(`title:${normalizedTitle}`, bookmarkKey);
            }
            bookmarkInfoMap.set(bookmarkKey, {
                url: normalizedUrl,
                title: normalizedTitle || normalizedUrl,
                urls: [normalizedUrl]
            });
        }
    }

    const statsMap = new Map(); // bookmarkKey -> stats

    // 从「点击记录」的数据结构中汇总统计信息
    for (const bookmarks of calendar.bookmarksByDate.values()) {
        bookmarks.forEach(bm => {
            if (!bm || !bm.url) return;

            const url = bm.url;
            const title = typeof bm.title === 'string' && bm.title.trim()
                ? bm.title.trim()
                : (bm.url || '');
            const t = typeof bm.visitTime === 'number'
                ? bm.visitTime
                : (bm.dateAdded instanceof Date ? bm.dateAdded.getTime() : 0);
            if (!t) return;

            // ✨ 每条历史记录的 visitCount 应该是 1（单次访问），不应累积浏览器的总访问次数
            // 因为我们已经将每次访问都记录为单独的记录
            const increment = 1;

            // ✨ 找出这条记录匹配的书签（优先URL匹配，其次标题匹配）
            let bookmarkKey = bookmarkKeyMap.get(`url:${url}`);
            if (!bookmarkKey && title) {
                // URL 不匹配，尝试标题匹配
                bookmarkKey = bookmarkKeyMap.get(`title:${title}`);
            }

            if (!bookmarkKey) {
                // 没有匹配的书签，跳过（理论上不应该发生，因为这些记录来自存储库3）
                return;
            }

            let stats = statsMap.get(bookmarkKey);
            if (!stats) {
                const info = bookmarkInfoMap.get(bookmarkKey);
                stats = {
                    url: info.url,
                    title: info.title,
                    lastVisitTime: 0,
                    dayCount: 0,
                    weekCount: 0,
                    monthCount: 0,
                    yearCount: 0,
                    allCount: 0
                };
                statsMap.set(bookmarkKey, stats);
            }

            if (t > stats.lastVisitTime) {
                stats.lastVisitTime = t;
            }

            // ✨ 修复时间统计：只统计当前时间之前的访问
            const now = boundaries.now;
            if (t <= now) {
                stats.allCount += increment; // 全部时间范围
                if (t >= boundaries.dayStart && t <= now) stats.dayCount += increment;
                if (t >= boundaries.weekStart && t <= now) stats.weekCount += increment;
                if (t >= boundaries.monthStart && t <= now) stats.monthCount += increment;
                if (t >= boundaries.yearStart && t <= now) stats.yearCount += increment;
            }
        });
    }

    const items = Array.from(statsMap.values());

    // 保存映射供筛选函数使用
    browsingClickRankingStats = { items, boundaries, bookmarkKeyMap, bookmarkInfoMap };
    return browsingClickRankingStats;
}

function getBrowsingRankingItemsForRange(range) {
    if (!browsingClickRankingStats || !Array.isArray(browsingClickRankingStats.items)) {
        return [];
    }

    const key = range === 'day'
        ? 'dayCount'
        : range === 'week'
            ? 'weekCount'
            : range === 'year'
                ? 'yearCount'
                : range === 'all'
                    ? 'allCount'
                    : 'monthCount';

    const items = browsingClickRankingStats.items
        .filter(item => item[key] > 0)
        .sort((a, b) => {
            if (b[key] !== a[key]) return b[key] - a[key];
            return (b.lastVisitTime || 0) - (a.lastVisitTime || 0);
        });

    // 返回完整有序列表，渲染层做懒加载
    return items;
}

// 渲染文件夹模式的点击排行列表
async function renderBrowsingFolderRankingList(container, items, range, stats, options = {}) {
    container.innerHTML = '';

    const isZh = currentLang === 'zh_CN';

    // 确保书签信息已加载（包含 folderPath）
    await getBookmarkUrlsAndTitles();

    if (!items.length) {
        const title = isZh ? '暂无点击记录' : 'No click records found';
        const desc = isZh ? '当前时间范围内尚未找到这些书签的访问记录。' : 'No visit records were found in the selected time range.';
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-folder"></i></div>
                <div class="empty-state-title">${title}</div>
                <div class="empty-state-description">${desc}</div>
            </div>
        `;
        return;
    }

    const searchTokens = Array.isArray(options.searchTokens) ? options.searchTokens : null;

    // 按文件夹聚合统计
    const folderStats = new Map(); // folderPath -> { count, items: [] }
    const bookmarkInfo = stats.bookmarkInfoMap;

    items.forEach(item => {
        // 尝试从 getBookmarkUrlsAndTitles 获取 folderPath
        let folderPath = [];
        if (browsingRelatedBookmarkInfo && browsingRelatedBookmarkInfo.has(item.url)) {
            folderPath = browsingRelatedBookmarkInfo.get(item.url).folderPath || [];
        }

        // 使用完整的文件夹路径作为分组键（精确到最后一级文件夹）
        const folderKey = folderPath.length > 0 ? folderPath.join(' / ') : (isZh ? '未分类' : 'Uncategorized');
        const folderName = folderPath.length > 0 ? folderPath[folderPath.length - 1] : folderKey;

        if (!folderStats.has(folderKey)) {
            folderStats.set(folderKey, {
                name: folderName,
                fullPath: folderKey,
                folderPath: folderPath,
                count: 0,
                items: []
            });
        }

        const folderData = folderStats.get(folderKey);
        const itemCount = item.filteredCount !== undefined ? item.filteredCount : (
            range === 'day' ? item.dayCount :
                range === 'week' ? item.weekCount :
                    range === 'year' ? item.yearCount :
                        range === 'all' ? item.allCount : item.monthCount
        );
        folderData.count += itemCount;
        folderData.items.push({ ...item, count: itemCount, folderPath });
    });

    // 按点击次数排序文件夹
    let sortedFolders = Array.from(folderStats.values()).sort((a, b) => b.count - a.count);

    // Phase 4.7: folder-mode keyword search
    // - match folder name/path
    // - OR match any bookmark in folder
    if (searchTokens && searchTokens.length > 0) {
        sortedFolders = sortedFolders.filter(folder => {
            if (matchesTokens(folder.fullPath, searchTokens) || matchesTokens(folder.name, searchTokens)) {
                return true;
            }
            if (Array.isArray(folder.items) && folder.items.length > 0) {
                return folder.items.some(it => matchesTokens(it.title, searchTokens) || matchesTokens(it.url, searchTokens));
            }
            return false;
        });
    }

    // 渲染文件夹列表
    const rangeLabel = options.customRangeLabel || (() => {
        if (range === 'day') return isZh ? '今天' : 'Today';
        if (range === 'week') return isZh ? '本周' : 'This week';
        if (range === 'year') return isZh ? '本年' : 'This year';
        if (range === 'all') return isZh ? '全部' : 'All';
        return isZh ? '本月' : 'This month';
    })();

    sortedFolders.forEach((folder, index) => {
        const folderRow = document.createElement('div');
        folderRow.className = 'ranking-item folder-ranking-item';
        folderRow.style.cursor = 'pointer';

        // 排名样式
        let rankClass = '';
        if (index === 0) rankClass = 'rank-gold';
        else if (index === 1) rankClass = 'rank-silver';
        else if (index === 2) rankClass = 'rank-bronze';

        const header = document.createElement('div');
        header.className = 'ranking-header';

        // 排名数字
        const rank = document.createElement('span');
        rank.className = 'ranking-rank';
        rank.textContent = index + 1;
        if (rankClass) rank.classList.add(rankClass);
        header.appendChild(rank);

        // 文件夹图标和名称
        const main = document.createElement('div');
        main.className = 'ranking-main';
        const pathDisplay = folder.fullPath !== folder.name ? folder.fullPath : '';
        const safeFolderName = escapeHtml(folder.name);
        const safeFolderFullPath = escapeHtml(folder.fullPath);
        const safePathDisplay = escapeHtml(pathDisplay);
        main.innerHTML = `
            <div class="ranking-icon" style="color: var(--accent-primary);">
                <i class="fas fa-folder"></i>
            </div>
            <div class="ranking-info">
                <div class="ranking-title" title="${safeFolderFullPath}">${safeFolderName}</div>
                <div class="ranking-meta">${pathDisplay ? `${safePathDisplay} · ` : ''}${isZh ? `${folder.items.length} 个书签` : `${folder.items.length} bookmarks`}</div>
            </div>
        `;
        header.appendChild(main);

        // 点击次数
        const counts = document.createElement('div');
        counts.className = 'ranking-counts';
        if (rankClass) counts.classList.add(rankClass);
        counts.textContent = folder.count.toLocaleString(isZh ? 'zh-CN' : 'en-US');
        counts.dataset.tooltip = isZh ? `${rangeLabel}：${folder.count} 次` : `${rangeLabel}: ${folder.count} clicks`;
        header.appendChild(counts);

        folderRow.appendChild(header);

        // 展开的书签列表
        const bookmarkList = document.createElement('div');
        bookmarkList.className = 'folder-bookmark-list';
        bookmarkList.style.display = 'none';
        bookmarkList.style.padding = '8px 0 8px 40px';
        bookmarkList.style.borderTop = '1px solid var(--border-color)';
        bookmarkList.style.marginTop = '8px';

        // 按点击次数排序书签
        folder.items.sort((a, b) => b.count - a.count);

        folder.items.forEach(item => {
            const bookmarkItem = document.createElement('div');
            bookmarkItem.style.display = 'flex';
            bookmarkItem.style.alignItems = 'center';
            bookmarkItem.style.gap = '8px';
            bookmarkItem.style.padding = '6px 8px';
            bookmarkItem.style.marginBottom = '4px';
            bookmarkItem.style.borderRadius = '4px';
            bookmarkItem.style.cursor = 'pointer';
            bookmarkItem.style.transition = 'background 0.2s';

            const itemTitle = item.title || item.url || '';
            const faviconSrc = typeof getFaviconUrl === 'function'
                ? getFaviconUrl(item.url)
                : `${(navigator.userAgent || '').includes('Edg/') ? 'edge' : 'chrome'}://favicon/${item.url || ''}`;

            bookmarkItem.innerHTML = `
                <img class="ranking-favicon" src="${escapeHtml(faviconSrc)}" style="width:16px;height:16px;flex-shrink:0;">
                <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;" 
                      title="${escapeHtml(itemTitle)}">${escapeHtml(itemTitle)}</span>
                <span style="font-size:11px;color:var(--text-tertiary);flex-shrink:0;">${item.count}</span>
            `;

            bookmarkItem.addEventListener('mouseenter', () => {
                bookmarkItem.style.background = 'var(--bg-tertiary)';
            });
            bookmarkItem.addEventListener('mouseleave', () => {
                bookmarkItem.style.background = 'transparent';
            });
            bookmarkItem.addEventListener('click', (e) => {
                e.stopPropagation();
                try {
                    const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
                    if (browserAPI?.tabs?.create) {
                        browserAPI.tabs.create({ url: item.url });
                    } else {
                        window.open(item.url, '_blank');
                    }
                } catch (err) {
                    console.warn('[FolderRanking] 打开书签失败:', err);
                }
            });

            bookmarkList.appendChild(bookmarkItem);
        });

        folderRow.appendChild(bookmarkList);

        // 点击展开/收起
        header.addEventListener('click', () => {
            const isExpanded = bookmarkList.style.display === 'block';
            bookmarkList.style.display = isExpanded ? 'none' : 'block';
            const icon = main.querySelector('.fa-folder, .fa-folder-open');
            if (icon) {
                icon.classList.toggle('fa-folder', isExpanded);
                icon.classList.toggle('fa-folder-open', !isExpanded);
            }
        });

        container.appendChild(folderRow);
    });
}

function renderBrowsingClickRankingList(container, items, range, options = {}) {
    container.innerHTML = '';

    if (!items.length) {
        const isZh = currentLang === 'zh_CN';
        const title = i18n.browsingRankingEmptyTitle
            ? i18n.browsingRankingEmptyTitle[currentLang]
            : (isZh ? '暂无点击记录' : 'No click records found');
        const desc = i18n.browsingRankingEmptyDescription
            ? i18n.browsingRankingEmptyDescription[currentLang]
            : (isZh ? '当前时间范围内尚未找到这些书签的访问记录。' : 'No visit records were found in the selected time range.');

        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-clock"></i></div>
                <div class="empty-state-title">${title}</div>
                <div class="empty-state-description">${desc}</div>
            </div>
        `;
        return;
    }

    const isZh = currentLang === 'zh_CN';
    const rangeLabel = options.customRangeLabel || (() => {
        if (range === 'day') return isZh ? '今天' : 'Today';
        if (range === 'week') return isZh ? '本周' : 'This week';
        if (range === 'year') return isZh ? '本年' : 'This year';
        if (range === 'all') return isZh ? '全部' : 'All';
        return isZh ? '本月' : 'This month';
    })();

    const PAGE_SIZE = 200; // 每次加载200条
    let offset = 0;

    const appendNextPage = () => {
        const end = Math.min(offset + PAGE_SIZE, items.length);
        for (let i = offset; i < end; i++) {
            const entry = items[i];

            const row = document.createElement('div');
            row.className = 'addition-item ranking-item';

            const header = document.createElement('div');
            header.className = 'ranking-item-header';

            const main = document.createElement('div');
            main.className = 'ranking-main';

            const rankSpan = document.createElement('span');
            rankSpan.className = 'ranking-index';
            rankSpan.textContent = i + 1;
            let rankClass = '';
            if (i === 0) {
                rankClass = 'gold';
            } else if (i === 1) {
                rankClass = 'silver';
            } else if (i === 2) {
                rankClass = 'bronze';
            }
            if (rankClass) {
                rankSpan.classList.add(rankClass);
            }

            const icon = document.createElement('img');
            icon.className = 'addition-icon';
            icon.src = getFaviconUrl(entry.url);
            icon.alt = '';

            const info = document.createElement('div');
            info.className = 'addition-info';

            const titleLink = document.createElement('a');
            titleLink.className = 'addition-title';
            titleLink.href = entry.url;
            titleLink.target = '_blank';
            titleLink.rel = 'noopener noreferrer';
            titleLink.textContent = entry.title;

            const urlDiv = document.createElement('div');
            urlDiv.className = 'addition-url';
            urlDiv.textContent = entry.url;

            info.appendChild(titleLink);
            info.appendChild(urlDiv);

            main.appendChild(rankSpan);
            main.appendChild(icon);
            main.appendChild(info);

            const counts = document.createElement('div');
            counts.className = 'ranking-counts';

            // 优先使用筛选后的次数（如果存在）
            const value = entry.filteredCount !== undefined
                ? entry.filteredCount
                : (range === 'day'
                    ? entry.dayCount
                    : range === 'week'
                        ? entry.weekCount
                        : range === 'year'
                            ? entry.yearCount
                            : range === 'all'
                                ? entry.allCount
                                : entry.monthCount);
            const locale = currentLang === 'zh_CN' ? 'zh-CN' : 'en-US';
            const formattedValue = typeof value === 'number'
                ? value.toLocaleString(locale)
                : String(value);
            counts.textContent = formattedValue;

            if (rankClass) {
                counts.classList.add(rankClass);
            }

            const unitLabel = isZh ? '次' : (value === 1 ? 'click' : 'clicks');
            const accessibleLabel = isZh
                ? `${rangeLabel}：${value} ${unitLabel}`
                : `${rangeLabel}: ${value} ${unitLabel}`;
            counts.dataset.tooltip = accessibleLabel;
            counts.setAttribute('aria-label', accessibleLabel);

            header.appendChild(main);

            // 跳转按钮容器（点击次数左边）
            const jumpBtnContainer = document.createElement('div');
            jumpBtnContainer.className = 'jump-to-related-btn-container';
            jumpBtnContainer.style.display = 'flex';
            jumpBtnContainer.style.alignItems = 'center';
            jumpBtnContainer.style.flexShrink = '0';

            const jumpBtn = document.createElement('button');
            jumpBtn.className = 'jump-to-related-btn';
            jumpBtn.dataset.tooltip = isZh ? '跳转至关联记录' : 'Jump to Related History';
            jumpBtn.innerHTML = '<i class="fas fa-external-link-alt"></i>';
            jumpBtn.dataset.url = entry.url;
            jumpBtn.dataset.title = entry.title;
            jumpBtn.dataset.range = range;

            jumpBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (typeof jumpToRelatedHistoryFromRanking === 'function') {
                    jumpToRelatedHistoryFromRanking(entry.url, entry.title, range);
                }
            });

            // 容器也阻止事件冒泡
            jumpBtnContainer.addEventListener('click', (e) => {
                e.stopPropagation();
            });

            jumpBtnContainer.appendChild(jumpBtn);
            header.appendChild(jumpBtnContainer);

            header.appendChild(counts);

            const detail = document.createElement('div');
            detail.className = 'ranking-detail';
            detail.style.display = 'none';

            const lastVisitText = entry.lastVisitTime
                ? new Date(entry.lastVisitTime).toLocaleString()
                : (isZh ? '无访问记录' : 'No visits');

            if (isZh) {
                detail.textContent =
                    `今天：${entry.dayCount} 次，本周：${entry.weekCount} 次，本月：${entry.monthCount} 次，本年：${entry.yearCount} 次；` +
                    `最近访问：${lastVisitText}`;
            } else {
                detail.textContent =
                    `Today: ${entry.dayCount} clicks, This week: ${entry.weekCount} clicks, ` +
                    `This month: ${entry.monthCount} clicks, This year: ${entry.yearCount} clicks; ` +
                    `Last visit: ${lastVisitText}`;
            }

            row.appendChild(header);
            row.appendChild(detail);

            // 整行可点击：展开/收起详细统计，同时打开书签
            row.addEventListener('click', (e) => {
                // 如果直接点击的是标题链接，让浏览器默认打开，不拦截
                if (e.target === titleLink) {
                    return;
                }

                // 如果点击的是跳转按钮或其容器，不执行打开书签操作
                if (e.target.closest('.jump-to-related-btn-container') ||
                    e.target.closest('.jump-to-related-btn')) {
                    return;
                }

                e.preventDefault();

                const visible = detail.style.display === 'block';
                detail.style.display = visible ? 'none' : 'block';

                try {
                    if (browserAPI && browserAPI.tabs && typeof browserAPI.tabs.create === 'function') {
                        browserAPI.tabs.create({ url: entry.url });
                    } else {
                        window.open(entry.url, '_blank');
                    }
                } catch (err) {
                    console.warn('[BrowsingRanking] 打开书签失败:', err);
                }
            });

            container.appendChild(row);
        }

        offset = end;
    };

    appendNextPage();

    // 找到真正的滚动容器（.content-area）
    const scrollContainer = container.closest('.content-area') || container;

    const onScroll = () => {
        if (offset >= items.length) return;
        // 提前加载：使用视口高度的3倍作为阈值，至少1500px
        const threshold = Math.max(1500, scrollContainer.clientHeight * 3);
        if (scrollContainer.scrollTop + scrollContainer.clientHeight + threshold >= scrollContainer.scrollHeight) {
            appendNextPage();
        }
    };

    // 清理旧的监听器
    if (scrollContainer.__browsingRankingScrollHandler) {
        scrollContainer.removeEventListener('scroll', scrollContainer.__browsingRankingScrollHandler);
    }
    scrollContainer.addEventListener('scroll', onScroll);
    scrollContainer.__browsingRankingScrollHandler = onScroll;

    // 暴露懒加载状态和函数，供跳转功能使用
    container.__lazyLoadState = {
        totalItems: items.length,
        getLoadedCount: () => offset,
        loadMore: appendNextPage,
        loadAll: () => {
            while (offset < items.length) {
                appendNextPage();
            }
        }
    };
}

async function loadBrowsingClickRanking(range) {
    const listContainer = document.getElementById('browsingRankingList');
    if (!listContainer) return;

    // 显示加载状态
    const isZh = currentLang === 'zh_CN';
    const loadingText = isZh ? '正在读取历史记录...' : 'Loading history...';
    listContainer.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-clock"></i></div>
            <div class="empty-state-title">${loadingText}</div>
        </div>
    `;

    try {
        const stats = await ensureBrowsingClickRankingStats();

        if (stats.error === 'noHistoryApi') {
            const title = i18n.browsingRankingNotSupportedTitle
                ? i18n.browsingRankingNotSupportedTitle[currentLang]
                : (isZh ? '当前环境不支持历史记录统计' : 'History statistics are not available in this environment');
            const desc = i18n.browsingRankingNotSupportedDesc
                ? i18n.browsingRankingNotSupportedDesc[currentLang]
                : (isZh ? '请确认扩展已获得浏览器的历史记录权限。' : 'Please ensure the extension has permission to access browser history.');

            listContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-ban"></i></div>
                    <div class="empty-state-title">${title}</div>
                    <div class="empty-state-description">${desc}</div>
                </div>
            `;
            return;
        }

        if (stats.error === 'noBookmarks') {
            const title = i18n.browsingRankingNoBookmarksTitle
                ? i18n.browsingRankingNoBookmarksTitle[currentLang]
                : (isZh ? '暂无书签可统计' : 'No bookmarks to analyze');

            listContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-bookmark"></i></div>
                    <div class="empty-state-title">${title}</div>
                </div>
            `;
            return;
        }

        // Ensure view mode is up-to-date before applying keyword logic
        initBrowsingRankingViewMode();

        let items = [];
        let customRangeLabel = null;

        // Phase 4.7: If custom date range is active, compute filteredCount from calendar data.
        if (browsingRankingCustomRange && typeof getBrowsingRankingItemsForCustomRange === 'function') {
            customRangeLabel = browsingRankingCustomRange.label || null;
            items = await getBrowsingRankingItemsForCustomRange(browsingRankingCustomRange.startTime, browsingRankingCustomRange.endTime);
        } else {
            items = getBrowsingRankingItemsForRange(range);

            // 应用二级菜单时间筛选
            if (browsingRankingTimeFilter && items.length > 0) {
                items = filterRankingItemsByTime(items, browsingRankingTimeFilter, stats.boundaries);
            }
        }

        // Phase 4.7: Keyword filter
        // - bookmark mode: filter items directly
        // - folder mode: support folder-name/path matching (filter in folder renderer)
        let folderSearchTokens = null;
        if (browsingRankingSearchTokens && browsingRankingSearchTokens.length > 0) {
            if (browsingRankingViewMode === 'folder') {
                folderSearchTokens = browsingRankingSearchTokens;
            } else {
                items = items.filter(item => matchesTokens(item.title, browsingRankingSearchTokens) || matchesTokens(item.url, browsingRankingSearchTokens));
            }
        }

        // 根据视图模式渲染
        if (browsingRankingViewMode === 'folder') {
            await renderBrowsingFolderRankingList(listContainer, items, range, stats, { customRangeLabel, searchTokens: folderSearchTokens });
        } else {
            renderBrowsingClickRankingList(listContainer, items, range, { customRangeLabel });
        }
    } catch (error) {
        console.error('[BrowsingRanking] 加载点击排行失败:', error);
        const fallbackTitle = isZh ? '加载点击排行失败' : 'Failed to load click ranking';
        listContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-exclamation-circle"></i></div>
                <div class="empty-state-title">${fallbackTitle}</div>
            </div>
        `;
    }
}

function initBrowsingClickRanking() {
    const panel = document.getElementById('browsingRankingPanel');
    if (!panel) return;

    const buttons = panel.querySelectorAll('.ranking-time-filter-btn');
    if (!buttons.length) return;

    // Phase 4.7: Insert filter indicator next to [All]
    try {
        const allBtn = document.getElementById('browsingRankingFilterAll');
        const indicator = ensureSearchFilterIndicator('browsingRankingSearchIndicator', allBtn);
        if (indicator && !indicator.__searchIndicatorBound) {
            indicator.__searchIndicatorBound = true;
            indicator.addEventListener('click', () => {
                const input = document.getElementById('searchInput');
                if (input) {
                    input.focus();
                    // restore query for editing if possible
                    if (browsingRankingSearchQuery) input.value = browsingRankingSearchQuery;
                }
            });
        }
    } catch (_) { }

    const allowedRanges = ['day', 'week', 'month', 'year', 'all'];

    const setActiveRange = (range, shouldPersist = true) => {
        if (!allowedRanges.includes(range)) {
            range = 'month';
        }

        buttons.forEach(btn => {
            if (btn.dataset.range === range) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // 显示时间菜单
        showBrowsingRankingTimeMenu(range);

        loadBrowsingClickRanking(range);

        if (shouldPersist) {
            try {
                localStorage.setItem('browsingRankingActiveRange', range);
            } catch (storageErr) {
                console.warn('[BrowsingRanking] 无法保存筛选范围:', storageErr);
            }
        }
    };

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const range = btn.dataset.range || 'month';
            setActiveRange(range);
        });
    });

    let initialRange = 'day';
    try {
        const saved = localStorage.getItem('browsingRankingActiveRange');
        if (saved && allowedRanges.includes(saved)) {
            initialRange = saved;
        }
    } catch (storageErr) {
        console.warn('[BrowsingRanking] 无法读取筛选范围:', storageErr);
    }

    setActiveRange(initialRange, false);
}

function getActiveBrowsingRankingRange() {
    const panel = document.getElementById('browsingRankingPanel');
    if (!panel) return null;
    const activeBtn = panel.querySelector('.ranking-time-filter-btn.active');
    return activeBtn ? (activeBtn.dataset.range || 'month') : null;
}

// Phase 4.7: allow programmatic switching (search-driven)
function setBrowsingRankingActiveRange(range, shouldPersist = true) {
    const panel = document.getElementById('browsingRankingPanel');
    if (!panel) return;
    const buttons = panel.querySelectorAll('.ranking-time-filter-btn');
    if (!buttons.length) return;

    const allowedRanges = ['day', 'week', 'month', 'year', 'all'];
    if (!allowedRanges.includes(range)) range = 'month';

    buttons.forEach(btn => {
        if (btn.dataset.range === range) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    showBrowsingRankingTimeMenu(range);
    loadBrowsingClickRanking(range);

    if (shouldPersist) {
        try {
            localStorage.setItem('browsingRankingActiveRange', range);
        } catch (_) { }
    }
}

async function refreshActiveBrowsingRankingIfVisible() {
    const panel = document.getElementById('browsingRankingPanel');
    if (!panel || !panel.classList.contains('active')) return;

    // ✨ 等待日历数据同步完成（防止显示空白）
    const waitForCalendarData = async () => {
        const start = Date.now();
        const timeout = 2000; // 2秒超时
        while (Date.now() - start < timeout) {
            const inst = window.browsingHistoryCalendarInstance;
            if (inst && inst.bookmarksByDate && inst.bookmarksByDate.size > 0) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    };

    const dataReady = await waitForCalendarData();
    if (!dataReady) {
        console.warn('[BrowsingRanking] 等待日历数据超时');
    }

    const range = getActiveBrowsingRankingRange() || 'month';
    loadBrowsingClickRanking(range);
}

// Phase 4.7: Ranking/Related filter APIs (called by search.js)
function isBrowsingRankingSearchActive() {
    return Boolean((browsingRankingCustomRange && browsingRankingCustomRange.startTime) || (browsingRankingSearchTokens && browsingRankingSearchTokens.length));
}

function isBrowsingRelatedSearchActive() {
    return Boolean(
        browsingRelatedExpandMode ||
        (browsingRelatedCustomBounds && browsingRelatedCustomBounds.startTime) ||
        (browsingRelatedSearchTokens && browsingRelatedSearchTokens.length)
    );
}

function applyBrowsingRankingIndicatorState() {
    try {
        const allBtn = document.getElementById('browsingRankingFilterAll');
        ensureSearchFilterIndicator('browsingRankingSearchIndicator', allBtn);
        const active = isBrowsingRankingSearchActive();
        // If list is currently empty, don't show the green outline.
        setListSearchFilterHighlight('browsingRankingList', active, { requireNonEmpty: true });

        if (!active) {
            setSearchFilterIndicatorState('browsingRankingSearchIndicator', false);
            return;
        }
        const label = browsingRankingCustomRange
            ? browsingRankingCustomRange.label
            : (browsingRankingSearchQuery ? `"${browsingRankingSearchQuery}"` : '');
        setSearchFilterIndicatorState('browsingRankingSearchIndicator', true, label);
    } catch (_) { }
}

function applyBrowsingRelatedIndicatorState() {
    try {
        const allBtn = document.getElementById('browsingRelatedFilterAll');
        ensureSearchFilterIndicator('browsingRelatedSearchIndicator', allBtn);
        const active = isBrowsingRelatedSearchActive();
        setListSearchFilterHighlight('browsingRelatedList', active);

        if (!active) {
            setSearchFilterIndicatorState('browsingRelatedSearchIndicator', false);
            return;
        }
        const label = browsingRelatedCustomBounds
            ? browsingRelatedCustomBounds.label
            : (browsingRelatedSearchQuery
                ? `"${browsingRelatedSearchQuery}"`
                : (browsingRelatedExpandMode ? getBrowsingRelatedScopeLabel() : ''));
        setSearchFilterIndicatorState('browsingRelatedSearchIndicator', true, label);
    } catch (_) { }
}

function clearBrowsingRankingSearchFilter(restorePrev = true) {
    if (restorePrev && browsingRankingSearchPrevState) {
        const prev = browsingRankingSearchPrevState;
        browsingRankingSearchPrevState = null;

        browsingRankingCustomRange = prev.customRange || null;
        browsingRankingSearchTokens = prev.tokens || null;
        browsingRankingSearchQuery = prev.query || '';

        // Restore range + view mode + time filter
        if (prev.viewMode === 'folder' || prev.viewMode === 'bookmark') {
            browsingRankingViewMode = prev.viewMode;
        }

        setBrowsingRankingActiveRange(prev.range || 'month', false);
        browsingRankingTimeFilter = prev.timeFilter || null;
        loadBrowsingClickRanking(prev.range || 'month');
    } else {
        browsingRankingSearchPrevState = null;
        browsingRankingSearchQuery = '';
        browsingRankingSearchTokens = null;
        browsingRankingCustomRange = null;
        const range = getActiveBrowsingRankingRange() || 'month';
        loadBrowsingClickRanking(range);
    }

    applyBrowsingRankingIndicatorState();
    if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();
}

function clearBrowsingRelatedSearchFilter(restorePrev = true) {
    if (restorePrev && browsingRelatedSearchPrevState) {
        const prev = browsingRelatedSearchPrevState;
        browsingRelatedSearchPrevState = null;

        browsingRelatedCustomBounds = prev.customBounds || null;
        browsingRelatedSearchTokens = prev.tokens || null;
        browsingRelatedSearchQuery = prev.query || '';
        browsingRelatedExpandMode = false;

        // Restore range + time filter
        if (prev.range) {
            setBrowsingRelatedActiveRange(prev.range, false);
        } else {
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
        }
        browsingRelatedTimeFilter = prev.timeFilter || null;
        loadBrowsingRelatedHistory(prev.range || browsingRelatedCurrentRange);
    } else {
        browsingRelatedSearchPrevState = null;
        browsingRelatedSearchQuery = '';
        browsingRelatedSearchTokens = null;
        browsingRelatedCustomBounds = null;
        browsingRelatedExpandMode = false;
        browsingRelatedExpandSavedQuery = '';
        browsingRelatedExpandSavedTokens = null;
        loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
    }

    applyBrowsingRelatedIndicatorState();
    if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();
}

// Phase 4.7: when leaving ranking/related/tracking pages, auto exit to keep isolation
function autoExitSearchFiltersOnContextChange(prevCtx, nextCtx) {
    try {
        const prev = prevCtx || {};
        const next = nextCtx || {};

        const prevIsRanking = prev.view === 'additions' && prev.tab === 'browsing' && prev.subTab === 'ranking';
        const prevIsRelated = prev.view === 'additions' && prev.tab === 'browsing' && prev.subTab === 'related';
        const prevIsTracking = prev.view === 'additions' && prev.tab === 'tracking';

        const nextIsRanking = next.view === 'additions' && next.tab === 'browsing' && next.subTab === 'ranking';
        const nextIsRelated = next.view === 'additions' && next.tab === 'browsing' && next.subTab === 'related';
        const nextIsTracking = next.view === 'additions' && next.tab === 'tracking';

        if (prevIsRanking && !nextIsRanking && isBrowsingRankingSearchActive()) {
            clearBrowsingRankingSearchFilter(true);
        }
        if (prevIsRelated && !nextIsRelated) {
            // 离开关联记录页面时，无条件隐藏「显示当天关联记录」按钮
            setShowTodayRelatedVisible(false);
            if (isBrowsingRelatedSearchActive()) {
                clearBrowsingRelatedSearchFilter(true);
            }
        }
        // Phase 4.7: 时间捕捉页面离开时自动退出筛选
        if (prevIsTracking && !nextIsTracking && isTrackingRankingSearchActive()) {
            clearTrackingRankingSearchFilter();
        }

        // 确保退出按钮状态正确更新
        if (typeof window.updateSearchFilterExitButton === 'function') {
            setTimeout(() => window.updateSearchFilterExitButton(), 0);
        }
    } catch (_) { }
}

try {
    window.autoExitSearchFiltersOnContextChange = autoExitSearchFiltersOnContextChange;
} catch (_) { }

function setBrowsingRelatedActiveRange(range, shouldPersist = true) {
    const panel = document.getElementById('browsingRelatedPanel');
    if (!panel) return;
    const buttons = panel.querySelectorAll('.ranking-time-filter-btn');
    if (!buttons.length) return;

    const allowedRanges = ['day', 'week', 'month', 'year', 'all'];
    if (!allowedRanges.includes(range)) range = 'day';

    browsingRelatedCurrentRange = range;

    buttons.forEach(btn => {
        if (btn.dataset.range === range) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    showBrowsingRelatedTimeMenu(range);
    loadBrowsingRelatedHistory(range);

    if (shouldPersist) {
        try {
            localStorage.setItem('browsingRelatedActiveRange', range);
        } catch (_) { }
    }

    try {
        if (typeof window.updateSearchFilterExitButton === 'function') {
            window.updateSearchFilterExitButton();
        }
    } catch (_) { }
}

try {
    window.setBrowsingRankingActiveRange = setBrowsingRankingActiveRange;
    window.setBrowsingRelatedActiveRange = setBrowsingRelatedActiveRange;
    // Phase 4.7: Export filter state check functions for blur exit
    window.isBrowsingRankingSearchActive = isBrowsingRankingSearchActive;
    window.isBrowsingRelatedSearchActive = isBrowsingRelatedSearchActive;
} catch (_) { }

try {
    window.applyBrowsingRankingKeywordFilter = (query, tokens) => {
        const q = String(query || '').trim();
        browsingRankingSearchQuery = q;
        browsingRankingSearchTokens = Array.isArray(tokens) ? tokens : null;

        if (!browsingRankingSearchPrevState && !browsingRankingCustomRange) {
            browsingRankingSearchPrevState = {
                range: getActiveBrowsingRankingRange() || 'month',
                timeFilter: browsingRankingTimeFilter ? { ...browsingRankingTimeFilter } : null,
                viewMode: browsingRankingViewMode,
                tokens: null,
                query: '',
                customRange: null
            };
        }

        applyBrowsingRankingIndicatorState();
        if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();

        const range = getActiveBrowsingRankingRange() || 'month';
        loadBrowsingClickRanking(range);
    };

    window.applyBrowsingRankingDateRangeFilter = (bounds, options = {}) => {
        if (!bounds || typeof bounds.startTime !== 'number' || typeof bounds.endTime !== 'number') return;

        if (!browsingRankingSearchPrevState) {
            browsingRankingSearchPrevState = {
                range: getActiveBrowsingRankingRange() || 'month',
                timeFilter: browsingRankingTimeFilter ? { ...browsingRankingTimeFilter } : null,
                viewMode: browsingRankingViewMode,
                tokens: browsingRankingSearchTokens,
                query: browsingRankingSearchQuery,
                customRange: browsingRankingCustomRange
            };
        }

        browsingRankingCustomRange = {
            startTime: bounds.startTime,
            endTime: bounds.endTime,
            label: bounds.label || (options.rawQuery || '')
        };
        browsingRankingSearchQuery = options.rawQuery || bounds.label || '';
        browsingRankingSearchTokens = null;
        browsingRankingTimeFilter = null;

        applyBrowsingRankingIndicatorState();
        if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();

        // Use [All] as a neutral base range
        setBrowsingRankingActiveRange('all', false);
    };

    window.applyBrowsingRelatedKeywordFilter = (query, tokens) => {
        const q = String(query || '').trim();
        browsingRelatedSearchQuery = q;
        browsingRelatedSearchTokens = Array.isArray(tokens) ? tokens : null;
        browsingRelatedExpandMode = false;
        browsingRelatedExpandSavedQuery = '';
        browsingRelatedExpandSavedTokens = null;

        if (!browsingRelatedSearchPrevState && !browsingRelatedCustomBounds) {
            browsingRelatedSearchPrevState = {
                range: browsingRelatedCurrentRange,
                timeFilter: browsingRelatedTimeFilter ? { ...browsingRelatedTimeFilter } : null,
                tokens: null,
                query: '',
                customBounds: null
            };
        }

        applyBrowsingRelatedIndicatorState();
        if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();

        loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
    };

    window.applyBrowsingRelatedDateRangeFilter = (bounds, options = {}) => {
        if (!bounds || typeof bounds.startTime !== 'number' || typeof bounds.endTime !== 'number') return;

        if (!browsingRelatedSearchPrevState) {
            browsingRelatedSearchPrevState = {
                range: browsingRelatedCurrentRange,
                timeFilter: browsingRelatedTimeFilter ? { ...browsingRelatedTimeFilter } : null,
                tokens: browsingRelatedSearchTokens,
                query: browsingRelatedSearchQuery,
                customBounds: browsingRelatedCustomBounds
            };
        }

        browsingRelatedCustomBounds = {
            startTime: bounds.startTime,
            endTime: bounds.endTime,
            label: bounds.label || (options.rawQuery || '')
        };
        browsingRelatedSearchQuery = options.rawQuery || bounds.label || '';
        browsingRelatedSearchTokens = null;
        browsingRelatedExpandMode = false;
        browsingRelatedExpandSavedQuery = '';
        browsingRelatedExpandSavedTokens = null;
        browsingRelatedTimeFilter = null;

        applyBrowsingRelatedIndicatorState();
        if (typeof window.updateSearchFilterExitButton === 'function') window.updateSearchFilterExitButton();

        // Use [All] as a neutral base range
        setBrowsingRelatedActiveRange('all', false);
    };

    window.exitSearchFilter = () => {
        const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};
        if (ctx && ctx.view === 'additions') {
            if (ctx.tab === 'browsing') {
                if (ctx.subTab === 'ranking') {
                    clearBrowsingRankingSearchFilter(true);
                    return;
                }
                if (ctx.subTab === 'related') {
                    clearBrowsingRelatedSearchFilter(true);
                    return;
                }
            } else if (ctx.tab === 'tracking') {
                // Phase 4.7: 时间捕捉搜索筛选
                clearTrackingRankingSearchFilter();
                return;
            }
        }

        // Fallback: clear whichever is active
        if (isBrowsingRankingSearchActive()) clearBrowsingRankingSearchFilter(true);
        if (isBrowsingRelatedSearchActive()) clearBrowsingRelatedSearchFilter(true);
        if (isTrackingRankingSearchActive()) clearTrackingRankingSearchFilter();
    };

    window.showTodayBrowsingRelated = () => {
        try {
            // In related page, this button is an "expand" action:
            // when we are in keyword-filter mode, show ALL records within the CURRENT scope
            // (current range + optional secondary time menu selection).

            // Toggle behavior:
            // - First click: expand (remove keyword filter)
            // - Second click: restore keyword filter (no need to use Exit)

            if (browsingRelatedExpandMode) {
                browsingRelatedExpandMode = false;
                if (browsingRelatedExpandSavedTokens && browsingRelatedExpandSavedTokens.length > 0) {
                    browsingRelatedSearchTokens = browsingRelatedExpandSavedTokens;
                    browsingRelatedSearchQuery = browsingRelatedExpandSavedQuery || '';
                }
                browsingRelatedExpandSavedTokens = null;
                browsingRelatedExpandSavedQuery = '';

                applyBrowsingRelatedIndicatorState();
                loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
                return;
            }

            // Capture prev state once so Exit Filter can restore.
            if (!browsingRelatedSearchPrevState) {
                browsingRelatedSearchPrevState = {
                    range: browsingRelatedCurrentRange,
                    timeFilter: browsingRelatedTimeFilter ? { ...browsingRelatedTimeFilter } : null,
                    tokens: browsingRelatedSearchTokens,
                    query: browsingRelatedSearchQuery,
                    customBounds: browsingRelatedCustomBounds
                };
            }

            // Save current keyword filter for restoring on second click
            browsingRelatedExpandSavedTokens = browsingRelatedSearchTokens;
            browsingRelatedExpandSavedQuery = browsingRelatedSearchQuery;

            // Clear ONLY keyword filter; keep range/time menu selection.
            browsingRelatedSearchTokens = null;
            browsingRelatedSearchQuery = '';
            browsingRelatedExpandMode = true;

            applyBrowsingRelatedIndicatorState();
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);

            if (typeof window.updateSearchFilterExitButton === 'function') {
                window.updateSearchFilterExitButton();
            }
        } catch (e) {
            console.warn('[BrowsingRelated] showTodayBrowsingRelated failed:', e);
        }
    };

    window.updateSearchFilterExitButton = () => {
        try {
            const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};
            const isZh = currentLang === 'zh_CN';
            const btn = ensureExitSearchFilterButton();
            if (!btn) return;

            const todayBtn = ensureShowTodayRelatedButton();

            let visible = false;
            if (ctx && ctx.view === 'additions') {
                if (ctx.tab === 'browsing') {
                    if (ctx.subTab === 'ranking') visible = isBrowsingRankingSearchActive();
                    if (ctx.subTab === 'related') visible = isBrowsingRelatedSearchActive();
                } else if (ctx.tab === 'tracking') {
                    // Phase 4.7: 时间捕捉搜索筛选
                    visible = isTrackingRankingSearchActive();
                }
            }

            if (!visible) {
                setExitSearchFilterVisible(false);
                setShowTodayRelatedVisible(false);
                return;
            }

            btn.innerHTML = isZh
                ? '<i class="fas fa-times"></i><span>退出筛选</span>'
                : '<i class="fas fa-times"></i><span>Exit filter</span>';
            setExitSearchFilterVisible(true);

            // Phase 4.7: Related quick action
            if (ctx && ctx.view === 'additions' && ctx.tab === 'browsing' && ctx.subTab === 'related') {
                if (todayBtn) {
                    const rangeLabel = getBrowsingRelatedScopeLabel();
                    const iconClass = browsingRelatedExpandMode ? 'fas fa-check-square' : 'fas fa-square';
                    todayBtn.innerHTML = isZh
                        ? `<i class="${iconClass}"></i><span>显示${rangeLabel}关联记录</span>`
                        : `<i class="${iconClass}"></i><span>Show ${rangeLabel} related</span>`;

                    todayBtn.classList.toggle('checked', Boolean(browsingRelatedExpandMode));
                    todayBtn.setAttribute('aria-pressed', browsingRelatedExpandMode ? 'true' : 'false');
                }
                setShowTodayRelatedVisible(true);
            } else {
                setShowTodayRelatedVisible(false);
            }
        } catch (_) { }
    };
} catch (_) { }

document.addEventListener('browsingHistoryCacheUpdated', () => {
    console.log('[Event] browsingHistoryCacheUpdated 触发，刷新所有浏览记录相关页面');
    browsingClickRankingStats = null;
    refreshActiveBrowsingRankingIfVisible();
    refreshBrowsingRelatedHistory(); // 同时刷新书签关联页面
});

function groupBookmarksByTime(bookmarks, timeFilter) {
    const groups = {};

    bookmarks.forEach(bookmark => {
        const date = new Date(bookmark.dateAdded);
        let groupKey;

        switch (timeFilter) {
            case 'year':
                groupKey = date.getFullYear().toString();
                break;
            case 'month':
                groupKey = currentLang === 'zh_CN'
                    ? `${date.getFullYear()}年${date.getMonth() + 1}月`
                    : `${date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}`;
                break;
            case 'day':
            case 'all':
            default:
                groupKey = date.toLocaleDateString(currentLang === 'en' ? 'en-US' : 'zh-CN');
                break;
        }

        if (!groups[groupKey]) {
            groups[groupKey] = [];
        }
        groups[groupKey].push(bookmark);
    });

    return groups;
}

// 保留旧函数用于兼容
function groupBookmarksByDate(bookmarks) {
    return groupBookmarksByTime(bookmarks, 'day');
}

function filterBookmarks(groups) {
    return groups;
}

function renderBookmarkGroups(groups, timeFilter) {
    const sortedDates = Object.keys(groups).sort((a, b) => {
        // 根据timeFilter决定排序方式
        if (timeFilter === 'year') {
            return parseInt(b) - parseInt(a);
        }
        return new Date(b) - new Date(a);
    });

    return sortedDates.map((date, index) => {
        const bookmarks = groups[date];
        const groupId = `group-${index}`;
        // 默认折叠
        const isExpanded = false;

        return `
            <div class="addition-group" data-group-id="${groupId}">
                <div class="addition-group-header" data-group-id="${groupId}">
                    <div class="addition-group-title">
                        <i class="fas fa-chevron-right addition-group-toggle ${isExpanded ? 'expanded' : ''}"></i>
                        <span class="addition-group-date">${date}</span>
                        <span class="addition-count">${bookmarks.length} ${i18n.bookmarks[currentLang]}</span>
                    </div>
                </div>
                <div class="addition-items ${isExpanded ? 'expanded' : ''}" data-group-id="${groupId}">
                    ${bookmarks.map(renderBookmarkItem).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// 绑定折叠/展开事件
function attachAdditionGroupEvents() {
    document.querySelectorAll('.addition-group-header').forEach(header => {
        header.addEventListener('click', (e) => {
            const groupId = header.getAttribute('data-group-id');
            const items = document.querySelector(`.addition-items[data-group-id="${groupId}"]`);
            const toggle = header.querySelector('.addition-group-toggle');

            if (items && toggle) {
                items.classList.toggle('expanded');
                toggle.classList.toggle('expanded');
            }
        });
    });
}

function renderBookmarkItem(bookmark) {
    const favicon = getFaviconUrl(bookmark.url);

    return `
        <div class="addition-item" data-bookmark-url="${escapeHtml(bookmark.url)}">
            <img class="addition-icon" src="${favicon}" alt="">
            <div class="addition-info">
                <a href="${escapeHtml(bookmark.url)}" target="_blank" class="addition-title" rel="noopener noreferrer">${escapeHtml(bookmark.title)}</a>
                <div class="addition-url">${escapeHtml(bookmark.url)}</div>
            </div>
        </div>
    `;
}

// =============================================================================
// 搜索功能（核心逻辑已移动到 search/search.js）
// =============================================================================

// NOTE:
// 顶部搜索框在多个视图/子标签共用。
// 这里做“请求隔离 + 防抖取消”，避免：
// - 用户清空输入 / 切换视图后，旧的 debounce 回调仍执行，导致候选列表“串台”
// - 首次进入页面/快捷键进入/刷新时，初始化时序导致的旧状态残留

let mainSearchDebounceTimer = null;
let mainSearchDebounceSeq = 0;

function getMainSearchContextKey() {
    const view = (typeof currentView === 'string' && currentView) ? currentView : 'unknown';
    try {
        const ctx = window.SearchContextManager && window.SearchContextManager.currentContext
            ? window.SearchContextManager.currentContext
            : null;
        if (ctx && typeof ctx === 'object') {
            const parts = [ctx.view || view, ctx.tab, ctx.subTab].filter(Boolean);
            if (parts.length) return parts.join('|');
        }
    } catch (_) { }
    return view;
}

function cancelPendingMainSearchDebounce() {
    try {
        if (mainSearchDebounceTimer) {
            clearTimeout(mainSearchDebounceTimer);
            mainSearchDebounceTimer = null;
        }
    } catch (_) { }
    // bump seq so any already-scheduled closures become stale
    mainSearchDebounceSeq += 1;
}

try {
    window.cancelPendingMainSearchDebounce = cancelPendingMainSearchDebounce;
} catch (_) { }

function handleSearch(e) {
    const inputEl = e && e.target;
    const raw = (inputEl && typeof inputEl.value === 'string') ? inputEl.value : '';
    const normalizedQuery = raw.trim().toLowerCase();

    // 清空输入：立即执行清理，且取消所有排队的搜索
    if (!normalizedQuery) {
        cancelPendingMainSearchDebounce();
        performSearch('');
        return;
    }

    const seq = (mainSearchDebounceSeq += 1);
    const scheduledContextKey = getMainSearchContextKey();

    if (mainSearchDebounceTimer) clearTimeout(mainSearchDebounceTimer);
    mainSearchDebounceTimer = setTimeout(() => {
        // 1) 新的输入事件已经触发，旧回调作废
        if (seq !== mainSearchDebounceSeq) return;

        // 2) 切换了视图/子标签：作废（避免候选列表串台）
        if (scheduledContextKey !== getMainSearchContextKey()) return;

        // 3) 输入框内容已变化：作废（避免输入已清空但旧结果仍渲染）
        const currentInput = document.getElementById('searchInput');
        const currentNormalized = (currentInput && typeof currentInput.value === 'string')
            ? currentInput.value.trim().toLowerCase()
            : '';
        if (currentNormalized !== normalizedQuery) return;

        performSearch(normalizedQuery);
    }, 260);
}

function performSearch(query) {
    if (!query) {
        hideSearchResultsPanel();
        return;
    }

    // 根据当前视图执行搜索（仅 Additions / Recommend）
    switch (currentView) {
        case 'additions':
            if (typeof window.searchBookmarkAdditionsAndRender === 'function') {
                window.searchBookmarkAdditionsAndRender(query);
            } else {
                searchAdditions(query);
            }
            break;
        case 'recommend':
            if (typeof window.searchBookmarkRecommendAndRender === 'function') {
                window.searchBookmarkRecommendAndRender(query);
            } else {
                hideSearchResultsPanel();
            }
            break;
    }
}

function searchAdditions(query) {
    const filtered = allBookmarks.filter(bookmark => {
        const title = (bookmark.title || '').toLowerCase();
        const url = (bookmark.url || '').toLowerCase();
        return title.includes(query) || url.includes(query);
    });

    const groupedByDate = groupBookmarksByDate(filtered);
    const container = document.getElementById('additionsList');
    if (container) {
        container.innerHTML = renderBookmarkGroups(groupedByDate);
    }
}

// =============================================================================
// 主题和语言切换
// =============================================================================

// 主题和语言切换 - 独立设置，主UI优先
// 设置覆盖后会显示重置按钮

function toggleTheme() {
    currentTheme = currentTheme === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', currentTheme);

    // 设置覆盖标志
    try {
        localStorage.setItem('historyViewerHasCustomTheme', 'true');
        localStorage.setItem('historyViewerCustomTheme', currentTheme);
        console.log('[History Viewer] 设置主题覆盖:', currentTheme);
    } catch (e) {
        console.error('[History Viewer] 无法保存主题覆盖:', e);
    }

    // 更新图标
    const icon = document.querySelector('#themeToggle i');
    if (icon) {
        icon.className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
    }
}

function toggleLanguage() {
    currentLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
    window.currentLang = currentLang; // 同步到 window

    // 设置覆盖标志
    try {
        localStorage.setItem('historyViewerHasCustomLang', 'true');
        localStorage.setItem('historyViewerCustomLang', currentLang);
        console.log('[History Viewer] 设置语言覆盖:', currentLang);
    } catch (e) {
        console.error('[History Viewer] 无法保存语言覆盖:', e);
    }

    applyLanguage();

    // 只更新界面文字，不重新渲染内容（避免图标重新加载）
    // renderCurrentView();

    // 手动更新需要多语言的UI元素（不涉及书签树内容）
    updateLanguageDependentUI();

    // [User Request] 更新搜索组件语言
    if (typeof window.updateSearchUILanguage === 'function') {
        window.updateSearchUILanguage();
    }

    // 复习热力图：重新加载一次以应用当前语言
    // 只影响热力图容器，不会重新加载书签图标
    try {
        loadHeatmapData();
    } catch (e) {
        console.warn('[Heatmap] 语言切换时重载失败:', e);
    }

    // 刷新书签关联记录列表（更新badge文字）
    refreshBrowsingRelatedHistory();
}

// 更新依赖语言的UI元素（不重新渲染内容，避免图标重新加载）
function updateLanguageDependentUI() {
    const isEn = currentLang === 'en';

    // 更新加载文本（如果存在）
    const loadingTexts = document.querySelectorAll('.loading');
    loadingTexts.forEach(el => {
        if (el.textContent.includes('Loading') || el.textContent.includes('加载中')) {
            el.textContent = i18n.loading[currentLang];
        }
    });

    // 更新空状态文本
    const emptyStates = document.querySelectorAll('.empty-state');
    emptyStates.forEach(el => {
        if (el.textContent.includes('No') || el.textContent.includes('没有')) {
            el.textContent = isEn ? 'No data' : '没有数据';
        }
    });

    // 5. 更新书签关联记录排序按钮的tooltip
    const relatedSortBtn = document.getElementById('browsingRelatedSortBtn');
    if (relatedSortBtn) {
        const tooltip = relatedSortBtn.querySelector('.btn-tooltip');
        if (tooltip) {
            tooltip.textContent = browsingRelatedSortAsc
                ? (i18n.currentAscending?.[currentLang] || (isEn ? 'Current: Ascending' : '当前：正序'))
                : (i18n.currentDescending?.[currentLang] || (isEn ? 'Current: Descending' : '当前：倒序'));
        }
    }

    console.log('[toggleLanguage] 已更新UI文字');
}

// =============================================================================
// 实时更新
// =============================================================================

function handleStorageChange(changes, namespace) {
    if (namespace !== 'local') return;

    console.log('[存储监听] 检测到变化:', Object.keys(changes));

    // 书签数据变化时，刷新当前视图数据
    if (changes.lastBookmarkData || changes.lastSyncOperations || changes.lastSyncTime) {
        // 推荐搜索索引依赖书签树，变更时需要失效（避免搜索结果仍是旧书签）
        try {
            if (typeof window.invalidateRecommendSearchIndex === 'function') {
                window.invalidateRecommendSearchIndex();
            }
        } catch (_) { }

        loadAllData({ skipRender: true }).then(() => {
            renderCurrentView();
        }).catch((e) => {
            console.warn('[存储监听] 数据刷新失败:', e);
        });
    }

    // S 值缓存变化时，刷新推荐搜索索引
    if (changes.recommend_scores_cache) {
        try {
            if (typeof window.invalidateRecommendSearchIndex === 'function') {
                window.invalidateRecommendSearchIndex();
            }
            if (typeof window.refreshRecommendSearchIfNeeded === 'function') {
                window.refreshRecommendSearchIfNeeded();
            }
        } catch (_) { }
    }

    // 主题变化（只在没有覆盖设置时跟随主UI）
    if (changes.currentTheme && !hasThemeOverride()) {
        const newTheme = changes.currentTheme.newValue;
        console.log('[存储监听] 主题变化，跟随主UI:', newTheme);
        currentTheme = newTheme;
        document.documentElement.setAttribute('data-theme', currentTheme);

        // 更新主题切换按钮图标
        const icon = document.querySelector('#themeToggle i');
        if (icon) {
            icon.className = currentTheme === 'dark' ? 'fas fa-sun' : 'fas fa-moon';
        }
    }

    // 语言变化（只在没有覆盖设置时跟随主UI）
    if (changes.preferredLang && !hasLangOverride()) {
        const newLang = changes.preferredLang.newValue;
        console.log('[存储监听] 语言变化，跟随主UI:', newLang);
        currentLang = newLang;
        window.currentLang = currentLang; // 同步到 window

        // 更新语言切换按钮文本
        const langText = document.querySelector('#langToggle .lang-text');
        if (langText) {
            langText.textContent = currentLang === 'zh_CN' ? 'EN' : '中';
        }

        // 应用新语言到所有UI元素
        applyLanguage();

        // 重新渲染当前视图以应用语言
        renderCurrentView();

        // 刷新书签关联记录列表（更新badge文字）
        refreshBrowsingRelatedHistory();
    }

    // 翻牌历史变化（用于实时刷新热力图）
    if (changes.flipHistory && currentView === 'recommend') {
        loadHeatmapData();
    }
}


// =============================================================================
// 书签API监听（实时更新书签数据）
// =============================================================================

function setupBookmarkListener() {
    if (!browserAPI.bookmarks) {
        console.warn('[书签监听] 书签API不可用');
        return;
    }

    console.log('[书签监听] 设置书签API监听器');

    // 书签创建
browserAPI.bookmarks.onCreated.addListener(async (id, bookmark) => {
        console.log('[书签监听] 书签创建:', bookmark.title);
        try {
            addBookmarkToAdditionsCache(bookmark);
            // S值计算由background.js的bookmarks.onCreated监听器处理
            // 书签集合变化会影响「点击记录」「点击排行」「书签关联记录」
            // 这里使用全量重建（仅限最近一年的历史，内部有lookback与去重）
            scheduleHistoryRefresh({ forceFull: true });
        } catch (e) {
            // 仅记录错误，不触发完全刷新以避免页面闪烁和滚动位置丢失
            console.warn('[书签监听] onCreated 处理异常:', e);
        }
    });

    // 书签删除
browserAPI.bookmarks.onRemoved.addListener(async (id, removeInfo) => {
        console.log('[书签监听] 书签删除:', id);
        try {
            removeBookmarkFromAdditionsCache(id);
            // 从S值缓存中删除该书签
            if (typeof removeCachedScore === 'function') {
                await removeCachedScore(id);
            }
            // 删除对应的 favicon 缓存
            // removeInfo.node 包含被删除书签的信息（包括 URL）
            if (removeInfo.node && removeInfo.node.url) {
                FaviconCache.clear(removeInfo.node.url);
            }

            // 书签被删除后，对应的点击记录与排行需要重算
            scheduleHistoryRefresh({ forceFull: true });
        } catch (e) {
            // 仅记录错误，不触发完全刷新以避免页面闪烁和滚动位置丢失
            console.warn('[书签监听] onRemoved 处理异常:', e);
        }
    });

    // 书签修改
browserAPI.bookmarks.onChanged.addListener(async (id, changeInfo) => {
        console.log('[书签监听] 书签修改:', changeInfo);
        try {
            updateBookmarkInAdditionsCache(id, changeInfo);

            // URL或标题变化时，清除T值缓存并重算S值
            if (changeInfo.url || changeInfo.title) {
                // P10修复：书签URL/标题变化时，清除整个T值缓存以确保正确性
                // 因为无法可靠获取修改前的旧URL/标题，直接让缓存重新加载
                if (trackingRankingCache.loaded) {
                    clearTrackingRankingCache();
                    console.log('[书签修改] 已清除T值缓存（URL或标题变化）');
                }
                // 发消息给background.js重新计算该书签的S值
                browserAPI.runtime.sendMessage({ action: 'updateBookmarkScore', bookmarkId: id });
                console.log('[书签修改] 已请求background更新S值:', id);
            }

            // 书签URL或标题变化会影响匹配结果，重建最近一年的点击记录
            scheduleHistoryRefresh({ forceFull: true });
        } catch (e) {
            // 仅记录错误，不触发完全刷新以避免页面闪烁和滚动位置丢失
            console.warn('[书签监听] onChanged 处理异常:', e);
        }
    });

    // 书签移动
browserAPI.bookmarks.onMoved.addListener(async (id, moveInfo) => {
        console.log('[书签监听] 书签移动:', id);

        try {
            moveBookmarkInAdditionsCache(id, moveInfo);
        } catch (e) {
            // 仅记录错误，不触发完全刷新以避免页面闪烁和滚动位置丢失
            console.warn('[书签监听] onMoved 处理异常:', e);
        }
    });
}

// =============================================================================
// 消息监听
// =============================================================================

function setupRealtimeMessageListener() {
    if (typeof messageListenerRegistered !== 'undefined' && messageListenerRegistered) return;
    messageListenerRegistered = true;

    browserAPI.runtime.onMessage.addListener((message) => {
        if (!message || !message.action) return;

        if (message.action === 'trackingDataUpdated') {
            // T值数据更新，增量更新缓存
            if (message.url || message.title) {
                // 增量更新缓存（不清除整个缓存，只更新变化的条目）
                if (trackingRankingCache.loaded) {
                    const stat = {
                        url: message.url,
                        title: message.title,
                        compositeMs: message.compositeMs || 0
                    };
                    // 累加到现有值（如果已存在）
                    if (message.url && trackingRankingCache.byUrl.has(message.url)) {
                        const existing = trackingRankingCache.byUrl.get(message.url);
                        stat.compositeMs = existing.compositeMs + (message.compositeMs || 0);
                    } else if (message.title && trackingRankingCache.byTitle.has(message.title)) {
                        const existing = trackingRankingCache.byTitle.get(message.title);
                        stat.compositeMs = existing.compositeMs + (message.compositeMs || 0);
                    }
                    // 更新双索引
                    if (message.title) {
                        trackingRankingCache.byTitle.set(message.title, stat);
                    }
                    if (message.url) {
                        trackingRankingCache.byUrl.set(message.url, stat);
                    }
                    console.log('[T值缓存] 增量更新:', message.title || message.url);
                }

                // T值变化后，发消息给background.js触发S值增量更新
                // background.js也会监听trackingDataUpdated，即使html页面没打开也能更新
                if (message.url) {
                    browserAPI.runtime.sendMessage({ action: 'updateBookmarkScoreByUrl', url: message.url });
                }
            }
        } else if (message.action === 'clearFaviconCache') {
            // 书签URL被修改，清除favicon缓存（静默）
            if (message.url) {
                FaviconCache.clear(message.url);
            }
        } else if (message.action === 'updateFaviconFromTab') {
            // 从打开的 tab 更新 favicon（静默）
            if (message.url && message.favIconUrl) {
                FaviconCache.save(message.url, message.favIconUrl).then(() => {
                    // 更新页面上对应的 favicon 图标
                    updateFaviconImages(message.url, message.favIconUrl);
                }).catch(() => {
                    // 静默处理错误
                });
            }
        } else if (message.action === 'clearLocalStorage') {
            // 收到来自 background.js 的清除 localStorage 请求（"恢复到初始状态"功能）
            console.log('[history.js] 收到清除 localStorage 请求');
            try {
                localStorage.clear();
                console.log('[history.js] localStorage 已清除');
            } catch (e) {
                console.warn('[history.js] 清除 localStorage 失败:', e);
            }
        }
    });
}

// =============================================================================
// 书签关联记录功能（浏览器历史记录 + 书签标识）
// 复用「点击记录」的 browsingHistoryCalendarInstance.bookmarksByDate 数据库
// ============================================================================

let browsingRelatedSortAsc = false; // 排序方式：false=倒序（新到旧），true=正序（旧到新）
let browsingRelatedCurrentRange = 'day'; // 当前选中的时间范围
let browsingRelatedBookmarkUrls = null; // 缓存的书签URL集合（用于标识）
let browsingRelatedBookmarkTitles = null; // 缓存的书签标题集合（用于标识）
let browsingRelatedBookmarkInfo = null; // 缓存的书签URL->标题映射（用于统计与展示）

// 初始化书签关联记录
function initBrowsingRelatedHistory() {
    const panel = document.getElementById('browsingRelatedPanel');
    if (!panel) return;

    const buttons = panel.querySelectorAll('.ranking-time-filter-btn');
    const sortBtn = document.getElementById('browsingRelatedSortBtn');
    if (!buttons.length) return;

    // Phase 4.7: Insert filter indicator next to [All] (before sort button)
    try {
        const allBtn = document.getElementById('browsingRelatedFilterAll');
        const indicator = ensureSearchFilterIndicator('browsingRelatedSearchIndicator', allBtn);
        if (indicator && !indicator.__searchIndicatorBound) {
            indicator.__searchIndicatorBound = true;
            indicator.addEventListener('click', () => {
                const input = document.getElementById('searchInput');
                if (input) {
                    input.focus();
                    if (browsingRelatedSearchQuery) input.value = browsingRelatedSearchQuery;
                }
            });
        }

        // If sort button exists and indicator was inserted after All button,
        // keep sort button at the end.
        if (indicator && sortBtn && indicator.nextSibling !== sortBtn) {
            // no-op: DOM order is already: ... AllBtn, indicator, sortBtn
        }
    } catch (_) { }

    const allowedRanges = ['day', 'week', 'month', 'year', 'all'];

    const setActiveRange = (range, shouldPersist = true) => {
        if (!allowedRanges.includes(range)) {
            range = 'day';
        }

        browsingRelatedCurrentRange = range;

        buttons.forEach(btn => {
            if (btn.dataset.range === range) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // 显示对应的时间段菜单
        showBrowsingRelatedTimeMenu(range);

        loadBrowsingRelatedHistory(range);

        if (shouldPersist) {
            try {
                localStorage.setItem('browsingRelatedActiveRange', range);
            } catch (storageErr) {
                console.warn('[BrowsingRelated] 无法保存筛选范围:', storageErr);
            }
        }
    };

    buttons.forEach(btn => {
        btn.addEventListener('click', () => {
            const range = btn.dataset.range || 'day';
            setActiveRange(range);
        });
    });

    // 排序按钮事件
    if (sortBtn) {
        // 创建tooltip
        const tooltip = document.createElement('span');
        tooltip.className = 'btn-tooltip';
        const updateTooltip = () => {
            tooltip.textContent = browsingRelatedSortAsc
                ? (i18n.currentAscending?.[currentLang] || (currentLang === 'zh_CN' ? '当前：正序' : 'Current: Ascending'))
                : (i18n.currentDescending?.[currentLang] || (currentLang === 'zh_CN' ? '当前：倒序' : 'Current: Descending'));
        };
        updateTooltip();
        sortBtn.appendChild(tooltip);

        sortBtn.addEventListener('click', () => {
            browsingRelatedSortAsc = !browsingRelatedSortAsc;
            if (browsingRelatedSortAsc) {
                sortBtn.classList.add('asc');
            } else {
                sortBtn.classList.remove('asc');
            }
            updateTooltip();
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
        });
    }

    let initialRange = 'day';
    try {
        const saved = localStorage.getItem('browsingRelatedActiveRange');
        if (saved && allowedRanges.includes(saved)) {
            initialRange = saved;
        }
    } catch (storageErr) {
        console.warn('[BrowsingRelated] 无法读取筛选范围:', storageErr);
    }

    setActiveRange(initialRange, false);
}

// 刷新书签关联记录
async function refreshBrowsingRelatedHistory() {
    const panel = document.getElementById('browsingRelatedPanel');
    if (!panel || !panel.classList.contains('active')) return;

    const activeBtn = panel.querySelector('.ranking-time-filter-btn.active');
    const range = activeBtn ? (activeBtn.dataset.range || 'day') : 'day';

    // 清除书签URL/标题缓存（以便重新获取最新书签）
    browsingRelatedBookmarkUrls = null;
    browsingRelatedBookmarkTitles = null;
    browsingRelatedBookmarkInfo = null;

    // ✨ 等待日历数据同步完成（确保标题匹配的记录能正确显示）
    const waitForCalendarData = async () => {
        const start = Date.now();
        const timeout = 2000; // 2秒超时
        while (Date.now() - start < timeout) {
            const inst = window.browsingHistoryCalendarInstance;
            if (inst && inst.bookmarksByDate && inst.bookmarksByDate.size > 0) {
                return true;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return false;
    };

    const dataReady = await waitForCalendarData();
    if (!dataReady) {
        console.warn('[BrowsingRelated] 等待日历数据超时');
    }

    // 直接重新加载（数据来自 browsingHistoryCalendarInstance）
    loadBrowsingRelatedHistory(range);
}

// 获取书签URL和标题集合（使用URL或标题匹配）
async function getBookmarkUrlsAndTitles() {
    if (browsingRelatedBookmarkUrls && browsingRelatedBookmarkTitles && browsingRelatedBookmarkInfo) {
        return {
            urls: browsingRelatedBookmarkUrls,
            titles: browsingRelatedBookmarkTitles,
            info: browsingRelatedBookmarkInfo
        };
    }

    const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
    if (!browserAPI || !browserAPI.bookmarks || !browserAPI.bookmarks.getTree) {
        return { urls: new Set(), titles: new Set() };
    }

    const urls = new Set();
    const titles = new Set();
    const info = new Map(); // url -> { url, title, folderPath }

    const collectUrlsAndTitles = (nodes, parentPath = []) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
            if (node.url) {
                const url = node.url;
                urls.add(url);

                // 同时收集标题（去除空白后存储）
                const trimmedTitle = typeof node.title === 'string' ? node.title.trim() : '';
                if (trimmedTitle) {
                    titles.add(trimmedTitle);
                }

                // 记录URL到标题和文件夹路径的映射
                if (!info.has(url)) {
                    info.set(url, {
                        url,
                        title: trimmedTitle || url,
                        folderPath: parentPath.slice() // 复制父文件夹路径
                    });
                }
            }
            if (node.children) {
                // 构建当前节点的路径（排除根节点）
                const currentPath = node.title ? [...parentPath, node.title] : parentPath;
                collectUrlsAndTitles(node.children, currentPath);
            }
        }
    };

    try {
        const tree = await new Promise((resolve, reject) => {
            browserAPI.bookmarks.getTree((result) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    reject(browserAPI.runtime.lastError);
                } else {
                    resolve(result);
                }
            });
        });

        collectUrlsAndTitles(tree);
        browsingRelatedBookmarkUrls = urls;
        browsingRelatedBookmarkTitles = titles;
        browsingRelatedBookmarkInfo = info;
        return { urls, titles, info };
    } catch (error) {
        console.error('[BrowsingRelated] 获取书签URL和标题失败:', error);
        return { urls: new Set(), titles: new Set(), info: new Map() };
    }
}

// 获取时间范围的起始时间
function getTimeRangeStart(range) {
    const now = new Date();
    let startTime = new Date();

    switch (range) {
        case 'day':
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'week':
            const dayOfWeek = now.getDay();
            const daysToMonday = (dayOfWeek === 0 ? 6 : dayOfWeek - 1);
            startTime.setDate(now.getDate() - daysToMonday);
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'month':
            startTime.setDate(1);
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'year':
            startTime.setMonth(0, 1);
            startTime.setHours(0, 0, 0, 0);
            break;
        case 'all':
            return 0; // 从最早时间开始
        default:
            startTime.setHours(0, 0, 0, 0);
    }

    return startTime.getTime();
}

// 获取书签关联历史数据（不渲染，仅返回数据）
async function getBrowsingRelatedHistoryData(range = 'day') {
    const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
    if (!browserAPI || !browserAPI.history || !browserAPI.history.search) {
        return [];
    }

    try {
        const startTime = getTimeRangeStart(range);
        const endTime = Date.now();

        const historyItems = await new Promise((resolve, reject) => {
            browserAPI.history.search({
                text: '',
                startTime: startTime,
                endTime: endTime,
                maxResults: 0
            }, (results) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    reject(browserAPI.runtime.lastError);
                } else {
                    resolve(results || []);
                }
            });
        });

        return historyItems;
    } catch (error) {
        console.error('[BrowsingRelated] 获取历史数据失败:', error);
        return [];
    }
}

// 加载书签关联记录（显示所有浏览记录，标识出书签）
// 复用「点击记录」的书签集合进行标识，实现数据一致性
async function loadBrowsingRelatedHistory(range = 'day') {
    const listContainer = document.getElementById('browsingRelatedList');
    if (!listContainer) return;

    const isZh = currentLang === 'zh_CN';
    const loadingTitle = isZh ? '正在读取历史记录...' : 'Loading history...';

    listContainer.innerHTML = `
        <div class="empty-state">
            <div class="empty-state-icon"><i class="fas fa-spinner fa-spin"></i></div>
            <div class="empty-state-title">${loadingTitle}</div>
        </div>
    `;

    try {
        const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
        if (!browserAPI || !browserAPI.history || !browserAPI.history.search) {
            throw new Error('History API not available');
        }

        // 确保「点击记录」日历已初始化
        if (typeof initBrowsingHistoryCalendar === 'function' && !window.browsingHistoryCalendarInstance) {
            console.log('[BrowsingRelated] 初始化日历...');
            initBrowsingHistoryCalendar();
        }

        // 等待日历数据加载（最多10秒）
        const waitForCalendarData = async () => {
            const start = Date.now();
            const timeout = 10000;
            while (Date.now() - start < timeout) {
                const inst = window.browsingHistoryCalendarInstance;
                if (inst && inst.bookmarksByDate && inst.bookmarksByDate.size > 0) {
                    console.log('[BrowsingRelated] 日历数据已加载，记录数:', inst.bookmarksByDate.size);
                    return inst;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            console.warn('[BrowsingRelated] 等待日历数据超时');
            return window.browsingHistoryCalendarInstance || null;
        };

        const calendar = await waitForCalendarData();

        // 获取时间范围（Phase 4.7: 支持自定义日期范围覆盖）
        const startTime = browsingRelatedCustomBounds ? browsingRelatedCustomBounds.startTime : getTimeRangeStart(range);
        const endTime = browsingRelatedCustomBounds ? browsingRelatedCustomBounds.endTime : Date.now();

        // 搜索所有历史记录（不限制数量）
        const historyItems = await new Promise((resolve, reject) => {
            browserAPI.history.search({
                text: '',
                startTime: startTime,
                endTime: endTime,
                maxResults: 0  // 0表示不限制数量
            }, (results) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    reject(browserAPI.runtime.lastError);
                } else {
                    resolve(results || []);
                }
            });
        });

        if (historyItems.length === 0) {
            const emptyTitle = isZh ? '该时间范围内没有历史记录' : 'No history in this time range';
            listContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-history"></i></div>
                    <div class="empty-state-title">${emptyTitle}</div>
                </div>
            `;
            return;
        }

        // ✨ 使用 getVisits 获取每个URL的详细访问记录，展开为每次访问一条
        const expandedItems = [];
        const getVisitsAsync = (url) => new Promise((resolve) => {
            if (!browserAPI.history.getVisits) {
                resolve([]);
                return;
            }
            browserAPI.history.getVisits({ url }, (visits) => {
                if (browserAPI.runtime && browserAPI.runtime.lastError) {
                    resolve([]);
                } else {
                    resolve(visits || []);
                }
            });
        });

        // 并发获取所有URL的访问详情
        const visitPromises = historyItems.map(async (item) => {
            const visits = await getVisitsAsync(item.url);
            // 过滤在时间范围内的访问
            const filteredVisits = visits.filter(v =>
                v.visitTime >= startTime && v.visitTime <= endTime
            );

            if (filteredVisits.length > 0) {
                // 每次访问创建一条记录
                return filteredVisits.map(visit => ({
                    ...item,
                    lastVisitTime: visit.visitTime,
                    transition: visit.transition || '',
                    _visitId: visit.visitId
                }));
            } else {
                // 如果没有详细访问记录，使用汇总记录
                return [item];
            }
        });

        const allVisitArrays = await Promise.all(visitPromises);
        allVisitArrays.forEach(arr => expandedItems.push(...arr));

        if (expandedItems.length === 0) {
            const emptyTitle = isZh ? '该时间范围内没有历史记录' : 'No history in this time range';
            listContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-history"></i></div>
                    <div class="empty-state-title">${emptyTitle}</div>
                </div>
            `;
            return;
        }

        // 用展开后的记录替换原来的
        const historyItemsExpanded = expandedItems;

        // ✨ 获取书签URL和标题集合（用于标识哪些是书签）
        // 优先从「点击记录」日历获取，保持数据一致性
        let bookmarkUrls, bookmarkTitles;

        // 优先使用 DatabaseManager 获取书签信息（最准确）
        if (calendar && calendar.dbManager) {
            console.log('[BrowsingRelated] 从DatabaseManager获取书签集合');
            const bookmarkDB = calendar.dbManager.getBookmarksDB();
            if (bookmarkDB) {
                bookmarkUrls = bookmarkDB.getAllUrls();
                bookmarkTitles = bookmarkDB.getAllTitles();
                console.log('[BrowsingRelated] DatabaseManager书签集合 - URL:', bookmarkUrls.size, 'Title:', bookmarkTitles.size);
            } else {
                // 回退到日历数据
                bookmarkUrls = new Set();
                bookmarkTitles = new Set();
            }
        } else if (calendar && calendar.bookmarksByDate && calendar.bookmarksByDate.size > 0) {
            console.log('[BrowsingRelated] 从日历提取书签集合');
            // 从日历实例中提取书签URL和标题集合
            bookmarkUrls = new Set();
            bookmarkTitles = new Set();
            for (const records of calendar.bookmarksByDate.values()) {
                if (!Array.isArray(records)) continue;
                records.forEach(record => {
                    if (record.url) bookmarkUrls.add(record.url);
                    if (record.title && record.title.trim()) bookmarkTitles.add(record.title.trim());
                });
            }
            console.log('[BrowsingRelated] 日历书签集合 - URL:', bookmarkUrls.size, 'Title:', bookmarkTitles.size);
        } else {
            console.log('[BrowsingRelated] 使用降级方案获取书签');
            // 降级方案：直接获取书签库
            const result = await getBookmarkUrlsAndTitles();
            bookmarkUrls = result.urls;
            bookmarkTitles = result.titles;
            console.log('[BrowsingRelated] 降级方案书签集合 - URL:', bookmarkUrls.size, 'Title:', bookmarkTitles.size);
        }

        // 按当前排序方式排序（使用展开后的记录）
        if (browsingRelatedSortAsc) {
            // 正序：旧到新
            historyItemsExpanded.sort((a, b) => (a.lastVisitTime || 0) - (b.lastVisitTime || 0));
        } else {
            // 倒序：新到旧
            historyItemsExpanded.sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
        }

        // 渲染历史记录（根据数量和时间范围自动决定是否懒加载）
        renderBrowsingRelatedList(listContainer, historyItemsExpanded, bookmarkUrls, bookmarkTitles, range);

    } catch (error) {
        console.error('[BrowsingRelated] 加载失败:', error);
        const errorTitle = isZh ? '加载历史记录失败' : 'Failed to load history';
        const errorDesc = isZh ? '请检查浏览器权限设置' : 'Please check browser permissions';
        listContainer.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-exclamation-circle"></i></div>
                <div class="empty-state-title">${errorTitle}</div>
                <div class="empty-state-description">${errorDesc}</div>
            </div>
        `;
    }
}

// 渲染书签关联记录列表（大列表场景支持懒加载）
async function renderBrowsingRelatedList(container, historyItems, bookmarkUrls, bookmarkTitles, range) {
    if (!container) return;

    container.innerHTML = '';

    const isZh = currentLang === 'zh_CN';
    const bookmarkLabel = i18n.browsingRelatedBadgeText[currentLang];

    // ✨ 应用时间筛选
    let filteredItems = historyItems;
    if (browsingRelatedTimeFilter) {
        filteredItems = filterHistoryByTime(historyItems, browsingRelatedTimeFilter, range);
        if (filteredItems.length === 0) {
            const emptyTitle = isZh ? '没有匹配的记录' : 'No matching records';
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-filter"></i></div>
                    <div class="empty-state-title">${emptyTitle}</div>
                </div>
            `;
            return;
        }
    }

    // Phase 4.7: 关键词筛选（在当前时间范围内过滤关联记录）
    if (browsingRelatedSearchTokens && browsingRelatedSearchTokens.length > 0) {
        filteredItems = filteredItems.filter(item =>
            matchesTokens(item.title, browsingRelatedSearchTokens) ||
            matchesTokens(item.url, browsingRelatedSearchTokens)
        );

        if (filteredItems.length === 0) {
            const emptyTitle = isZh ? '没有匹配的记录' : 'No matching records';
            container.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon"><i class="fas fa-filter"></i></div>
                    <div class="empty-state-title">${emptyTitle}</div>
                </div>
            `;
            return;
        }
    }

    // ✨ 辅助函数：判断记录是否为书签
    const checkIsBookmark = (item) => {
        if (bookmarkUrls.has(item.url)) return true;
        if (item.title && item.title.trim() && bookmarkTitles.has(item.title.trim())) return true;
        return false;
    };

    // ✨ 辅助函数：从URL提取用于比较的键（去掉查询参数和hash）
    const getUrlKey = (url) => {
        try {
            const u = new URL(url);
            return u.origin + u.pathname; // 只保留协议+域名+路径
        } catch {
            return url;
        }
    };

    // ✨ 辅助函数：检测字符串是否是URL
    const isUrl = (str) => {
        if (!str) return false;
        return str.startsWith('http://') || str.startsWith('https://') || str.startsWith('chrome-extension://') || str.startsWith('file://');
    };

    // ✨ 辅助函数：规范化标题用于比较
    const normalizeTitle = (title) => {
        if (!title) return '';
        const trimmed = title.trim();
        // 如果标题本身是URL，则去掉查询参数进行比较
        if (isUrl(trimmed)) {
            return getUrlKey(trimmed);
        }
        return trimmed
            .replace(/\s+/g, ' ')  // 多个空白字符合并为一个空格
            .replace(/[\u200B-\u200D\uFEFF]/g, ''); // 去除零宽字符
    };

    // ✨ 合并连续相同标题的非书签记录
    // 规则：连续相同名字的浏览记录合并，书签作为分界线不合并
    const mergeConsecutiveItems = (items) => {
        const groups = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const isBookmark = checkIsBookmark(item);
            // 优先使用标题，如果标题为空则使用URL的路径部分（去掉查询参数）
            const itemTitle = (item.title && item.title.trim()) ? normalizeTitle(item.title) : getUrlKey(item.url);

            if (isBookmark) {
                // 书签单独成组，不合并
                groups.push({
                    startIndex: i + 1,
                    endIndex: i + 1,
                    items: [item],
                    isBookmark: true,
                    representativeItem: item,
                    title: itemTitle
                });
            } else {
                // 非书签：检查是否可以和前一组合并
                const lastGroup = groups.length > 0 ? groups[groups.length - 1] : null;
                if (lastGroup && !lastGroup.isBookmark && lastGroup.title === itemTitle) {
                    // 合并到前一组
                    lastGroup.endIndex = i + 1;
                    lastGroup.items.push(item);
                } else {
                    // 创建新组
                    groups.push({
                        startIndex: i + 1,
                        endIndex: i + 1,
                        items: [item],
                        isBookmark: false,
                        representativeItem: item,
                        title: itemTitle
                    });
                }
            }
        }
        return groups;
    };

    // 合并后的分组
    const mergedGroups = mergeConsecutiveItems(filteredItems);

    // Phase 4.7: Remember an anchor item for "show day related" button
    try {
        const anchor = mergedGroups && mergedGroups[0] && mergedGroups[0].representativeItem
            ? mergedGroups[0].representativeItem
            : null;
        browsingRelatedLastAnchorVisitTime = anchor && anchor.lastVisitTime ? anchor.lastVisitTime : null;
    } catch (_) { }

    // 懒加载规则：
    // - 当分组数 > 500 时启用懒加载（所有范围都适用）
    // - 其他情况一次性渲染全部
    const enableLazy = mergedGroups.length > 500;

    // 渲染单个分组的函数
    const renderGroup = (group) => {
        const item = group.representativeItem;
        const isBookmark = group.isBookmark;

        const itemEl = document.createElement('div');
        itemEl.className = 'related-history-item' + (isBookmark ? ' is-bookmark' : '');

        // 添加 dataset 属性用于跳转匹配
        const visitTimestamp = item.lastVisitTime || null;
        itemEl.dataset.url = item.url;
        itemEl.dataset.visitTime = visitTimestamp || Date.now();
        if (visitTimestamp) {
            itemEl.dataset.visitMinute = Math.floor(visitTimestamp / 60000);
        }
        if (item.title && item.title.trim()) {
            itemEl.dataset.title = item.title.trim();
        }

        // 获取favicon
        const faviconUrl = getFaviconUrl(item.url);

        // ✨ 格式化时间：如果合并了多条，显示时间范围
        let timeStr;
        if (group.items.length === 1) {
            // 单条记录：显示单个时间
            const visitTime = item.lastVisitTime ? new Date(item.lastVisitTime) : new Date();
            timeStr = formatTimeByRange(visitTime, range);
        } else {
            // 多条记录：显示时间范围（第一条 ~ 最后一条）
            const firstItem = group.items[0];
            const lastItem = group.items[group.items.length - 1];
            const firstTime = firstItem.lastVisitTime ? new Date(firstItem.lastVisitTime) : new Date();
            const lastTime = lastItem.lastVisitTime ? new Date(lastItem.lastVisitTime) : new Date();
            const firstTimeStr = formatTimeByRange(firstTime, range);
            const lastTimeStr = formatTimeByRange(lastTime, range);
            // 时间顺序已经由排序决定，直接按数组顺序显示
            timeStr = `${firstTimeStr} ~ ${lastTimeStr}`;
        }

        const displayTitle = (item.title && item.title.trim()) ? item.title : item.url;

        // ✨ 序号显示：如果合并了多条，显示为 "起始~结束" 格式
        const numberStr = group.startIndex === group.endIndex
            ? `${group.startIndex}`
            : `${group.startIndex}~${group.endIndex}`;

        itemEl.innerHTML = `
            <div class="related-history-number">${numberStr}</div>
            <div class="related-history-header">
                <img src="${faviconUrl}" class="related-history-favicon" alt="">
                <div class="related-history-info">
                    <div class="related-history-title">${escapeHtml(displayTitle)}</div>
                </div>
            </div>
            <div class="related-history-meta">
                <div class="related-history-time">
                    <i class="fas fa-clock"></i>
                    ${timeStr}
                </div>
                ${isBookmark ? `<div class="related-history-badge">${bookmarkLabel}</div>` : ''}
            </div>
        `;

        // 点击打开链接
        itemEl.addEventListener('click', () => {
            try {
                if (item.lastVisitTime) browsingRelatedFocusedVisitTime = item.lastVisitTime;
            } catch (_) { }
            const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
            if (browserAPI && browserAPI.tabs && browserAPI.tabs.create) {
                browserAPI.tabs.create({ url: item.url });
            } else {
                window.open(item.url, '_blank');
            }
        });

        // Hover to set focus for "show day related" button
        itemEl.addEventListener('mouseenter', () => {
            try {
                if (item.lastVisitTime) browsingRelatedFocusedVisitTime = item.lastVisitTime;
            } catch (_) { }
        });

        return itemEl;
    };

    if (!enableLazy) {
        for (const group of mergedGroups) {
            container.appendChild(renderGroup(group));
        }
        return;
    }

    // 启用懒加载：每次追加 1000 个分组
    const PAGE_SIZE = 1000;
    let offset = 0;

    const appendNextPage = () => {
        const end = Math.min(offset + PAGE_SIZE, mergedGroups.length);

        for (let i = offset; i < end; i++) {
            container.appendChild(renderGroup(mergedGroups[i]));
        }

        offset = end;
    };

    appendNextPage();

    // 找到真正的滚动容器（.content-area）
    const scrollContainer = container.closest('.content-area') || container;

    const onScroll = () => {
        if (offset >= mergedGroups.length) return;
        // 提前加载：使用视口高度的3倍作为阈值，至少1500px
        const threshold = Math.max(1500, scrollContainer.clientHeight * 3);
        if (scrollContainer.scrollTop + scrollContainer.clientHeight + threshold >= scrollContainer.scrollHeight) {
            appendNextPage();
        }
    };

    // 清理旧的监听器
    if (scrollContainer.__browsingRelatedScrollHandler) {
        scrollContainer.removeEventListener('scroll', scrollContainer.__browsingRelatedScrollHandler);
    }
    scrollContainer.addEventListener('scroll', onScroll);
    scrollContainer.__browsingRelatedScrollHandler = onScroll;

    // 暴露懒加载状态和函数，供跳转功能使用
    container.__lazyLoadState = {
        totalItems: filteredItems.length,
        getLoadedCount: () => offset,
        loadMore: appendNextPage,
        loadAll: () => {
            while (offset < mergedGroups.length) {
                appendNextPage();
            }
        }
    };
}

// 根据时间范围格式化时间
function formatTimeByRange(date, range) {
    const isZh = currentLang === 'zh_CN';
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const timeOnly = `${hour}:${minute}`;

    switch (range) {
        case 'day':
            // 当天：只显示时间
            return timeOnly;

        case 'week':
            // 当周：显示周几+时间
            const weekdays = isZh
                ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
                : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            const weekday = weekdays[date.getDay()];
            return `${weekday} ${timeOnly}`;

        case 'month':
        case 'year':
            // 当月/当年：显示月-日 时间
            const month = String(date.getMonth() + 1).padStart(2, '0');
            const day = String(date.getDate()).padStart(2, '0');
            return `${month}-${day} ${timeOnly}`;

        default:
            return timeOnly;
    }
}

// 格式化时间为日期时间格式（保留用于其他地方）
function formatRelativeTime(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}`;
}

// ========== 点击排行 - 时间段菜单功能 ==========

// 全局变量：点击排行当前选中的时间筛选
let browsingRankingTimeFilter = null; // { type: 'hour'|'day'|'week'|'month', value: number|Date }
let browsingRankingCurrentRange = 'month'; // 当前选中的时间范围
let browsingRankingViewMode = 'bookmark'; // 'bookmark' 或 'folder'

// Phase 4.7: 点击排行搜索筛选状态
let browsingRankingSearchQuery = '';
let browsingRankingSearchTokens = null; // string[]
let browsingRankingCustomRange = null; // { startTime:number, endTime:number, label:string }
let browsingRankingSearchPrevState = null; // { range, timeFilter, viewMode, tokens, query, customRange }

// Phase 4.7: 关联记录搜索筛选状态（在关联记录模块处也会用到，先声明以便全局访问）
let browsingRelatedSearchQuery = '';
let browsingRelatedSearchTokens = null; // string[]
let browsingRelatedCustomBounds = null; // { startTime:number, endTime:number, label:string }
let browsingRelatedSearchPrevState = null; // { range, timeFilter, tokens, query, customBounds }
let browsingRelatedFocusedVisitTime = null; // number (ms)
let browsingRelatedLastAnchorVisitTime = null; // number (ms)
let browsingRelatedExpandMode = false; // boolean (keeps isolation after expanding scope)
let browsingRelatedExpandSavedQuery = ''; // keyword query to restore
let browsingRelatedExpandSavedTokens = null; // string[]

function matchesTokens(text, tokens) {
    if (!tokens || !tokens.length) return true;
    const hay = String(text || '').toLowerCase();
    if (!hay) return false;
    for (const t of tokens) {
        if (!t) continue;
        if (!hay.includes(t)) return false;
    }
    return true;
}

function ensureSearchFilterIndicator(buttonId, insertAfterEl) {
    try {
        let btn = document.getElementById(buttonId);
        if (btn) return btn;
        if (!insertAfterEl || !insertAfterEl.parentElement) return null;

        btn = document.createElement('button');
        btn.id = buttonId;
        btn.className = 'search-filter-indicator';
        btn.type = 'button';
        btn.innerHTML = '<i class="fas fa-search"></i><span class="search-filter-label"></span>';
        insertAfterEl.insertAdjacentElement('afterend', btn);
        return btn;
    } catch (_) {
        return null;
    }
}

function setSearchFilterIndicatorState(buttonId, active, label) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    const labelEl = btn.querySelector('.search-filter-label');

    if (!active) {
        btn.classList.remove('active');
        btn.style.display = 'none';
        if (labelEl) labelEl.textContent = '';
        return;
    }

    btn.style.display = '';
    btn.classList.add('active');
    if (labelEl) labelEl.textContent = label ? ` ${label}` : '';
}

function setListSearchFilterHighlight(listId, active, options = {}) {
    const el = document.getElementById(listId);
    if (!el) return;

    const { requireNonEmpty = false } = options;
    const isEmpty = Boolean(el.querySelector('.empty-state'));

    const shouldEnable = Boolean(active) && (!requireNonEmpty || !isEmpty);
    if (shouldEnable) el.classList.add('search-filter-active');
    else el.classList.remove('search-filter-active');
}

function ensureShowTodayRelatedButton() {
    let btn = document.getElementById('showTodayRelatedBtn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'showTodayRelatedBtn';
    btn.className = 'show-today-related-btn';
    btn.type = 'button';
    btn.style.display = 'none';
    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
        try {
            if (typeof window.showTodayBrowsingRelated === 'function') {
                window.showTodayBrowsingRelated();
            }
        } catch (_) { }
    });

    return btn;
}

function setShowTodayRelatedVisible(visible) {
    const btn = ensureShowTodayRelatedButton();
    if (!btn) return;
    btn.style.display = visible ? 'inline-flex' : 'none';
}

function getBrowsingRelatedRangeLabel(range) {
    const isZh = currentLang === 'zh_CN';
    const r = range || browsingRelatedCurrentRange || 'day';
    if (r === 'day') return isZh ? '当天' : 'that day';
    if (r === 'week') return isZh ? '当周' : 'that week';
    if (r === 'month') return isZh ? '当月' : 'that month';
    if (r === 'year') return isZh ? '当年' : 'that year';
    if (r === 'all') return isZh ? '全部' : 'all';
    return isZh ? '当天' : 'that day';
}

function getBrowsingRelatedScopeLabel() {
    const isZh = currentLang === 'zh_CN';
    const range = browsingRelatedCurrentRange || 'day';
    const f = browsingRelatedTimeFilter;

    if (f && f.type) {
        switch (f.type) {
            case 'hour': {
                const hh = String(f.value).padStart(2, '0');
                return `${hh}:00`;
            }
            case 'day': {
                const d = new Date(f.value);
                const weekdayNames = isZh
                    ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
                    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                if (!isNaN(d.getTime())) return weekdayNames[d.getDay()];
                return isZh ? '当天' : 'that day';
            }
            case 'week':
                return isZh ? `第${f.value}周` : `W${f.value}`;
            case 'month': {
                const monthIdx = parseInt(f.value, 10);
                if (isZh) return `${monthIdx + 1}月`;
                const d = new Date();
                d.setMonth(monthIdx);
                return d.toLocaleString('en-US', { month: 'short' });
            }
            case 'year':
                return isZh ? `${f.value}年` : `${f.value}`;
            default:
                break;
        }
    }

    // No secondary filter, use the current primary range
    if (range === 'day') return isZh ? '当天' : 'that day';
    if (range === 'week') return isZh ? '当周' : 'that week';
    if (range === 'month') return isZh ? '当月' : 'that month';
    if (range === 'year') return isZh ? '当年' : 'that year';
    if (range === 'all') return isZh ? '全部' : 'all';
    return isZh ? '当天' : 'that day';
}

function getBoundsForRangeAtDate(range, baseTs) {
    const d = new Date(baseTs);

    const clampEndToNow = (endMs) => Math.min(endMs, Date.now());

    if (range === 'day') {
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
        const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
        return { startTime: start, endTime: clampEndToNow(end) };
    }

    if (range === 'week') {
        const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const weekStartDay = currentLang === 'zh_CN' ? 1 : 0; // 0=Sun,1=Mon
        const currentDay = dayStart.getDay();
        let diff = currentDay - weekStartDay;
        if (diff < 0) diff += 7;
        const startDate = new Date(dayStart);
        startDate.setDate(startDate.getDate() - diff);
        const start = startDate.getTime();
        const end = start + 7 * 24 * 60 * 60 * 1000 - 1;
        return { startTime: start, endTime: clampEndToNow(end) };
    }

    if (range === 'month') {
        const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime();
        const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
        return { startTime: start, endTime: clampEndToNow(end) };
    }

    if (range === 'year') {
        const start = new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0).getTime();
        const end = new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();
        return { startTime: start, endTime: clampEndToNow(end) };
    }

    // all
    return { startTime: 0, endTime: Date.now() };
}

function ensureExitSearchFilterButton() {
    let btn = document.getElementById('exitSearchFilterBtn');
    if (btn) return btn;

    btn = document.createElement('button');
    btn.id = 'exitSearchFilterBtn';
    btn.className = 'exit-locate-mode-btn';
    btn.type = 'button';
    btn.style.display = 'none';

    document.body.appendChild(btn);

    btn.addEventListener('click', () => {
        try {
            if (typeof window.exitSearchFilter === 'function') {
                window.exitSearchFilter();
            }
        } catch (_) { }
    });

    return btn;
}

function setExitSearchFilterVisible(visible) {
    const btn = ensureExitSearchFilterButton();
    if (!btn) return;
    btn.style.display = visible ? 'inline-flex' : 'none';
}

// 初始化视图模式（从localStorage读取）
function initBrowsingRankingViewMode() {
    try {
        const saved = localStorage.getItem('browsingRankingViewMode');
        if (saved === 'folder' || saved === 'bookmark') {
            browsingRankingViewMode = saved;
        }
    } catch (e) {
        console.warn('[BrowsingRanking] 无法读取视图模式:', e);
    }
}

// 保存视图模式
function saveBrowsingRankingViewMode(mode) {
    browsingRankingViewMode = mode;
    try {
        localStorage.setItem('browsingRankingViewMode', mode);
    } catch (e) {
        console.warn('[BrowsingRanking] 无法保存视图模式:', e);
    }
}

// 显示点击排行的时间段菜单
async function showBrowsingRankingTimeMenu(range) {
    browsingRankingCurrentRange = range;
    const menuContainer = document.getElementById('browsingRankingTimeMenu');
    if (!menuContainer) return;

    menuContainer.innerHTML = '';
    menuContainer.style.display = 'none';
    browsingRankingTimeFilter = null; // 重置筛选

    // 初始化视图模式
    initBrowsingRankingViewMode();

    // 获取点击排行的数据
    const stats = await ensureBrowsingClickRankingStats();
    if (!stats || !stats.items || stats.items.length === 0) {
        return;
    }

    const now = new Date();
    const isZh = currentLang === 'zh_CN';

    // 创建菜单行容器（包含时间按钮和切换按钮）
    const menuRow = document.createElement('div');
    menuRow.style.display = 'flex';
    menuRow.style.alignItems = 'center';
    menuRow.style.justifyContent = 'space-between';
    menuRow.style.gap = '12px';

    // 创建时间菜单项容器
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'time-menu-items';
    itemsContainer.style.flex = '1';

    // 添加"全部"按钮（默认选中）
    const allBtn = document.createElement('button');
    allBtn.className = 'time-menu-btn active';
    allBtn.textContent = isZh ? '全部' : 'All';
    allBtn.dataset.filter = 'all';
    allBtn.addEventListener('click', () => {
        itemsContainer.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
        allBtn.classList.add('active');
        browsingRankingTimeFilter = null;
        loadBrowsingClickRanking(browsingRankingCurrentRange);
    });
    itemsContainer.appendChild(allBtn);

    // 根据范围显示不同的时间段按钮
    switch (range) {
        case 'day':
            renderRankingDayHoursMenu(itemsContainer, now, stats);
            break;
        case 'week':
            renderRankingWeekDaysMenu(itemsContainer, now, stats);
            break;
        case 'month':
            renderRankingMonthWeeksMenu(itemsContainer, now, stats);
            break;
        case 'year':
            renderRankingYearMonthsMenu(itemsContainer, now, stats);
            break;
        case 'all':
            // 全部：显示有数据的年份
            renderRankingAllYearsMenu(itemsContainer, stats);
            break;
    }

    menuRow.appendChild(itemsContainer);

    // 创建"文件夹/书签"滑块开关
    const toggleContainer = document.createElement('div');
    toggleContainer.className = 'ranking-view-toggle';
    toggleContainer.style.cssText = `
        position: relative;
        display: inline-flex;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 20px;
        padding: 3px;
        flex-shrink: 0;
    `;

    // 滑块
    const slider = document.createElement('div');
    slider.className = 'toggle-slider';
    slider.style.cssText = `
        position: absolute;
        top: 3px;
        height: calc(100% - 6px);
        width: calc(50% - 3px);
        background: linear-gradient(135deg, var(--accent-primary) 0%, #0056b3 100%);
        border-radius: 16px;
        transition: left 0.25s cubic-bezier(0.4, 0, 0.2, 1);
        box-shadow: 0 2px 4px rgba(0,0,0,0.15);
        z-index: 0;
    `;
    slider.style.left = browsingRankingViewMode === 'folder' ? '3px' : 'calc(50%)';
    toggleContainer.appendChild(slider);

    // 按钮通用样式
    const btnStyle = `
        position: relative;
        z-index: 1;
        padding: 5px 12px;
        font-size: 11px;
        font-weight: 500;
        border: none;
        background: transparent;
        cursor: pointer;
        transition: color 0.2s;
        white-space: nowrap;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        border-radius: 16px;
    `;

    // 文件夹按钮（左边）
    const folderBtn = document.createElement('button');
    folderBtn.style.cssText = btnStyle;
    folderBtn.style.color = browsingRankingViewMode === 'folder' ? '#fff' : 'var(--text-tertiary)';
    folderBtn.innerHTML = `<i class="fas fa-folder" style="font-size:11px;"></i><span>${isZh ? '文件夹' : 'Folder'}</span>`;

    // 书签按钮（右边）
    const bookmarkBtn = document.createElement('button');
    bookmarkBtn.style.cssText = btnStyle;
    bookmarkBtn.style.color = browsingRankingViewMode === 'bookmark' ? '#fff' : 'var(--text-tertiary)';
    bookmarkBtn.innerHTML = `<i class="fas fa-bookmark" style="font-size:10px;"></i><span>${isZh ? '书签' : 'Bookmark'}</span>`;

    const updateToggle = (mode) => {
        slider.style.left = mode === 'folder' ? '3px' : 'calc(50%)';
        folderBtn.style.color = mode === 'folder' ? '#fff' : 'var(--text-tertiary)';
        bookmarkBtn.style.color = mode === 'bookmark' ? '#fff' : 'var(--text-tertiary)';
    };

    folderBtn.addEventListener('click', () => {
        if (browsingRankingViewMode !== 'folder') {
            saveBrowsingRankingViewMode('folder');
            updateToggle('folder');
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        }
    });

    bookmarkBtn.addEventListener('click', () => {
        if (browsingRankingViewMode !== 'bookmark') {
            saveBrowsingRankingViewMode('bookmark');
            updateToggle('bookmark');
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        }
    });

    // hover效果
    [folderBtn, bookmarkBtn].forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            if ((btn === folderBtn && browsingRankingViewMode !== 'folder') ||
                (btn === bookmarkBtn && browsingRankingViewMode !== 'bookmark')) {
                btn.style.color = 'var(--text-primary)';
            }
        });
        btn.addEventListener('mouseleave', () => {
            if ((btn === folderBtn && browsingRankingViewMode !== 'folder') ||
                (btn === bookmarkBtn && browsingRankingViewMode !== 'bookmark')) {
                btn.style.color = 'var(--text-tertiary)';
            }
        });
    });

    toggleContainer.appendChild(folderBtn);
    toggleContainer.appendChild(bookmarkBtn);
    menuRow.appendChild(toggleContainer);

    // 对于 'all' 范围，即使只有"全部"按钮，也要显示菜单（因为需要切换按钮）
    if (itemsContainer.children.length > 1 || range === 'all') {
        menuContainer.appendChild(menuRow);
        menuContainer.style.display = 'block';
    }
}

// 渲染点击排行当天的小时菜单
function renderRankingDayHoursMenu(container, date, stats) {
    const isZh = currentLang === 'zh_CN';
    const boundaries = stats.boundaries;
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的小时
    const hoursSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.dayStart && t <= boundaries.now) {
                hoursSet.add(new Date(t).getHours());
            }
        });
    }

    Array.from(hoursSet).sort((a, b) => a - b).forEach(hour => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = `${String(hour).padStart(2, '0')}:00`;
        btn.dataset.hour = hour;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRankingTimeFilter = { type: 'hour', value: hour };
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        });
        container.appendChild(btn);
    });
}

// 渲染点击排行当周的天菜单
function renderRankingWeekDaysMenu(container, date, stats) {
    const isZh = currentLang === 'zh_CN';
    const boundaries = stats.boundaries;
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return;

    const weekdayNames = isZh
        ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // 分析有数据的天
    const daysSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.weekStart && t <= boundaries.now) {
                daysSet.add(new Date(t).toDateString());
            }
        });
    }

    // 生成本周的日期
    const weekStart = new Date(boundaries.weekStart);
    for (let i = 0; i < 7; i++) {
        const dayDate = new Date(weekStart);
        dayDate.setDate(weekStart.getDate() + i);

        if (!daysSet.has(dayDate.toDateString())) continue;
        if (dayDate.getTime() > boundaries.now) continue;

        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = weekdayNames[dayDate.getDay()];
        btn.dataset.date = dayDate.toISOString();
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRankingTimeFilter = { type: 'day', value: dayDate };
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        });
        container.appendChild(btn);
    }
}

// 渲染点击排行当月的周菜单
function renderRankingMonthWeeksMenu(container, date, stats) {
    const isZh = currentLang === 'zh_CN';
    const boundaries = stats.boundaries;
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的周
    const weeksSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.monthStart && t <= boundaries.now) {
                weeksSet.add(getWeekNumberForRelated(new Date(t)));
            }
        });
    }

    Array.from(weeksSet).sort((a, b) => a - b).forEach(weekNum => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = isZh ? `第${weekNum}周` : `W${weekNum}`;
        btn.dataset.week = weekNum;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRankingTimeFilter = { type: 'week', value: weekNum };
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        });
        container.appendChild(btn);
    });
}

// 渲染点击排行当年的月份菜单
function renderRankingYearMonthsMenu(container, date, stats) {
    const isZh = currentLang === 'zh_CN';
    const boundaries = stats.boundaries;
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return;

    const monthNames = isZh
        ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
        : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // 分析有数据的月份
    const monthsSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.yearStart && t <= boundaries.now) {
                monthsSet.add(new Date(t).getMonth());
            }
        });
    }

    Array.from(monthsSet).sort((a, b) => a - b).forEach(month => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = monthNames[month];
        btn.dataset.month = month;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRankingTimeFilter = { type: 'month', value: month };
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        });
        container.appendChild(btn);
    });
}

// 渲染点击排行全部时间的年份菜单
function renderRankingAllYearsMenu(container, stats) {
    const isZh = currentLang === 'zh_CN';
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的年份
    const yearsSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t > 0) {
                yearsSet.add(new Date(t).getFullYear());
            }
        });
    }

    // 按年份倒序排列（最近的年份在前）
    Array.from(yearsSet).sort((a, b) => b - a).forEach(year => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = isZh ? `${year}年` : `${year}`;
        btn.dataset.year = year;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRankingTimeFilter = { type: 'year', value: year };
            loadBrowsingClickRanking(browsingRankingCurrentRange);
        });
        container.appendChild(btn);
    });
}

// 按时间筛选点击排行项目（重新计算每个时间段的点击次数）
function filterRankingItemsByTime(items, filter, boundaries) {
    if (!filter || !items || items.length === 0) return items;

    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) return items;

    // 使用与原始统计相同的映射
    const stats = browsingClickRankingStats;
    if (!stats || !stats.bookmarkKeyMap || !stats.bookmarkInfoMap) return items;

    const bookmarkKeyMap = stats.bookmarkKeyMap;
    const bookmarkInfoMap = stats.bookmarkInfoMap;

    // 创建 bookmarkKey -> 访问次数的映射
    const keyVisitCounts = new Map();

    // 遍历所有访问记录，使用与原始统计完全相同的匹配逻辑
    for (const bookmarks of calendar.bookmarksByDate.values()) {
        for (const bm of bookmarks) {
            if (!bm || !bm.url) continue;

            const url = bm.url;
            const title = typeof bm.title === 'string' && bm.title.trim()
                ? bm.title.trim()
                : (bm.url || '');
            const t = typeof bm.visitTime === 'number'
                ? bm.visitTime
                : (bm.dateAdded instanceof Date ? bm.dateAdded.getTime() : 0);
            if (!t) continue;

            const visitDate = new Date(t);
            let matches = false;

            switch (filter.type) {
                case 'hour':
                    if (t >= boundaries.dayStart && t <= boundaries.now &&
                        visitDate.getHours() === filter.value) {
                        matches = true;
                    }
                    break;
                case 'day':
                    if (t >= boundaries.weekStart && t <= boundaries.now &&
                        visitDate.toDateString() === filter.value.toDateString()) {
                        matches = true;
                    }
                    break;
                case 'week':
                    if (t >= boundaries.monthStart && t <= boundaries.now &&
                        getWeekNumberForRelated(visitDate) === filter.value) {
                        matches = true;
                    }
                    break;
                case 'month':
                    if (t >= boundaries.yearStart && t <= boundaries.now &&
                        visitDate.getMonth() === filter.value) {
                        matches = true;
                    }
                    break;
                case 'year':
                    // 筛选特定年份（用于「全部」范围的年份二级菜单）
                    if (visitDate.getFullYear() === filter.value) {
                        matches = true;
                    }
                    break;
            }

            if (matches) {
                // 与原始统计完全相同的匹配逻辑
                let bookmarkKey = bookmarkKeyMap.get(`url:${url}`);
                if (!bookmarkKey && title) {
                    bookmarkKey = bookmarkKeyMap.get(`title:${title}`);
                }

                if (bookmarkKey) {
                    keyVisitCounts.set(bookmarkKey, (keyVisitCounts.get(bookmarkKey) || 0) + 1);
                }
            }
        }
    }

    // 将 bookmarkKey 的计数映射回 item.url
    const urlVisitCounts = new Map();
    for (const [key, count] of keyVisitCounts.entries()) {
        const info = bookmarkInfoMap.get(key);
        if (info && info.url) {
            urlVisitCounts.set(info.url, count);
        }
    }

    // 过滤并更新items的点击次数
    const result = items
        .filter(item => urlVisitCounts.has(item.url) && urlVisitCounts.get(item.url) > 0)
        .map(item => ({
            ...item,
            filteredCount: urlVisitCounts.get(item.url)
        }))
        .sort((a, b) => {
            if (b.filteredCount !== a.filteredCount) return b.filteredCount - a.filteredCount;
            return (b.lastVisitTime || 0) - (a.lastVisitTime || 0);
        });

    return result;
}

// Phase 4.7: 自定义日期范围点击排行（用于日期/日期范围搜索）
async function getBrowsingRankingItemsForCustomRange(startTime, endTime) {
    try {
        const calendar = window.browsingHistoryCalendarInstance;
        if (!calendar || !calendar.bookmarksByDate) return [];

        const stats = await ensureBrowsingClickRankingStats();
        if (!stats || !stats.bookmarkKeyMap || !stats.bookmarkInfoMap) return [];

        const bookmarkKeyMap = stats.bookmarkKeyMap;
        const bookmarkInfoMap = stats.bookmarkInfoMap;

        const start = Math.min(startTime, endTime);
        const end = Math.max(startTime, endTime);

        // bookmarkKey -> { count, lastVisitTime }
        const keyAgg = new Map();

        for (const bookmarks of calendar.bookmarksByDate.values()) {
            if (!Array.isArray(bookmarks)) continue;
            for (const bm of bookmarks) {
                if (!bm || !bm.url) continue;

                const t = typeof bm.visitTime === 'number'
                    ? bm.visitTime
                    : (bm.dateAdded instanceof Date ? bm.dateAdded.getTime() : 0);
                if (!t || t < start || t > end) continue;

                const url = bm.url;
                const title = typeof bm.title === 'string' && bm.title.trim()
                    ? bm.title.trim()
                    : (bm.url || '');

                let bookmarkKey = bookmarkKeyMap.get(`url:${url}`);
                if (!bookmarkKey && title) {
                    bookmarkKey = bookmarkKeyMap.get(`title:${title}`);
                }
                if (!bookmarkKey) continue;

                if (!keyAgg.has(bookmarkKey)) {
                    keyAgg.set(bookmarkKey, { count: 0, lastVisitTime: 0 });
                }
                const agg = keyAgg.get(bookmarkKey);
                agg.count += 1;
                if (t > agg.lastVisitTime) agg.lastVisitTime = t;
            }
        }

        // url -> { count, lastVisitTime }
        const urlAgg = new Map();
        for (const [key, agg] of keyAgg.entries()) {
            const info = bookmarkInfoMap.get(key);
            if (info && info.url) {
                urlAgg.set(info.url, { count: agg.count, lastVisitTime: agg.lastVisitTime });
            }
        }

        // Use the existing all-range items as base so we preserve title/url fields.
        const baseItems = getBrowsingRankingItemsForRange('all') || [];
        const result = baseItems
            .filter(it => urlAgg.has(it.url) && urlAgg.get(it.url).count > 0)
            .map(it => {
                const agg = urlAgg.get(it.url);
                return {
                    ...it,
                    filteredCount: agg.count,
                    lastVisitTime: agg.lastVisitTime || it.lastVisitTime
                };
            })
            .sort((a, b) => {
                if ((b.filteredCount || 0) !== (a.filteredCount || 0)) return (b.filteredCount || 0) - (a.filteredCount || 0);
                return (b.lastVisitTime || 0) - (a.lastVisitTime || 0);
            });

        return result;
    } catch (e) {
        console.warn('[BrowsingRanking] getBrowsingRankingItemsForCustomRange failed:', e);
        return [];
    }
}

// ========== 书签关联页面 - 时间段菜单功能 ==========

// 全局变量：当前选中的时间筛选
let browsingRelatedTimeFilter = null; // { type: 'hour'|'day'|'week'|'month', value: number|Date }

// 显示时间段菜单（按需显示，只显示有数据的时间段）
// 使用与点击排行相同的数据源（calendar.bookmarksByDate），保持一致
async function showBrowsingRelatedTimeMenu(range) {
    const menuContainer = document.getElementById('browsingRelatedTimeMenu');
    if (!menuContainer) return;

    menuContainer.innerHTML = '';
    menuContainer.style.display = 'none';
    browsingRelatedTimeFilter = null; // 重置筛选

    // 使用与点击排行相同的数据源
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate || calendar.bookmarksByDate.size === 0) {
        return; // 没有数据，不显示菜单
    }

    // 获取时间边界（与点击排行保持一致）
    const stats = await ensureBrowsingClickRankingStats();
    if (!stats || !stats.boundaries) return;

    const boundaries = stats.boundaries;
    const now = new Date();
    const isZh = currentLang === 'zh_CN';

    // 创建菜单项容器
    const itemsContainer = document.createElement('div');
    itemsContainer.className = 'time-menu-items';

    // 添加"全部"按钮（默认选中）
    const allBtn = document.createElement('button');
    allBtn.className = 'time-menu-btn active';
    allBtn.textContent = isZh ? '全部' : 'All';
    allBtn.dataset.filter = 'all';
    allBtn.addEventListener('click', () => {
        itemsContainer.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
        allBtn.classList.add('active');
        browsingRelatedTimeFilter = null;
        loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
        try {
            if (typeof window.updateSearchFilterExitButton === 'function') {
                window.updateSearchFilterExitButton();
            }
        } catch (_) { }
    });
    itemsContainer.appendChild(allBtn);

    // 使用与点击排行相同的数据源和边界
    switch (range) {
        case 'day':
            // 当天：只显示有数据的小时段
            renderRelatedDayHoursMenu(itemsContainer, boundaries, calendar);
            break;
        case 'week':
            // 当周：只显示有数据的天
            renderRelatedWeekDaysMenu(itemsContainer, boundaries, calendar);
            break;
        case 'month':
            // 当月：只显示有数据的周
            renderRelatedMonthWeeksMenu(itemsContainer, boundaries, calendar);
            break;
        case 'year':
            // 当年：只显示有数据的月份
            renderRelatedYearMonthsMenu(itemsContainer, boundaries, calendar);
            break;
        case 'all':
            // 全部：显示有数据的年份
            renderRelatedAllYearsMenu(itemsContainer, calendar);
            break;
    }

    if (itemsContainer.children.length > 1) { // 至少有"全部"和一个其他选项
        menuContainer.appendChild(itemsContainer);
        menuContainer.style.display = 'block';
    }
}

// 辅助函数：复用日历的 ISO 8601 周数计算
function getWeekNumberForRelated(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const thursday = new Date(d);
    thursday.setDate(d.getDate() + (4 - (d.getDay() || 7)));
    const yearStart = new Date(thursday.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((thursday - yearStart) / 86400000) + 1) / 7);
    return weekNo;
}

// 书签关联记录 - 渲染当天的小时菜单（使用与点击排行相同的数据源）
function renderRelatedDayHoursMenu(container, boundaries, calendar) {
    const isZh = currentLang === 'zh_CN';
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的小时（与点击排行完全相同的逻辑）
    const hoursSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.dayStart && t <= boundaries.now) {
                hoursSet.add(new Date(t).getHours());
            }
        });
    }

    Array.from(hoursSet).sort((a, b) => a - b).forEach(hour => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = `${String(hour).padStart(2, '0')}:00`;
        btn.dataset.hour = hour;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRelatedTimeFilter = { type: 'hour', value: hour };
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
            try {
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
            } catch (_) { }
        });
        container.appendChild(btn);
    });
}

// 书签关联记录 - 渲染当周的天菜单（使用与点击排行相同的数据源）
function renderRelatedWeekDaysMenu(container, boundaries, calendar) {
    const isZh = currentLang === 'zh_CN';
    if (!calendar || !calendar.bookmarksByDate) return;

    const weekdayNames = isZh
        ? ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
        : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // 分析有数据的天
    const daysSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.weekStart && t <= boundaries.now) {
                daysSet.add(new Date(t).toDateString());
            }
        });
    }

    // 生成本周的日期
    const weekStart = new Date(boundaries.weekStart);
    for (let i = 0; i < 7; i++) {
        const dayDate = new Date(weekStart);
        dayDate.setDate(weekStart.getDate() + i);

        if (!daysSet.has(dayDate.toDateString())) continue;
        if (dayDate.getTime() > boundaries.now) continue;

        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = weekdayNames[dayDate.getDay()];
        btn.dataset.date = dayDate.toISOString();
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRelatedTimeFilter = { type: 'day', value: dayDate };
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
            try {
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
            } catch (_) { }
        });
        container.appendChild(btn);
    }
}

// 书签关联记录 - 渲染当月的周菜单（使用与点击排行相同的数据源）
function renderRelatedMonthWeeksMenu(container, boundaries, calendar) {
    const isZh = currentLang === 'zh_CN';
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的周
    const weeksSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.monthStart && t <= boundaries.now) {
                weeksSet.add(getWeekNumberForRelated(new Date(t)));
            }
        });
    }

    Array.from(weeksSet).sort((a, b) => a - b).forEach(weekNum => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = isZh ? `第${weekNum}周` : `W${weekNum}`;
        btn.dataset.week = weekNum;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRelatedTimeFilter = { type: 'week', value: weekNum };
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
            try {
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
            } catch (_) { }
        });
        container.appendChild(btn);
    });
}

// 书签关联记录 - 渲染当年的月份菜单（使用与点击排行相同的数据源）
function renderRelatedYearMonthsMenu(container, boundaries, calendar) {
    const isZh = currentLang === 'zh_CN';
    if (!calendar || !calendar.bookmarksByDate) return;

    const monthNames = isZh
        ? ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
        : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // 分析有数据的月份
    const monthsSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t >= boundaries.yearStart && t <= boundaries.now) {
                monthsSet.add(new Date(t).getMonth());
            }
        });
    }

    Array.from(monthsSet).sort((a, b) => a - b).forEach(month => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = monthNames[month];
        btn.dataset.month = month;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRelatedTimeFilter = { type: 'month', value: month };
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
            try {
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
            } catch (_) { }
        });
        container.appendChild(btn);
    });
}

// 书签关联记录 - 渲染全部时间的年份菜单
function renderRelatedAllYearsMenu(container, calendar) {
    const isZh = currentLang === 'zh_CN';
    if (!calendar || !calendar.bookmarksByDate) return;

    // 分析有数据的年份
    const yearsSet = new Set();
    for (const records of calendar.bookmarksByDate.values()) {
        records.forEach(record => {
            const t = record.visitTime || (record.dateAdded instanceof Date ? record.dateAdded.getTime() : 0);
            if (t > 0) {
                yearsSet.add(new Date(t).getFullYear());
            }
        });
    }

    // 按年份倒序排列（最近的年份在前）
    Array.from(yearsSet).sort((a, b) => b - a).forEach(year => {
        const btn = document.createElement('button');
        btn.className = 'time-menu-btn';
        btn.textContent = isZh ? `${year}年` : `${year}`;
        btn.dataset.year = year;
        btn.addEventListener('click', () => {
            container.querySelectorAll('.time-menu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            browsingRelatedTimeFilter = { type: 'year', value: year };
            loadBrowsingRelatedHistory(browsingRelatedCurrentRange);
            try {
                if (typeof window.updateSearchFilterExitButton === 'function') {
                    window.updateSearchFilterExitButton();
                }
            } catch (_) { }
        });
        container.appendChild(btn);
    });
}

// 按时间筛选历史记录
function filterHistoryByTime(items, filter, range) {
    if (!filter || !items || items.length === 0) return items;

    return items.filter(item => {
        if (!item.lastVisitTime) return false;

        const itemDate = new Date(item.lastVisitTime);

        switch (filter.type) {
            case 'hour':
                // 筛选特定小时
                return itemDate.getHours() === filter.value;

            case 'day':
                // 筛选特定日期
                const filterDate = new Date(filter.value);
                return itemDate.toDateString() === filterDate.toDateString();

            case 'week':
                // 筛选特定周
                const weekNum = getWeekNumberForRelated(itemDate);
                return weekNum === filter.value;

            case 'month':
                // 筛选特定月份
                return itemDate.getMonth() === filter.value;

            case 'year':
                // 筛选特定年份
                return itemDate.getFullYear() === filter.value;

            default:
                return true;
        }
    });
}

// ============================================================================
// 跳转至书签关联记录功能（从点击记录跳转）
// ============================================================================

// 全局变量：存储待高亮的记录信息
let pendingHighlightInfo = null;

// 返回按钮相关
let jumpSourceInfo = null;  // 记录跳转来源信息

function getWeekStartForRelated(date) {
    const d = new Date(date);
    const day = d.getDay() || 7; // 周日返回0，转换为7
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - day + 1);
    weekStart.setHours(0, 0, 0, 0);
    return weekStart;
}

function getPreferredRangeFromCalendar(instance) {
    if (!instance || !instance.viewLevel) return null;
    const level = String(instance.viewLevel).toLowerCase();
    switch (level) {
        case 'day':
        case 'week':
        case 'month':
        case 'year':
            return level;
        default:
            return null;
    }
}

function getPrimaryRangeForVisit(visitDate) {
    if (!visitDate) return 'day';
    const now = new Date();
    if (visitDate.toDateString() === now.toDateString()) {
        return 'day';
    }
    const diff = Math.abs(now - visitDate);
    const oneDay = 24 * 60 * 60 * 1000;
    if (diff <= 7 * oneDay) {
        return 'week';
    }
    if (diff <= 31 * oneDay) {
        return 'month';
    }
    if (visitDate.getFullYear() === now.getFullYear()) {
        return 'year';
    }
    return 'all';
}

function buildRangeFilter(range, visitDate) {
    if (!visitDate) return null;
    switch (range) {
        case 'day':
            return { type: 'hour', value: visitDate.getHours() };
        case 'week': {
            const dayDate = new Date(visitDate);
            dayDate.setHours(0, 0, 0, 0);
            return { type: 'day', value: dayDate };
        }
        case 'month':
            return { type: 'week', value: getWeekNumberForRelated(visitDate) };
        case 'year':
            return { type: 'month', value: visitDate.getMonth() };
        case 'all':
            return { type: 'year', value: visitDate.getFullYear() };
        default:
            return null;
    }
}

function buildRelatedRangeStrategies(visitTime, options = {}) {
    const strategies = [];
    const seen = new Set();
    const { preferredRange = null } = options || {};
    const hasVisitTime = typeof visitTime === 'number' && !Number.isNaN(visitTime);
    const visitDate = hasVisitTime ? new Date(visitTime) : null;

    const pushStrategy = (range, filter = null) => {
        if (!range) return;
        const filterKey = filter
            ? `${filter.type}-${filter.value instanceof Date ? filter.value.toISOString() : filter.value}`
            : 'none';
        const key = `${range}|${filterKey}`;
        if (seen.has(key)) return;
        seen.add(key);
        strategies.push({ range, filter });
    };

    if (!visitDate) {
        pushStrategy(preferredRange || 'day', null);
        pushStrategy('all', null);
        return strategies;
    }

    const primaryRange = getPrimaryRangeForVisit(visitDate);
    const orderedRanges = [];
    if (preferredRange) orderedRanges.push(preferredRange);
    orderedRanges.push(primaryRange);
    if (primaryRange !== 'year' && visitDate.getFullYear() === (new Date()).getFullYear()) {
        orderedRanges.push('year');
    }
    orderedRanges.push('all');

    const uniqueRanges = [];
    const rangeSeen = new Set();
    orderedRanges.forEach(range => {
        if (!range) return;
        if (rangeSeen.has(range)) return;
        rangeSeen.add(range);
        uniqueRanges.push(range);
    });

    uniqueRanges.forEach(range => {
        pushStrategy(range, buildRangeFilter(range, visitDate));
    });

    pushStrategy('all', null);
    return strategies;
}

function scheduleApplyRelatedFilter(filter, attempt = 0) {
    const MAX_ATTEMPTS = 10;
    const success = applyRelatedTimeFilter(filter);
    if (!success && attempt < MAX_ATTEMPTS) {
        setTimeout(() => scheduleApplyRelatedFilter(filter, attempt + 1), 120);
    }
}

function activateRelatedRangeStrategy(strategy) {
    if (!strategy) {
        // 确保在没有策略时也清理加载状态和超时
        clearTimeout(window.__relatedJumpTimeout);
        if (pendingHighlightInfo && pendingHighlightInfo.silentMenu) {
            setRelatedPanelSilent(false);
        }
        pendingHighlightInfo = null;
        return;
    }
    pendingHighlightInfo.activeStrategy = strategy;
    if (pendingHighlightInfo) {
        pendingHighlightInfo.pendingUIRange = strategy.range;
        pendingHighlightInfo.pendingUIFilter = strategy.filter || null;
    }

    const silentMode = pendingHighlightInfo && pendingHighlightInfo.silentMenu;
    if (silentMode) {
        setRelatedPanelSilent(true);
    }

    const loadAndHighlightSilently = () => {
        setTimeout(() => {
            highlightRelatedHistoryItem();
        }, 20);
    };

    if (silentMode) {
        browsingRelatedCurrentRange = strategy.range;
        browsingRelatedTimeFilter = strategy.filter || null;
        loadBrowsingRelatedHistory(strategy.range)
            .then(loadAndHighlightSilently)
            .catch(loadAndHighlightSilently);
        return;
    }

    const rangeName = strategy.range.charAt(0).toUpperCase() + strategy.range.slice(1);
    const filterBtn = document.getElementById(`browsingRelatedFilter${rangeName}`);

    const triggerHighlightFlow = () => {
        scheduleApplyRelatedFilter(strategy.filter || null);
        setTimeout(() => {
            highlightRelatedHistoryItem();
        }, 450);
    };

    if (filterBtn) {
        if (!filterBtn.classList.contains('active')) {
            filterBtn.click();
            setTimeout(triggerHighlightFlow, 350);
        } else {
            loadBrowsingRelatedHistory(strategy.range).then(() => {
                triggerHighlightFlow();
            }).catch(() => {
                triggerHighlightFlow();
            });
        }
    } else {
        loadBrowsingRelatedHistory(strategy.range).then(() => {
            triggerHighlightFlow();
        }).catch(() => {
            triggerHighlightFlow();
        });
    }
}

function syncRelatedUIWithStrategy(strategy) {
    if (!strategy) return;
    const range = strategy.range;
    const filter = strategy.filter || null;
    setActiveRelatedRangeButton(range);
    showBrowsingRelatedTimeMenu(range).then(() => {
        markRelatedTimeMenuSelection(filter);
    }).catch(() => {
        markRelatedTimeMenuSelection(filter);
    });
}

function setRelatedPanelSilent(enabled) {
    const panel = document.getElementById('browsingRelatedPanel');
    if (!panel) return;
    if (enabled) {
        const loadingText = currentLang === 'zh_CN' ? '正在定位记录…' : 'Locating record…';
        panel.setAttribute('data-loading-text', loadingText);
        panel.classList.add('related-silent-loading');
    } else {
        panel.classList.remove('related-silent-loading');
        panel.removeAttribute('data-loading-text');
    }
}

function setActiveRelatedRangeButton(range) {
    if (!range) return;
    const panel = document.getElementById('browsingRelatedPanel');
    if (!panel) return;
    const buttons = panel.querySelectorAll('.ranking-time-filter-btn');
    buttons.forEach(btn => {
        const isMatch = btn.dataset.range === range;
        btn.classList.toggle('active', isMatch);
    });
}

function markRelatedTimeMenuSelection(filter) {
    const menuContainer = document.getElementById('browsingRelatedTimeMenu');
    if (!menuContainer) return;
    const buttons = menuContainer.querySelectorAll('.time-menu-btn');
    buttons.forEach(btn => btn.classList.remove('active'));

    if (!filter) {
        const allBtn = menuContainer.querySelector('.time-menu-btn[data-filter="all"]');
        if (allBtn) allBtn.classList.add('active');
        return;
    }

    let targetBtn = null;
    buttons.forEach(btn => {
        if (filter.type === 'hour' && btn.dataset.hour == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'day' && btn.dataset.date) {
            const btnDate = new Date(btn.dataset.date);
            if (filter.value instanceof Date && btnDate.toDateString() === filter.value.toDateString()) {
                targetBtn = btn;
            }
        } else if (filter.type === 'week' && btn.dataset.week == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'month' && btn.dataset.month == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'year' && btn.dataset.year == filter.value) {
            targetBtn = btn;
        }
    });

    if (targetBtn) {
        targetBtn.classList.add('active');
    } else {
        const allBtn = menuContainer.querySelector('.time-menu-btn[data-filter="all"]');
        if (allBtn) allBtn.classList.add('active');
    }
}

// 跳转到书签关联记录并高亮对应条目
async function jumpToRelatedHistory(url, title, visitTime, sourceElement) {
    // 记录来源信息，用于返回
    jumpSourceInfo = {
        type: 'browsingHistory',  // 来自点击记录
        url: url,
        title: title,
        visitTime: visitTime,
        scrollTop: document.querySelector('.content-area')?.scrollTop || 0
    };

    // 添加超时保护机制，确保加载状态一定会被清理
    clearTimeout(window.__relatedJumpTimeout);
    window.__relatedJumpTimeout = setTimeout(() => {
        if (pendingHighlightInfo && pendingHighlightInfo.silentMenu) {
            console.warn('[BrowsingRelated] 跳转超时，强制清理加载状态');
            setRelatedPanelSilent(false);
            pendingHighlightInfo = null;
        }
    }, 10000); // 10秒超时保护

    // 1. 切换到「书签浏览记录」标签
    const browsingTab = document.getElementById('additionsTabBrowsing');
    if (browsingTab && !browsingTab.classList.contains('active')) {
        browsingTab.click();
    }

    // 2. 切换到「书签关联记录」子标签
    const relatedTab = document.getElementById('browsingTabRelated');
    if (relatedTab && !relatedTab.classList.contains('active')) {
        relatedTab.click();
    }

    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    const hasPreciseVisit = typeof visitTime === 'number' && !Number.isNaN(visitTime);
    const preferredRange = getPreferredRangeFromCalendar(window.browsingHistoryCalendarInstance);
    const strategyQueue = buildRelatedRangeStrategies(visitTime, { preferredRange });
    const effectiveStrategies = strategyQueue.length ? strategyQueue : [{ range: 'all', filter: null }];

    // 3. 存储待高亮信息和时间范围策略
    pendingHighlightInfo = {
        url: url,
        title: title,
        normalizedTitle,
        visitTime: visitTime,
        strategyQueue: effectiveStrategies,
        currentStrategyIndex: 0,
        showBackButton: true, // 标记需要显示返回按钮
        hasVisitTime: hasPreciseVisit,
        forceLoadAll: true,
        silentMenu: true,
        pendingUIRange: effectiveStrategies[0]?.range || null,
        pendingUIFilter: effectiveStrategies[0]?.filter || null
    };

    // 4. 启动首个时间范围策略
    activateRelatedRangeStrategy(effectiveStrategies[0]);
}

// 高亮书签关联记录中的目标条目
function highlightRelatedHistoryItem(retryCount = 0) {
    if (!pendingHighlightInfo) return;

    const {
        url,
        title,
        normalizedTitle,
        visitTime,
        strategyQueue = [],
        currentStrategyIndex = 0,
        fromAdditions,
        showBackButton: shouldShowBackButton,
        hasVisitTime: storedVisitFlag,
        forceLoadAll
    } = pendingHighlightInfo;
    const listContainer = document.getElementById('browsingRelatedList');
    if (!listContainer) {
        // 确保在容器不存在时也清理加载状态和超时
        clearTimeout(window.__relatedJumpTimeout);
        const silentMode = pendingHighlightInfo && pendingHighlightInfo.silentMenu;
        pendingHighlightInfo = null;
        if (silentMode) {
            setRelatedPanelSilent(false);
        }
        return;
    }

    const normalizedTitleValue = normalizedTitle || (title ? title.trim() : '');
    const computedHasVisitTime = typeof visitTime === 'number' && !Number.isNaN(visitTime);
    const hasVisitTime = typeof storedVisitFlag === 'boolean' ? storedVisitFlag : computedHasVisitTime;
    const targetMinute = hasVisitTime ? Math.floor(visitTime / (60 * 1000)) : null;

    const candidateSelector = hasVisitTime && targetMinute !== null
        ? `[data-visit-minute="${targetMinute}"]`
        : '.related-history-item';
    let nodes = listContainer.querySelectorAll(candidateSelector);
    if (!nodes || nodes.length === 0) {
        nodes = listContainer.querySelectorAll('.related-history-item');
    }

    let minuteUrlMatch = null;
    let minuteTitleMatch = null;
    let fallbackMatch = null;
    nodes.forEach(item => {
        if (minuteUrlMatch && minuteTitleMatch) {
            return;
        }

        const itemUrl = item.dataset.url;
        const itemTitle = (item.dataset.title || '').trim();
        const matchesUrl = itemUrl === url;
        const matchesTitle = normalizedTitleValue && itemTitle === normalizedTitleValue;

        if (hasVisitTime) {
            const itemMinuteAttr = item.dataset.visitMinute;
            if (itemMinuteAttr && Number(itemMinuteAttr) === targetMinute) {
                if (matchesUrl && !minuteUrlMatch) {
                    minuteUrlMatch = item;
                    return;
                }
                if (matchesTitle && !minuteTitleMatch) {
                    minuteTitleMatch = item;
                    return;
                }
            }
        } else if (!fallbackMatch && (matchesUrl || matchesTitle)) {
            fallbackMatch = item;
        }
    });

    let targetItem = minuteUrlMatch || minuteTitleMatch || null;
    if (!targetItem && !hasVisitTime) {
        targetItem = fallbackMatch;
    }

    if (targetItem) {
        const shouldSyncUI = pendingHighlightInfo && pendingHighlightInfo.silentMenu;
        const finalStrategy = pendingHighlightInfo ? pendingHighlightInfo.activeStrategy : null;
        listContainer.querySelectorAll('.related-history-item.highlight-target').forEach(el => {
            el.classList.remove('highlight-target');
        });
        targetItem.classList.add('highlight-target');
        targetItem.scrollIntoView({ behavior: 'instant', block: 'center' });
        if (shouldShowBackButton && typeof showBackButton === 'function' && jumpSourceInfo) {
            showBackButton();
        }
        if (shouldSyncUI && finalStrategy) {
            browsingRelatedTimeFilter = finalStrategy.filter || null;
            syncRelatedUIWithStrategy(finalStrategy);
        }
        showRelatedJumpSuccessToast(visitTime, title);
        // 清除超时保护
        clearTimeout(window.__relatedJumpTimeout);
        if (pendingHighlightInfo && pendingHighlightInfo.silentMenu) {
            setRelatedPanelSilent(false);
        }
        pendingHighlightInfo = null;
        return;
    }

    const lazyState = listContainer.__lazyLoadState;
    if (lazyState) {
        if (forceLoadAll && !lazyState.__forceLoaded) {
            lazyState.__forceLoaded = true;
            lazyState.loadAll();
            setTimeout(() => highlightRelatedHistoryItem(retryCount + 1), 120);
            return;
        }
        if (lazyState.getLoadedCount() < lazyState.totalItems) {
            lazyState.loadMore();
            if (retryCount < 20) {
                setTimeout(() => highlightRelatedHistoryItem(retryCount + 1), 120);
            } else {
                lazyState.loadAll();
                setTimeout(() => highlightRelatedHistoryItem(100), 150);
            }
            return;
        }
    }

    if (retryCount < 5) {
        setTimeout(() => highlightRelatedHistoryItem(retryCount + 1), 220);
        return;
    }

    if (strategyQueue.length && currentStrategyIndex < strategyQueue.length - 1) {
        const nextIndex = currentStrategyIndex + 1;
        pendingHighlightInfo.currentStrategyIndex = nextIndex;
        activateRelatedRangeStrategy(strategyQueue[nextIndex]);
        return;
    }

    const silentMode = pendingHighlightInfo && pendingHighlightInfo.silentMenu;
    // 清除超时保护
    clearTimeout(window.__relatedJumpTimeout);
    pendingHighlightInfo = null;
    if (silentMode) {
        setRelatedPanelSilent(false);
    }
    if (fromAdditions || hasVisitTime) {
        showNoRecordToast();
    }
}

// 显示暂无记录提示
function showNoRecordToast() {
    const msg = typeof currentLang !== 'undefined' && currentLang === 'zh_CN'
        ? '暂无浏览记录（可能是导入的书签）'
        : 'No browsing history found (may be imported bookmark)';

    // 创建提示元素
    let toast = document.getElementById('noRecordToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'noRecordToast';
        toast.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: #fff;
            padding: 16px 24px;
            border-radius: 8px;
            font-size: 14px;
            z-index: 10000;
            opacity: 0;
            transition: opacity 0.3s ease;
        `;
        document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.opacity = '1';

    setTimeout(() => {
        toast.style.opacity = '0';
    }, 2500);
}

function showRelatedJumpSuccessToast(visitTime, title) {
    const isZh = currentLang === 'zh_CN';
    const dateText = visitTime
        ? new Date(visitTime).toLocaleString(isZh ? 'zh-CN' : 'en-US', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        })
        : '';
    const safeTitle = (title && title.trim()) || (isZh ? '目标记录' : 'target entry');
    const msg = isZh
        ? `已定位：${safeTitle}${dateText ? `（${dateText}）` : ''}`
        : `Jumped to ${safeTitle}${dateText ? ` (${dateText})` : ''}`;

    let toast = document.getElementById('relatedJumpToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'relatedJumpToast';
        toast.style.cssText = `
            position: fixed;
            top: 28px;
            right: 28px;
            background: rgba(33, 150, 243, 0.92);
            color: #fff;
            padding: 14px 18px;
            border-radius: 10px;
            font-size: 13px;
            box-shadow: 0 8px 24px rgba(33, 150, 243, 0.35);
            z-index: 11000;
            opacity: 0;
            transition: opacity 0.25s ease;
        `;
        document.body.appendChild(toast);
    }

    toast.textContent = msg;
    toast.style.opacity = '1';

    clearTimeout(toast.__hideTimer);
    toast.__hideTimer = setTimeout(() => {
        toast.style.opacity = '0';
    }, 2400);
}

// 从「书签添加记录」跳转到「书签关联记录」
async function jumpToRelatedHistoryFromAdditions(url, title, dateAdded) {
    const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;

    // 先查询该URL在书签添加时间附近是否有访问记录
    let hasMatchingVisit = false;
    let matchingVisitTime = null;

    try {
        if (browserAPI && browserAPI.history && browserAPI.history.getVisits) {
            const visits = await new Promise((resolve, reject) => {
                browserAPI.history.getVisits({ url: url }, (results) => {
                    if (browserAPI.runtime && browserAPI.runtime.lastError) {
                        reject(browserAPI.runtime.lastError);
                    } else {
                        resolve(results || []);
                    }
                });
            });

            // 查找时间精确匹配的访问记录（同一分钟内，即60秒）
            const oneMinute = 60 * 1000;
            let minDiff = Infinity;

            visits.forEach(visit => {
                const diff = Math.abs(visit.visitTime - dateAdded);
                if (diff < minDiff) {
                    minDiff = diff;
                    matchingVisitTime = visit.visitTime;
                }
            });

            // 时间差必须在1分钟内才算匹配
            hasMatchingVisit = minDiff <= oneMinute;
        }
    } catch (e) {
        console.warn('[jumpToRelatedHistoryFromAdditions] 查询访问记录失败:', e);
    }

    // 如果没有精确匹配的访问记录，直接显示提示，不跳转
    if (!hasMatchingVisit) {
        showNoRecordToast();
        return;
    }

    // 记录来源信息，用于返回
    jumpSourceInfo = {
        type: 'bookmarkAdditions',  // 来自书签添加记录
        url: url,
        title: title,
        dateAdded: dateAdded,
        scrollTop: document.querySelector('.content-area')?.scrollTop || 0
    };

    // 添加超时保护机制
    clearTimeout(window.__relatedJumpTimeout);
    window.__relatedJumpTimeout = setTimeout(() => {
        if (pendingHighlightInfo && pendingHighlightInfo.silentMenu) {
            console.warn('[BrowsingRelated] 跳转超时，强制清理加载状态');
            setRelatedPanelSilent(false);
            pendingHighlightInfo = null;
        }
    }, 10000);

    // 1. 切换到「书签浏览记录」标签
    const browsingTab = document.getElementById('additionsTabBrowsing');
    if (browsingTab && !browsingTab.classList.contains('active')) {
        browsingTab.click();
    }

    // 2. 切换到「书签关联记录」子标签
    const relatedTab = document.getElementById('browsingTabRelated');
    if (relatedTab && !relatedTab.classList.contains('active')) {
        relatedTab.click();
    }

    // 3. 根据访问时间构建时间范围策略
    const normalizedTitle = typeof title === 'string' ? title.trim() : '';
    const hasPreciseVisit = typeof matchingVisitTime === 'number' && !Number.isNaN(matchingVisitTime);
    const preferredRange = getPreferredRangeFromCalendar(window.bookmarkCalendarInstance);
    const strategyQueue = buildRelatedRangeStrategies(matchingVisitTime, { preferredRange });
    const effectiveStrategies = strategyQueue.length ? strategyQueue : [{ range: 'all', filter: null }];

    // 4. 存储待高亮信息
    pendingHighlightInfo = {
        url: url,
        title: title,
        normalizedTitle,
        visitTime: matchingVisitTime,
        strategyQueue: effectiveStrategies,
        currentStrategyIndex: 0,
        fromAdditions: true,
        showBackButton: true,  // 标记需要显示返回按钮
        hasVisitTime: hasPreciseVisit,
        forceLoadAll: true,
        silentMenu: true,
        pendingUIRange: effectiveStrategies[0]?.range || null,
        pendingUIFilter: effectiveStrategies[0]?.filter || null
    };

    // 5. 启动对应的范围策略
    activateRelatedRangeStrategy(effectiveStrategies[0]);
}

// 从「点击排行」跳转到「书签关联记录」并高亮所有匹配记录
async function jumpToRelatedHistoryFromRanking(url, title, currentRange) {
    // 保存当前的二级菜单筛选条件
    const currentTimeFilter = browsingRankingTimeFilter ? { ...browsingRankingTimeFilter } : null;

    // 记录来源信息，用于返回
    jumpSourceInfo = {
        type: 'clickRanking',  // 来自点击排行
        url: url,
        title: title,
        range: currentRange,
        timeFilter: currentTimeFilter,  // 保存二级菜单筛选条件
        scrollTop: document.querySelector('.content-area')?.scrollTop || 0
    };

    // 添加超时保护机制
    clearTimeout(window.__relatedJumpTimeout);
    window.__relatedJumpTimeout = setTimeout(() => {
        if (pendingHighlightInfo) {
            console.warn('[BrowsingRelated] 跳转超时，强制清理状态');
            setRelatedPanelSilent(false);
            pendingHighlightInfo = null;
        }
    }, 10000);

    // 1. 切换到「书签浏览记录」标签
    const browsingTab = document.getElementById('additionsTabBrowsing');
    if (browsingTab && !browsingTab.classList.contains('active')) {
        browsingTab.click();
    }

    // 2. 切换到「书签关联记录」子标签
    const relatedTab = document.getElementById('browsingTabRelated');
    if (relatedTab && !relatedTab.classList.contains('active')) {
        relatedTab.click();
    }

    // 3. 存储待高亮信息
    pendingHighlightInfo = {
        url: url,
        title: title,
        currentRange: currentRange,
        timeFilter: currentTimeFilter,  // 传递二级菜单筛选条件
        fromRanking: true,
        showBackButton: true,
        highlightAll: true
    };

    // 4. 切换到对应的时间范围（这会触发 showBrowsingRelatedTimeMenu）
    const rangeName = currentRange.charAt(0).toUpperCase() + currentRange.slice(1);
    const filterBtn = document.getElementById(`browsingRelatedFilter${rangeName}`);
    if (filterBtn && !filterBtn.classList.contains('active')) {
        filterBtn.click();
    } else {
        // 已经在当前范围，重新加载
        await loadBrowsingRelatedHistory(currentRange);
    }

    // 5. 延迟应用二级菜单筛选并高亮
    setTimeout(() => {
        if (currentTimeFilter) {
            scheduleApplyRelatedFilter(currentTimeFilter);
        }
        highlightAllRelatedHistoryItems();
    }, 500);
}

// 应用书签关联记录的二级菜单筛选（从点击排行跳转时使用）
function applyRelatedTimeFilter(filter) {
    const menuContainer = document.getElementById('browsingRelatedTimeMenu');
    if (!menuContainer) return false;
    const buttons = menuContainer.querySelectorAll('.time-menu-btn');
    if (!buttons.length) return false;

    let targetBtn = null;

    buttons.forEach(btn => {
        if (!filter) {
            if (btn.dataset.filter === 'all' && !targetBtn) {
                targetBtn = btn;
            }
            return;
        }

        if (btn.dataset.filter === 'all' && filter.type === 'all') {
            targetBtn = btn;
        } else if (filter.type === 'hour' && btn.dataset.hour == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'day' && btn.dataset.date) {
            const btnDate = new Date(btn.dataset.date);
            if (filter.value instanceof Date && btnDate.toDateString() === filter.value.toDateString()) {
                targetBtn = btn;
            }
        } else if (filter.type === 'week' && btn.dataset.week == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'month' && btn.dataset.month == filter.value) {
            targetBtn = btn;
        } else if (filter.type === 'year' && btn.dataset.year == filter.value) {
            targetBtn = btn;
        }
    });

    if (targetBtn) {
        targetBtn.click();
        return true;
    }

    return false;
}

// 高亮点击记录日历中所有匹配的记录（从点击排行跳转时使用）
function highlightAllClickHistoryItems(retryCount = 0) {
    if (!pendingHighlightInfo) return;

    const { url, title, currentRange, showBackButton: shouldShowBackButton } = pendingHighlightInfo;

    // 获取点击记录日历实例
    const calendar = window.browsingHistoryCalendarInstance;
    if (!calendar || !calendar.bookmarksByDate) {
        if (retryCount < 10) {
            setTimeout(() => highlightAllClickHistoryItems(retryCount + 1), 300);
        } else {
            pendingHighlightInfo = null;
            showNoRecordToast();
        }
        return;
    }

    // 查找日历容器中的所有书签项
    const calendarContainer = document.getElementById('browsingHistoryCalendar');
    if (!calendarContainer) {
        if (retryCount < 10) {
            setTimeout(() => highlightAllClickHistoryItems(retryCount + 1), 300);
        }
        return;
    }

    // 查找所有匹配URL的书签项（使用 data-bookmark-url 属性）
    const items = calendarContainer.querySelectorAll('[data-bookmark-url]');
    const matchedItems = [];

    items.forEach(item => {
        const itemUrl = item.dataset.bookmarkUrl;
        if (itemUrl === url) {
            matchedItems.push(item);
        }
    });

    if (matchedItems.length > 0) {
        // 移除之前的高亮
        calendarContainer.querySelectorAll('[data-bookmark-url].highlight-target').forEach(el => {
            el.classList.remove('highlight-target');
        });

        // 为所有匹配项添加高亮
        matchedItems.forEach(item => {
            item.classList.add('highlight-target');
        });

        // 滚动到第一个匹配项
        matchedItems[0].scrollIntoView({ behavior: 'instant', block: 'center' });

        // 显示返回按钮
        if (shouldShowBackButton && jumpSourceInfo) {
            showBackButton();
        }

        // 清除待高亮信息
        pendingHighlightInfo = null;
        return;
    }

    // 没找到匹配项，可能需要等待渲染
    if (retryCount < 10) {
        setTimeout(() => highlightAllClickHistoryItems(retryCount + 1), 300);
    } else {
        pendingHighlightInfo = null;
        showNoRecordToast();
    }
}

// 高亮所有匹配的书签关联记录（保留，可能其他地方使用）
function highlightAllRelatedHistoryItems(retryCount = 0) {
    if (!pendingHighlightInfo) return;

    const { url, title, highlightAll, showBackButton: shouldShowBackButton } = pendingHighlightInfo;
    const listContainer = document.getElementById('browsingRelatedList');
    if (!listContainer) {
        // 确保在容器不存在时也清理状态
        clearTimeout(window.__relatedJumpTimeout);
        pendingHighlightInfo = null;
        return;
    }

    // 查找所有匹配的记录项（URL匹配或标题匹配，与点击排行的计数逻辑保持一致）
    const items = listContainer.querySelectorAll('.related-history-item');
    const matchedItems = [];
    const normalizedTitle = title ? title.trim() : '';

    items.forEach(item => {
        const itemUrl = item.dataset.url;
        const itemTitle = item.dataset.title || '';

        // URL 精确匹配
        if (itemUrl === url) {
            matchedItems.push(item);
        }
        // 标题匹配（URL不同但标题相同）
        else if (normalizedTitle && itemTitle === normalizedTitle) {
            matchedItems.push(item);
        }
    });

    // 如果找到了匹配项，高亮显示
    if (matchedItems.length > 0) {
        // 移除之前的高亮
        listContainer.querySelectorAll('.related-history-item.highlight-target').forEach(el => {
            el.classList.remove('highlight-target');
        });

        // 为所有匹配项添加高亮
        matchedItems.forEach(item => {
            item.classList.add('highlight-target');
        });

        // 获取当前排序顺序（默认按时间降序，即最新的在前）
        const sortBtn = document.querySelector('.sort-indicator-btn');
        const isAscending = sortBtn && sortBtn.classList.contains('asc');

        // 根据排序滚动到第一个或最后一个（最新/最旧的记录）
        const targetItem = isAscending ? matchedItems[0] : matchedItems[0];
        targetItem.scrollIntoView({ behavior: 'instant', block: 'center' });

        // 显示返回按钮
        if (shouldShowBackButton && jumpSourceInfo) {
            showBackButton();
        }

        // 清除超时保护和待高亮信息
        clearTimeout(window.__relatedJumpTimeout);
        pendingHighlightInfo = null;
        return;
    }

    // 检查是否有未加载的数据（懒加载场景）
    const lazyState = listContainer.__lazyLoadState;
    if (lazyState && lazyState.getLoadedCount() < lazyState.totalItems) {
        // 还有未加载的数据，加载更多后重试
        lazyState.loadMore();
        if (retryCount < 20) {
            setTimeout(() => highlightAllRelatedHistoryItems(retryCount + 1), 100);
        } else {
            // 重试次数过多，加载全部然后最后尝试一次
            lazyState.loadAll();
            setTimeout(() => highlightAllRelatedHistoryItems(100), 100);
        }
        return;
    }

    // 没找到匹配项
    if (retryCount < 5) {
        setTimeout(() => highlightAllRelatedHistoryItems(retryCount + 1), 300);
    } else {
        // 清除超时保护
        clearTimeout(window.__relatedJumpTimeout);
        pendingHighlightInfo = null;
        // 显示暂无记录提示
        showNoRecordToast();
    }
}

// ============================================================================
// 返回按钮功能
// ============================================================================

// 显示返回按钮
function showBackButton() {
    // 如果已存在，先移除（但不清除 jumpSourceInfo）
    const existingBtn = document.getElementById('jumpBackBtn');
    if (existingBtn) existingBtn.remove();

    console.log('[showBackButton] 显示返回按钮, jumpSourceInfo:', jumpSourceInfo);

    const btn = document.createElement('button');
    btn.id = 'jumpBackBtn';
    btn.className = 'jump-back-btn';
    btn.innerHTML = '<i class="fas fa-arrow-left"></i>';
    btn.title = typeof currentLang !== 'undefined' && currentLang === 'zh_CN' ? '返回' : 'Go Back';

    btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        console.log('[showBackButton] 点击返回按钮');
        goBackToSource();
    });

    document.body.appendChild(btn);

    // 显示动画
    setTimeout(() => {
        btn.style.opacity = '1';
        btn.style.transform = 'translateY(0)';
    }, 50);
}

// 隐藏返回按钮（可选是否清除来源信息）
function hideBackButton(clearSource = true) {
    const btn = document.getElementById('jumpBackBtn');
    if (btn) {
        btn.remove();
    }
    if (clearSource) {
        jumpSourceInfo = null;
    }
}

// 返回到跳转来源
async function goBackToSource() {
    if (!jumpSourceInfo) {
        console.warn('[goBackToSource] jumpSourceInfo 为空');
        return;
    }

    const { type, url, scrollTop } = jumpSourceInfo;
    console.log('[goBackToSource] 返回:', type, url);

    // 先隐藏返回按钮
    const btn = document.getElementById('jumpBackBtn');
    if (btn) btn.remove();

    // 清除来源信息（在使用完之后立即清除）
    jumpSourceInfo = null;

    if (type === 'browsingHistory') {
        // 返回点击记录 - 需要切换到「点击记录」子标签
        const historyTab = document.getElementById('browsingTabHistory');
        if (historyTab) {
            historyTab.click();
            console.log('[goBackToSource] 已切换到点击记录');
        }

        // 恢复滚动位置并高亮
        setTimeout(() => {
            const contentArea = document.querySelector('.content-area');
            if (contentArea && scrollTop) {
                contentArea.scrollTop = scrollTop;
            }
            highlightSourceBookmark(url);
        }, 500);

    } else if (type === 'bookmarkAdditions') {
        // 返回书签添加记录 - 需要切换到「书签添加记录」标签
        const reviewTab = document.getElementById('additionsTabReview');
        if (reviewTab) {
            reviewTab.click();
            console.log('[goBackToSource] 已切换到书签添加记录');
        }

        // 恢复滚动位置并高亮
        setTimeout(() => {
            const contentArea = document.querySelector('.content-area');
            if (contentArea && scrollTop) {
                contentArea.scrollTop = scrollTop;
            }
            highlightSourceBookmark(url);
        }, 500);

    } else if (type === 'clickRanking') {
        // 返回点击排行 - 需要切换到「点击排行」子标签
        const rankingTab = document.getElementById('browsingTabRanking');
        if (rankingTab) {
            rankingTab.click();
            console.log('[goBackToSource] 已切换到点击排行');
        }

        // 恢复滚动位置并高亮
        setTimeout(() => {
            const contentArea = document.querySelector('.content-area');
            if (contentArea && scrollTop) {
                contentArea.scrollTop = scrollTop;
            }
            highlightSourceRankingItem(url);
        }, 500);
    }
}

// 高亮来源书签
function highlightSourceBookmark(url) {
    // 在整个内容区域查找匹配的书签项
    const contentArea = document.querySelector('.content-area');
    if (!contentArea) {
        console.warn('[highlightSourceBookmark] 未找到 content-area');
        return;
    }

    // 查找所有匹配URL的书签项
    const items = contentArea.querySelectorAll('[data-bookmark-url]');
    console.log('[highlightSourceBookmark] 查找书签:', url, '找到', items.length, '个书签项');

    let found = false;

    items.forEach(item => {
        if (item.dataset.bookmarkUrl === url && !found) {
            found = true;
            console.log('[highlightSourceBookmark] 找到匹配书签，添加高亮');
            item.classList.add('highlight-source');
            item.scrollIntoView({ behavior: 'instant', block: 'center' });

            // 3秒后移除高亮
            setTimeout(() => {
                item.classList.remove('highlight-source');
            }, 3000);
        }
    });

    if (!found) {
        console.warn('[highlightSourceBookmark] 未找到匹配的书签');
    }
}

// 高亮点击排行中的来源书签
function highlightSourceRankingItem(url) {
    const listContainer = document.getElementById('browsingRankingList');
    if (!listContainer) {
        console.warn('[highlightSourceRankingItem] 未找到 browsingRankingList');
        return;
    }

    // 查找所有排行项
    const items = listContainer.querySelectorAll('.ranking-item');
    console.log('[highlightSourceRankingItem] 查找排行项:', url, '找到', items.length, '个项目');

    let found = false;

    items.forEach(item => {
        // 通过跳转按钮的 data-url 来匹配
        const jumpBtn = item.querySelector('.jump-to-related-btn');
        if (jumpBtn && jumpBtn.dataset.url === url && !found) {
            found = true;
            console.log('[highlightSourceRankingItem] 找到匹配排行项，添加高亮');
            item.classList.add('highlight-source');
            item.scrollIntoView({ behavior: 'instant', block: 'center' });

            // 3秒后移除高亮
            setTimeout(() => {
                item.classList.remove('highlight-source');
            }, 3000);
        }
    });

    if (!found) {
        console.warn('[highlightSourceRankingItem] 未找到匹配的排行项');
    }
}

// 工具函数
// =============================================================================

async function renderTreeView() {
    // 记录/推荐版不使用书签树视图，仅用于兼容共享菜单模块
}

async function openBookmarkNewTab(url, meta = {}) {
    try {
        const browserAPI = (typeof chrome !== 'undefined') ? chrome : browser;
        if (browserAPI?.tabs?.create) {
            const tab = await browserAPI.tabs.create({ url });
            if (tab && tab.id != null) {
                await reportExtensionBookmarkOpen({
                    tabId: tab.id,
                    url,
                    title: meta.title || '',
                    bookmarkId: meta.bookmarkId || null,
                    source: meta.source || 'history_ui'
                });
            }
        } else {
            window.open(url, '_blank');
        }
    } catch (e) {
        console.warn('[openBookmarkNewTab] 打开失败:', e);
        try { window.open(url, '_blank'); } catch (_) { }
    }
}
async function reportExtensionBookmarkOpen({ tabId, url, title = '', bookmarkId = null, source = 'history_ui' } = {}) {
    try {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
        if (typeof tabId !== 'number') return;
        if (!url || typeof url !== 'string') return;
        await chrome.runtime.sendMessage({
            action: 'extensionBookmarkOpen',
            tabId,
            url,
            title,
            bookmarkId,
            source
        });
    } catch (_) { }
}
if (typeof window !== 'undefined') {
    window.openBookmarkNewTab = openBookmarkNewTab;
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    return `${year}/${month}/${day} ${hours}:${minutes}:${seconds}`;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showLoading() {
    document.querySelectorAll('.view.active .additions-container').forEach(el => {
        el.innerHTML = `<div class="loading">${i18n.loading[currentLang]}</div>`;
    });
}

function showError(message) {
    const container = document.querySelector('.view.active > div:last-child');
    if (container) {
        container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-exclamation-triangle"></i></div>
                <div class="empty-state-title">${escapeHtml(message)}</div>
            </div>
        `;
    }
}

function showToast(message) {
    // 简单的提示功能
    const toast = document.createElement('div');
    toast.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        padding: 12px 20px;
        background: var(--accent-primary);
        color: white;
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        z-index: 10000;
        animation: slideIn 0.3s ease;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 2000);
}



// 添加动画样式
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from { transform: translateX(100%); opacity: 0; }
        to { transform: translateX(0); opacity: 1; }
    }
    @keyframes slideOut {
        from { transform: translateX(0); opacity: 1; }
        to { transform: translateX(100%); opacity: 0; }
    }
`;
document.head.appendChild(style);
