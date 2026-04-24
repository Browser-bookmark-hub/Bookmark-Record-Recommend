# AI 同步 · AGENTS.md 与分析能力补全（讨论稿）

状态：讨论稿  
日期：2026-04-19  
范围：仅当前项目 `Bookmark-Record-Recommend`  
前置计划：`doc/AI_SYNC_PUSH_PULL_PLAN_2026-04-18.md`（Push/Pull 骨架已落地）

---

## 0. 一句话结论

让 `AGENTS.md` **既是规则文件、也是可在同步页 MD 渲染器里查看和编辑的一等文档**；在此基础上，把"按时间分析（日/周/月）"、"用户视角书签问答"、"推荐算法调优"三类 AI 能力一次性规划好，并补齐当前数据桶的两处缺口（**当前激活模式** 与 **时间排行**）。

本稿不锁死实现细节，只收敛方向与决策点，供下一轮讨论。

---

## 1. 问题起点（本轮讨论输入）

1. `AGENTS.md` 不应只是后台规则文件，应暴露到同步页 MD 渲染器里，作为一份可查看、可编辑的索引。
2. AI 分析需要明确的时间维度：每日 / 每周 / 每月。
3. 书签推荐算法：需要调研网络上成熟做法，结合本项目数据与用户特色。
4. 用户视角：用户看到一个书签，想知道"**当天我做了什么具体内容 → 所在文件夹 → 路径 → 上下文 → 相关网络新闻**"。
5. 需要判断"对用户来说什么最重要"——特别是"**待复习 = 用户提前标注过的重点**"这个强信号必须被 AI 优先利用。
6. 当前 6 个推送桶到底装了什么，对照用户关心的清单有没有缺项？
7. 用户切换推荐模式（默认 / 考古 / 巩固 / 漫游 / 优先巩固）时，当前激活模式与对应参数值是否随同推送？

---

## 2. 数据桶完整性核对（v1 现状）

按用户本次点名清单逐项对照当前 `buildSyncPushPayload` 的实现（`history_html/history.js`）。

### 2.1 记录类（主要在 `bookmarkRecords` 包）

| 用户关心项 | 当前推送字段 | 所在包 | 状态 |
|---|---|---|---|
| 书签添加记录 | `additionsRecords` | bookmarkRecords | ✅ |
| 点击/浏览记录 | `clickRecords.rows` | bookmarkRecords | ✅ |
| 点击排行 | `clickRanking.items`（上限 300） | bookmarkRecords | ✅ |
| 关联记录 | `relatedRecords.snapshots`（最近 5 份 × 每份 160 条） | bookmarkRecords | ✅ |
| 时间捕捉统计 | `trackingStats` + `trackingDailyStatsV1` | timeTracking | ✅ |
| **时间排行** | —— | —— | ❌ **未独立提供**，只给原始 trackingStats，AI 需自行派生 |

### 2.2 推荐类（`recommendPool` + `recommendEvents`）

| 用户关心项 | 当前推送字段 | 所在包 | 状态 |
|---|---|---|---|
| S 计算池（全量分值） | `recommend_scores_cache` | recommendPool | ✅ |
| 当前候选卡片 | `historyCurrentCards` | recommendPool | ✅ |
| 池游标 | `bb_recommend_pool_cursor_v1` | recommendPool | ✅ |
| 推荐公式配置（权重/阈值） | `recommendFormulaConfig` | recommendPool | ✅ |
| 段落顺序 / 刷新设置 | `recommendSectionOrder` / `recommendRefreshSettings` | recommendPool | ✅ |
| **当前激活模式**（default/archaeology/consolidate/wander/priority） | —— | —— | ❌ **未推送**。仅存在于内存变量 `currentRecommendMode`（history.js:17924），从未序列化到 storage 或 payload |
| **各模式参数预设快照** | —— | —— | ❌ **未推送**。模式切换只改运行时行为，未写成可读 config |
| 待复习卡片 | `recommend_reviews` + `recommend_postponed` + 版本号 | recommendEvents | ✅ |
| 屏蔽卡片 | `recommend_blocked` | recommendEvents | ✅ |
| 跳过卡片 | `recommend_skipped_bookmarks_v1` | recommendEvents | ✅ |
| 翻牌历史 | `flipHistory`（上限 2000）+ `flippedBookmarks` | recommendEvents | ✅ |
| 复习热力图日索引 | `flipHistoryDailyIndexV1` | recommendEvents | ✅ |

