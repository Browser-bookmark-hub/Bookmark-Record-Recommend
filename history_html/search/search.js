/**
 * 搜索功能模块（书签记录 + 书签推荐）
 * Search Module (Record + Recommend)
 *
 * 文件位置：history_html/search/search.js
 *
 * 书签记录搜索：
 * - review/browsing/tracking 子标签内的筛选与定位
 *
 * 书签推荐搜索：
 * - 推荐列表与卡片内容的检索
 *
 * 依赖：
 * - history.js 中的全局变量：currentView, currentLang
 * - history.js 中的工具函数：escapeHtml, i18n
 */

// ==================== 模块状态 ====================

/**
 * 搜索 UI 状态
 */
let initialSearchMode = 'additions';
try {
    if (typeof window !== 'undefined') {
        if (window.currentView === 'recommend') {
            initialSearchMode = 'recommend';
        } else {
            const viewAttr = document?.documentElement?.getAttribute('data-initial-view');
            if (viewAttr === 'recommend') {
                initialSearchMode = 'recommend';
            } else {
                const params = new URLSearchParams(window.location.search);
                const viewParam = params.get('view');
                if (viewParam === 'recommend') {
                    initialSearchMode = 'recommend';
                }
            }
        }
    }
} catch (_) { }

const searchUiState = {
    view: null,
    query: '',
    selectedIndex: -1,
    results: [],
    activeMode: initialSearchMode,
    isMenuOpen: false,
    isHelpOpen: false
};

function isSidePanelModeInSearch() {
    try {
        if (window.__SIDE_PANEL_MODE__ === true) return true;
        if (document && document.documentElement && document.documentElement.classList.contains('side-panel-mode')) return true;
        const params = new URLSearchParams(window.location.search);
        const flag = params.get('sidepanel') || params.get('side_panel') || params.get('panel');
        return flag === '1' || flag === 'true';
    } catch (_) {
        return false;
    }
}

function setSidePanelSearchExpanded(expanded) {
    const container = document.querySelector('.search-container');
    if (!container) return;

    const shouldExpand = !!expanded;
    if (shouldExpand) {
        container.classList.add('side-panel-search-expanded');
        return;
    }

    container.classList.remove('side-panel-search-expanded');
}

function isSidePanelSearchExpanded() {
    const container = document.querySelector('.search-container');
    return !!(container && container.classList.contains('side-panel-search-expanded'));
}

// ==================== 搜索上下文管理器 (Phase 4) ====================

/**
 * 搜索上下文管理器
 * 负责根据当前视图状态（View/Tab）动态配置搜索行为
 */
window.SearchContextManager = {
    currentContext: {
        view: 'additions', // Record + Recommend
        tab: null,
        subTab: null
    },

    _lastContextKey: '',

    /**
     * 更新搜索上下文
     * @param {string} [tab] - 二级标签 (review, browsing, tracking)
     * @param {string} [subTab] - 三级标签 (history, ranking, related)
     */
    updateContext(view, tab = null, subTab = null) {
        const next = { view, tab, subTab };
        const key = `${String(view || '')}::${String(tab || '')}::${String(subTab || '')}`;
        const changed = key !== this._lastContextKey;

        this.currentContext = next;
        this._lastContextKey = key;
        console.log('[SearchContext] Context Updated:', this.currentContext);

        // [Search Isolation] Different pages share the same top search input but have different behaviors.
        // When context changes, clear the input + results so queries won't leak across views/tabs.
        if (changed && typeof window.resetMainSearchUI === 'function') {
            window.resetMainSearchUI({ reason: 'context-change' });
        }

        this.updateUI();

        // Phase 4.7: keep exit button visibility in sync with context
        try {
            if (typeof window.updateSearchFilterExitButton === 'function') {
                window.updateSearchFilterExitButton();
            }
        } catch (_) { }

        // Phase 4.7: auto-exit isolated filters when leaving page
        try {
            if (typeof window.autoExitSearchFiltersOnContextChange === 'function') {
                window.autoExitSearchFiltersOnContextChange(prev, next);
            }
        } catch (_) { }
    },

    /**
     * 根据当前上下文更新 UI（如 Placeholder）
     */
    updateUI() {
        const input = document.getElementById('searchInput');
        if (!input) return;

        let placeholder = '';
        const ctx = this.currentContext;

        if (ctx.view === 'additions') {
            if (ctx.tab === 'review') {
                placeholder = currentLang === 'zh_CN' ? '搜索日期 (20241105, 2024...) 或关键词' : 'Search date (20241105...) or keyword...';
            } else if (ctx.tab === 'browsing') {
                if (ctx.subTab === 'history') {
                    placeholder = currentLang === 'zh_CN' ? '搜索日期 (20241105, 2024...) 或关键词' : 'Search date (20241105...) or keyword...';
                } else if (ctx.subTab === 'ranking') {
                    placeholder = currentLang === 'zh_CN' ? '在排行中筛选书签...' : 'Filter bookmarks in ranking...';
                } else if (ctx.subTab === 'related') {
                    placeholder = currentLang === 'zh_CN' ? '搜索日期或关键词...' : 'Search date or keyword...';
                }
            } else if (ctx.tab === 'tracking') {
                placeholder = currentLang === 'zh_CN' ? '在综合排行中搜索书签...' : 'Search in ranking...';
            } else {
                placeholder = currentLang === 'zh_CN' ? '搜索书签记录...' : 'Search records...';
            }
        } else if (ctx.view === 'recommend') {
            placeholder = currentLang === 'zh_CN' ? '搜索推荐内容...' : 'Search recommendations...';
        }

        if (placeholder) {
            input.setAttribute('placeholder', placeholder);
        }
    },

    /**
     * 获取当前上下文的搜索模式 ID
     */
    getModeId() {
        const ctx = this.currentContext;
        if (ctx.view === 'additions') {
            if (ctx.tab === 'review') return 'calendar-date';
            if (ctx.tab === 'browsing') {
                if (ctx.subTab === 'history') return 'calendar-date';
                if (ctx.subTab === 'ranking') return 'ranking-item';
                if (ctx.subTab === 'related') return 'related-item';
            }
            if (ctx.tab === 'tracking') return 'tracking-item';
        }
        return 'default';
    }
};

function syncSearchContextFromCurrentUI(reason = 'sync') {
    try {
        if (!window.SearchContextManager || typeof window.SearchContextManager.updateContext !== 'function') return;

        const view = (typeof window.currentView === 'string' && window.currentView)
            ? window.currentView
            : 'additions';

        let tab = null;
        let subTab = null;
        if (view === 'additions') {
            tab = localStorage.getItem('additionsActiveTab') || 'review';
            if (tab === 'browsing') {
                subTab = localStorage.getItem('browsingActiveSubTab') || 'history';
            }
        }

        window.SearchContextManager.updateContext(view, tab, subTab);
        try {
            if (typeof setSearchMode === 'function') {
                setSearchMode(view, { switchView: false });
            }
        } catch (_) { }
        console.log('[SearchContext] Synced from UI:', { reason, view, tab, subTab });
    } catch (_) { }
}

try {
    window.syncSearchContextFromCurrentUI = syncSearchContextFromCurrentUI;
} catch (_) { }

// Ensure correct placeholder after refresh.
// history.js runs before search.js, and initAdditionsSubTabs() may restore tabs in the background.
// We re-sync once the DOM is ready so the placeholder matches the actual active view.
document.addEventListener('DOMContentLoaded', () => {
    // Defer 1 tick to let history.js finish early view restore.
    setTimeout(() => syncSearchContextFromCurrentUI('DOMContentLoaded'), 0);
});

// ==================== DOM 操作辅助函数 ====================

/**
 * 获取搜索结果面板元素
 */
function getSearchResultsPanel() {
    return document.getElementById('searchResultsPanel');
}

/**
 * 显示搜索结果面板
 */
function showSearchResultsPanel() {
    const panel = getSearchResultsPanel();
    if (panel) panel.classList.add('visible');
}

/**
 * 隐藏搜索结果面板
 */
function hideSearchResultsPanel() {
    const panel = getSearchResultsPanel();
    if (panel) {
        panel.classList.remove('visible');
        try { panel.dataset.panelType = ''; } catch (_) { }
    }
}

/**
 * 重置顶部主搜索框（跨视图/标签隔离）
 * - 清空输入框
 * - 隐藏并清空结果面板
 * - 清空 searchUiState
 */
function resetMainSearchUI(options = {}) {
    const { clearInput = true } = options;

    // Cancel any pending debounced search from history.js
    // (Shared top search box across views/sub-tabs: avoid stale renders)
    try {
        if (typeof window.cancelPendingMainSearchDebounce === 'function') {
            window.cancelPendingMainSearchDebounce();
        }
    } catch (_) { }

    // Cancel focus-triggered delayed search to avoid cross-view leakage
    try {
        if (typeof focusSearchTimeout !== 'undefined' && focusSearchTimeout) {
            clearTimeout(focusSearchTimeout);
            focusSearchTimeout = null;
        }
    } catch (_) { }

    try {
        if (clearInput) {
            const input = document.getElementById('searchInput');
            if (input) input.value = '';
        }

        const panel = getSearchResultsPanel();
        if (panel) panel.innerHTML = '';

        if (typeof hideSearchResultsPanel === 'function') hideSearchResultsPanel();
        if (typeof toggleSearchModeMenu === 'function') toggleSearchModeMenu(false);

        // Reset UI state
        if (typeof searchUiState === 'object' && searchUiState) {
            searchUiState.view = null;
            searchUiState.query = '';
            searchUiState.results = [];
            searchUiState.selectedIndex = -1;
        }
    } catch (_) { }

    // Close any help/mode menu to avoid cross-view leakage
    try {
        toggleSearchModeMenu(false);
        toggleSearchHelpMenu(false);
    } catch (_) { }
}

try {
    window.resetMainSearchUI = resetMainSearchUI;
} catch (_) { }

/**
 * 更新搜索结果选中项
 */
function updateSearchResultSelection(nextIndex) {
    const panel = getSearchResultsPanel();
    if (!panel) return;
    const items = panel.querySelectorAll('.search-result-item');
    if (!items.length) {
        searchUiState.selectedIndex = -1;
        return;
    }
    const maxIdx = items.length - 1;
    const clamped = Math.max(0, Math.min(maxIdx, nextIndex));

    items.forEach(el => el.classList.remove('selected'));
    const selectedEl = items[clamped];
    if (selectedEl) {
        selectedEl.classList.add('selected');
        // 仅在面板内滚动，不影响页面滚动
        try {
            selectedEl.scrollIntoView({ block: 'nearest' });
        } catch (_) { }
    }
    searchUiState.selectedIndex = clamped;
}

// ==================== 搜索结果渲染 ====================

/**
 * 渲染搜索结果面板
 * @param {Array} results - 搜索结果数组
 * @param {Object} options - 渲染选项
 */
