## Switch to [English](#english)

[![GitHub Releases](https://img.shields.io/github/v/release/Browser-bookmark-hub/Bookmark-Record-Recommend?logo=github&logoColor=white&label=GitHub+Releases)](https://github.com/Browser-bookmark-hub/Bookmark-Record-Recommend/releases)
[![Microsoft Edge Add-ons](https://img.shields.io/badge/Edge_Add--ons-Available-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/hdoajmdijappigkbiiefbhkfifbfoleb)
[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/ehodmhbidnoegdodnceiepdekgeoggck?color=0F9D58&logo=googlechrome&logoColor=white&label=Chrome+Web+Store)](https://chromewebstore.google.com/detail/ehodmhbidnoegdodnceiepdekgeoggck)

### 简介
`书签记录与推荐` 是一款为重度用户打造的增强型扩展，通过“书签记录”、“智能推荐”与“AI 推送”三大核心引擎唤醒你的知识库。
它基于 S 值算法实现动态推荐，并在本地完成所有复杂的关联计算。“原始数据 + 计算结果”可直接下载到本地或推送到 GitHub，让 AI 结合 `AGENTS.md` / `CLAUDE.md` 规则“开箱即用”地进行深度分析，免去了处理生数据的算力负担。

### 特色功能
- **双工作区**：支持 Side Panel + 独立 HTML 页面，适配不同使用习惯。
- **推荐引擎（v6.2）**：基于 S 值与池子模型，支持三卡位轮换与优先复习队列。
- **小组件中心**：聚合推荐、时间捕捉、排行、周统计等常用信息，快速查看当前书签状态。
- **推荐操作语义清晰**：`待复习 / 跳过 / 屏蔽` 三种操作可直接影响后续推荐。
- **书签记录三件套**：书签添加记录、点击排行、关联记录（含日历与筛选）。
- **时间捕捉与排行**：按书签页面活跃时长统计，支持多时间范围查看。
- **校准机制**：支持手动/自动校准浏览历史，降低删除历史后的数据偏差。
- **AI 推送与分析**：支持将书签记录、推荐信号和 Markdown 文档推送到 GitHub 云端，并配合 `AGENTS.md` / `CLAUDE.md` 进行 AI 分析。
- **上下文搜索**：同一个搜索框按场景切换，支持关键词、日期区间、S 值筛选。
- **中英文 + 主题切换**：自动语言识别，支持明暗主题。

### 预览

#### 推送与分析结构图预览
```text
书签记录与推荐/
|-- AGENTS.md                             [PUSH] 同步/AI 分析规则文档：固定写入产品文件夹，限定可读路径、结果格式、manifest 与 pushId 聚合流程。
|-- data/manifest.json                    [PUSH] AI 入口索引：列出本次 pushId、正文文件、hash、读取顺序；不包含正文或本地变化摘要。
|-- data/packages/bookmark-record.json    [PUSH] 书签记录包：新增、点击、点击排行、关联记录、当前时间排行与时间屏蔽状态。
|-- data/packages/bookmark-recommend.json [PUSH] 书签推荐包：S 分数池、候选池、推荐模式、复习、屏蔽、跳过、翻卡事件。
|-- data/raw-native/bookmarks-tree.json   [PUSH] 书签树/准原生事实源：Phase A 标注 source 与 flattened-records 格式。
|-- data/raw-native/history-visits.jsonl  [PUSH] 浏览历史事实源：JSONL 明细，manifest 标注 limit 与 truncated。
|-- ai/input-docs/index.json              [PUSH] “查看”区输入文档索引：记录任务 Markdown 的文件名与更新时间。
|-- ai/input-docs/*.md                    [PULL/PUSH] 输入任务文档：你在“查看”里维护；本地/云端删除会按拉取或推送同步。
|-- ai/results/**/*.md                    [PULL/PUSH] AI 输出结果文档：拉取查看；本地编辑、重命名、删除后随下次推送同步。
|-- GitHub /commits?sha=<branch>          [READ] 仓库提交时间线：查看最近改动文件与变更频率。
|-- GitHub /compare/<base>...<head>       [READ] 按 pushId 聚合后的差异摘要：查看业务文件变化；不生成本地变化摘要。
\-- meta/sync_state.json                  [PUSH] 同步状态元数据：最近推送时间、分支、推送文件数、文档数量。
```

### 主要视图
- **小组件**：聚合推荐、时间捕捉、排行、周统计等常用信息。
- **书签推​​荐**：推荐卡片、待复习、屏蔽管理、复习热力图。
- **书签记录**：添加记录 / 浏览记录 / 时间捕捉。
- **推送与分析**：GitHub 同步、数据包推送、Markdown 文档管理与 AI 分析规则。

### 数据与隐私
- **默认本地存储**：核心记录与推荐状态保存在浏览器本地存储（无独立后端服务）。
- **可选 GitHub 云端同步**：支持将数据与文档上传/下载到你个人的 GitHub 仓库。
- 插件会请求书签、历史记录、标签页等权限以提供完整功能。
- favicon 可能通过浏览器内置 favicon 服务或公共 favicon 源加载，并持久化到本地缓存。
- 更多详情请参考：[隐私政策 (`PRIVACY_POLICY.md`)](PRIVACY_POLICY.md)

### 相关文档
- [`docs/other docs/RECOMMEND_POOLS_V6_2.md`](docs/other%20docs/RECOMMEND_POOLS_V6_2.md)：推荐池模型与流转规则（v6.2）

---

## English

### Overview
`Bookmark Record and Recommend` is an enhanced extension for power bookmark users. It reawakens your knowledge base through three core engines: "Bookmark Records", "Smart Recommendations", and "AI Push".
It uses an S-Score algorithm for dynamic recommendations and processes all complex data computations locally. The "raw data + computed results" can be downloaded locally or synced to GitHub, allowing AI to perform deep analysis out-of-the-box using `AGENTS.md` / `CLAUDE.md` rules, bypassing the heavy raw computation burden.

### Highlights
- **Dual workspace**: works in Side Panel and standalone page.
- **Recommendation engine (v6.2)**: S-score + pool model with 3-card rotation and due-first queue.
- **Widget center**: consolidated widgets for recommendations, active-time tracking, rankings, and weekly summaries.
- **Actionable recommendation controls**: `Review Later / Skip / Block` directly shape future recommendations.
- **Bookmark record suite**: additions, click ranking, and related history with calendar/filter views.
- **Active-time tracking**: weighted bookmark-page activity with range-based ranking.
- **Calibration tools**: manual + auto calibration to realign data after history deletions.
- **AI Push & Analyze**: push bookmark records, recommendation signals, and Markdown docs to GitHub cloud sync, with `AGENTS.md` / `CLAUDE.md`rules for AI analysis.
- **Context-aware search**: one search box, multiple modes (keywords, date ranges, S-score filters).
- **Bilingual + themes**: auto language detection and light/dark themes.

### Preview

#### Screenshot Preview
| Sidebar | Recommend |
| :---: | :---: |
| <img src="../Screenshots%20and%20icons/v0.3/侧边栏%20en.png" width="400"> | <img src="../Screenshots%20and%20icons/v0.3/推荐公式%20en.png" width="400"> |
| **Bookmark Record** | **Push & Analyze** |
| <img src="../Screenshots%20and%20icons/v0.3/书签记录%20en.png" width="400"> | <img src="../Screenshots%20and%20icons/v0.3/推送与分析%20en.png" width="400"> |

#### Push & Analyze Structure Preview
```text
Bookmark Record and Recommend/
|-- AGENTS.md                             [PUSH] Required Sync/AI rule document in the product folder: manifest, pushId grouping, output format, and citation rules.
|-- data/manifest.json                    [PUSH] AI entry index: pushId, package files, hashes, read order; no package body or local delta summary.
|-- data/packages/bookmark-record.json    [PUSH] Bookmark record bundle: additions, clicks, rankings, related records, current time rankings and blocked state.
|-- data/packages/bookmark-recommend.json [PUSH] Bookmark recommendation bundle: S-scores, candidates, mode, review/block/skip/flip events.
|-- data/raw-native/bookmarks-tree.json   [PUSH] Bookmark-tree fact source: Phase A marks source and flattened-records format.
|-- data/raw-native/history-visits.jsonl  [PUSH] History fact source: JSONL rows; manifest records limit and truncated.
|-- ai/input-docs/index.json              [PUSH] Input-doc index in the View panel: file names and update timestamps.
|-- ai/input-docs/*.md                    [PULL/PUSH] Input task docs maintained in View; local/cloud deletes sync through push or pull.
|-- ai/results/**/*.md                    [PULL/PUSH] AI result docs: pulled for viewing; local edits, renames, and deletes sync on the next push.
|-- GitHub /commits?sha=<branch>          [READ] Commit timeline for the repository and change frequency.
|-- GitHub /compare/<base>...<head>       [READ] Diff summary after grouping commits by pushId; no local delta summary is generated.
\-- meta/sync_state.json                  [PUSH] Sync metadata: last push time, branch, pushed file count, doc count.
```

### Main Views
- **Widgets**: consolidated widgets for recommendations, active-time tracking, rankings, and weekly summaries.
- **Bookmark Recommend**: recommendation cards, review-later queue, block manager, review heatmap.
- **Bookmark Records**: additions / browsing history / time tracking.
- **Push & Analyze**: GitHub sync, data-package push, Markdown document management, and AI analysis rules.

### Data & Privacy
- **Local Storage by Default**: Core states are stored locally in browser storage (no dedicated backend service).
- **Optional GitHub Cloud Sync**: Supports uploading/downloading your data and documents to your personal GitHub repository.
- Permissions include bookmarks/history/tabs to support full functionality.
- Favicons may be loaded from the browser's built-in favicon service or public favicon providers, then persisted in local cache.
- For more details, please refer to our [Privacy Policy (`PRIVACY_POLICY.md`)](PRIVACY_POLICY.md)

### Docs
- [`docs/other docs/RECOMMEND_POOLS_V6_2.md`](docs/other%20docs/RECOMMEND_POOLS_V6_2.md): recommendation pool model and flow rules (v6.2)

---

## License

GPL-3.0

## [Back to top ](#switch-to-english)