### 2.3 其他包

| 项 | 字段 | 状态 |
|---|---|---|
| 书签树快照 | `bookmarkTreeSnapshot`（含文件夹层级） | ✅ |
| 高体量原始包（可选关） | `additionsCacheRaw` / `browsingHistoryCacheRaw` / `flipHistoryRaw`（上限 4000） | ✅ |

### 2.4 结论：当前缺口两条

- **缺口 A（重要）**：推荐"当前激活模式 + 各模式参数值"没进推送。AI 无法区分"这是用户在考古模式下的行为"还是"默认模式下的行为"，所有分析都会被模式混淆。
- **缺口 B（次要）**：时间排行没有单独预计算字段。AI 可从 `trackingStats` 自己派生，但给一份"composite / wakes 双口径 ranking"更省算力、且与 UI 口径一致。

本计划 §5 给出补齐方案。

---

## 3. AGENTS.md 的双重角色（核心设计）

### 3.1 现状

前置计划 §4 约定 `AGENTS.md` 放在 `bookmark_record_and_recommend_sync/AGENTS.md`，只作为"给 AI 看的规则"。当前代码里**既没有写入逻辑、也没有在 MD 渲染器里暴露**。

### 3.2 本稿主张

`AGENTS.md` 应当是**一等的、用户可见可编辑的索引文档**，理由：

1. 它定义了 AI 读什么、写什么、怎么写——用户有必要随时查看与修改。
2. 它本身就是"规则 + 分析模板 + 重要性权重说明"的载体，是用户表达"我希望 AI 怎么看我"的最主要入口。
3. 用户不该为了调整规则去改代码或改存储，应当就在 MD 渲染器里改。

### 3.3 具体做法

1. 在 `syncFileList` 列表里**固定置顶一个"AGENTS.md（规则）"条目**，与 `latest.md` / `runs/...` 同级。
2. 首次进入同步页时，如远端不存在 `AGENTS.md`，由扩展显示内置默认模板；下一次推送写入固定 `AGENTS.md`。
3. 点击后进入**只读渲染**；勾选"编辑模式"后可改；保存走 `syncGitHubPutFile` 推到 `AGENTS.md`。
4. 编辑保存**不受"推送数据包勾选"影响**，属于独立写入路径。
5. 拉取时，`AGENTS.md` 与 `latest.md` / `runs/...` 一同枚举，保留本地已编辑开关同样生效。

### 3.4 AGENTS.md 模板草案（v0）

参考通用 `AGENTS.md` 惯例，建议最小字段：

```md
# AGENTS.md — Bookmark Record and Recommend AI 规则

## 1. 身份与目标
我是 {{user_handle}} 的书签助理。目标是：
- 按日/周/月总结我的阅读活动
- 基于 S 计算池给出值得打开/值得复习/可屏蔽的建议
- 当我点开某个书签时，能还原它的上下文

## 2. 可读输入（路径白名单）
- data/latest.json          # 6 个数据桶的当前快照
- data/snapshots/...         # 历史快照
- AGENTS.md          # 本文件

## 3. 必写输出(路径白名单)
- ai/results/latest.md                       # 覆盖写
- ai/results/runs/<YYYY-MM-DD>/<HHmmss>.md   # 追加写（可选）
- ai/results/daily/<YYYY-MM-DD>.md           # 日报
- ai/results/weekly/<YYYY-Www>.md            # 周报
- ai/results/monthly/<YYYY-MM>.md            # 月报

## 4. 重要性权重（我对"重要"的定义）
1. 待复习（recommend_reviews / recommend_postponed）= 最高优先级，
   因为这是我提前标注过的"我喜欢这类内容"的强信号。
2. 高频点击 + 长时间捕捉 的书签 = 次高。
3. 近 7 天新加但未打开 = 需要提醒。
4. 屏蔽（recommend_blocked）= 永远排除。

## 5. 输出模板
（见本计划 §6 的 daily/weekly/monthly 模板）

## 6. 风格与禁忌
- 只输出 Markdown；不嵌入脚本/iframe。
- 引用书签时给出：标题、所在文件夹路径、bookmarkId。
- 不泄露 Token/Owner/Repo 等同步配置字段。
```