function renderSearchResultsPanel(results, options = {}) {
    const { view = null, query = '' } = options;
    const panel = getSearchResultsPanel();
    if (!panel) return;

    // Isolation guard:
    // Prevent stale (debounced/queued) renders from a different view/query from overwriting the panel.
    try {
        const input = document.getElementById('searchInput');
        const currentQ = (input && typeof input.value === 'string') ? input.value.trim().toLowerCase() : '';
        const expectedQ = String(query || '').trim().toLowerCase();
        if (currentQ !== expectedQ) return;
        if (view && typeof window.currentView === 'string' && window.currentView !== view) return;
    } catch (_) { }

    searchUiState.view = view;
    searchUiState.query = query;
    searchUiState.results = Array.isArray(results) ? results : [];
    searchUiState.selectedIndex = -1;
    try {
        panel.dataset.panelType = 'results';
    } catch (_) { }

    if (!searchUiState.results.length) {
        const emptyText = options.emptyText || i18n.searchNoResults[currentLang];
        panel.innerHTML = `<div class="search-results-empty">${escapeHtml(emptyText)}</div>`;
        showSearchResultsPanel();
        return;
    }

    const rowsHtml = searchUiState.results.map((item, idx) => {
        const safeTitle = escapeHtml(item.title || (currentLang === 'zh_CN' ? '（无标题）' : '(Untitled)'));

        // Meta Logic: Path or URL
        // If meta is provided (e.g. "Added on 2024..."), use it.
        // If not, and it's a bookmark, try to show URL.
        let metaText = item.meta ? escapeHtml(item.meta) : '';
        if (!metaText && item.nodeType === 'bookmark' && item.url) {
            metaText = escapeHtml(item.url);
        }

        // Badges (Moved up to be available for all blocks)
        const parts = Array.isArray(item.changeTypeParts) ? item.changeTypeParts : [];
        const badges = [];
        if (parts.includes('added') || item.changeType === 'added') badges.push(`<span class="search-change-prefix added">+</span>`);
        if (parts.includes('deleted') || item.changeType === 'deleted') badges.push(`<span class="search-change-prefix deleted">-</span>`);
        if (parts.includes('moved')) badges.push(`<span class="search-change-prefix moved">>></span>`);
        if (parts.includes('modified')) badges.push(`<span class="search-change-prefix modified">~</span>`);

        const badgesHtml = badges.length ? badges.join('') : '';
        const changeIconsHtml = badgesHtml ? `<span class="search-change-icons">${badgesHtml}</span>` : '';

        // Favicon / Icon Logic - 使用全局 FaviconCache 统一缓存系统
        // 策略: 优先使用 FaviconCache 获取的真实 favicon，
        // 如果获取不到（返回 fallbackIcon）则使用黄色书签 SVG 图标
        let iconHtml = '';

        // 黄色书签图标（书签搜索模式的默认 fallback）
        const bookmarkFallbackIcon = `<div class="search-result-icon-box-inline" style="display:flex; align-items:center; justify-content:center; width:20px; height:20px; flex-shrink:0;">
            <i class="fas fa-bookmark" style="color:#f59e0b; font-size:14px;"></i>
        </div>`;

        if (item.nodeType === 'bookmark' && item.url) {
            // 使用全局的 getFaviconUrl 函数（如果存在）
            // 这会自动从 FaviconCache（IndexedDB + 内存缓存）获取图标
            if (typeof getFaviconUrl === 'function' && typeof fallbackIcon !== 'undefined') {
                const faviconSrc = getFaviconUrl(item.url);
                // 检查是否获取到真实 favicon（不是 fallbackIcon 灰色星标）
                if (faviconSrc && !faviconSrc.startsWith('data:image/svg+xml')) {
                    // 真实 favicon（已缓存的 Base64 或第三方服务 URL）
                    iconHtml = `<img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" alt="">`;
                } else {
                    // 返回的是 fallbackIcon（灰色星标 SVG），使用黄色书签图标替代
                    // 但仍然添加一个隐藏的 img 以便后台加载完成后可以触发更新
                    iconHtml = bookmarkFallbackIcon + `<img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" alt="" style="display:none;">`;
                }
            } else if (typeof getFaviconUrl === 'function') {
                // getFaviconUrl 可用但 fallbackIcon 未定义，直接使用 favicon
                const faviconSrc = getFaviconUrl(item.url);
                iconHtml = `<img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" alt="">`;
            } else {
                // Fallback: 如果全局函数不可用，使用黄色书签图标
                iconHtml = bookmarkFallbackIcon;
            }
        } else if (item.nodeType === 'folder') {
            // 文件夹使用蓝色文件夹图标
            iconHtml = `<div class="search-result-icon-box-inline" style="display:flex; align-items:center; justify-content:center; width:20px; height:20px; flex-shrink:0;">
                <i class="fas fa-folder" style="color:#2563eb; font-size:14px;"></i>
            </div>`;
        }

        // If specific types, override with FontAwesome icons (but styled as favicons)
        if (item.type === 'calendar-year' || item.type === 'browsing-year') {
            iconHtml = '<div class="search-result-icon-box blue"><i class="fas fa-calendar-alt"></i></div>';
        } else if (item.type === 'calendar-month' || item.type === 'browsing-month') {
            iconHtml = '<div class="search-result-icon-box blue"><i class="fas fa-calendar-day"></i></div>';
        } else if (item.type === 'calendar-day' || item.type === 'browsing-day') {
            // Structure:
            // Line 1: Icon + Title
            // Line 2: URL
            // Line 3: Date + Weekday

            // Icon Logic - 接入 FaviconCache 统一缓存系统
            const isBrowsingDay = item.type === 'browsing-day';
            const fallbackIconClass = isBrowsingDay ? 'fa-history' : 'fa-bookmark';
            const fallbackIconColor = isBrowsingDay ? '#10b981' : '#f59e0b';

            // Fallback 图标 HTML
            const fallbackIconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; margin-right:4px;">
                <i class="fas ${fallbackIconClass}" style="color:${fallbackIconColor}; font-size:16px;"></i>
            </div>`;

            // 尝试加载 favicon（如果有 URL）
            if (item.url && typeof getFaviconUrl === 'function') {
                const faviconSrc = getFaviconUrl(item.url);
                // 检查是否是真实 favicon（不是 SVG fallback 图标）
                if (faviconSrc && !faviconSrc.startsWith('data:image/svg+xml')) {
                    // 真实 favicon（已缓存）
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; margin-right:4px;">
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="width:16px; height:16px; object-fit:contain;" alt="">
                    </div>`;
                } else {
                    // fallback 图标 + 隐藏的 img 用于后台加载后更新
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; margin-right:4px; position:relative;">
                        <i class="fas ${fallbackIconClass} search-result-icon-box-inline" style="color:${fallbackIconColor}; font-size:16px;"></i>
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="display:none; width:16px; height:16px; object-fit:contain; position:absolute;" alt="">
                    </div>`;
                }
            } else {
                // 没有 URL 或 getFaviconUrl 不可用，使用 fallback 图标
                iconHtml = fallbackIconHtml;
            }

            // Construct Date/Weekday HTML
            const dateStr = item.dateDisplay || '';
            const weekStr = item.weekdayDisplay || '';

            return `
                <div class="search-result-item calendar-result-item" role="option" data-index="${idx}" data-type="${item.type || ''}" data-node-id="${escapeHtml(item.id)}">
                    <div class="search-result-content">
                        <div class="search-result-title-row" style="display:flex; align-items:center;">
                            ${iconHtml}
                            ${changeIconsHtml}
                            <span class="search-result-title-text" style="font-weight:600; color:var(--text-normal);">${safeTitle}</span>
                        </div>
                        <div class="search-result-meta-row" style="padding-left:28px;">
                            <span class="search-result-url" style="color:var(--text-tertiary); font-size:11px;">${item.url ? escapeHtml(item.url) : ''}</span>
                        </div>
                        <div class="search-result-extra-row" style="padding-left:28px; margin-top:2px; font-size:11px; color:var(--text-tertiary);">
                            <span class="search-result-date">${escapeHtml(dateStr)}</span>
                            <span class="search-result-weekday" style="margin-left:6px;">${escapeHtml(weekStr)}</span>
                        </div>
                    </div>
                </div>
            `;
        } else if (item.type === 'ranking-item') {
            // 点击排行：优先尝试加载 favicon，fallback 到橙色奖杯图标
            // [接入 FaviconCache 统一缓存系统]
            const fallbackHtml = '<div class="search-result-icon-box orange"><i class="fas fa-trophy"></i></div>';

            if (item.url && typeof getFaviconUrl === 'function') {
                const faviconSrc = getFaviconUrl(item.url);
                if (faviconSrc && !faviconSrc.startsWith('data:image/svg+xml')) {
                    // 真实 favicon（已缓存）
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0;">
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="width:16px; height:16px; object-fit:contain;" alt="">
                    </div>`;
                } else {
                    // fallback 图标 + 隐藏的 img 用于后台加载后更新
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; position:relative;">
                        <i class="fas fa-trophy search-result-icon-box-inline" style="color:#f59e0b; font-size:14px;"></i>
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="display:none; width:16px; height:16px; object-fit:contain; position:absolute;" alt="">
                    </div>`;
                }
            } else {
                iconHtml = fallbackHtml;
            }
        } else if (item.type === 'tracking-item') {
            // 时间捕捉：优先尝试加载 favicon，fallback 到紫色秒表图标
            // [接入 FaviconCache 统一缓存系统]
            const fallbackHtml = '<div class="search-result-icon-box purple"><i class="fas fa-stopwatch"></i></div>';

            if (item.url && typeof getFaviconUrl === 'function') {
                const faviconSrc = getFaviconUrl(item.url);
                if (faviconSrc && !faviconSrc.startsWith('data:image/svg+xml')) {
                    // 真实 favicon（已缓存）
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0;">
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="width:16px; height:16px; object-fit:contain;" alt="">
                    </div>`;
                } else {
                    // fallback 图标 + 隐藏的 img 用于后台加载后更新
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; position:relative;">
                        <i class="fas fa-stopwatch search-result-icon-box-inline" style="color:#a855f7; font-size:14px;"></i>
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="display:none; width:16px; height:16px; object-fit:contain; position:absolute;" alt="">
                    </div>`;
                }
            } else {
                iconHtml = fallbackHtml;
            }
        } else if (item.type === 'calendar-dates-group') {
            // [Added] Date Group Action Icon (green - full dates)
            iconHtml = '<div class="search-result-icon-box green"><i class="fas fa-check-double"></i></div>';
        } else if (item.type === 'calendar-filtered-group' || item.type === 'browsing-filtered-group') {
            // [New] Keyword Filtered Group Icon (orange - filtered results)
            iconHtml = '<div class="search-result-icon-box orange"><i class="fas fa-filter"></i></div>';
        } else if (item.type === 'calendar-date-range-group' || item.type === 'browsing-date-range-group') {
            // [New] Date Range Group Icon (cyan - date range)
            iconHtml = '<div class="search-result-icon-box teal"><i class="fas fa-calendar-week"></i></div>';
        } else if (item.type === 'related-item') {
            // 关联记录：优先尝试加载 favicon，fallback 到青色关联图标
            // [接入 FaviconCache 统一缓存系统]
            const fallbackHtml = '<div class="search-result-icon-box teal"><i class="fas fa-project-diagram"></i></div>';

            if (item.url && typeof getFaviconUrl === 'function') {
                const faviconSrc = getFaviconUrl(item.url);
                if (faviconSrc && !faviconSrc.startsWith('data:image/svg+xml')) {
                    // 真实 favicon（已缓存）
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0;">
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="width:16px; height:16px; object-fit:contain;" alt="">
                    </div>`;
                } else {
                    // fallback 图标 + 隐藏的 img 用于后台加载后更新
                    iconHtml = `<div style="display:flex; align-items:center; justify-content:center; width:24px; height:24px; flex-shrink:0; position:relative;">
                        <i class="fas fa-project-diagram search-result-icon-box-inline" style="color:#14b8a6; font-size:14px;"></i>
                        <img class="search-result-favicon" src="${faviconSrc}" data-bookmark-url="${escapeHtml(item.url)}" style="display:none; width:16px; height:16px; object-fit:contain; position:absolute;" alt="">
                    </div>`;
                }
            } else {
                iconHtml = fallbackHtml;
            }
        }



        // Layout:
        // [Icon/Favicon]  [Title + Badges]
        //                 [Meta/URL]
        return `
            <div class="search-result-item" role="option" data-index="${idx}" data-type="${item.type || ''}" data-node-id="${escapeHtml(item.id)}">
                <div class="search-result-left">
                    ${iconHtml}
                </div>
                <div class="search-result-content">
                    <div class="search-result-title-row">
                        ${changeIconsHtml}
                        <span class="search-result-title-text" style="${item.nodeType === 'group_action' ? 'color:var(--accent-primary); font-weight:700;' : ''}">${safeTitle}</span>
                        ${!iconHtml ? `<span class="search-result-index-tag">${idx + 1}</span>` : ''} 
                    </div>
                    ${metaText ? `<div class="search-result-meta-row">${metaText}</div>` : ''}
                </div>
            </div>
        `;
    }).join('');

    panel.innerHTML = rowsHtml;
    showSearchResultsPanel();
    updateSearchResultSelection(0);
}

// ==================== 搜索结果激活 ====================

// ==================== 事件处理 ====================

/**
 * 激活搜索结果（根据当前视图调用对应的激活函数）
 * @param {number} index - 结果索引
 */
function activateSearchResult(index) {
    const view = searchUiState.view;
    if (view === 'additions') {
        activateAdditionsSearchResult(index);
        return;
    }
    if (view === 'recommend') {
        activateRecommendSearchResult(index);
        return;
    }
    hideSearchResultsPanel();
}



// ==================== Phase 5: 书签推荐搜索 (Recommend) ====================

const RECOMMEND_SEARCH_MAX_RESULTS = 60;
const RECOMMEND_SEARCH_INDEX_TTL = 60 * 1000;

let recommendSearchIndexState = {
    builtAt: 0,
    bookmarkCount: 0,
    scoreCount: 0,
    items: [],
    buildPromise: null
};

let recommendSearchComputeTriggered = false;

function invalidateRecommendSearchIndex() {
    recommendSearchIndexState.builtAt = 0;
    recommendSearchIndexState.bookmarkCount = 0;
    recommendSearchIndexState.scoreCount = 0;
    recommendSearchIndexState.items = [];
}

try {
    window.invalidateRecommendSearchIndex = invalidateRecommendSearchIndex;
} catch (_) { }

function updateRecommendSearchScoreCache(bookmarkId, newS) {
    if (!bookmarkId || !Number.isFinite(newS)) return false;
    const id = String(bookmarkId);
    const scoreText = `S = ${newS.toFixed(3)}`;
    let updated = false;

    try {
        const items = recommendSearchIndexState.items;
        if (Array.isArray(items) && items.length) {
            const target = items.find(item => String(item.id) === id);
            if (target) {
                target.s = newS;
                items.sort((a, b) => {
                    const diff = b.s - a.s;
                    if (Math.abs(diff) > 1e-12) return diff;
                    return String(a.title || '').localeCompare(String(b.title || ''));
                });
                updated = true;
            }
        }
    } catch (_) { }

    try {
        if (searchUiState.view === 'recommend' && Array.isArray(searchUiState.results) && searchUiState.results.length) {
            let hit = false;
            searchUiState.results.forEach((item) => {
                if (!item || item.type !== 'recommend-item') return;
                const itemId = item.bookmarkId || item.id;
                if (String(itemId) !== id) return;
                item.scoreS = newS;
                if (item.meta && String(item.meta).trim()) {
                    item.meta = scoreText;
                }
                hit = true;
            });
            if (hit) {
                const panel = getSearchResultsPanel();
                if (panel) {
                    panel.querySelectorAll('.search-result-item').forEach((row) => {
                        if (row?.dataset?.nodeId !== id) return;
                        const metaRow = row.querySelector('.search-result-meta-row');
                        if (metaRow && metaRow.textContent && metaRow.textContent.trim().startsWith('S')) {
                            metaRow.textContent = scoreText;
                        }
                    });
                }
                updated = true;
            }
        }
    } catch (_) { }

    return updated;
}

