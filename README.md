## Switch to [English](#english)

## 中文

### 简介
`书签记录 & 推荐` 是一个面向重度书签用户的浏览器扩展：
在同一套 UI 中，把「书签记录」和「书签推荐」结合起来，支持侧边栏与独立页面两种使用方式。

### 特色功能
- **双工作区**：支持 Side Panel + 独立 HTML 页面，适配不同使用习惯。
- **推荐引擎（v6.2）**：基于 S 值与池子模型，支持三卡位轮换与优先复习队列。
- **推荐操作语义清晰**：`待复习 / 跳过 / 屏蔽` 三种操作可直接影响后续推荐。
- **书签记录三件套**：书签添加记录、点击排行、关联记录（含日历与筛选）。
- **时间捕捉与排行**：按书签页面活跃时长统计，支持多时间范围查看。
- **校准机制**：支持手动/自动校准浏览历史，降低删除历史后的数据偏差。
- **上下文搜索**：同一个搜索框按场景切换，支持关键词、日期区间、S 值筛选。
- **中英文 + 主题切换**：自动语言识别，支持明暗主题。

### 预览
| 侧边栏 | 推荐公式|
| :---: | :---: |
| <img src="doc/screenshots/sidebar_zh.png" width="400"> | <img src="doc/screenshots/recommend_zh.png" width="400"> |
| **搜索** | **点击排行** |
| <img src="doc/screenshots/search_zh.png" width="400"> | <img src="doc/screenshots/ranking_zh.png" width="400"> |
### 快速安装（开发者模式）
1. 下载或克隆本仓库。
2. 打开 `chrome://extensions`（或 Edge 扩展页）。
3. 开启“开发者模式”。
4. 选择“加载已解压的扩展程序”，指向本项目根目录。
5. 点击扩展图标即可打开侧边栏。

### 主要视图
- **Widgets**：聚合小组件（推荐、时间捕捉、排行、周统计等）。
- **Bookmark Recommend**：推荐卡片、待复习、屏蔽管理、复习热力图。
- **Bookmark Records**：添加记录 / 浏览记录 / 时间捕捉。

### 数据与隐私
- 核心记录与推荐状态保存在浏览器本地存储（无独立后端服务）。
- 插件会请求书签、历史记录、标签页等权限以提供完整功能。
- favicon 可能通过站点图标或公共 favicon 源加载。

### 相关文档
- `doc/RECOMMEND_POOLS_V6_2.md`：推荐池模型与流转规则（v6.2）

---

## English

### Overview
`Bookmark Records & Recommendations` is a browser extension for power bookmark users.
It combines **recording** and **recommendation** into one workflow, available in both **Side Panel** and **full HTML page** modes.

### Highlights
- **Dual workspace**: works in Side Panel and standalone page.
- **Recommendation engine (v6.2)**: S-score + pool model with 3-card rotation and due-first queue.
- **Actionable recommendation controls**: `Review Later / Skip / Block` directly shape future recommendations.
- **Bookmark record suite**: additions, click ranking, and related history with calendar/filter views.
- **Active-time tracking**: weighted bookmark-page activity with range-based ranking.
- **Calibration tools**: manual + auto calibration to realign data after history deletions.
- **Context-aware search**: one search box, multiple modes (keywords, date ranges, S-score filters).
- **Bilingual + themes**: auto language detection and light/dark themes.

### Preview

| Sidebar | Recommend |
| :---: | :---: |
| <img src="doc/screenshots/sidebar_en.png" width="400"> | <img src="doc/screenshots/recommend_en.png" width="400"> |
| **Search** | **Ranking** |
| <img src="doc/screenshots/search_en.png" width="400"> | <img src="doc/screenshots/ranking_en.png" width="400"> |

### Quick Start (Developer Mode)
1. Clone or download this repository.
2. Open `chrome://extensions` (or Edge extensions page).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this project folder.
5. Click the extension action button to open the side panel.

### Main Views
- **Widgets**: consolidated widgets for recommendations, tracking, ranking, weekly summaries.
- **Bookmark Recommend**: recommendation cards, review-later queue, block manager, review heatmap.
- **Bookmark Records**: additions / browsing history / time tracking.

### Data & Privacy
- Core states are stored locally in browser storage (no dedicated backend service).
- Permissions include bookmarks/history/tabs to support full functionality.
- Favicons may be loaded from site icons or public favicon providers.

### Docs
- `doc/RECOMMEND_POOLS_V6_2.md`: recommendation pool model and flow rules (v6.2)

---

## License

GPL-3.0

## [Back to top ](#中文)