**未决**：`AGENTS.md` 是否要支持"多身份"（同一人不同 Profile）？本轮先不做，单文件即可。

---

## 4. 分析维度：日 / 周 / 月（AI 产出分层）

### 4.1 三层产出文件

| 层级 | 路径 | 覆盖策略 | 目的 |
|---|---|---|---|
| 即时 | `ai/results/latest.md` | 始终覆盖 | 打开扩展首屏看到的"现在该干嘛" |
| 日 | `ai/results/daily/<YYYY-MM-DD>.md` | 按日写一份 | 复盘昨天 / 当天阅读 |
| 周 | `ai/results/weekly/<YYYY-Www>.md` | 按 ISO 周写一份 | 主题聚类、趋势、待复习清单 |
| 月 | `ai/results/monthly/<YYYY-MM>.md` | 按月写一份 | 长期兴趣迁移、冷热变化、屏蔽回顾 |

### 4.2 日报模板草案

```md
# Daily — 2026-04-19
## 今天打开了什么
- (bookmarkId) 标题 — 文件夹路径 — 停留 X 分钟
## 今天新加了什么
## 触发待复习的
## 被跳过 / 屏蔽的
## 明天建议优先看
```

### 4.3 周报 / 月报模板

- 周报：主题聚类（从标题/文件夹路径派生标签）、本周 Top 10 停留时长、本周新加 vs 打开比率、下周复习清单。
- 月报：长期兴趣 shift（对比上月主题分布）、冷却中的旧爱好、持续投入的主题。

### 4.4 实现侧要点

- 这些路径统一写到 `AGENTS.md §3` 白名单里，AI 按约定写入，**扩展端只负责拉取与渲染**——不做本地汇总计算（避免与 AI 重复）。
- 文件列表支持按 `daily/` / `weekly/` / `monthly/` 分组折叠。

---

## 5. 推送数据桶补齐（对 §2.4 缺口的回应）

### 5.1 缺口 A：推荐模式 + 模式参数

**主张**：新增一个子字段 `recommendMode` 到 `recommendPool.data` 下：

```js
payload.packages.recommendPool.data.recommendMode = {
  activeMode: 'default' | 'archaeology' | 'consolidate' | 'wander' | 'priority',
  modePresets: {
    default:      { weights: {...}, thresholds: {...} },
    archaeology:  { weights: {...}, thresholds: {...} },
    consolidate:  { weights: {...}, thresholds: {...} },
    wander:       { weights: {...}, thresholds: {...} },
    priority:     { weights: {...}, thresholds: {...} }
  },
  // 当前生效的参数 = activeMode 对应的 preset 覆盖 recommendFormulaConfig
  effective: { weights: {...}, thresholds: {...} },
  lastSwitchAt: <timestamp>
};
```

落地步骤：
1. 把内存变量 `currentRecommendMode` 持久化到 `storage.local.recommendActiveMode`，同时记 `lastSwitchAt`。
2. 把 `applyPresetMode` 里硬编码的各模式参数抽成常量表 `RECOMMEND_MODE_PRESETS`。
3. 推送时读 storage + 常量表，组装 `recommendMode` 字段。