try {
    window.updateRecommendSearchScoreCache = updateRecommendSearchScoreCache;
} catch (_) { }

function parseRecommendScoreQuery(query) {
    const raw = String(query || '').trim();
    if (!raw) return null;

    let q = raw.toLowerCase().trim();
    q = q.replace(/^\s*(s|score)\s*[:=]?\s*/, '');
    q = q.replace(/\s+/g, '');

    const clamp01 = (v) => Math.max(0, Math.min(1, v));

    // Range: 0.65-0.75 / 0.65~0.75
    const rangeMatch = q.match(/^(-?\d*\.?\d+)(?:-|~|–|—)(-?\d*\.?\d+)$/);
    if (rangeMatch) {
        let a = parseFloat(rangeMatch[1]);
        let b = parseFloat(rangeMatch[2]);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        a = clamp01(a);
        b = clamp01(b);
        const min = Math.min(a, b);
        const max = Math.max(a, b);
        return { kind: 'range', min, max };
    }

    // Comparator: >=0.8 / <0.3 / =0.7
    const cmpMatch = q.match(/^(>=|<=|>|<|=)(-?\d*\.?\d+)$/);
    if (cmpMatch) {
        const op = cmpMatch[1];
        const valueRaw = parseFloat(cmpMatch[2]);
        if (!Number.isFinite(valueRaw)) return null;
        const value = clamp01(valueRaw);
        if (op === '=') {
            const eps = 0.001;
            return { kind: 'range', min: clamp01(value - eps), max: clamp01(value + eps) };
        }
        return { kind: 'cmp', op, value };
    }

    // Plain number: treat as >=
    const numMatch = q.match(/^(-?\d*\.?\d+)$/);
    if (numMatch) {
        const valueRaw = parseFloat(numMatch[1]);
        if (!Number.isFinite(valueRaw)) return null;
        return { kind: 'cmp', op: '>=', value: clamp01(valueRaw) };
    }

    return null;
}

function findFirstIndexScoreLe(items, threshold) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].s <= threshold) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

function findFirstIndexScoreLt(items, threshold) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid].s < threshold) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    return lo;
}

function filterRecommendItemsByScore(sortedItems, rule, limit = RECOMMEND_SEARCH_MAX_RESULTS) {
    const maxResults = Number.isFinite(limit) ? limit : RECOMMEND_SEARCH_MAX_RESULTS;
    const out = [];
    if (!Array.isArray(sortedItems) || sortedItems.length === 0) return out;

    if (rule.kind === 'cmp') {
        const v = rule.value;
        if (rule.op === '>=' || rule.op === '>') {
            const strict = rule.op === '>';
            for (const item of sortedItems) {
                if (strict ? item.s > v : item.s >= v) {
                    out.push(item);
                    if (out.length >= maxResults) break;
                } else {
                    break;
                }
            }
            return out;
        }

        if (rule.op === '<=' || rule.op === '<') {
            const start = (rule.op === '<') ? findFirstIndexScoreLt(sortedItems, v) : findFirstIndexScoreLe(sortedItems, v);
            for (let i = start; i < sortedItems.length && out.length < maxResults; i++) {
                out.push(sortedItems[i]);
            }
            return out;
        }

        return out;
    }

    if (rule.kind === 'range') {
        const min = rule.min;
        const max = rule.max;

        // Skip those greater than max (descending list)
        let i = 0;
        while (i < sortedItems.length && sortedItems[i].s > max) i++;

        for (; i < sortedItems.length && out.length < maxResults; i++) {
            const s = sortedItems[i].s;
            if (s < min) break;
            if (s <= max) out.push(sortedItems[i]);
        }
        return out;
    }

    return out;
}

async function buildRecommendSearchIndex(options = {}) {
    const force = options && options.force === true;
    const now = Date.now();

    if (!force && recommendSearchIndexState.items && recommendSearchIndexState.items.length &&
        (now - recommendSearchIndexState.builtAt) < RECOMMEND_SEARCH_INDEX_TTL) {
        return recommendSearchIndexState;
    }

    if (recommendSearchIndexState.buildPromise) {
        return recommendSearchIndexState.buildPromise;
    }

    recommendSearchIndexState.buildPromise = (async () => {
        let bookmarks = [];
        try {
            if (typeof getAllBookmarksFlat === 'function') {
                bookmarks = await getAllBookmarksFlat();
            }
        } catch (_) { }

        let scoresCache = {};
        try {
            const result = await new Promise(resolve => {
                if (!browserAPI?.storage?.local?.get) return resolve({});
                browserAPI.storage.local.get(['recommend_scores_cache'], resolve);
            });
            scoresCache = result?.recommend_scores_cache || {};
        } catch (_) {
            scoresCache = {};
        }

        const items = [];
        for (const b of bookmarks) {
            if (!b || !b.id || !b.url) continue;
            const cached = scoresCache[b.id];
            const s = (cached && Number.isFinite(cached.S)) ? cached.S : 0.5;
            items.push({
                id: b.id,
                title: b.title || b.name || '',
                url: b.url,
                s
            });
        }

        items.sort((a, b) => {
            const diff = b.s - a.s;
            if (Math.abs(diff) > 1e-12) return diff;
            return String(a.title || '').localeCompare(String(b.title || ''));
        });

        recommendSearchIndexState.builtAt = Date.now();
        recommendSearchIndexState.bookmarkCount = bookmarks.length;
        recommendSearchIndexState.scoreCount = Object.keys(scoresCache).length;
        recommendSearchIndexState.items = items;

        return recommendSearchIndexState;
    })();

    try {
        return await recommendSearchIndexState.buildPromise;
    } finally {
        recommendSearchIndexState.buildPromise = null;
    }
}

async function searchBookmarkRecommendAndRender(query) {
    const q = String(query || '').trim();
    const view = 'recommend';

    let idx;
    try {
        idx = await buildRecommendSearchIndex();
    } catch (e) {
        renderSearchResultsPanel([], { view, query: q, emptyText: 'Search index build failed' });
        return;
    }

    if (idx && idx.bookmarkCount > 0 && idx.scoreCount === 0) {
        if (!recommendSearchComputeTriggered) {
            recommendSearchComputeTriggered = true;
            try {
                browserAPI.runtime.sendMessage({ action: 'computeBookmarkScores' }, () => { });
            } catch (_) { }
        }

        const msg = currentLang === 'zh_CN'
            ? 'S 值缓存为空，已触发后台计算，请稍后再试'
            : 'S cache is empty. Triggered background computation, please try again later.';
        renderSearchResultsPanel([], { view, query: q, emptyText: msg });
        return;
    }

    const rule = parseRecommendScoreQuery(q);
    let matches = [];

    if (rule) {
        matches = filterRecommendItemsByScore(idx.items || [], rule, RECOMMEND_SEARCH_MAX_RESULTS);
    } else {
        const token = q.toLowerCase();
        const items = idx.items || [];
        for (const item of items) {
            const title = (item.title || '').toLowerCase();
            const url = (item.url || '').toLowerCase();
            if (title.includes(token) || url.includes(token)) {
                matches.push(item);
                if (matches.length >= RECOMMEND_SEARCH_MAX_RESULTS) break;
            }
        }
    }

    const results = matches.map(item => ({
        id: item.id,
        title: item.title || '',
        url: item.url,
        meta: '',
        nodeType: 'bookmark',
        type: 'recommend-item',
        scoreS: item.s,
        bookmarkId: item.id
    }));

    let emptyText = i18n.searchNoResults[currentLang];
    if (!results.length && !rule) {
        emptyText = currentLang === 'zh_CN'
            ? '无匹配结果（提示：可用 0.7 / >=0.8 / 0.65-0.75 搜索 S 值）'
            : 'No results (Tip: use 0.7 / >=0.8 / 0.65-0.75 for S search)';
    }

    renderSearchResultsPanel(results, { view, query: q, emptyText });
}

try {
    window.searchBookmarkRecommendAndRender = searchBookmarkRecommendAndRender;
} catch (_) { }

function refreshRecommendSearchIfNeeded() {
    try {
        if (searchUiState.view !== 'recommend') return;
        const q = String(searchUiState.query || '').trim();
        if (!q) return;
        searchBookmarkRecommendAndRender(q);
    } catch (_) { }
}

try {
    window.refreshRecommendSearchIfNeeded = refreshRecommendSearchIfNeeded;
} catch (_) { }

function activateRecommendSearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    hideSearchResultsPanel();

    try {
        if (typeof window.showRecommendSearchResultCard === 'function') {
            window.showRecommendSearchResultCard(item);
            return;
        }
    } catch (_) { }
}
// ==================== Phase 4: 书签添加记录搜索 (Additions) ====================

/**
 * 执行书签添加记录搜索
 */
