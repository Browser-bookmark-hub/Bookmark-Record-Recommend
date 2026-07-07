# Bookmark Record and Recommend 项目结构

整理基准：2026-07-08  
当前扩展目录：`Bookmark-Record-Recommend-main/`

本文档用于快速定位当前代码模块。若与旧计划文档冲突，以当前代码为准。

## 顶层结构

```text
Bookmark-Record-Recommend/
|-- README.md                              [DOC] 仓库首页说明。
|-- PRIVACY_POLICY.md                      [DOC] 隐私政策。
|-- LICENSE                                [DOC] 仓库许可证。
|-- .gitattributes                         [DEV] Git 文本属性配置。
|-- Bookmark-Record-Recommend-main/        [CORE] 可加载的 MV3 扩展目录。
|-- Screenshots and icons/                 [ASSET] 截图、图标和生成脚本。
|-- docs/                                  [DOC] 当前文档与历史计划归档。
\-- .codegraph/                            [DEV] 本地 CodeGraph 索引文件。
```

## 扩展目录结构

```text
Bookmark-Record-Recommend-main/
|-- manifest.json                          [CORE] Manifest V3 配置、权限、Side Panel、命令和后台 Service Worker。
|-- background.js                          [CORE] 后台中枢：推荐算法、浏览历史库、活跃时间桥接、命令、闹钟、复习提醒和消息处理。
|-- panel-shell.html                       [UI] Side Panel 外壳。
|-- panel-shell.js                         [UI] 将 Side Panel 路由到 history 页面对应视图。
|-- panel-shell.css                        [UI] Side Panel 外壳样式。
|-- panel-shell-theme-bootstrap.js         [UI] Side Panel 早期主题应用。
|-- github-token-guide.html                [UI] GitHub Token 配置说明页。
|-- github-token-guide.js                  [UI] GitHub Token 配置说明页交互逻辑。
|-- active_time_tracker/                   [CORE] 活跃时间捕捉模块。
|   \-- index.js                           [CORE] 状态机、会话、统计、排行与存储同步。
|-- history_html/                          [UI] 主工作区页面。
|   |-- history.html                       [UI] 页面结构，承载 widgets / recommend / additions / sync 视图。
|   |-- history.js                         [UI] 主交互逻辑、推荐视图、同步页、GitHub API、Markdown、快捷复习和小组件。
|   |-- history.css                        [UI] 主页面样式。
|   |-- history_bootstrap.js               [UI] 页面启动辅助。
|   |-- history_theme_bootstrap.js         [UI] 早期主题应用。
|   |-- history_view_bootstrap.js          [UI] 视图启动辅助。
|   |-- bookmark_calendar.js               [UI] 书签新增记录日历。
|   |-- bookmark_calendar.css              [UI] 书签新增记录日历样式。
|   |-- browsing_history_calendar.js       [UI] 浏览记录日历与本地库读取。
|   |-- shortcuts_helpers.js               [UTIL] 快捷键显示辅助。
|   |-- sidepanel_toggle_bridge.js         [UTIL] Side Panel 与页面切换桥。
|   |-- database/utils.js                  [UTIL] 历史页数据库辅助。
|   |-- search/                            [UI] 搜索模块。
|   |   |-- search.js                       [UI] 搜索逻辑。
|   |   \-- search.css                      [UI] 搜索样式。
|   \-- vendor/                            [VENDOR] Markdown 渲染、清洗和 Obsidian Markdown 相关库。
|-- review_reminder/                       [UI] 推荐复习提醒弹窗。
|   |-- review_reminder_popup.html         [UI] 弹窗结构。
|   |-- review_reminder_popup.js           [UI] 弹窗交互。
|   \-- review_reminder_popup.css          [UI] 弹窗样式。
|-- _locales/                              [I18N] Chrome 扩展国际化资源。
|   |-- en/messages.json                   [I18N] 英文名称、描述和标题。
|   \-- zh_CN/messages.json                [I18N] 中文名称、描述和标题。
|-- icons/                                 [ASSET] 扩展图标。
|   |-- icon16.png                         [ASSET] Manifest/action 图标。
|   |-- icon24.png                         [ASSET] action 默认图标。
|   |-- icon32.png                         [ASSET] action 默认图标。
|   |-- icon48.png                         [ASSET] Manifest 图标。
|   \-- icon128.png                        [ASSET] Manifest 图标。
|-- webfonts/                              [ASSET] Font Awesome 字体文件。
|-- font-awesome.min.css                   [ASSET] Font Awesome 样式。
|-- README.md                              [DOC] 扩展目录内说明。
|-- PRIVACY_POLICY.md                      [DOC] 隐私政策副本。
\-- LICENSE                                [DOC] 扩展目录许可证。
```

## 模块定位

- **主入口**：`manifest.json` 声明 Side Panel 默认路径为 `panel-shell.html`，后台为 `background.js` module service worker。
- **工作区路由**：`panel-shell.js` 通过 iframe 打开 `history_html/history.html` 并传入目标视图参数。
- **后台推荐**：`background.js` 维护 S 值缓存、推荐状态、快捷复习、推荐后台刷新和复习提醒调度。
- **记录与日历**：`history_html/bookmark_calendar.js` 与 `history_html/browsing_history_calendar.js` 分别处理书签新增记录和浏览记录日历。
- **浏览历史库**：`background.js` 维护本地浏览历史缓存；`browsing_history_calendar.js` 从页面数据库管理器同步到展示层。
- **活跃时间**：`active_time_tracker/index.js` 管理会话状态、统计和排行，后台导入其接口供页面查询。
- **AI 同步**：`history_html/history.js` 中的同步页负责 GitHub 配置、push/pull、数据包构建、Markdown 查看和编辑。
- **快捷键**：Manifest 当前包含 `Ctrl/Command+Shift+6/7/8/9`，分别用于激活扩展、推荐视图、记录视图和快捷复习。

## 文档放置约定

- `README.md`：面向当前版本的产品说明和截图入口。
- `docs/PROJECT_STRUCTURE.md`：当前文件结构。
- `docs/S_SCORE_ALGORITHM_V6_4.md`：当前 S 值算法 v6.4、书签树/浏览历史维护桶和同步推送说明。
- `docs/LIMITATIONS_AND_COMPROMISES.md`：当前限制和妥协。
- `docs/CHANGELOG.md`：当前整理后的更新记录。
- `docs/归档/`：历史计划、旧审计和阶段性验收材料。归档正文不代表当前实现规范。