**未决**：是否记录最近 N 次"模式切换事件"（类似行为事件）？本轮先只推当前值，事件化留给后续。

### 5.2 缺口 B：时间排行

**主张**：在 `timeTracking.data` 下加一个 `rankings` 字段，提供与 UI 小组件一致的两个口径：

```js
payload.packages.timeTracking.data.rankings = {
  composite: [{ bookmarkId, title, folderPath, totalMs, wakeCount, score }, ...Top 100],
  wakes:     [{ bookmarkId, title, folderPath, wakeCount }, ...Top 100],
  generatedAt, range: 'all'
};
```

复用现有 `trackingRanking` 计算逻辑，推送前调用一次。

### 5.3 其他小修正

- `timeTracking.data.widgetsLayoutOrder` 是纯 UI 偏好，与前置计划 §6.7"禁推 UI 偏好"有冲突——建议**移除**。
- 推送 schema 版本号从 `v2` 升至 `v3`（因为加了 `recommendMode` 与 `rankings`）。

---

## 6. 用户视角问答：围绕"一个书签"的上下文还原（数据层）

用户点开某个书签时，希望能回答：

1. **"我当天对它做了什么"**：打开次数、停留时长、是否加待复习、是否复习过。
2. **"它在哪"**：书签树路径（从根目录到叶节点），同文件夹下的兄弟书签。
3. **"它的上下文"**：同一时间窗内打开的其他书签（关联记录）、最近 7 天与它一起被点过的书签。
4. **"外部相关"**：相关网络新闻 / 博文。

### 6.1 分工原则（本轮修订）

**扩展端不做本地组装，也不新增 UI。** 这四类问题全部由云端 AI 回答——本项目已确立的分工：**扩展 = 管道，云端 AI = 大脑**。

扩展端要做的只有一件事：**确保推到云端的 JSON 里包含 AI 回答这些问题所需的所有原子数据**。下表核对当前 payload（schema v3）是否已覆盖：

| 问题 | 所需字段 | 是否已推 |
|---|---|---|
| 当天操作 | `bookmarkRecords.clickRecords.rows`（按日期切片）+ `recommendEvents.flipHistory` | ✅ |
| 所在路径 / 兄弟书签 | `bookmarkTreeSnapshot.data.records`（含 `parentId` / `ancestorFolderIds` / `path`） | ✅ |
| 同时段书签 | `bookmarkRecords.relatedRecords.snapshots` + `clickRecords.rows` 时间戳 | ✅ |
| 待复习相似推荐 | `recommendEvents.recommend_reviews_similar`（扩展端在推送时预计算） | ✅（P6 已落地） |
| 外部新闻 | 由 AI 端自身联网能力完成 | —（不在扩展职责内） |

结论：无 UI 侧工作。若将来 AI 告诉我们"缺某个聚合维度"，再在 payload 里补一个字段——**永远以数据字段为出口，不以 UI 为出口**。

### 6.2 重要性权重——"待复习 = 重点"如何落到 AI 提示里

用户明确：待复习是用户提前标注过的高价值信号。落地：

1. 在 `AGENTS.md §4` 把"待复习 > 高频+长时长 > 新加未开 > 其他"写成硬规则（已写入模板）。
2. `recommend_reviews_similar` 预计算字段已在 P6 加入 payload，AI 直接用。
3. AI 生成 `latest.md` 时默认把"待复习相关推荐"放在最顶部——由 AGENTS.md 约束，不在扩展端实现。

---

## 7. 推荐算法调优：调研方向（不锁结论）

用户要求"看看网络上有哪些好的推荐算法，结合推送到云端的数据"。本稿**不直接给算法选型**，只列出需要下一轮对齐的调研问题：