function searchBookmarkAdditionsAndRender(query) {
    // [Fixed] 根据上下文分发搜索请求 (Search Isolation)
    const ctx = (window.SearchContextManager && window.SearchContextManager.currentContext) || {};

    // 1. 浏览记录 Tab (Browsing History)
    if (ctx.tab === 'browsing') {
        if (ctx.subTab === 'ranking' && typeof searchBrowsingRankingAndRender === 'function') {
            searchBrowsingRankingAndRender(query);
            return;
        }
        if (ctx.subTab === 'related' && typeof searchBrowsingRelatedAndRender === 'function') {
            searchBrowsingRelatedAndRender(query);
            return;
        }
        if (typeof searchBrowsingHistoryAndRender === 'function') {
            searchBrowsingHistoryAndRender(query);
            return;
        }
    }

    // 1.5. 时间捕捉 Tab (Time Tracking) - Phase 4.7
    if (ctx.tab === 'tracking') {
        if (typeof searchTrackingRankingAndRender === 'function') {
            searchTrackingRankingAndRender(query);
            return;
        }
    }

    // 2. 书签添加记录 (Bookmark Additions) - Default
    if (!window.bookmarkCalendarInstance || !window.bookmarkCalendarInstance.bookmarksByDate) {
        renderSearchResultsPanel([], { view: 'additions', query, emptyText: 'Calendar data not ready' });
        return;
    }

    const cal = window.bookmarkCalendarInstance;
    const dateMap = cal.bookmarksByDate;
    const q = String(query).trim();
    const results = [];

    // 1. Precise Date Match (Unified Date Protocol)
    const dateMeta = parseDateQuery(q);
    if (dateMeta) {
        // [Feature] Multi-Year Match for MMDD / Period-less dates
        if (dateMeta.ignoreYear && dateMeta.type === 'day') {
            const suffix = `-${dateMeta.m}-${dateMeta.d}`;
            const matchedKeys = [];
            for (const k of dateMap.keys()) {
                if (k.endsWith(suffix)) matchedKeys.push(k);
            }
            // Sort newest first
            matchedKeys.sort().reverse();

            if (matchedKeys.length > 0) {
                // Create group if multiple
                if (matchedKeys.length > 1) {
                    results.push({
                        type: 'calendar-dates-group',
                        id: `group:additions:date:${q}`,
                        title: `${dateMeta.m}-${dateMeta.d} (${matchedKeys.length} years matched)`,
                        meta: `Dates: ${matchedKeys.join(', ')}`,
                        dateKeys: matchedKeys,
                        score: 300,
                        nodeType: 'group_action'
                    });
                }

                // Add individual days
                for (const k of matchedKeys) {
                    const bms = dateMap.get(k) || [];
                    results.push({
                        type: 'calendar-day',
                        id: `day:${k}:root`,
                        title: k,
                        meta: `Added ${k} (${bms.length} bookmarks)`,
                        dateKey: k,
                        url: '',
                        dateDisplay: k,
                        weekdayDisplay: '',
                        score: 200
                    });
                }
            }
        }
        // Strict Match (YYYY-MM-DD) or fallback if ignoreYear yielded no results (though ignoreYear means key is incomplete)
        else if (dateMeta.type === 'day') {
            if (dateMap.has(dateMeta.key)) {
                const bms = dateMap.get(dateMeta.key) || [];
                results.push({
                    type: 'calendar-day',
                    id: `day:${dateMeta.key}:root`,
                    title: dateMeta.key,
                    meta: `Added ${dateMeta.key} (${bms.length} bookmarks)`,
                    dateKey: dateMeta.key,
                    url: '',
                    dateDisplay: dateMeta.key,
                    weekdayDisplay: '',
                    score: 200
                });
            }
        } else if (dateMeta.type === 'month') {
            // Support ignoreYear for month too (e.g. "Jan") matches Jan of any year
            let count = 0;
            const matchedMonths = new Set();

            for (const [dk, bms] of dateMap) {
                // dk is YYYY-MM-DD
                if (dateMeta.ignoreYear) {
                    const parts = dk.split('-');
                    if (parts[1] === dateMeta.m) {
                        count += bms.length;
                        matchedMonths.add(parts[0] + '-' + parts[1]); // YYYY-MM
                    }
                } else {
                    if (dk.startsWith(dateMeta.key)) count += bms.length;
                }
            }

            if (count > 0) {
                const title = dateMeta.ignoreYear ? `${dateMeta.m}月 (All Years)` : `${dateMeta.key}`;
                results.push({
                    type: dateMeta.ignoreYear ? 'calendar-dates-group' : 'calendar-month',
                    id: `month:${dateMeta.key}`,
                    title: title,
                    meta: `${count} bookmarks`,
                    year: parseInt(dateMeta.y),
                    month: parseInt(dateMeta.m) - 1,
                    // If ignoreYear, we can't jump to a single month easily unless we group.
                    // For now, let's just show it.
                    score: 180,
                    // For group action:
                    dateKeys: dateMeta.ignoreYear ? Array.from(dateMap.keys()).filter(k => k.split('-')[1] === dateMeta.m) : null
                });
            }
        } else if (dateMeta.type === 'year') {
            let count = 0;
            for (const [dk, bms] of dateMap) {
                if (dk.startsWith(dateMeta.key)) count += bms.length;
            }
            if (count > 0) {
                results.push({
                    type: 'calendar-year',
                    id: `year:${dateMeta.key}`,
                    title: `${dateMeta.key}年`,
                    meta: `${count} bookmarks`,
                    year: parseInt(dateMeta.y),
                    score: 160
                });
            }
        } else if (dateMeta.type === 'range') {
            // [New] Date Range Search (e.g., 0107-0120)
            const matchedKeys = [];
            let totalCount = 0;

            // Helper function to check if a date is within range
            const isDateInRange = (dateKey) => {
                // For ignoreYear: compare only MM-DD part
                if (dateMeta.ignoreYear) {
                    const parts = dateKey.split('-');
                    const mmdd = parts[1] + '-' + parts[2]; // MM-DD
                    const startMmdd = dateMeta.startM + '-' + dateMeta.startD;
                    const endMmdd = dateMeta.endM + '-' + dateMeta.endD;
                    return mmdd >= startMmdd && mmdd <= endMmdd;
                } else {
                    // Full date comparison
                    return dateKey >= dateMeta.startKey && dateKey <= dateMeta.endKey;
                }
            };

            for (const [dk, bms] of dateMap) {
                if (isDateInRange(dk)) {
                    matchedKeys.push(dk);
                    totalCount += bms.length;
                }
            }

            // Sort dates
            matchedKeys.sort();

            if (matchedKeys.length > 0) {
                // Format title
                const rangeTitle = dateMeta.ignoreYear
                    ? `${dateMeta.startM}-${dateMeta.startD} ~ ${dateMeta.endM}-${dateMeta.endD}`
                    : `${dateMeta.startKey} ~ ${dateMeta.endKey}`;

                const groupTitle = currentLang === 'zh_CN'
                    ? `选中日期范围内的 ${matchedKeys.length} 天`
                    : `Select ${matchedKeys.length} days in range`;

                // Add group action
                results.push({
                    type: 'calendar-date-range-group', // Uses selectDateKeys (full bookmarks)
                    id: `range:additions:${q}`,
                    title: groupTitle,
                    meta: `${rangeTitle} (${totalCount} bookmarks)`,
                    dateKeys: matchedKeys,
                    score: 300,
                    nodeType: 'group_action'
                });

                // Add individual days (limited to first 10)
                const displayKeys = matchedKeys.slice(0, 10);
                for (const k of displayKeys) {
                    const bms = dateMap.get(k) || [];
                    results.push({
                        type: 'calendar-day',
                        id: `day:${k}:root`,
                        title: k,
                        meta: `Added ${k} (${bms.length} bookmarks)`,
                        dateKey: k,
                        url: '',
                        dateDisplay: k,
                        weekdayDisplay: '',
                        score: 195
                    });
                }

                // Show "... and X more" if there are more dates
                if (matchedKeys.length > 10) {
                    results.push({
                        type: 'calendar-dates-group',
                        id: `range:additions:more:${q}`,
                        title: currentLang === 'zh_CN'
                            ? `...还有 ${matchedKeys.length - 10} 天`
                            : `...and ${matchedKeys.length - 10} more days`,
                        meta: '',
                        dateKeys: matchedKeys,
                        score: 190,
                        nodeType: 'group_action'
                    });
                }
            }
        }
    }

    // 2. Keyword Search (Content & Loose Date)
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

    // [Fixed] Collect matching bookmarks grouped by date (not just dates)
    const matchingDates = new Set();
    const filteredBookmarksByDate = new Map(); // dateKey -> [matching bookmarks]
    let itemMatchCount = 0;
    const MAX_ITEM_MATCHES = 20;

    for (const [dateKey, bookmarks] of dateMap) {
        for (const bm of bookmarks) {
            // Match against Title, URL
            if (checkMatch(bm.title, tokens) || checkMatch(bm.url, tokens)) {
                matchingDates.add(dateKey);

                // [New] Collect filtered bookmarks for Group Select
                if (!filteredBookmarksByDate.has(dateKey)) {
                    filteredBookmarksByDate.set(dateKey, []);
                }
                filteredBookmarksByDate.get(dateKey).push(bm);

                if (itemMatchCount < MAX_ITEM_MATCHES) {
                    const dateObj = new Date(dateKey);
                    const weekdayIndex = dateObj.getDay();
                    const weekdayStr = typeof tw === 'function' ? tw(weekdayIndex) : '';

                    results.push({
                        type: 'calendar-day',
                        id: `day:${dateKey}:${bm.url}`,
                        title: bm.title || '(Untitled)',
                        meta: `Added on ${dateKey}`,
                        dateKey: dateKey,
                        dateDisplay: dateKey,
                        weekdayDisplay: weekdayStr,
                        url: bm.url,
                        score: 95
                    });
                    itemMatchCount++;
                }
            }
        }
    }

    // 3. Add "Group Select" Action if multiple dates found
    if (matchingDates.size > 0) {
        const dateList = Array.from(matchingDates).sort();
        const groupTitle = currentLang === 'zh_CN'
            ? `选中包含关键词的 ${matchingDates.size} 个日期`
            : `Select ${matchingDates.size} dates with matches`;

        // [Fixed] Use 'calendar-filtered-group' for keyword searches
        // This passes the filtered bookmarks, not just dates
        const filteredData = {};
        for (const [dk, bms] of filteredBookmarksByDate) {
            filteredData[dk] = bms;
        }

        results.unshift({
            type: 'calendar-filtered-group', // [Changed] New type for keyword-filtered results
            id: `group:additions:${q}`,
            title: groupTitle,
            meta: `Filter calendar to show matches ("${q}")`,
            dateKeys: dateList,
            filteredBookmarks: filteredData, // [New] Pass filtered bookmarks
            searchQuery: q, // [New] Pass query for reference
            score: 300,
            nodeType: 'group_action'
        });
    }

    results.sort((a, b) => b.score - a.score || b.title.localeCompare(a.title));
    renderSearchResultsPanel(results, { view: 'additions', query });
}

function checkMatch(text, tokens) {
    if (!tokens.length) return true; // Show all if focus? Or handled by "Show Default"
    const lower = text.toLowerCase();
    return tokens.every(t => lower.includes(t));
}

// Dispatcher for search result activation
function activateAdditionsSearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    // Dispatch to Browsing History if applicable
    if (item.type && item.type.startsWith('browsing-')) {
        activateBrowsingHistorySearchResult(index);
        return;
    }
    // Dispatch to Ranking if applicable
    if (item.type === 'ranking-item') {
        activateRankingSearchResult(index);
        return;
    }
    // Dispatch to Tracking if applicable
    if (item.type === 'tracking-item') {
        activateTrackingSearchResult(index); // Assuming this function exists
        return;
    }
    // Related items
    if (item.type === 'related-item') {
        activateRelatedSearchResult(index);
        return;
    }

    // Default: Bookmark Additions Calendar
    hideSearchResultsPanel();
    if (!window.bookmarkCalendarInstance) return;
    const cal = window.bookmarkCalendarInstance;

    if (item.type === 'calendar-year' || item.type === 'calendar-month') {
        // For year/month, item.id is like "year:YYYY" or "month:YYYY-MM"
        const dateParts = item.id.split(':'); // e.g., ["year", "2024"] or ["month", "2024-11"]
        const ym = dateParts[1];
        const [y, m] = ym.split('-');

        cal.selectYear(parseInt(y));
        if (m) cal.selectMonth(parseInt(m) - 1); // 0-indexed

        // Show exit button
        if (cal.renderExitButton) cal.renderExitButton();
    }
    else if (item.type === 'calendar-day') {
        // item.dateKey is YYYY-MM-DD
        cal.selectDay(item.dateKey);

        // Show exit button
        if (cal.renderExitButton) cal.renderExitButton();
    }
    else if (item.type === 'calendar-dates-group') {
        // [Date Group Select] - Shows ALL bookmarks for selected dates
        if (Array.isArray(item.dateKeys)) {
            cal.selectDateKeys(item.dateKeys);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    }
    else if (item.type === 'calendar-filtered-group') {
        // [Keyword Filtered Group] - Shows ONLY matching bookmarks
        if (item.filteredBookmarks && typeof cal.selectFilteredBookmarks === 'function') {
            cal.selectFilteredBookmarks(item.filteredBookmarks, item.searchQuery);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    }
    else if (item.type === 'calendar-date-range-group') {
        // [Date Range Group] - Shows ALL bookmarks for dates in range (like date search)
        if (Array.isArray(item.dateKeys)) {
            cal.selectDateKeys(item.dateKeys);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    }
}

/**
 * Robust Date Parser
 * Supports: YYYY, YYYY-MM, YYYYMMDD, YYYY.MM.DD, YYYY/MM/DD
 */
// ==================== Robust Date Parser ====================

/**
 * Robust Date Parser
 * Supports: 
 * - Numeric: YYYY, YYYY-MM, YYYYMMDD, YYYY.MM.DD, YYYY/MM/DD
 * - Relative: 今天/Today, 昨天/Yesterday, 前天
 * - Chinese: 2024年1月5日, 1月5日, 2024年1月, 1月
 * - Strict: NO standalone day numbers (e.g. "15", "15日")
 */
function parseDateQuery(query) {
    const q = query.trim().toLowerCase();
    const now = new Date();
    const currentYear = now.getFullYear();

    // --- 1. Relative Keywords ---
    if (['今天', 'today'].includes(q)) {
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const d = String(now.getDate()).padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d };
    }
    if (['昨天', 'yesterday'].includes(q)) {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${day}`, y, m, day };
    }
    if (['前天', 'day before yesterday'].includes(q)) {
        const d = new Date(now);
        d.setDate(d.getDate() - 2);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${day}`, y, m, day };
    }

    // --- 2. Numeric Formats ---

    // YYYYMMDD (8 digits) -> YYYY-MM-DD
    if (/^\d{8}$/.test(q)) {
        const y = q.substring(0, 4);
        const m = q.substring(4, 6);
        const d = q.substring(6, 8);
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d };
    }

    // MMDD (4 digits) -> CurrentYear-MM-DD
    // Conflict with YYYY (Year). Logic:
    // - Years are usually 1990-2100.
    // - MMDD is 0101-1231.
    // - Overlap: 1990-2025 might be year OR time (e.g. 2025 = 8:25pm? No, strict date).
    // - User asked for "0115". 
    // Logic: If starts with '0' or '1' (up to 12), and valid day, treat as MMDD. 
    // Exception: 1998, 2000 are definitely Years. 
    // Heuristic: If it looks like a valid MMDD (MM=01-12, DD=01-31), AND (startswith 0 OR (startswith 1 and year outside typical range?)).
    // Actually, "0115" is unambiguous (Year 115 vs Jan 15). User implies Current Year.
    if (/^\d{4}$/.test(q)) {
        const val = parseInt(q, 10);
        // Valid Year Range for this app: 2010 - 2030+
        const isLikelyYear = (val >= 2000 && val <= 2100);

        // Check MMDD validity
        const mStr = q.substring(0, 2);
        const dStr = q.substring(2, 4);
        const m = parseInt(mStr, 10);
        const d = parseInt(dStr, 10);
        const isValidMMDD = (m >= 1 && m <= 12 && d >= 1 && d <= 31);

        // Decision: 
        // If it starts with '0', it's MMDD (e.g. 0115).
        // If it is 2024, it's Year.
        // If it is 1231, it's Dec 31 (Year 1231 unlikely).
        if (!isLikelyYear && isValidMMDD) {
            const y = String(currentYear);
            return { type: 'day', key: `${y}-${mStr}-${dStr}`, y, m: mStr, d: dStr, ignoreYear: true };
        }
        // Fallback to Year logic later
    }

    // YYYYMM (6 digits) -> YYYY-MM
    if (/^\d{6}$/.test(q)) {
        const y = q.substring(0, 4);
        const m = q.substring(4, 6);
        return { type: 'month', key: `${y}-${m}`, y, m };
    }

    // Separator formats: 2024-11-05, 2024.11.05, 2024/11/05
    const sepMatch = q.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/);
    if (sepMatch) {
        const y = sepMatch[1];
        const m = sepMatch[2].padStart(2, '0');
        const d = sepMatch[3].padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d };
    }

    // MM-DD Separator (Current Year): "01-15", "1/15", "1.15"
    // Distinct from YYYY-MM (starts with 4 digits)
    const mdMatch = q.match(/^(\d{1,2})[-./](\d{1,2})$/);
    if (mdMatch) {
        const y = String(currentYear);
        const m = mdMatch[1].padStart(2, '0');
        const d = mdMatch[2].padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d, ignoreYear: true };
    }

    // YYYY-MM
    const ymMatch = q.match(/^(\d{4})[-./](\d{1,2})$/);
    if (ymMatch) {
        const y = ymMatch[1];
        const m = ymMatch[2].padStart(2, '0');
        return { type: 'month', key: `${y}-${m}`, y, m };
    }

    // YYYY
    if (/^\d{4}$/.test(q)) {
        return { type: 'year', key: q, y: q };
    }

    // --- 3. Chinese Formats (Strict) ---

    // 2024年1月5日
    const cnFull = q.match(/^(\d{4})年(\d{1,2})月(\d{1,2})[日号]?$/);
    if (cnFull) {
        const y = cnFull[1];
        const m = cnFull[2].padStart(2, '0');
        const d = cnFull[3].padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d };
    }

    // 1月5日 (Implies Current Year)
    const cnMonthDay = q.match(/^(\d{1,2})月(\d{1,2})[日号]?$/);
    if (cnMonthDay) {
        const y = String(currentYear);
        const m = cnMonthDay[1].padStart(2, '0');
        const d = cnMonthDay[2].padStart(2, '0');
        return { type: 'day', key: `${y}-${m}-${d}`, y, m, d, ignoreYear: true };
    }

    // 2024年1月
    const cnYearMonth = q.match(/^(\d{4})年(\d{1,2})月?$/);
    if (cnYearMonth) {
        const y = cnYearMonth[1];
        const m = cnYearMonth[2].padStart(2, '0');
        return { type: 'month', key: `${y}-${m}`, y, m };
    }

    // 1月 (Implies Current Year)
    const cnMonthOnly = q.match(/^(\d{1,2})月$/);
    if (cnMonthOnly) {
        const y = String(currentYear);
        const m = cnMonthOnly[1].padStart(2, '0');
        return { type: 'month', key: `${y}-${m}`, y, m, ignoreYear: true };
    }

    // --- 4. Date Range Formats ---
    // Support: MMDD-MMDD (e.g., 0107-0120), MMDD~MMDD, MMDD到MMDD
    // Also: MM-DD~MM-DD, MM/DD-MM/DD

    // MMDD-MMDD (8 digits with separator)
    const rangeMatch1 = q.match(/^(\d{4})[-~到](\d{4})$/);
    if (rangeMatch1) {
        const start = rangeMatch1[1];
        const end = rangeMatch1[2];

        const startM = parseInt(start.substring(0, 2), 10);
        const startD = parseInt(start.substring(2, 4), 10);
        const endM = parseInt(end.substring(0, 2), 10);
        const endD = parseInt(end.substring(2, 4), 10);

        // Validate MMDD
        if (startM >= 1 && startM <= 12 && startD >= 1 && startD <= 31 &&
            endM >= 1 && endM <= 12 && endD >= 1 && endD <= 31) {
            const y = String(currentYear);
            return {
                type: 'range',
                startKey: `${y}-${String(startM).padStart(2, '0')}-${String(startD).padStart(2, '0')}`,
                endKey: `${y}-${String(endM).padStart(2, '0')}-${String(endD).padStart(2, '0')}`,
                startM: String(startM).padStart(2, '0'),
                startD: String(startD).padStart(2, '0'),
                endM: String(endM).padStart(2, '0'),
                endD: String(endD).padStart(2, '0'),
                ignoreYear: true
            };
        }
    }

    // MM-DD~MM-DD or MM/DD-MM/DD (with separators)
    const rangeMatch2 = q.match(/^(\d{1,2})[-./](\d{1,2})[-~到](\d{1,2})[-./](\d{1,2})$/);
    if (rangeMatch2) {
        const startM = parseInt(rangeMatch2[1], 10);
        const startD = parseInt(rangeMatch2[2], 10);
        const endM = parseInt(rangeMatch2[3], 10);
        const endD = parseInt(rangeMatch2[4], 10);

        if (startM >= 1 && startM <= 12 && startD >= 1 && startD <= 31 &&
            endM >= 1 && endM <= 12 && endD >= 1 && endD <= 31) {
            const y = String(currentYear);
            return {
                type: 'range',
                startKey: `${y}-${String(startM).padStart(2, '0')}-${String(startD).padStart(2, '0')}`,
                endKey: `${y}-${String(endM).padStart(2, '0')}-${String(endD).padStart(2, '0')}`,
                startM: String(startM).padStart(2, '0'),
                startD: String(startD).padStart(2, '0'),
                endM: String(endM).padStart(2, '0'),
                endD: String(endD).padStart(2, '0'),
                ignoreYear: true
            };
        }
    }

    // YYYYMMDD-YYYYMMDD (Full date range)
    const rangeMatch3 = q.match(/^(\d{8})[-~到](\d{8})$/);
    if (rangeMatch3) {
        const start = rangeMatch3[1];
        const end = rangeMatch3[2];

        const startY = start.substring(0, 4);
        const startM = start.substring(4, 6);
        const startD = start.substring(6, 8);
        const endY = end.substring(0, 4);
        const endM = end.substring(4, 6);
        const endD = end.substring(6, 8);

        return {
            type: 'range',
            startKey: `${startY}-${startM}-${startD}`,
            endKey: `${endY}-${endM}-${endD}`,
            startY, startM, startD,
            endY, endM, endD,
            ignoreYear: false
        };
    }

    // Explicitly REJECT standalone day numbers (e.g. "15", "15日", "15号")
    // They are too ambiguous and clash with ID searches or other numbers.

    return null;
}

