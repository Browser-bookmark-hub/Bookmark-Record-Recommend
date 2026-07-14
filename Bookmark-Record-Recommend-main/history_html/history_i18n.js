// =================================================================================
// II. LOCALIZATION & TRANSLATIONS (国际化文本定义)
// =================================================================================


// =============================================================================
// 国际化文本
// =============================================================================

const i18n = {pageTitle: {
        'zh_CN': '推荐 & 记录',
        'en': 'Recommend & Record'
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
        'zh_CN': '问题反馈与快捷键',
        'en': 'Feedback & Shortcuts'
    },settingsQuickReviewText: {
        'zh_CN': '快捷复习设置',
        'en': 'Quick Review Settings'
    },quickReviewShortcutLabel: {
        'zh_CN': '当前快捷键',
        'en': 'Current Shortcut'
    },openShortcutsSettingsText: {
        'zh_CN': '读取中...',
        'en': 'Loading...'
    },quickReviewShortcutUnset: {
        'zh_CN': '未设置',
        'en': 'Not Set'
    },quickReviewShortcutRefreshHint: {
        'zh_CN': '如修改了浏览器快捷键，请关闭并重新打开本设置弹窗以刷新显示。',
        'en': 'After changing browser shortcuts, close and reopen this settings dialog to refresh.'
    },quickReviewOpenModeLabel: {
        'zh_CN': '打开模式',
        'en': 'Open Mode'
    },quickReviewModeSingleText: {
        'zh_CN': '固定单页',
        'en': 'Fixed Tab'
    },quickReviewModeNewTabText: {
        'zh_CN': '新标签',
        'en': 'New Tab'
    },quickReviewTooltip: {
        'zh_CN': '快捷复习',
        'en': 'Quick Review'
    },headerToggleCollapseTooltip: {
        'zh_CN': '收起标题栏',
        'en': 'Collapse header'
    },headerToggleExpandTooltip: {
        'zh_CN': '展开标题栏',
        'en': 'Expand header'
    },navAdditions: {
        'zh_CN': '书签记录',
        'en': 'Bookmark Record'
    },navRecommend: {
        'zh_CN': '书签推荐',
        'en': 'Bookmark Recommend'
    },navRecommendShort: {
        'zh_CN': '书签推荐',
        'en': 'Bookmark Rec.'
    },navWidgets: {
        'zh_CN': '小组件',
        'en': 'Widgets'
    },navSync: {
        'zh_CN': '推送与分析',
        'en': 'Push & Analysis'
    },sidePanelTitleWidgets: {
        'zh_CN': '小组件',
        'en': 'Widgets'
    },sidePanelTitleRecommend: {
        'zh_CN': '推荐',
        'en': 'Recommend'
    },sidePanelTitleRecommendShort: {
        'zh_CN': '推荐',
        'en': 'Rec.'
    },sidePanelTitleAdditions: {
        'zh_CN': '记录',
        'en': 'Record'
    },sidePanelTitleSync: {
        'zh_CN': '同步',
        'en': 'Sync'
    },syncViewTitle: {
        'zh_CN': '推送与分析',
        'en': 'Push & Analysis'
    },syncViewDescription: {
        'zh_CN': '手动推送推荐/记录数据，并同步可查看的 Markdown。',
        'en': 'Manually push recommendation/record data and sync visible Markdown files.'
    },syncControlPanelCollapseBtnText: {
        'zh_CN': '折叠',
        'en': 'Collapse'
    },syncControlPanelExpandBtnText: {
        'zh_CN': '展开',
        'en': 'Expand'
    },syncRepoSettingsTitle: {
        'zh_CN': '配置方式',
        'en': 'Configuration'
    },syncProviderLabel: {
        'zh_CN': '同步方式',
        'en': 'Sync Provider'
    },syncProviderGithubOption: {
        'zh_CN': 'GitHub',
        'en': 'GitHub'
    },syncProviderLocalOption: {
        'zh_CN': '本地',
        'en': 'Local'
    },syncGithubTokenLabel: {
        'zh_CN': 'GitHub Token',
        'en': 'GitHub Token'
    },syncGithubOwnerLabel: {
        'zh_CN': '仓库 Owner',
        'en': 'Repository Owner'
    },syncGithubRepoLabel: {
        'zh_CN': '仓库名',
        'en': 'Repository Name'
    },syncGithubBranchLabel: {
        'zh_CN': '分支',
        'en': 'Branch'
    },syncRepoTestBtnText: {
        'zh_CN': '测试连接',
        'en': 'Test Connection'
    },syncRepoOpenHtmlBtnText: {
        'zh_CN': '配置说明',
        'en': 'Guide'
    },syncRepoStatusIdle: {
        'zh_CN': '等待配置',
        'en': 'Waiting for configuration'
    },syncSettingsTitle: {
        'zh_CN': '推送数据包',
        'en': 'Push Bundles'
    },syncPushPackageInfoBtnText: {
        'zh_CN': '说明',
        'en': 'Info'
    },syncPushPackagePathTitle: {
        'zh_CN': '推送到云端路径结构',
        'en': 'Cloud Path Layout'
    },syncPushPackageBookmarkRecommendText: {
        'zh_CN': '书签推荐包（S 池/候选/复习/屏蔽/跳过/翻卡）',
        'en': 'Bookmark recommendation bundle (S-score/candidates/review/block/skip/flip)'
    },syncPushPackageBookmarkRecordText: {
        'zh_CN': '书签记录包（新增/点击/排行/关联/时间排行）',
        'en': 'Bookmark record bundle (additions/clicks/ranking/related/time ranking)'
    },syncPushPackageRawNativeText: {
        'zh_CN': '原生真相源包（书签树/浏览访问事实源）',
        'en': 'Raw-native source bundle (bookmark tree/browsing visit facts)'
    },syncPushPackageRecommendText: {
        'zh_CN': '书签推荐包（S 池/候选/复习/屏蔽/跳过/翻卡）',
        'en': 'Bookmark recommendation bundle (S-score/candidates/review/block/skip/flip)'
    },syncPushPackageRecordsText: {
        'zh_CN': '书签记录包（新增/点击/排行/关联/时间排行）',
        'en': 'Bookmark record bundle (additions/clicks/ranking/related/time ranking)'
    },syncPushPackageWidgetsText: {
        'zh_CN': '推荐行为事件（复习/翻卡/跳过/屏蔽）',
        'en': 'Recommendation events (review/flip/skip/block)'
    },syncPushPackageTrackingText: {
        'zh_CN': '时间捕捉（按天/周/月统计）',
        'en': 'Time tracking (daily/weekly/monthly stats)'
    },syncPushTimeRangeLabel: {
        'zh_CN': '推送范围',
        'en': 'Push Range'
    },syncPushTimeRangeDay: {
        'zh_CN': '今天',
        'en': 'Today'
    },syncPushTimeRangeWeek: {
        'zh_CN': '本周',
        'en': 'This Week'
    },syncPushTimeRangeMonth: {
        'zh_CN': '本月',
        'en': 'This Month'
    },syncPushTimeRangeQuarter: {
        'zh_CN': '本季',
        'en': 'This Quarter'
    },syncPushTimeRangeYear: {
        'zh_CN': '本年',
        'en': 'This Year'
    },syncPushTimeRangeAll: {
        'zh_CN': '全部',
        'en': 'All'
    },syncPushTimeRangeCustom: {
        'zh_CN': '自定义',
        'en': 'Custom'
    },syncPushCustomRangeStartLabel: {
        'zh_CN': '开始日期',
        'en': 'Start Date'
    },syncPushCustomRangeEndLabel: {
        'zh_CN': '结束日期',
        'en': 'End Date'
    },syncPushCustomRangeConfirmBtn: {
        'zh_CN': '确认',
        'en': 'Confirm'
    },syncPushCustomRangeCancelBtn: {
        'zh_CN': '取消',
        'en': 'Cancel'
    },syncPushCustomRangeInvalid: {
        'zh_CN': '请选择有效的开始和结束日期',
        'en': 'Please select a valid start and end date'
    },syncPullPolicyInfoBtnLabel: {
        'zh_CN': '说明',
        'en': 'Info'
    },syncPullPolicyInfoText: {
        'zh_CN': '拉取策略：最新修改版本取胜，不做复杂 MERGE 合并。比对依据为本地文档修改时间与云端文档最新提交时间。',
        'en': 'Pull policy: latest modified version wins, without complex MERGE. Comparison uses local edit time and latest cloud commit time.'
    },syncFilesPrevText: {
        'zh_CN': '上一页',
        'en': 'Previous page'
    },syncFilesNextText: {
        'zh_CN': '下一页',
        'en': 'Next page'
    },syncPullBtnText: {
        'zh_CN': '拉取更新',
        'en': 'Pull'
    },syncPullBtnLoadingText: {
        'zh_CN': '拉取中...',
        'en': 'Pulling...'
    },syncPullBtnSuccessText: {
        'zh_CN': '拉取完成',
        'en': 'Pulled'
    },syncPullBtnErrorText: {
        'zh_CN': '拉取失败',
        'en': 'Pull Failed'
    },syncPushBtnText: {
        'zh_CN': '推送当前',
        'en': 'Push'
    },syncPushBtnLoadingText: {
        'zh_CN': '推送中...',
        'en': 'Pushing...'
    },syncPushBtnSuccessText: {
        'zh_CN': '推送完成',
        'en': 'Pushed'
    },syncPushBtnErrorText: {
        'zh_CN': '推送失败',
        'en': 'Push Failed'
    },syncRepoCollapseBtnCollapseText: {
        'zh_CN': '折叠配置方式',
        'en': 'Collapse Config'
    },syncRepoCollapseBtnExpandText: {
        'zh_CN': '展开配置方式',
        'en': 'Expand Config'
    },syncFilesTitle: {
        'zh_CN': '查看',
        'en': 'View'
    },syncNewFileText: {
        'zh_CN': '新建',
        'en': 'New'
    },syncEditModeText: {
        'zh_CN': '编辑',
        'en': 'Edit'
    },syncEditModeDoneText: {
        'zh_CN': '完成',
        'en': 'Done'
    },syncFileItemEditText: {
        'zh_CN': '编辑',
        'en': 'Edit'
    },syncFileItemPinText: {
        'zh_CN': '置顶',
        'en': 'Pin'
    },syncFileItemUnpinText: {
        'zh_CN': '取消置顶',
        'en': 'Unpin'
    },syncFileItemDeleteText: {
        'zh_CN': '删除',
        'en': 'Delete'
    },syncMarkdownToolsLabel: {
        'zh_CN': '格式工具',
        'en': 'Format Tools'
    },syncSaveDocBtnText: {
        'zh_CN': '保存',
        'en': 'Save'
    },syncMarkdownEmpty: {
        'zh_CN': '暂无 Markdown 文件。点击“拉取”或“新建”。',
        'en': 'No Markdown files yet. Click Pull or New.'
    },syncStatusIdle: {
        'zh_CN': '状态：未同步',
        'en': 'Status: Not synced'
    },syncStatusLoaded: {
        'zh_CN': '状态：已加载本地同步数据',
        'en': 'Status: Loaded local sync data'
    },syncStatusPushed: {
        'zh_CN': '状态：已推送到云端快照',
        'en': 'Status: Pushed to cloud snapshot'
    },syncStatusPulled: {
        'zh_CN': '状态：已从云端拉取并更新',
        'en': 'Status: Pulled and updated from cloud snapshot'
    },syncStatusNoCloud: {
        'zh_CN': '状态：云端暂无可拉取快照',
        'en': 'Status: No cloud snapshot to pull'
    },widgetsViewTitle: {
        'zh_CN': '小组件',
        'en': 'Widgets'
    },widgetsViewDescription: {
        'zh_CN': '',
        'en': ''
    },widgetsTrackingWidgetTitle: {
        'zh_CN': '时间捕捉',
        'en': 'Time Tracking'
    },widgetsTrackingWidgetEmpty: {
        'zh_CN': '暂无追踪中的书签',
        'en': 'No bookmarks being tracked'
    },widgetsRankingWidgetTitle: {
        'zh_CN': '点击排行',
        'en': 'Click Ranking'
    },widgetsRankingWidgetTitleCompact: {
        'zh_CN': '点击排行',
        'en': 'Ranking'
    },widgetsRankingWidgetEmpty: {
        'zh_CN': '暂无点击记录',
        'en': 'No click records'
    },widgetsTimeRankingWidgetTitle: {
        'zh_CN': '时间排行',
        'en': 'Time Ranking'
    },widgetsTimeRankingWidgetEmpty: {
        'zh_CN': '暂无时间排行数据',
        'en': 'No time ranking data'
    },widgetsTimeRankingTypeComposite: {
        'zh_CN': '时长',
        'en': 'Time'
    },widgetsTimeRankingTypeWakes: {
        'zh_CN': '次数',
        'en': 'Wakes'
    },widgetsRankingRangeToggle: {
        'zh_CN': '切换范围',
        'en': 'Switch range'
    },widgetsRankingModeToggle: {
        'zh_CN': '切换模式',
        'en': 'Switch mode'
    },widgetsRankingModeBookmark: {
        'zh_CN': '书签',
        'en': 'Bmk'
    },widgetsRankingModeFolder: {
        'zh_CN': '文件夹',
        'en': 'Fld'
    },widgetsRankingModeDomain: {
        'zh_CN': '全域',
        'en': 'Dom'
    },widgetsRankingModeSubdomain: {
        'zh_CN': '子域',
        'en': 'Sub'
    },widgetsRecommendWidgetTitle: {
        'zh_CN': '书签推荐',
        'en': 'Bookmark Recommend'
    },widgetsAdditionsWeekWidgetTitle: {
        'zh_CN': '添加记录',
        'en': 'Additions'
    },widgetsAdditionsWeekWidgetEmpty: {
        'zh_CN': '暂无本周添加记录',
        'en': 'No additions this week'
    },widgetsHistoryWeekWidgetTitle: {
        'zh_CN': '点击记录',
        'en': 'Click History'
    },widgetsHistoryWeekWidgetEmpty: {
        'zh_CN': '暂无本周点击记录',
        'en': 'No clicks this week'
    },widgetsChartViewToggle: {
        'zh_CN': '切换视图',
        'en': 'Switch view'
    },widgetsChartViewLine: {
        'zh_CN': '曲线',
        'en': 'Line'
    },widgetsChartViewWeekGrid: {
        'zh_CN': '周格',
        'en': 'Grid'
    },widgetsChartViewMonthGrid: {
        'zh_CN': '月格',
        'en': 'M-Grid'
    },widgetsChartViewYearGrid: {
        'zh_CN': '年格',
        'en': 'Y-Grid'
    },widgetsChartRangeToggle: {
        'zh_CN': '切换范围',
        'en': 'Switch range'
    },widgetsChartRangeWeek: {
        'zh_CN': '本周',
        'en': 'Week'
    },widgetsChartRangeMonth: {
        'zh_CN': '本月',
        'en': 'Month'
    },widgetsChartRangeYear: {
        'zh_CN': '当年',
        'en': 'Year'
    },widgetsChartRangeMonth30: {
        'zh_CN': '本月',
        'en': 'Month'
    },widgetsRankingVisualToggle: {
        'zh_CN': '切换图表',
        'en': 'Switch chart'
    },widgetsRankingVisualList: {
        'zh_CN': '列表',
        'en': 'List'
    },widgetsRankingVisualPie: {
        'zh_CN': '饼图',
        'en': 'Pie'
    },widgetsPieOther: {
        'zh_CN': '其他',
        'en': 'Other'
    },widgetsWeekTotal: {
        'zh_CN': '本周共 {count} 条',
        'en': '{count} this week'
    },widgetsRelatedWidgetTitle: {
        'zh_CN': '关联记录',
        'en': 'Related Records'
    },widgetsRelatedLevel1: {
        'zh_CN': '一级目录',
        'en': 'Level 1'
    },widgetsRelatedLevel2: {
        'zh_CN': '二级目录',
        'en': 'Level 2'
    },widgetsRelatedEmpty: {
        'zh_CN': '暂无目录记录',
        'en': 'No folder records'
    },widgetsRelatedComputing: {
        'zh_CN': '正在计算…',
        'en': 'Calculating...'
    },widgetsCardRefreshText: {
        'zh_CN': '刷新推荐',
        'en': 'Refresh Cards'
    },widgetsQuickReviewText: {
        'zh_CN': '添加待复习',
        'en': 'Add to Review'
    },widgetsSmartSortToggle: {
        'zh_CN': '智能排序',
        'en': 'Smart Sort'
    },widgetsSmartSortEnabled: {
        'zh_CN': '智能排序：开启',
        'en': 'Smart Sort: On'
    },widgetsSmartSortDisabled: {
        'zh_CN': '智能排序：关闭',
        'en': 'Smart Sort: Off'
    },widgetsSortPanelTitle: {
        'zh_CN': '小组件排序',
        'en': 'Widget Order'
    },widgetsSortMoveUp: {
        'zh_CN': '上移',
        'en': 'Move Up'
    },widgetsSortMoveDown: {
        'zh_CN': '下移',
        'en': 'Move Down'
    },widgetsSmartSortInfoBtn: {
        'zh_CN': '智能排序说明',
        'en': 'Smart Sort Help'
    },widgetsSortInfoPanelTitle: {
        'zh_CN': '智能排序说明',
        'en': 'How Smart Sort Works'
    },widgetsSortInfoLine1: {
        'zh_CN': '待复习到期时，「书签推荐」会自动置顶。',
        'en': 'Bookmark Recommend goes to top when review-later items are due.'
    },widgetsSortInfoLine2: {
        'zh_CN': '其余小组件会根据数据变化自动上浮。',
        'en': 'Other widgets move up when data changes.'
    },widgetsSortInfoLine3: {
        'zh_CN': '关闭智能排序后，顺序按手动排序结果展示。',
        'en': 'When smart sort is off, manual order is used.'
    },widgetsSortOpenMaskToggle: {
        'zh_CN': '显示“正在排序”遮罩',
        'en': 'Show "Sorting" Overlay'
    },widgetsSortManualLockedHint: {
        'zh_CN': '智能排序开启时，手动排序已锁定',
        'en': 'Manual order is locked while Smart Sort is on'
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
    },browsingCalibrationText: {
        'zh_CN': '校准与清理',
        'en': 'Calibrate & Clean'
    },browsingCalibrationManual: {
        'zh_CN': '手动校准',
        'en': 'Manual calibrate'
    },browsingCalibrationSettings: {
        'zh_CN': '自动校准设置',
        'en': 'Auto calibration settings'
    },browsingCalibrationSettingsTitle: {
        'zh_CN': '自动校准设置',
        'en': 'Auto calibration settings'
    },browsingCalibrationSettingsDesc1: {
        'zh_CN': '说明：校准只维护扩展自己的<span class="calibration-desc-highlight">本地浏览历史库</span>；点击记录、点击排行和关联记录会在读取时再与当前书签库匹配。',
        'en': 'Note: calibration only maintains the extension-owned <span class="calibration-desc-highlight">local browsing history library</span>. Click records, rankings, and related history are matched against the current bookmark library when read.'
    },browsingCalibrationSettingsDesc3: {
        'zh_CN': '首次启用当前本地库版本时，会丢弃旧版本的历史缓存，并通过浏览器 History API 建立最近约 90 天的基线；之后校准只重新对齐最近热区，同时保留本版本后续沉淀的 90 天前冷数据。每日后台定时校准按固定时间执行；如果错过时间，后台启动或打开插件页面时会补检查。下方空闲选项只影响后台定时校准，手动校准和打开页面校准不受影响。',
        'en': 'The first run of the current local library version discards legacy history cache data and seeds a roughly 90-day baseline through the browser History API. Later calibration realigns only the recent hot window while preserving cold data accumulated by this library version. Daily background calibration runs at the selected time. If the time is missed, the background startup or extension page open checks whether it should catch up. The idle option below only affects background scheduled calibration; manual and page-open calibration are unaffected.'
    },historyPurgeRangeLabel: {
        'zh_CN': '清理本地记录:',
        'en': 'Clean local records:'
    },historyPurgeInfoTitle: {
        'zh_CN': '清理规则说明',
        'en': 'Cleanup rules'
    },historyPurgeInfoText: {
        'zh_CN': '浏览器 History API 通常只能回查最近约 90 天的浏览记录；首次启用当前本地库版本时，扩展会丢弃旧版本历史缓存并用 API 建立最近约 90 天的基线。之后，为支持更久的点击排行、关联记录和导出，扩展会维护自己的本地浏览历史库。本地库保存浏览器访问事实，不会因为书签被删除或 URL 被修改而删除；点击记录、点击排行和关联记录会在读取时再与当前书签库匹配。本地记录库会监听浏览器历史删除事件并做同步；浏览器清空全部历史时，本地记录也会清空。浏览器只删除部分历史时，本地库只同步最近 90 天窗口，避免误删本版本后续沉淀的冷数据。这里的“立即清理”只清理扩展自己的本地记录库，不会删除 Chrome/Edge 的浏览器历史。',
        'en': 'The browser History API usually only lets extensions query roughly the most recent 90 days of browsing records. On the first run of the current local library version, this extension discards legacy history cache data and seeds a roughly 90-day baseline from the API. After that, the extension maintains its own local browsing history library to support longer click ranking, related records, and exports. The local library stores browser visit facts and is not deleted just because a bookmark is removed or its URL changes. Click records, rankings, and related history are matched against the current bookmark library when read. The local library listens to browser history deletion events and syncs them. If the browser clears all history, local records are cleared too. If the browser deletes only part of history, the local library syncs only the recent 90-day window to protect cold data accumulated by this library version. “Clean now” only cleans this extension’s local records and does not delete Chrome/Edge browser history.'
    },historyPurgeOptionKeep2Years: {
        'zh_CN': '清理2年前记录',
        'en': 'Clean records older than 2 years'
    },historyPurgeOptionKeep1Year: {
        'zh_CN': '清理1年前记录',
        'en': 'Clean records older than 1 year'
    },historyPurgeOptionKeep180Days: {
        'zh_CN': '清理180天前记录',
        'en': 'Clean records older than 180 days'
    },historyPurgeOptionKeep90Days: {
        'zh_CN': '清理90天前记录',
        'en': 'Clean records older than 90 days'
    },browsingCalibrationSettingsSave: {
        'zh_CN': '保存',
        'en': 'Save'
    },browsingCalibrationDeleteLabel: {
        'zh_CN': '累计删除',
        'en': 'Auto calibrate after'
    },browsingCalibrationDeleteUnit: {
        'zh_CN': '次后自动校准',
        'en': 'deletions'
    },browsingCalibrationOpenLabel: {
        'zh_CN': '浏览历史相关打开/点击',
        'en': 'Auto calibrate after'
    },browsingCalibrationOpenUnit: {
        'zh_CN': '次后自动校准',
        'en': 'history-related opens/clicks'
    },browsingCalibrationScheduleLabel: {
        'zh_CN': '每天',
        'en': 'Every day at'
    },browsingCalibrationScheduleUnit: {
        'zh_CN': '自动校准',
        'en': 'auto calibrate'
    },browsingCalibrationIdleLabel: {
        'zh_CN': '后台定时校准遇到浏览器忙碌时延后',
        'en': 'Delay background scheduled calibration while the browser is busy'
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
    },browsingRelatedComputingOpen: {
        'zh_CN': '正在打开关联记录…',
        'en': 'Opening related history...'
    },browsingRelatedComputingCalc: {
        'zh_CN': '正在计算关联记录…',
        'en': 'Calculating related history...'
    },browsingRelatedComputingApply: {
        'zh_CN': '正在应用筛选…',
        'en': 'Applying filters...'
    },browsingRelatedComputingReuse: {
        'zh_CN': '正在复用上次结果…',
        'en': 'Reusing last snapshot...'
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
    },calendarWeekLabel: {
        'zh_CN': '周',
        'en': 'Week'
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
    },calendarNoBookmarksThisMonth: {
        'zh_CN': '本月暂无书签',
        'en': 'No bookmarks this month'
    },calendarNoBookmarksThisDay: {
        'zh_CN': '当天暂无书签',
        'en': 'No bookmarks this day'
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
        'zh_CN': '问题反馈与快捷键',
        'en': 'Feedback & Shortcuts'
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
    },shortcutsRefreshHint: {
        'zh_CN': '如修改了浏览器快捷键，请关闭并重新打开本窗口以刷新显示。',
        'en': 'After changing browser shortcuts, close and reopen this window to refresh.'
    },shortcutsTableHeaderKey: {
        'zh_CN': '按键',
        'en': 'Key'
    },shortcutsTableHeaderAction: {
        'zh_CN': '功能',
        'en': 'Action'
    },shortcutsSettingsTooltip: {
        'zh_CN': '在浏览器中管理快捷键',
        'en': 'Manage shortcuts in browser'
    },shortcutSidePanel: {
        'zh_CN': '激活扩展 / 打开侧栏',
        'en': 'Activate extension / open side panel'
    },shortcutAdditions: {
        'zh_CN': '打开「书签记录」视图',
        'en': 'Open "Bookmark Record" view'
    },shortcutRecommend: {
        'zh_CN': '打开「书签推荐」视图',
        'en': 'Open "Bookmark Recommend" view'
    },shortcutQuickReviewNext: {
        'zh_CN': '快捷复习：开始或下一张',
        'en': 'Quick review: start or next card'
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
        'zh_CN': '屏蔽',
        'en': 'Block'
    },trackingBlockModalTitle: {
        'zh_CN': '时间追踪屏蔽',
        'en': 'Time Tracking Block'
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
    },trackingStateHelpTitle: {
        'zh_CN': '状态说明',
        'en': 'State guide'
    },trackingHeaderTitle: {
        'zh_CN': '书签',
        'en': 'Bookmark'
    },trackingHeaderTime: {
        'zh_CN': '综合时长（当前）',
        'en': 'Composite Duration (Current)'
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
        'zh_CN': '综合时长',
        'en': 'Composite Duration'
    },trackingRankingTypeWakes: {
        'zh_CN': '唤醒次数',
        'en': 'Wake Count'
    },trackingRangeToday: {
        'zh_CN': '今天',
        'en': 'Today'
    },trackingRangeWeek: {
        'zh_CN': '本周',
        'en': 'Week'
    },trackingRangeMonth: {
        'zh_CN': '本月',
        'en': 'Month'
    },trackingRangeYear: {
        'zh_CN': '当年',
        'en': 'Year'
    },trackingRangeAll: {
        'zh_CN': '全部',
        'en': 'All'
    },trackingNoData: {
        'zh_CN': '暂无活跃时间数据',
        'en': 'No active time data'
    },trackingNoDataRange: {
        'zh_CN': '该时间范围暂无数据（旧数据请查看“全部”）',
        'en': 'No data in this range yet (older data is available in "All").'
    },trackingRangeDataHintFrom: {
        'zh_CN': '区间统计起始于 {date}（旧数据仅计入“全部”）',
        'en': 'Range stats start from {date} (older data is available in "All" only).'
    },trackingRangeDataHintPending: {
        'zh_CN': '区间统计仅记录新版本后的数据（旧数据仅计入“全部”）',
        'en': 'Range stats only include data after this version update (older data is in "All" only).'
    },trackingClearRangeConfirm: {
        'zh_CN': '确定要清除{range}以前的综合排行数据吗？',
        'en': 'Are you sure you want to clear ranking data older than {range}?'
    },trackingClearCurrentConfirm: {
        'zh_CN': '确定要清除正在追踪的会话吗？',
        'en': 'Are you sure you want to clear current tracking sessions?'
    },trackingClearRange: {
        'zh_CN': { week: '一周', month: '一个月', year: '一年', all: '全部' },
        'en': { week: '1 week', month: '1 month', year: '1 year', all: 'all' }
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
    },thresholdFreshnessLabel: {
        'zh_CN': '添加天数',
        'en': 'Days since added'
    },thresholdColdnessLabel: {
        'zh_CN': '点击数',
        'en': 'Click count'
    },thresholdTimeDegreeLabel: {
        'zh_CN': '综合时间',
        'en': 'Composite time'
    },thresholdMinutesUnit: {
        'zh_CN': '分钟',
        'en': ' min'
    },thresholdForgettingLabel: {
        'zh_CN': '未访问',
        'en': 'Unvisited'
    },thresholdDaysUnit: {
        'zh_CN': '天',
        'en': ' days'
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
    },cardQuickReviewText: {
        'zh_CN': '快捷复习',
        'en': 'Quick Review'
    },refreshSettingsTitle: {
        'zh_CN': '书签推荐设置',
        'en': 'Bookmark Recommend Settings'
    },widgetSettingsTooltip: {
        'zh_CN': '设置',
        'en': 'Settings'
    },settingsAutoRefreshText: {
        'zh_CN': '自动刷新设置',
        'en': 'Auto Refresh'
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
    },settingsReviewReminderText: {
        'zh_CN': '待复习提醒',
        'en': 'Review Reminder'
    },reviewReminderPopupLabel: {
        'zh_CN': '待复习到期时弹出提醒窗口',
        'en': 'Show a reminder window when review items are due'
    },reviewReminderPopupHint: {
        'zh_CN': '独立提醒窗口会在书签到期后弹出，需要手动关闭。',
        'en': 'A standalone reminder window opens when bookmarks become due and stays open until closed.'
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
    },cardSkipTitle: {
        'zh_CN': '跳过',
        'en': 'Skip'
    },recommendSearchModalTitle: {
        'zh_CN': '推荐候选',
        'en': 'Recommendation Candidate'
    },recommendSearchDebugTitle: {
        'zh_CN': '诊断',
        'en': 'Debug'
    },recommendSearchLaterText: {
        'zh_CN': '待复习',
        'en': 'To Review'
    },recommendSearchSkipText: {
        'zh_CN': '跳过',
        'en': 'Skip'
    },recommendSearchBlockText: {
        'zh_CN': '屏蔽',
        'en': 'Block'
    },recommendSearchReviewText: {
        'zh_CN': '标记已复习',
        'en': 'Mark Reviewed'
    },recommendSearchOpenText: {
        'zh_CN': '打开',
        'en': 'Open'
    },recommendSearchCloseText: {
        'zh_CN': '关闭',
        'en': 'Close'
    },addTabFolder: {
        'zh_CN': '随机',
        'en': 'Random'
    },addTabTree: {
        'zh_CN': '树',
        'en': 'Tree'
    },addTabSearch: {
        'zh_CN': '搜索',
        'en': 'Search'
    },addTabDomain: {
        'zh_CN': '域名',
        'en': 'Domain'
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
    },addTreeSelectedText: {
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
        'zh_CN': '屏蔽',
        'en': 'Block'
    },blockAddBtnTitle: {
        'zh_CN': '添加到屏蔽',
        'en': 'Add to block'
    },addBlockModalTitle: {
        'zh_CN': '添加到屏蔽',
        'en': 'Add to Block'
    },addBlockConfirmText: {
        'zh_CN': '添加屏蔽',
        'en': 'Add Block'
    },addBlockTabTree: {
        'zh_CN': '树',
        'en': 'Tree'
    },addBlockTabSearch: {
        'zh_CN': '搜索',
        'en': 'Search'
    },addBlockTabDomain: {
        'zh_CN': '域名',
        'en': 'Domain'
    },addBlockTreeHint: {
        'zh_CN': '',
        'en': ''
    },addBlockSearchHint: {
        'zh_CN': '',
        'en': ''
    },addBlockDomainHint: {
        'zh_CN': '域名按 A-Z 排序；已在待复习中的书签会自动跳过。',
        'en': 'Domains are sorted A-Z. Bookmarks already in review are skipped.'
    },addBlockTreeSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },addBlockSearchSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },addBlockUnifiedDomainSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },addBlockUnifiedDomainSelectedLabel: {
        'zh_CN': '个域名',
        'en': 'domains'
    },addBlockFooterSelectedText: {
        'zh_CN': '已选择',
        'en': 'Selected'
    },blockedUnifiedEmptyText: {
        'zh_CN': '暂无屏蔽项',
        'en': 'No blocked items'
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
    },laterPresetText: {
        'zh_CN': '快捷时间',
        'en': 'Quick Times'
    },laterModalTitle: {
        'zh_CN': '稍后复习',
        'en': 'Review Later'
    },laterIn1Hour: {
        'zh_CN': '1小时后',
        'en': 'In 1 hour'
    },laterTomorrow: {
        'zh_CN': '明天',
        'en': 'Tomorrow'
    },laterIn3Days: {
        'zh_CN': '3天后',
        'en': 'In 3 days'
    },laterIn1Week: {
        'zh_CN': '1周后',
        'en': 'In 1 week'
    },laterCustomTimeLabel: {
        'zh_CN': '自定义时间',
        'en': 'Custom time'
    },laterCustomSubmit: {
        'zh_CN': '确定',
        'en': 'Confirm'
    },laterCustomTimeHint: {
        'zh_CN': '输入一个未来时间，到期后进入待复习。',
        'en': 'Enter a future time. It will enter the review queue when due.'
    }
,exportTooltip: {
        'zh_CN': '导出书签添加记录',
        'en': 'Export Bookmark Addition Records'
    },exportModalTitle: {
        'zh_CN': '导出书签添加记录',
        'en': 'Export Bookmark Addition Records'
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
        'zh_CN': '书签记录与推荐',
        'en': 'Bookmark Record and Recommend'
    },calendarSelectMode: {
        'zh_CN': '勾选',
        'en': 'Select'
    },calendarLocateToday: {
        'zh_CN': '定位至今天',
        'en': 'Locate Today'
    },browsingExportTooltip: {
        'zh_CN': '导出书签点击记录',
        'en': 'Export Bookmark Click Records'
    },browsingExportModalTitle: {
        'zh_CN': '导出书签点击记录',
        'en': 'Export Bookmark Click Records'
    }
};
window.i18n = i18n; // 暴露给其他模块使用