1. **基于内容的相似**（TF-IDF / BM25 / embedding 相似）：适合"你标了待复习 A → 推相似的 B"。需要向量化书签标题+文件夹路径。embedding 放扩展端做还是 AI 端做？
2. **协同信号**：本项目是单用户，没有其他用户协同数据，传统 CF 不适用。但"同一用户的时间相邻共现"（session-based）可用。
3. **冷启动**：新加书签没有点击数据，当前 S 公式靠 `freshness` 兜底，是否够？
4. **遗忘曲线**：当前已有 `thresholdForgetting`，是否按 Ebbinghaus 曲线细化？
5. **多样性 / 探索**：漫游模式是一种 epsilon-greedy，是否加 MMR（Maximal Marginal Relevance）避免推荐同质化？

**输出形式**：下一轮讨论定下 2-3 个要引入的机制，再开子计划书。

---

## 8. MD 渲染器安全强化（承接前置计划 §5.2 未做项）

现状：`renderSyncMarkdown` 直接 `marked.parse(markdown)`，未做净化——AI 或人误写 `<script>` 可直接执行。

主张（最小代价）：
1. 引入 `DOMPurify`（或等价白名单净化）作为 vendor 脚本。
2. 渲染链路改为 `DOMPurify.sanitize(marked.parse(md), { ALLOWED_TAGS: [...], ALLOWED_ATTR: [...] })`。
3. 允许：标题、段落、列表、表格、代码块、链接、图片；禁止：`script` / `iframe` / `style` / `on*` 事件属性 / `javascript:` URL。
4. 外链强制 `target=_blank` + `rel=noopener noreferrer`。

**未决**：是否允许引用站内页面的相对链接（例如跳到另一份 `daily/*.md`）？建议允许以 `./` 开头的站内相对路径。

---

## 9. 分阶段落地建议

| 阶段 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| P1 | 数据桶补齐：§5.1 模式 + §5.2 时间排行 + §5.3 schema v3 | 无 | ✅ 已落地 |
| P2 | AGENTS.md 暴露到文件列表 + 首次生成模板 + 编辑保存 | P1 | ✅ 已落地 |
| P3 | MD 渲染器 DOMPurify 净化（§8） | 无 | ✅ 已落地 |
| P4 | 日/周/月三层产出路径约定 + 文件列表分组折叠 | P2 | ✅ 已落地 |
| ~~P5~~ | ~~书签上下文卡~~ | — | ❌ 已取消（违反"扩展=管道"分工） |
| P6 | `recommend_reviews_similar` 预计算（§6.2 第 2 点） | P1 | ✅ 已落地 |
| P7 | 推荐算法调优（§7，开子计划书） | 讨论后再启 | 🕐 待讨论 |

---

## 10. 未决项（下一轮重点讨论）

1. AGENTS.md 是否支持多身份 / 多 Profile？（本轮倾向：不支持）
2. 日/周/月报是否允许用户在扩展里**触发 AI 重算**？还是只做"展示 AI 已写好的结果"？
3. `modePresets` 是硬编码常量还是用户可改？（倾向：常量先行，后续再开暴露）
4. 外部新闻：是否最终确认"扩展端不主动发网络请求"这条红线？（倾向：是）
5. DOMPurify 体积（约 22KB 压缩）对扩展包大小影响是否可接受？（已按可接受落地）
6. Schema 版本升级到 v3 后，AI 端按当前 schema 重新读取，不设计历史兼容层。

---

## 11. 本轮验收目标（讨论稿阶段）

1. 确认 AGENTS.md"规则 + 可编辑索引"的双重角色。
2. 确认数据桶两处缺口（模式 / 时间排行）的补齐方向。
3. 确认"待复习 = 重点"写进 AGENTS.md §4 的重要性排序。
4. 确认 daily / weekly / monthly 三层产出路径。
5. 确认分工红线：**扩展 = 管道，云端 AI = 大脑**；所有上下文还原 / 关联分析 / 外部检索一律由 AI 端完成，扩展端不做本地组装 UI。
6. 确认 MD 渲染器走 DOMPurify 净化路线。
7. 冻结未决项清单（§10），留待下一轮逐条讨论。