// ==================== Phase 4: 浏览记录搜索 (Browsing History) ====================

/**
 * 执行浏览记录搜索 (Calendar)
 */
function searchBrowsingHistoryAndRender(query) {
    // [Fixed] Lazy Init: Ensure calendar is ready if we are searching (e.g. after refresh)
    if (!window.browsingHistoryCalendarInstance) {
        if (typeof initBrowsingHistoryCalendar === 'function') {
            try {
                initBrowsingHistoryCalendar();
            } catch (e) {
                console.error('[Search] Failed to lazy init browsing calendar:', e);
            }
        }
    }

    if (!window.browsingHistoryCalendarInstance || !window.browsingHistoryCalendarInstance.bookmarksByDate) {
        renderSearchResultsPanel([], { view: 'additions', query, emptyText: 'History Calendar not ready' });
        return;
    }

    const cal = window.browsingHistoryCalendarInstance;
    const dateMap = cal.bookmarksByDate;
    const q = String(query).trim();
    const results = [];

    // 1. Precise Date Match (Unified Date Protocol)
    const dateMeta = parseDateQuery(q);
    if (dateMeta) {
        // [Feature] Multi-Year Match for MMDD / Period-less dates
        if (dateMeta.ignoreYear && dateMeta.type === 'day') {
            const suffix = `-${dateMeta.m}-${dateMeta.d}`;
            const matchedKeys = [];
            for (const k of dateMap.keys()) {
                if (k.endsWith(suffix)) matchedKeys.push(k);
            }
            matchedKeys.sort().reverse();

            if (matchedKeys.length > 0) {
                if (matchedKeys.length > 1) {
                    results.push({
                        type: 'calendar-dates-group',
                        id: `group:browsing:date:${q}`,
                        title: `${dateMeta.m}-${dateMeta.d} (${matchedKeys.length} years matched)`,
                        meta: `Dates: ${matchedKeys.join(', ')}`,
                        dateKeys: matchedKeys,
                        score: 300,
                        nodeType: 'group_action'
                    });
                }
                for (const k of matchedKeys) {
                    const bms = dateMap.get(k) || [];
                    results.push({
                        type: 'browsing-day',
                        id: `br-day:${k}:root`,
                        title: k,
                        meta: `Browse ${k} (${bms.length} items)`,
                        dateKey: k,
                        url: '',
                        dateDisplay: k,
                        weekdayDisplay: '',
                        score: 200
                    });
                }
            }
        }
        else if (dateMeta.type === 'day') {
            if (dateMap.has(dateMeta.key)) {
                const bms = dateMap.get(dateMeta.key) || [];
                results.push({
                    type: 'browsing-day',
                    id: `br-day:${dateMeta.key}:root`,
                    title: dateMeta.key,
                    meta: `Browse ${dateMeta.key} (${bms.length} items)`,
                    dateKey: dateMeta.key,
                    url: '',
                    dateDisplay: dateMeta.key,
                    weekdayDisplay: '',
                    score: 200
                });
            }
        } else if (dateMeta.type === 'month') {
            let count = 0;
            const matchedMonths = new Set();
            for (const [dk, bms] of dateMap) {
                if (dateMeta.ignoreYear) {
                    const parts = dk.split('-');
                    if (parts[1] === dateMeta.m) {
                        count += bms.length;
                        matchedMonths.add(parts[0] + '-' + parts[1]);
                    }
                } else {
                    if (dk.startsWith(dateMeta.key)) count += bms.length;
                }
            }
            if (count > 0) {
                const title = dateMeta.ignoreYear ? `${dateMeta.m}月 (All Years)` : `${dateMeta.key}`;
                results.push({
                    type: dateMeta.ignoreYear ? 'calendar-dates-group' : 'browsing-month',
                    id: `br-month:${dateMeta.key}`,
                    title: title,
                    meta: `${count} visits`,
                    year: parseInt(dateMeta.y),
                    month: parseInt(dateMeta.m) - 1,
                    score: 180,
                    // If supporting group action for month-level browsing across years:
                    // Currently browsing-month expects specific Year/Month. 
                    // So we might prefer a group Action if fuzzy.
                    // But for simplicity, we keep specific types if not group.
                    // If ignoreYear, we cannot jump to single month. So use item.type = 'browsing-month' is buggy if we don't have year.
                    // Using 'calendar-dates-group' is safe if we collect all dateKeys.
                    dateKeys: dateMeta.ignoreYear ? Array.from(dateMap.keys()).filter(k => k.split('-')[1] === dateMeta.m) : null
                });
            }
        } else if (dateMeta.type === 'year') {
            let count = 0;
            for (const [dk, bms] of dateMap) {
                if (dk.startsWith(dateMeta.key)) count += bms.length;
            }
            if (count > 0) {
                results.push({
                    type: 'browsing-year',
                    id: `br-year:${dateMeta.key}`,
                    title: `${dateMeta.key}`,
                    meta: `${count} visits`,
                    year: parseInt(dateMeta.y),
                    score: 160
                });
            }
        } else if (dateMeta.type === 'range') {
            // [New] Date Range Search for Browsing History
            const matchedKeys = [];
            let totalCount = 0;

            const isDateInRange = (dateKey) => {
                if (dateMeta.ignoreYear) {
                    const parts = dateKey.split('-');
                    const mmdd = parts[1] + '-' + parts[2];
                    const startMmdd = dateMeta.startM + '-' + dateMeta.startD;
                    const endMmdd = dateMeta.endM + '-' + dateMeta.endD;
                    return mmdd >= startMmdd && mmdd <= endMmdd;
                } else {
                    return dateKey >= dateMeta.startKey && dateKey <= dateMeta.endKey;
                }
            };

            for (const [dk, bms] of dateMap) {
                if (isDateInRange(dk)) {
                    matchedKeys.push(dk);
                    totalCount += bms.length;
                }
            }

            matchedKeys.sort();

            if (matchedKeys.length > 0) {
                const rangeTitle = dateMeta.ignoreYear
                    ? `${dateMeta.startM}-${dateMeta.startD} ~ ${dateMeta.endM}-${dateMeta.endD}`
                    : `${dateMeta.startKey} ~ ${dateMeta.endKey}`;

                const groupTitle = currentLang === 'zh_CN'
                    ? `选中日期范围内的 ${matchedKeys.length} 天`
                    : `Select ${matchedKeys.length} days in range`;

                results.push({
                    type: 'browsing-date-range-group',
                    id: `range:browsing:${q}`,
                    title: groupTitle,
                    meta: `${rangeTitle} (${totalCount} visits)`,
                    dateKeys: matchedKeys,
                    score: 300,
                    nodeType: 'group_action'
                });

                const displayKeys = matchedKeys.slice(0, 10);
                for (const k of displayKeys) {
                    const bms = dateMap.get(k) || [];
                    results.push({
                        type: 'browsing-day',
                        id: `br-day:${k}:root`,
                        title: k,
                        meta: `Browse ${k} (${bms.length} items)`,
                        dateKey: k,
                        url: '',
                        dateDisplay: k,
                        weekdayDisplay: '',
                        score: 195
                    });
                }

                if (matchedKeys.length > 10) {
                    results.push({
                        type: 'calendar-dates-group',
                        id: `range:browsing:more:${q}`,
                        title: currentLang === 'zh_CN'
                            ? `...还有 ${matchedKeys.length - 10} 天`
                            : `...and ${matchedKeys.length - 10} more days`,
                        meta: '',
                        dateKeys: matchedKeys,
                        score: 190,
                        nodeType: 'group_action'
                    });
                }
            }
        }
    }

    // 2. Keyword Search (Content & Loose Date)
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

    // [Fixed] Collect matching bookmarks grouped by date (not just dates)
    const matchingDates = new Set();
    const filteredBookmarksByDate = new Map(); // dateKey -> [matching bookmarks]
    let itemMatchCount = 0;
    const MAX_ITEM_MATCHES = 20;

    for (const [dateKey, bookmarks] of dateMap) {
        for (const bm of bookmarks) {
            // Match against Title, URL
            if (checkMatch(bm.title, tokens) || checkMatch(bm.url, tokens)) {
                matchingDates.add(dateKey);

                // [New] Collect filtered bookmarks for Group Select
                if (!filteredBookmarksByDate.has(dateKey)) {
                    filteredBookmarksByDate.set(dateKey, []);
                }
                filteredBookmarksByDate.get(dateKey).push(bm);

                if (itemMatchCount < MAX_ITEM_MATCHES) {
                    const dateObj = new Date(dateKey);
                    const weekdayIndex = dateObj.getDay();
                    const weekdayStr = typeof tw === 'function' ? tw(weekdayIndex) : '';

                    results.push({
                        type: 'browsing-day',
                        id: `br-day:${dateKey}:${bm.url}`,
                        title: bm.title || '(Untitled)',
                        meta: `Visited on ${dateKey}`,
                        dateKey: dateKey,
                        dateDisplay: dateKey,
                        weekdayDisplay: weekdayStr,
                        url: bm.url,
                        score: 95
                    });
                    itemMatchCount++;
                }
            }
        }
    }

    // 3. Add "Group Select" Action if multiple dates found
    if (matchingDates.size > 0) {
        const dateList = Array.from(matchingDates).sort();
        const groupTitle = currentLang === 'zh_CN'
            ? `选中包含关键词的 ${matchingDates.size} 个日期`
            : `Select ${matchingDates.size} dates with matches`;

        // [Fixed] Use 'browsing-filtered-group' for keyword searches
        const filteredData = {};
        for (const [dk, bms] of filteredBookmarksByDate) {
            filteredData[dk] = bms;
        }

        results.unshift({
            type: 'browsing-filtered-group', // [Changed] New type for keyword-filtered results
            id: `group:browsing:${q}`,
            title: groupTitle,
            meta: `Filter calendar to show matches ("${q}")`,
            dateKeys: dateList,
            filteredBookmarks: filteredData, // [New] Pass filtered bookmarks
            searchQuery: q, // [New] Pass query for reference
            score: 300,
            nodeType: 'group_action'
        });
    }

    results.sort((a, b) => b.score - a.score || b.title.localeCompare(a.title));
    renderSearchResultsPanel(results, { view: 'additions', query });
}

/**
 * 激活浏览记录搜索结果
 */
function activateBrowsingHistorySearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    hideSearchResultsPanel();
    const cal = window.browsingHistoryCalendarInstance;
    if (!cal) return;

    if (item.type === 'browsing-year') {
        cal.selectYear(item.year);
    } else if (item.type === 'browsing-month') {
        cal.selectMonth(item.year, item.month);
    } else if (item.type === 'browsing-day') {
        cal.selectDay(item.dateKey);
        if (cal.renderExitButton) cal.renderExitButton();
    } else if (item.type === 'calendar-dates-group') {
        // [Date Group Select] - Shows ALL bookmarks for selected dates
        if (Array.isArray(item.dateKeys)) {
            cal.selectDateKeys(item.dateKeys);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    } else if (item.type === 'browsing-filtered-group') {
        // [Keyword Filtered Group] - Shows ONLY matching bookmarks
        if (item.filteredBookmarks && typeof cal.selectFilteredBookmarks === 'function') {
            cal.selectFilteredBookmarks(item.filteredBookmarks, item.searchQuery);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    } else if (item.type === 'browsing-date-range-group') {
        // [Date Range Group] - Shows ALL bookmarks for dates in range
        if (Array.isArray(item.dateKeys)) {
            cal.selectDateKeys(item.dateKeys);
            if (cal.renderExitButton) cal.renderExitButton();
        }
    }
}

// ==================== Phase 4: 点击排行搜索 (Click Ranking) ====================

function getDateBoundsFromMeta(dateMeta) {
    try {
        if (!dateMeta || !dateMeta.type) return null;

        const parseYmdKeyToLocalStart = (key) => {
            const parts = String(key || '').split('-');
            if (parts.length !== 3) return null;
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            const d = parseInt(parts[2], 10);
            if (!y || !m || !d) return null;
            return new Date(y, m - 1, d, 0, 0, 0, 0);
        };

        const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
        const endOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

        if (dateMeta.type === 'day') {
            const d = parseYmdKeyToLocalStart(dateMeta.key);
            if (!d) return null;
            const label = dateMeta.ignoreYear
                ? `${String(dateMeta.m).padStart(2, '0')}-${String(dateMeta.d || dateMeta.day).padStart(2, '0')}`
                : String(dateMeta.key);
            return { startTime: startOfDay(d).getTime(), endTime: endOfDay(d).getTime(), label };
        }

        if (dateMeta.type === 'month') {
            const key = String(dateMeta.key || '');
            const parts = key.split('-');
            if (parts.length !== 2) return null;
            const y = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            if (!y || !m) return null;
            const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
            const end = new Date(y, m, 0, 23, 59, 59, 999);
            const label = dateMeta.ignoreYear ? String(dateMeta.m).padStart(2, '0') : key;
            return { startTime: start.getTime(), endTime: end.getTime(), label };
        }

        if (dateMeta.type === 'year') {
            const y = parseInt(String(dateMeta.y || dateMeta.key), 10);
            if (!y) return null;
            const start = new Date(y, 0, 1, 0, 0, 0, 0);
            const end = new Date(y, 11, 31, 23, 59, 59, 999);
            return { startTime: start.getTime(), endTime: end.getTime(), label: String(y) };
        }

        if (dateMeta.type === 'range') {
            const startD = parseYmdKeyToLocalStart(dateMeta.startKey);
            const endD = parseYmdKeyToLocalStart(dateMeta.endKey);
            if (!startD || !endD) return null;

            const start = startOfDay(startD).getTime();
            const end = endOfDay(endD).getTime();

            const label = dateMeta.ignoreYear
                ? `${dateMeta.startM}-${dateMeta.startD} ~ ${dateMeta.endM}-${dateMeta.endD}`
                : `${dateMeta.startKey} ~ ${dateMeta.endKey}`;

            // Normalize
            if (end < start) {
                return { startTime: end, endTime: start, label };
            }
            return { startTime: start, endTime: end, label };
        }
    } catch (_) { }
    return null;
}

/**
 * 执行点击排行搜索
 */
function searchBrowsingRankingAndRender(query) {
    const q = String(query || '').trim();
    if (!q) return;

    // Phase 4.7: Ranking uses inline filtering (no dropdown panel)
    const dateMeta = parseDateQuery(q);
    if (dateMeta) {
        const bounds = getDateBoundsFromMeta(dateMeta);
        if (bounds && typeof window.applyBrowsingRankingDateRangeFilter === 'function') {
            window.applyBrowsingRankingDateRangeFilter(bounds, { rawQuery: q });
        }
        try { hideSearchResultsPanel(); } catch (_) { }
        return;
    }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (typeof window.applyBrowsingRankingKeywordFilter === 'function') {
        window.applyBrowsingRankingKeywordFilter(q, tokens);
    }
    try { hideSearchResultsPanel(); } catch (_) { }
}

/**
 * 激活点击排行搜索结果
 */
function activateRankingSearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    hideSearchResultsPanel();

    // Find the element
    // Escape CSS selector special chars in URL? 
    // data-url is attribute, can use quotes.
    const selector = `#browsingRankingPanel .ranking-item[data-url="${item.url.replace(/"/g, '\\"')}"]`;
    const el = document.querySelector(selector);

    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('breathe-animation'); // Reuse existing animation
        setTimeout(() => el.classList.remove('breathe-animation'), 2000);
    } else {
        console.warn('Ranking item not found in DOM:', item.url);
    }
}

// ==================== Phase 4: 关联记录搜索 (Related Records) ====================

/**
 * 执行关联记录搜索
 */
function searchBrowsingRelatedAndRender(query) {
    const q = String(query || '').trim();
    if (!q) return;

    // Phase 4.7: Related uses time grouping / in-panel filtering (no bookmark candidate list)
    const dateMeta = parseDateQuery(q);
    if (dateMeta) {
        const bounds = getDateBoundsFromMeta(dateMeta);
        if (bounds && typeof window.applyBrowsingRelatedDateRangeFilter === 'function') {
            window.applyBrowsingRelatedDateRangeFilter(bounds, { rawQuery: q });
        }
        try { hideSearchResultsPanel(); } catch (_) { }
        return;
    }

    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (typeof window.applyBrowsingRelatedKeywordFilter === 'function') {
        window.applyBrowsingRelatedKeywordFilter(q, tokens);
    }
    try { hideSearchResultsPanel(); } catch (_) { }
}

/**
 * 激活关联记录搜索结果
 */
function activateRelatedSearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    hideSearchResultsPanel();

    if (typeof window.jumpToRelatedHistory === 'function') {
        // Just trigger the view filter, pass 0 as timestamp to show all history
        window.jumpToRelatedHistory(item.url, item.title, 0);
    } else {
        console.error('jumpToRelatedHistory API missing');
    }
}

// ==================== Phase 4: 时间追踪搜索 (Time Tracking) ====================

/**
 * 执行时间追踪综合排行搜索（Phase 4.7）
 * 直接在 #trackingRankingList 中高亮匹配项（绿色边框），不使用弹出面板
 */
function searchTrackingRankingAndRender(query) {
    const q = String(query || '').trim();
    const container = document.getElementById('trackingRankingList');

    // 清除之前的高亮
    clearTrackingRankingSearchHighlight();

    if (!q) {
        // 空搜索：清除筛选状态
        if (typeof window.clearTrackingRankingSearchFilter === 'function') {
            window.clearTrackingRankingSearchFilter();
        }
        try { hideSearchResultsPanel(); } catch (_) { }
        return;
    }

    if (!container) {
        console.warn('[Tracking Search] Container not found');
        try { hideSearchResultsPanel(); } catch (_) { }
        return;
    }

    // 应用筛选
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (typeof window.applyTrackingRankingKeywordFilter === 'function') {
        window.applyTrackingRankingKeywordFilter(q, tokens);
    }

    try { hideSearchResultsPanel(); } catch (_) { }
}

/**
 * 清除时间追踪排行搜索高亮
 */
function clearTrackingRankingSearchHighlight() {
    const container = document.getElementById('trackingRankingList');
    if (!container) return;

    container.querySelectorAll('.tracking-ranking-item').forEach(item => {
        item.classList.remove('search-match-highlight');
    });
}

// 保留旧函数的别名，兼容性考虑
function searchTrackingAndRender(query) {
    searchTrackingRankingAndRender(query);
}

/**
 * 激活时间追踪搜索结果
 */
function activateTrackingSearchResult(index) {
    const item = searchUiState.results[index];
    if (!item) return;

    hideSearchResultsPanel();

    // Find the element in #trackingRankingList
    // Note: escape double quotes in URL
    const selector = `#trackingRankingList .tracking-ranking-item[data-url="${item.url.replace(/"/g, '\\"')}"]`;
    const el = document.querySelector(selector);

    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.add('breathe-animation');
        setTimeout(() => el.classList.remove('breathe-animation'), 2000);
    } else {
        console.warn('Tracking item not found in DOM:', item.url);
    }
}




/**
 * 搜索输入框键盘事件处理 (Updated for Phase 3.5: Mode Switching)
 */
function handleSearchKeydown(e) {
    if (currentView !== 'additions' && currentView !== 'recommend') return;

    const panel = getSearchResultsPanel();
    const isVisible = panel && panel.classList.contains('visible');
    const q = (e && e.target && typeof e.target.value === 'string') ? e.target.value.trim() : '';

    if (!isVisible) {
        if (!q && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            if (typeof cycleSearchMode === 'function') {
                e.preventDefault();
                cycleSearchMode(e.key === 'ArrowUp' ? -1 : 1);
                return;
            }
        }

        if (e.key === 'Escape') {
            hideSearchResultsPanel();
            toggleSearchModeMenu(false);
            toggleSearchHelpMenu(false);
            if (isSidePanelModeInSearch()) {
                const input = document.getElementById('searchInput');
                const hasQuery = !!(input && String(input.value || '').trim());
                if (!hasQuery) setSidePanelSearchExpanded(false);
            }
        }
        return;
    }

    // Results Visible
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        updateSearchResultSelection(searchUiState.selectedIndex + 1);
        return;
    }
    if (e.key === 'ArrowUp') {
        e.preventDefault();
        updateSearchResultSelection(searchUiState.selectedIndex - 1);
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        activateSearchResult(searchUiState.selectedIndex);
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        hideSearchResultsPanel();
        toggleSearchModeMenu(false);
        toggleSearchHelpMenu(false);
        if (isSidePanelModeInSearch()) {
            const input = document.getElementById('searchInput');
            const hasQuery = !!(input && String(input.value || '').trim());
            if (!hasQuery) setSidePanelSearchExpanded(false);
        }
    }
}

/**
 * 搜索结果面板点击事件处理
 */
// 搜索结果面板点击事件处理
function handleSearchResultsPanelClick(e) {
    const itemEl = e.target.closest('.search-result-item');
    if (!itemEl) return;

    try {
        const selection = window.getSelection();
        if (selection && selection.toString().length > 0) {
            e.stopPropagation();
            return;
        }

        e.preventDefault();
        e.stopPropagation();
    } catch (_) { }

    const index = parseInt(itemEl.getAttribute('data-index') || '-1', 10);
    activateSearchResult(index);
}

/**
 * 搜索结果面板鼠标悬停事件处理
 */
function handleSearchResultsPanelMouseOver(e) {
    const itemEl = e.target.closest('.search-result-item');
    if (!itemEl) return;
    const index = parseInt(itemEl.getAttribute('data-index') || '-1', 10);
    // [Fix] Only update if index actually changed to avoid flickering or interfering with text selection states
    if (!Number.isNaN(index) && index !== searchUiState.selectedIndex) {
        updateSearchResultSelection(index);
    }
}

/**
 * 点击搜索区域外部时隐藏结果面板
 */
function handleSearchOutsideClick(e) {
    if (currentView !== 'additions' && currentView !== 'recommend') return;

    const searchContainer = document.querySelector('.search-container');
    if (!searchContainer) return;

    if (searchContainer.contains(e.target)) return;
    hideSearchResultsPanel();
    toggleSearchModeMenu(false); // Close mode menu as well
    toggleSearchHelpMenu(false);
    if (isSidePanelModeInSearch()) {
        const input = document.getElementById('searchInput');
        const hasQuery = !!(input && String(input.value || '').trim());
        if (!hasQuery) setSidePanelSearchExpanded(false);
    }
}

/**
 * 搜索输入框获得焦点时重新显示结果面板
 * 只要有文字就触发搜索显示候选列表
 */
let focusSearchTimeout = null;

const EMPTY_QUERY_SUGGESTIONS_PREF_KEY_PREFIX = 'hideEmptyQuerySuggestions';

function getEmptyQuerySuggestionsPrefKey() {
    // Preference should be isolated per page/context.
    // - currentView is the primary dimension
    // - for additions, tab/subTab further refine behavior
    const view = (typeof window.currentView === 'string' && window.currentView) ? window.currentView : 'unknown';
    const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};
    const tab = (view === 'additions' && ctx && ctx.tab) ? String(ctx.tab) : '';
    const subTab = (view === 'additions' && ctx && ctx.subTab) ? String(ctx.subTab) : '';
    return `${EMPTY_QUERY_SUGGESTIONS_PREF_KEY_PREFIX}::${view}::${tab}::${subTab}`;
}

function shouldShowEmptyQuerySuggestions() {
    try {
        return localStorage.getItem(getEmptyQuerySuggestionsPrefKey()) !== 'true';
    } catch (_) {
        return true;
    }
}

function handleSearchInputFocus(e) {
    if (currentView !== 'additions' && currentView !== 'recommend') {
        hideSearchResultsPanel();
        return;
    }

    if (focusSearchTimeout) clearTimeout(focusSearchTimeout);

    // [User Request: Debounce focus search to prevent freeze]
    focusSearchTimeout = setTimeout(() => {
        const inputEl = e.target;
        // Check if input element still exists and is focused (optional, but good for safety)
        if (!inputEl) return;

        if (isSidePanelModeInSearch()) {
            setSidePanelSearchExpanded(true);
        }

        // 二次检查 View，防止 Timeout 期间切换了视图
        if (currentView !== 'additions' && currentView !== 'recommend') {
            hideSearchResultsPanel();
            return;
        }

        const query = (inputEl.value || '').trim();

        // 没有文字处理
        if (!query) {
            try {
                if (shouldShowEmptyQuerySuggestions()) {
                    renderEmptyQuerySuggestions();
                    showSearchResultsPanel();
                } else {
                    hideSearchResultsPanel();
                }
            } catch (_) { }
            return;
        }

        // 有文字就触发搜索显示候选列表（Recommend / Additions）
        if (currentView === 'recommend') {
            try {
                if (typeof searchBookmarkRecommendAndRender === 'function') {
                    searchBookmarkRecommendAndRender(query);
                }
            } catch (_) { }
            return;
        }

        // 有文字就触发搜索显示候选列表（Additions 子标签分发）
        const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};

        if (ctx.tab === 'browsing') {
            if (ctx.subTab === 'history') {
                searchBrowsingHistoryAndRender(query);
            } else if (ctx.subTab === 'ranking') {
                searchBrowsingRankingAndRender(query);
            } else if (ctx.subTab === 'related') {
                searchBrowsingRelatedAndRender(query);
            } else {
                searchBrowsingHistoryAndRender(query);
            }
        } else if (ctx.tab === 'tracking') {
            searchTrackingAndRender(query);
        } else {
            // Default or 'review' tab
            searchBookmarkAdditionsAndRender(query);
        }
    }, 200);
}

function renderEmptyQuerySuggestions() {
    const panel = getSearchResultsPanel();
    if (!panel) return;

    const isZh = currentLang === 'zh_CN';
    const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};

    const prefKey = getEmptyQuerySuggestionsPrefKey();

    // Avoid keeping old selectable results
    try {
        if (typeof searchUiState === 'object' && searchUiState) {
            searchUiState.view = currentView;
            searchUiState.query = '';
            searchUiState.results = [];
            searchUiState.selectedIndex = -1;
        }
    } catch (_) { }

    const items = [];

    if (currentView === 'additions') {
        if (ctx && ctx.tab === 'browsing' && ctx.subTab === 'ranking') {
            items.push(isZh ? '直接筛选列表（不弹候选）' : 'In-panel filter (no candidates)');
            items.push(isZh ? '关键词：空格 AND；支持日期协议' : 'Keywords: space AND; Date Protocol supported');
        } else if (ctx && ctx.tab === 'browsing' && ctx.subTab === 'related') {
            items.push(isZh ? '直接筛选列表（不弹候选）' : 'In-panel filter (no candidates)');
            items.push(isZh ? '关键词：空格 AND；支持日期协议' : 'Keywords: space AND; Date Protocol supported');
        } else if (ctx && ctx.tab === 'tracking') {
            items.push(isZh ? '直接筛选列表（不弹候选）' : 'In-panel filter (no candidates)');
            items.push(isZh ? '清空输入：恢复全部' : 'Clear input: show all');
        } else {
            items.push(isZh ? '关键词：标题/URL（空格 AND）' : 'Keyword: title/URL (space AND)');
            items.push(isZh ? '日期/范围：`20260122` / `0107-0120`' : 'Date/range: `20260122` / `0107-0120`');
        }
    } else {
        items.push(isZh ? '输入关键词开始搜索' : 'Type to search');
    }

    const html = items.map((text) => {
        return `
        <div class="search-result-item suggestion-item" style="pointer-events:none; opacity:0.85; display:flex; align-items:center; padding:6px 10px; border-bottom:1px solid var(--border-color-light);">
            <div class="search-result-content" style="flex:1; min-width:0; text-align:left;">
                <div class="search-result-title" style="font-weight:600; font-size:12px; margin-bottom:0; line-height:1.35;">${escapeHtml(String(text)).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>
            </div>
        </div>`;
    }).join('');

    const dontShowLabel = isZh ? '下次不再出现' : "Don't show again";
    const hintText = isZh ? '点放大镜查看说明' : 'Click the magnifier for help';

    // Pointer icon: an upward arrow that visually points to the left search button.
    const arrowUpSvg = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
            <path d="M12 21V7" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>
            <path d="M7 11l5-5 5 5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;

    panel.innerHTML = `
        <div class="search-suggestions-header" style="position:relative; padding:6px 10px; border-bottom:1px solid var(--border-color); display:flex; align-items:center; justify-content:flex-end; gap:10px;">
            <div class="search-empty-suggestions-hint" style="position:absolute; left:16px; top:50%; transform:translateY(-50%); display:flex; align-items:center; gap:6px; max-width:calc(100% - 140px); font-size:10px; line-height:1.2; color:var(--text-tertiary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; pointer-events:none;">
                <span style="display:inline-flex; position:relative; top:-1px;">${arrowUpSvg}</span><span>${escapeHtml(hintText)}</span>
            </div>
            <button type="button" class="search-empty-suggestions-hide-btn" style="border:1px solid var(--border-color); background:var(--bg-secondary); padding:3px 10px; border-radius:999px; font-size:10px; color:var(--text-secondary); cursor:pointer; white-space:nowrap;">
                ${escapeHtml(dontShowLabel)}
            </button>
        </div>
    ` + html;

    // Bind interactions (rebuilt each render)
    try {
        const btn = panel.querySelector('.search-empty-suggestions-hide-btn');
        if (btn) {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                try { localStorage.setItem(prefKey, 'true'); } catch (_) { }
                try { hideSearchResultsPanel(); } catch (_) { }
            });
        }

        // Help is opened by clicking the magnifier button, per product design.
    } catch (_) { }

    // Align the arrow (inside hint) to the center of the left search button.
    try {
        requestAnimationFrame(() => {
            const trigger = document.getElementById('searchModeTrigger');
            const hint = panel.querySelector('.search-empty-suggestions-hint');
            if (!trigger || !hint) return;

            const triggerRect = trigger.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();

            // arrow svg is 16px wide; nudge left a bit to visually align
            const arrowHalf = 8;
            const arrowNudgeLeft = 2;
            const centerX = triggerRect.left + triggerRect.width / 2;
            const left = centerX - panelRect.left - arrowHalf - arrowNudgeLeft;
            const clamped = Math.max(10, Math.min(panelRect.width - 10, left));
            hint.style.left = `${clamped}px`;
        });
    } catch (_) { }
}


// ==================== 搜索模式（记录 / 推荐） ====================

const SEARCH_MODES = [
    {
        key: 'additions',
        label: '书签记录',
        labelEn: 'Bookmark Records',
        icon: 'fa-plus-circle',
        desc: '标题 / URL / 日期',
        descEn: 'Title / URL / Date'
    },
    {
        key: 'recommend',
        label: '书签推荐',
        labelEn: 'Bookmark Recommend',
        icon: 'fa-lightbulb',
        desc: 'S值 / 标题 / URL',
        descEn: 'S score / Title / URL'
    }
];

const SEARCH_MODE_KEYS = ['additions', 'recommend'];

function getCurrentViewSafe() {
    try {
        if (typeof window !== 'undefined' && typeof window.currentView === 'string' && window.currentView) {
            return window.currentView;
        }
    } catch (_) { }
    try {
        if (typeof currentView === 'string' && currentView) return currentView;
    } catch (_) { }
    try {
        const params = new URLSearchParams(window.location.search);
        const viewParam = params.get('view');
        if (viewParam) return viewParam;
    } catch (_) { }
    return '';
}

function getActiveSearchMode() {
    return SEARCH_MODES.find(m => m.key === searchUiState.activeMode) || SEARCH_MODES[0];
}

function setSearchMode(modeKey, options = {}) {
    const mode = SEARCH_MODES.find(m => m.key === modeKey);
    if (!mode) return;

    searchUiState.activeMode = modeKey;
    renderSearchModeUI();

    // Sync placeholder to the active mode as a fallback
    try {
        const input = document.getElementById('searchInput');
        if (input) {
            const isZh = currentLang === 'zh_CN';
            input.placeholder = isZh ? mode.desc : mode.descEn;
        }
    } catch (_) { }

    // Optionally switch view to match mode
    const allowSwitchView = options && (options.userAction === true || options.forceSwitchView === true) && options.switchView !== false;
    if (!allowSwitchView) return;
    try {
        const view = getCurrentViewSafe();
        if (typeof switchView === 'function' && view && view !== modeKey) {
            switchView(modeKey);
        }
    } catch (_) { }
}

function cycleSearchMode(direction) {
    if (!SEARCH_MODE_KEYS.length) return;
    const currentIndex = SEARCH_MODE_KEYS.indexOf(searchUiState.activeMode);
    const idx = currentIndex >= 0 ? currentIndex : 0;
    let nextIndex = idx + direction;
    if (nextIndex >= SEARCH_MODE_KEYS.length) nextIndex = 0;
    if (nextIndex < 0) nextIndex = SEARCH_MODE_KEYS.length - 1;
    setSearchMode(SEARCH_MODE_KEYS[nextIndex], { userAction: true });

    if (searchUiState.isMenuOpen) {
        renderSearchModeMenu();
    }
}

function toggleSearchModeMenu(show) {
    const menu = document.getElementById('searchModeMenu');
    if (!menu) return;

    const shouldShow = (typeof show === 'boolean') ? show : menu.hasAttribute('hidden');
    if (shouldShow) {
        menu.removeAttribute('hidden');
        menu.dataset.menuType = 'mode';
        renderSearchModeMenu();
    } else {
        menu.setAttribute('hidden', '');
        menu.dataset.menuType = '';
    }
    searchUiState.isMenuOpen = shouldShow;
}

function toggleSearchHelpMenu(show) {
    const menu = document.getElementById('searchModeMenu');
    if (!menu) return;

    const shouldShow = (typeof show === 'boolean') ? show : menu.hasAttribute('hidden');
    if (shouldShow) {
        menu.removeAttribute('hidden');
        menu.dataset.menuType = 'help';
        renderSearchHelpMenu();
    } else {
        menu.setAttribute('hidden', '');
        menu.dataset.menuType = '';
    }
    searchUiState.isHelpOpen = shouldShow;
}

function renderSearchModeUI() {
    const trigger = document.getElementById('searchModeTrigger');
    if (!trigger) return;
    const mode = getActiveSearchMode();
    const isZh = currentLang === 'zh_CN';
    const label = isZh ? mode.label : mode.labelEn;
    const modeColorClass = mode && mode.key === 'recommend' ? 'mode-color-orange' : 'mode-color-blue';

    trigger.innerHTML = `<i class="fas ${mode.icon} ${modeColorClass}"></i><span class="search-mode-label ${modeColorClass}">${label}</span>`;
    trigger.title = isZh ? `搜索模式：${label}` : `Mode: ${label}`;
}

function renderSearchModeMenu() {
    const menu = document.getElementById('searchModeMenu');
    if (!menu) return;
    if (menu.dataset.menuType && menu.dataset.menuType !== 'mode') return;

    const hintText = currentLang === 'zh_CN'
        ? '↑/↓ 切换，Enter 选择，Esc 关闭'
        : '↑/↓ switch, Enter select, Esc close';

    let html = `<div class="search-mode-hint" style="text-align:left;">${hintText}</div>`;

    html += SEARCH_MODES.map(mode => {
        const isActive = mode.key === searchUiState.activeMode;
        const isZh = currentLang === 'zh_CN';
        const desc = isZh ? mode.desc : mode.descEn;

        return `
            <div class="search-mode-menu-item ${isActive ? 'active' : ''}" data-mode-key="${mode.key}">
                <div class="mode-icon"><i class="fas ${mode.icon}"></i></div>
                <div class="mode-info">
                    <div class="mode-name">${isZh ? mode.label : mode.labelEn}</div>
                    <div class="mode-desc">${desc}</div>
                </div>
            </div>
        `;
    }).join('');

    menu.innerHTML = html;
}

function renderSearchHelpMenu() {
    const menu = document.getElementById('searchModeMenu');
    if (!menu) return;

    const isZh = currentLang === 'zh_CN';
    const view = getCurrentViewSafe();
    const tips = []

    if (view === 'additions') {
        tips.push(isZh ? '关键词：标题/URL（空格 AND）' : 'Keyword: title/URL (space AND)');
        tips.push(isZh ? '日期/范围：`20260122` / `0107-0120`' : 'Date/range: `20260122` / `0107-0120`');
    } else {
        tips.push(isZh ? '输入关键词开始搜索' : 'Type to search');
    }

    const items = tips.map(t => `<div style="margin:6px 0; font-size:12px; color:var(--text-secondary); line-height:1.5;">${String(t).replace(/`([^`]+)`/g, '<code>$1</code>')}</div>`).join('');

    menu.innerHTML = `
        <div class="search-help-body" style="padding:10px 12px;">
            ${items || `<div style="color:var(--text-tertiary); font-size:12px;">(No help content)</div>`}
        </div>
    `;
}

function initSearchModeUI() {
    const view = getCurrentViewSafe();
    const initialMode = SEARCH_MODE_KEYS.includes(view) ? view : (searchUiState.activeMode || SEARCH_MODE_KEYS[0]);
    setSearchMode(initialMode, { switchView: false });

    const trigger = document.getElementById('searchModeTrigger');
    if (trigger && !trigger.hasAttribute('data-mode-ui-bound')) {
        trigger.setAttribute('data-mode-ui-bound', 'true');

        // Click: open help menu (per hint text)
        trigger.addEventListener('click', (e) => {
            const view = getCurrentViewSafe();
            if (view !== 'additions' && view !== 'recommend') return;

            e.stopPropagation();

            if (isSidePanelModeInSearch()) {
                const input = document.getElementById('searchInput');
                if (!isSidePanelSearchExpanded()) {
                    setSidePanelSearchExpanded(true);
                    try {
                        if (input) requestAnimationFrame(() => input.focus());
                    } catch (_) { }
                    return;
                }

                toggleSearchHelpMenu(false);
                toggleSearchModeMenu();
                try {
                    if (input) requestAnimationFrame(() => input.focus());
                } catch (_) { }
                return;
            }

            toggleSearchModeMenu(false);
            toggleSearchHelpMenu();

            try {
                const input = document.getElementById('searchInput');
                if (input) requestAnimationFrame(() => input.focus());
            } catch (_) { }
        });

        // Keyboard: allow mode cycling
        trigger.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                toggleSearchModeMenu(true);
                cycleSearchMode(-1);
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                toggleSearchModeMenu(true);
                cycleSearchMode(1);
            } else if (e.key === 'Escape') {
                toggleSearchModeMenu(false);
                toggleSearchHelpMenu(false);
            }
        });
    }

    const menu = document.getElementById('searchModeMenu');
    if (menu && !menu.hasAttribute('data-mode-menu-bound')) {
        menu.setAttribute('data-mode-menu-bound', 'true');
        menu.addEventListener('click', (e) => {
            if (menu.dataset.menuType && menu.dataset.menuType !== 'mode') return;
            const item = e.target.closest('.search-mode-menu-item');
            if (!item) return;
            const key = item.getAttribute('data-mode-key');
            if (!key) return;
            setSearchMode(key, { userAction: true });
            toggleSearchModeMenu(false);
        });
    }
}

// ==================== 初始化 ====================

/**
 * 初始化搜索模块事件监听
 * 应在 DOM 加载完成后调用
 */
function initSearchEvents() {
    const searchInput = document.getElementById('searchInput');
    const searchResultsPanel = getSearchResultsPanel();

    // Avoid double-binding: history.js may also bind these listeners.
    // IMPORTANT: history.js binds `input` later (after async settings load). If we set
    // `data-search-bound` too early without binding `input`, search won't trigger.
    if (searchInput && !searchInput.hasAttribute('data-search-bound')) {
        // If user starts typing while a menu is open (help/mode), auto-close it
        // so the results panel can show immediately.
        searchInput.addEventListener('input', () => {
            try {
                const q = (searchInput.value || '').trim();
                if (!q) return;
                toggleSearchModeMenu(false);
                toggleSearchHelpMenu(false);
            } catch (_) { }
        });

        // Bind input -> trigger search
        if (typeof handleSearch === 'function') {
            searchInput.addEventListener('input', handleSearch);
        } else if (typeof performSearch === 'function') {
            // Fallback: call search immediately (no debounce)
            searchInput.addEventListener('input', (e) => {
                try {
                    const q = (e && e.target && typeof e.target.value === 'string')
                        ? e.target.value.trim().toLowerCase()
                        : '';
                    performSearch(q);
                } catch (_) { }
            });
        }

        // Keyboard navigation
        searchInput.addEventListener('keydown', handleSearchKeydown);
        // Suggestions / auto search on focus
        searchInput.addEventListener('focus', handleSearchInputFocus);

        // Phase 4.7: Exit filter mode when input is empty and loses focus
        searchInput.addEventListener('blur', () => {
            try {
                if (isSidePanelModeInSearch()) {
                    setTimeout(() => {
                        try {
                            const container = document.querySelector('.search-container');
                            const activeEl = document.activeElement;
                            if (container && activeEl && container.contains(activeEl)) return;

                            const hasQuery = !!(searchInput && String(searchInput.value || '').trim());
                            if (hasQuery) return;

                            hideSearchResultsPanel();
                            toggleSearchModeMenu(false);
                            toggleSearchHelpMenu(false);
                            setSidePanelSearchExpanded(false);
                        } catch (_) { }
                    }, 120);
                }

                // Use a small delay to allow click events on exit button to fire first
                setTimeout(() => {
                    const q = (searchInput.value || '').trim();
                    if (q) return; // Input not empty, do nothing

                    const ctx = window.SearchContextManager ? window.SearchContextManager.currentContext : {};
                    if (!ctx || ctx.view !== 'additions') return;

                    // Check if in ranking or related sub-tab with active filter
                    if (ctx.tab === 'browsing') {
                        if (ctx.subTab === 'ranking') {
                            if (typeof window.isBrowsingRankingSearchActive === 'function' && window.isBrowsingRankingSearchActive()) {
                                if (typeof window.exitSearchFilter === 'function') {
                                    window.exitSearchFilter();
                                }
                            }
                        } else if (ctx.subTab === 'related') {
                            if (typeof window.isBrowsingRelatedSearchActive === 'function' && window.isBrowsingRelatedSearchActive()) {
                                if (typeof window.exitSearchFilter === 'function') {
                                    window.exitSearchFilter();
                                }
                            }
                        }
                    } else if (ctx.tab === 'tracking') {
                        // Phase 4.7: 时间捕捉搜索筛选
                        if (typeof window.isTrackingRankingSearchActive === 'function' && window.isTrackingRankingSearchActive()) {
                            if (typeof window.exitSearchFilter === 'function') {
                                window.exitSearchFilter();
                            }
                        }
                    }
                }, 150);
            } catch (_) { }
        });

        searchInput.setAttribute('data-search-bound', 'true');
    }

    if (searchResultsPanel && !searchResultsPanel.hasAttribute('data-search-bound')) {
        searchResultsPanel.addEventListener('click', handleSearchResultsPanelClick);
        searchResultsPanel.addEventListener('mouseover', handleSearchResultsPanelMouseOver);
        searchResultsPanel.setAttribute('data-search-bound', 'true');
    }

    // Outside click: use the same capture+guard strategy as history.js
    if (!document.documentElement.hasAttribute('data-search-outside-bound')) {
        document.addEventListener('click', handleSearchOutsideClick, true);
        document.documentElement.setAttribute('data-search-outside-bound', 'true');
    }

    // Phase 3.5: Init Mode UI
    initSearchModeUI();
}

// =============================================================================
// =============================================================================

/**
 */
// ==================== 导出（供 history.js 调用） ====================
// 注意：由于 history.js 不使用 ES6 模块，这些函数作为全局函数暴露
// 主要供 history.js 中的 performSearch 调用

// 将函数暴露到全局作用域，以便 history.js 可以直接调用
if (typeof window !== 'undefined') {
    // ==================== 通用事件处理函数 ====================
    window.handleSearchKeydown = handleSearchKeydown;
    window.handleSearchInputFocus = handleSearchInputFocus;
    window.handleSearchResultsPanelClick = handleSearchResultsPanelClick;
    window.handleSearchResultsPanelMouseOver = handleSearchResultsPanelMouseOver;
    window.handleSearchOutsideClick = handleSearchOutsideClick;

    // Phase 3.5 Export
    window.setSearchMode = setSearchMode;
    window.cycleSearchMode = cycleSearchMode;
    window.toggleSearchModeMenu = toggleSearchModeMenu;

    // 初始化
    window.initSearchEvents = initSearchEvents;

    // 模块对象（可选的命名空间访问方式）
    window.searchModule = {
        // 初始化
        init: initSearchEvents,
        hidePanel: hideSearchResultsPanel
    };
}

document.addEventListener('DOMContentLoaded', () => {
    if (typeof window.initSearchEvents === 'function') {
        window.initSearchEvents();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Re-bind mode menu events in case they were lost
    if (typeof window.initSearchModeUI === 'function') {
        // This function is internal but initSearchEvents calls it.
        // If we need to re-run it for safety:
        // window.initSearchEvents(); 
        // But let's check if the delegation is working.
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Re-bind click listener for manual selection to auto-close menu
    const menu = document.getElementById('searchModeMenu');
    if (menu) {
        // Cloning and replacing to remove old listeners might be cleaner, 
        // but 'search.js' architecture suggests straightforward updates.
        // We trust the latest initSearchModeUI() call from initSearchEvents().
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Re-bind mode trigger logic to respect visibility rules
    if (typeof window.renderSearchModeUI === 'function') {
        window.renderSearchModeUI();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Force refresh mode UI to match current view (do not switch view)
    if (typeof window.setSearchMode === 'function') {
        const view = getCurrentViewSafe();
        const mode = SEARCH_MODE_KEYS.includes(view)
            ? view
            : (window.searchUiState && window.searchUiState.activeMode ? window.searchUiState.activeMode : SEARCH_MODE_KEYS[0]);
        window.setSearchMode(mode, { switchView: false });
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // Re-bind mode trigger logic to respect visibility rules
    if (typeof window.renderSearchModeUI === 'function') {
        window.renderSearchModeUI();
    }
});

document.addEventListener('DOMContentLoaded', () => {
    // 1. Force placeholder update (do not switch view)
    if (window.setSearchMode) {
        const view = getCurrentViewSafe();
        const mode = SEARCH_MODE_KEYS.includes(view)
            ? view
            : (window.searchUiState && window.searchUiState.activeMode ? window.searchUiState.activeMode : SEARCH_MODE_KEYS[0]);
        window.setSearchMode(mode, { switchView: false });
    }

    // 2. Add extra safeguard for button focus cycling IF it wasn't added by previous steps correctly
    // (Though step 214 should have handled it in initSearchModeUI)
    const trigger = document.getElementById('searchModeTrigger');
    if (trigger && !trigger.hasAttribute('data-mode-ui-bound') && !trigger.hasAttribute('data-cycle-bound')) {
        trigger.setAttribute('data-cycle-bound', 'true');
        trigger.addEventListener('keydown', (e) => {
            const view = (typeof window.currentView === 'string' && window.currentView)
                ? window.currentView
                : (typeof currentView === 'string' ? currentView : '');
            if (view !== 'additions') return;
            if (e.key === 'ArrowUp') { e.preventDefault(); if (window.cycleSearchMode) window.cycleSearchMode(-1); }
            if (e.key === 'ArrowDown') { e.preventDefault(); if (window.cycleSearchMode) window.cycleSearchMode(1); }
        });
    }
});

// [User Request] Function to update search UI language (placeholder & menu)
function updateSearchUILanguage() {
    // Sync Placeholder
    if (typeof setSearchMode === 'function' && typeof searchUiState !== 'undefined') {
        setSearchMode(searchUiState.activeMode, { switchView: false });
    }

    // Sync Menu if open
    if (typeof renderSearchModeMenu === 'function') {
        const menu = document.getElementById('searchModeMenu');
        if (menu && !menu.hidden) {
            renderSearchModeMenu();
        }
    }
}
window.updateSearchUILanguage = updateSearchUILanguage;
