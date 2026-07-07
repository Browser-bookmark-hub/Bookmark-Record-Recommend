# AI 同步数据包重构计划（2026-04-25）

状态：执行版（v3，三包正式版）
日期：2026-04-25
范围：仅 `Bookmark-Record-Recommend` 同步导出结构与同步页 UI

## 1. 目标与结论

本次重构目标：
1. 将同步页从当前工程包收敛为用户可理解的 3 个正式包。
2. 保留当前已经可用的数据采集逻辑，不先重写推荐、记录、时间捕捉等核心采集。
3. 移除旧 `latest.json/current.json` 入口，新入口固定为 `data/manifest.json`。
4. 让 GitHub 上的文件变更天然可读：AI 通过 commits/compare 分析变化，不由插件生成本地变化摘要。
5. 让 `AGENTS.md` 成为产品文件夹固定规则文件：缺失时推送默认模板，不做其他规则文件名兼容。

一句话结论：
从“单体快照 + 6 个工程包”升级为“实时事实源采集 + 导出 adapter + 多文件事实包 + manifest 索引 + GitHub diff 分析”。

---

## 2. 当前代码现状（冻结）

当前实现不是空白重构，必须尊重以下事实：

1. 同步页 UI 曾直接暴露多个工程勾选项：
   - `recommendPool`
   - `recommendEvents`
   - `bookmarkRecords`
   - `timeTracking`
   - `bookmarkTreeSnapshot`
2. `collectSyncPushPayload(config)` 当前已能收集较完整的数据：
   - 推荐池、推荐行为、当前推荐模式、模式预设
   - 新增记录、点击记录、点击排行、关联记录
   - 时间捕捉统计与排行
   - 书签树快照
3. GitHub 推送当前使用 Contents API 逐文件 `PUT /contents/...`，一次用户推送会生成多个 commit，而不是一个 commit。
4. 当前 `AGENTS.md` 按产品文件夹固定文件处理：
   - 推送时必须写入 `AGENTS.md`
   - 拉取时只读取 `AGENTS.md`
5. 当前 `buildBookmarkTreeSnapshot()` 并不总是 Chrome Bookmarks API 原生树：
   - 优先从缓存/内存读取
   - 输出的是扁平 records，不是完整原生 tree

结论：本计划不应先重写采集层，而应先加“导出结构 adapter”，把现有 payload 拆成 AI 更好读的文件。

---

## 3. 明确不做：不生成本地变化摘要

本计划不新增 `data/delta/latest.json` 或任何“本次变化摘要”文件。

理由：
1. 变化判断交给 GitHub commit / compare，这是当前 AI 分析链路的一部分。
2. 插件侧只负责稳定推送事实数据，不在本地预判哪些变化重要。
3. 避免同一事实同时存在“原始文件 + 变化摘要”两套口径，造成 AI 解释冲突。

AI 的变化分析流程应为：
1. 读 `AGENTS.md` 获取规则。
2. 读 `data/manifest.json` 获取本次可用文件。
3. 通过 GitHub commits/compare 获取变化。
4. 需要正文时再读业务包或 raw-native。

---

## 4. 目标包模型（用户视角 3 包）

同步页包选择收敛为 3 个正式包：

1. 书签记录包（默认开）
2. 书签推荐包（默认开）
3. 原生真相源包（默认开）

内部数据到用户包映射：

| 用户包 | 当前内部数据来源 | 说明 |
|---|---|---|
| 书签记录包 | `bookmarkRecords` + `timeTracking` | 新增、点击、点击排行、关联记录、当前时间排行与时间屏蔽状态 |
| 书签推荐包 | `recommendPool` + `recommendEvents` | S 分数池、候选池、推荐模式、复习、屏蔽、跳过、翻卡事件 |
| 原生真相源包 | `bookmarkTreeSnapshot` + history visits 导出 | 书签树与浏览历史事实源，分阶段向真正 API 原生格式靠拢 |

实现原则：
1. UI 显示 3 个正式包，配置层直接使用当前包选择 key。
2. 导出层把当前 payload 拆为同步文件。
3. 内部字段只作为包内 `sourcePackages` 溯源标记，不提供旧入口文件。
4. 同步配置只保存 `bookmarkRecord`、`bookmarkRecommend`、`rawNative` 三个用户包键；内部采集项只在推送前临时展开，不作为兼容配置保存。

---

## 5. 目标目录结构

同步范围固定为产品文件夹，不再使用 `sync` 云端子目录。

```text
书签记录与推荐/ 或 Bookmark Record and Recommend/
|-- AGENTS.md                                  [PUSH]
|-- data/
|   |-- manifest.json                          [PUSH]  # AI 入口索引，不是正文
|   |-- packages/
|   |   |-- bookmark-record.json               [PUSH]
|   |   \-- bookmark-recommend.json            [PUSH]
|   \-- raw-native/
|       |-- bookmarks-tree.json                [PUSH]
|       \-- history-visits.jsonl               [PUSH]
|-- ai/
|   |-- input-docs/index.json                  [PUSH]
|   |-- input-docs/*.md                        [PUSH]
|   \-- results/**/*.md                        [PULL]
\-- meta/
    \-- sync_state.json                        [PUSH]
```

不新增 `data/delta/`。变化分析只依赖 GitHub。

---

## 6. Manifest 规范

`data/manifest.json` 只做入口索引，不放正文、不放变化摘要。

示例：

```json
{
  "schema": "bookmark_record_and_recommend.sync-manifest.v1",
  "pushId": "2026-04-25_203011",
  "snapshotId": "2026-04-25T12-30-22Z_8f2c",
  "generatedAt": 1777081822000,
  "generatedAtText": "2026-04-25 20:30:11",
  "writeMode": "github-contents-api-multi-commit",
  "packageSelection": {
    "bookmarkRecord": true,
    "bookmarkRecommend": true,
    "rawNative": true
  },
  "files": [
    {
      "role": "bookmark-record",
      "path": "data/packages/bookmark-record.json",
      "schema": "bookmark_record_and_recommend.bookmark-record.v1",
      "sha256": "<hash>",
      "records": 1234
    },
    {
      "role": "bookmark-recommend",
      "path": "data/packages/bookmark-recommend.json",
      "schema": "bookmark_record_and_recommend.bookmark-recommend.v1",
      "sha256": "<hash>",
      "records": 456
    },
    {
      "role": "raw-native-history",
      "path": "data/raw-native/history-visits.jsonl",
      "schema": "bookmark_record_and_recommend.history-visits-jsonl.v1",
      "sha256": "<hash>",
      "records": 5678,
      "truncated": true,
      "limit": 50000
    }
  ],
  "readOrder": [
    "data/packages/bookmark-record.json",
    "data/packages/bookmark-recommend.json",
    "data/raw-native/bookmarks-tree.json",
    "data/raw-native/history-visits.jsonl"
  ]
}
```

约束：
1. `manifest.json` 最后写入。
2. 所有正文文件先写，manifest 最后写，便于 AI 判断入口是否完整。
3. `pushId` 必须同时进入 manifest、meta、commit message，方便 AI 聚合一次用户推送产生的多个 commits。
4. `writeMode` Phase A 标记为 `github-contents-api-multi-commit`，后续如改成单 commit 再升级。

---

## 7. 业务包结构建议

### 7.1 `data/packages/bookmark-record.json`

来源：当前 `payload.packages.bookmarkRecords` + `payload.packages.timeTracking`。

建议结构：

```json
{
  "schema": "bookmark_record_and_recommend.bookmark-record.v1",
  "pushId": "<same-as-manifest>",
  "generatedAt": 1777081822000,
  "summary": {
    "additionsCount": 123,
    "clickRecordCount": 456,
    "clickRankingCount": 300,
    "relatedSnapshotCount": 5,
    "activeClickDateCount": 30,
    "recentClickItemCount": 120,
    "unopenedAdditionsCount": 18,
    "recentUnopenedAdditionsCount": 7,
    "topClickedDomainCount": 12,
    "hasTimeRanking": true,
    "rankingRange": "all",
    "trackingBlockedCount": 3,
    "compositeRankingCount": 100
  },
  "data": {
    "additionsRecords": [],
    "clickRecords": { "rows": [] },
    "clickRanking": {},
    "relatedRecords": {},
    "signals": {
      "recentClicks": {},
      "unopenedAdditions": {},
      "recentUnopenedAdditions": {},
      "topClickedDomains": [],
      "topClickedFolders": [],
      "topAddedFolders": []
    },
    "timeTracking": {
      "trackingBlocked": {},
      "rankings": {}
    }
  },
  "sourcePackages": ["bookmarkRecords", "timeTracking"]
}
```

说明：
1. 先保留当前字段，避免 AI 规则和历史分析一次性断裂。
2. 仅把 `timeTracking` 的当前排行与屏蔽状态放进记录包，不单独作为用户包暴露；正在捕捉的活跃会话不进入推送包。
3. `signals` 只放低体量业务摘要，方便 AI 不解析全量 rows 也能判断最近点击、未打开新增、域名和文件夹热度。
4. 时间捕捉的屏蔽书签/文件夹/域名必须随 `timeTracking.trackingBlocked` 进入记录包，和用户在“时间捕捉”面板里看到的屏蔽管理一致。
5. `clickRecords` 与 `raw-native/history-visits.jsonl` 是“可匹配到当前书签的历史访问事实”，不是完整浏览器历史；必须显式携带 `source/matchMethods/limit/truncated` 等元信息。

### 7.2 `data/packages/bookmark-recommend.json`

来源：当前 `payload.packages.recommendPool` + `payload.packages.recommendEvents`。

建议结构：

```json
{
  "schema": "bookmark_record_and_recommend.bookmark-recommend.v1",
  "pushId": "<same-as-manifest>",
  "generatedAt": 1777081822000,
  "summary": {
    "scoreCount": 1234,
    "currentCardCount": 20,
    "hasPoolCursor": true,
    "activeMode": "default",
    "modeLastSwitchAt": 1777081822000,
    "recommendScoresTime": 1777081822000,
    "scoresReady": true,
    "scoresReadyMode": "existing",
    "templateScoreCount": 0,
    "templateScoreRatio": 0,
    "scoreLeaderCount": 80,
    "forceDueCurrentCardCount": 0,
    "reviewsCount": 12,
    "reviewsSimilarAvailable": true,
    "reviewsSimilarCount": 12,
    "reviewTargetCount": 12,
    "blockedCount": 3,
    "postponedCount": 4,
    "skippedCount": 5,
    "flippedBookmarksCount": 6,
    "flipHistoryCount": 2000
  },
  "data": {
    "recommendPool": {
      "scoreCacheMeta": {}
    },
    "recommendEvents": {},
    "signals": {
      "scoreLeaders": {},
      "currentCards": {},
      "reviewTargets": {},
      "postponedTargets": {},
      "blockedSummary": {},
      "recentFlipEvents": {}
    }
  },
  "sourcePackages": ["recommendPool", "recommendEvents"]
}
```

说明：
1. 推荐模式 `recommendMode.activeMode` 必须保留。
2. 待复习、屏蔽、跳过、翻卡事件必须同包，便于 AI 直接判断推荐优先级。
3. `recommend_reviews_similar` 已有价值，继续保留在推荐包。
4. `signals` 只提供候选 Top 列表、当前卡片、复习目标和事件摘要，不重新塞入高体量内部明细。
5. `scoreCacheMeta` 必须说明推荐分数缓存是否来自现有缓存、增量更新或 template 临时分；AI 输出时需要根据 `templateScoreRatio/staleMeta/ensureResult` 标注不确定性。
6. `recommend_reviews_similar_meta` 必须说明相似候选是否生成、数据来源和跳过原因；不能把 null 解释为“没有相似书签”。

### 7.3 `data/raw-native/bookmarks-tree.json`

Phase A：
1. 推送/导出时优先实时调用 Chrome Bookmarks API。
2. 必须明确 `source`：
   - `bookmarks_api`
   - `cache_storage`（仅 API 不可用时回退）
   - `cache_memory`（仅 API 不可用时回退）
   - `unavailable`
3. 文件名可先使用 `bookmarks-tree.json`，但内容标注 `format: "flattened-records"`，避免误导 AI。

Phase B：
1. 改为直接导出 `chrome.bookmarks.getTree()` 原生树。
2. 扁平化 records 移到 `bookmark-record.json`。
3. `format` 改为 `chrome-bookmarks-getTree`.

### 7.4 `data/raw-native/history-visits.jsonl`

每行一条 JSON，建议包含：

```json
{"url":"https://example.com","title":"Example","visitTime":1777081822000,"visitCount":3,"typedCount":0,"source":"chrome.history.search"}
```

约束：
1. 必须有单次导出上限。
2. manifest 中必须标注 `truncated` 与 `limit`。
3. 推送/导出时优先实时调用 `chrome.history.search + getVisits`，缓存只作为 API 不可用时的回退。
4. 如果数据来自缓存而非 Chrome History API，必须在每行或文件 header 中标注 `source`。

---

## 8. GitHub commit / compare 策略

由于当前 GitHub 写入使用 Contents API 逐文件 PUT，一次推送会产生多个 commit。
因此 `AGENTS.md` 里的“比较最新 commit 与上一个 commit”必须改为“按 pushId 聚合一组 commits”。

Phase A 推荐策略：
1. 每次用户点击推送生成一个 `pushId`。
2. 所有文件 commit message 使用同一前缀：

```text
[sync:<pushId>] update data/packages/bookmark-record
[sync:<pushId>] update data/packages/bookmark-recommend
[sync:<pushId>] update data/manifest
```

3. AI 读取最近 commits 时，按 `pushId` 聚合。
4. 对同一 `pushId` 的 commit group：
   - group start = 最早一个 commit
   - group end = 最晚一个 commit
   - compare base = group start 的 parent
   - compare head = group end
5. AI 再从 compare 结果里看哪些业务文件变化。

Phase B 可选增强：
1. 从 GitHub Contents API 切换到 Git Data API。
2. 一次创建 tree + commit。
3. 一次用户推送只生成一个 commit。

当前阶段建议先做 Phase A，不强制切换 Git API。

---

## 9. AGENTS.md 调整（根目录固定）

目标行为：
1. 文件位置固定在产品文件夹下的 `AGENTS.md`。
2. 规则文件固定为 `AGENTS.md`。
3. 若用户未编辑规则，推送时使用内置默认规则模板写入固定路径。

当前代码需要调整：
1. `normalizeSyncDocs()` 将规则文件统一归一为 `AGENTS.md`。
2. UI 可以显示“默认规则预览”。
3. 用户编辑规则内容时，仍写入固定的 `AGENTS.md`。
4. 推送时必须写入产品文件夹下的 `AGENTS.md`。
5. 拉取时只读取产品文件夹下的 `AGENTS.md`。
6. 不支持其他规则文件名别名。

建议写入 AGENTS.md 的核心规则：
1. 先读 `data/manifest.json`。
2. 默认按 manifest 的 `readOrder` 读取业务包。
3. 需要核验事实时再读 `data/raw-native/*.json*`。
4. 变化分析只使用 GitHub commits/compare，不要求插件提供本地变化摘要。
5. 当前如果是多 commit 写入，必须按 `pushId` 聚合 commits 后再 compare。
6. 不输出 Token / Owner / Repo 等同步配置字段。
7. 结果只写入 `ai/results/**/*.md`。

---

## 10. 同步页 UI 改造方案

### 10.1 包选择区：工程项收敛为 3 项

现状 UI：
1. 推荐数据池
2. 推荐行为事件
3. 书签记录综合包
4. 时间捕捉包
5. 书签树快照包

目标 UI：
1. 书签记录包（新增/点击/排行/关联/当前时间排行）
2. 书签推荐包（S 池/候选/复习/屏蔽/跳过/翻卡）
3. 原生真相源包（书签树/浏览历史事实源）

落地方式：
1. Phase A 直接按当前 3 包选择口径读写。
2. `readSyncConfigFromUI()` 输出当前包选择 key。
3. `countEnabledSyncPackages()` 按 3 包口径显示数量。
4. i18n 文案改为用户视角，不再强调内部包名。

### 10.2 路径结构说明区

路径说明区改成目标目录结构，并明确：
1. `manifest.json` 是入口索引。
2. 业务正文在 `data/packages/`。
3. 原生/准原生事实源在 `data/raw-native/`。
4. GitHub commits/compare 是变化分析来源。
5. 不存在本地变化摘要文件。

### 10.3 文档区（AGENTS.md）

1. 首次无规则内容时显示默认规则预览。
2. 用户编辑规则内容后仍保存为固定 `AGENTS.md`。
3. 规则文件可编辑，但文件名固定。
4. Pull 时只读取远端固定 `AGENTS.md`。

---

## 11. 推送实现建议

新增统一导出 adapter：

```js
function buildSyncExportFiles(snapshot, repoConfig) {
  // 输入：当前 collectSyncPushPayload 产生的 snapshot
  // 输出：[{ path, text, role, message }]
}
```

这个函数同时服务：
1. GitHub 推送。
2. 本地 ZIP 导出。
3. 后续测试校验。

Phase A 实现步骤：
1. 保持 `collectSyncPushPayload(config)` 基本不动。
2. 在 `pushSyncSnapshotToGitHub()` 中不再手写 `latest/current` 文件列表，改为调用 `buildSyncExportFiles()`。
3. 在 `buildSyncLocalExportBundle()` 中也调用同一个 adapter，确保 GitHub 与本地导出结构一致。
4. adapter 输出新结构文件。
5. 不写旧结构：
   - 不写 `data/latest.json`
   - 不写 `data/snapshots/current.json`
6. GitHub 推送时主动删除远端残留旧结构文件。
7. manifest 最后加入 filesToPush，确保最后写入。

---

## 12. Pull 逻辑

当前 Pull 主要拉取 `ai/results/**/*.md` 和根目录规则文件。
这部分不需要读取数据包正文。

需要调整：
1. Pull 规则文件时只读产品文件夹下的 `AGENTS.md`。
2. 远端暂未生成 `AGENTS.md` 不视为 AI 结果拉取失败。
3. 仅拉取 AI 结果文档和固定规则文件。
4. 下一次 Push 会写入固定 `AGENTS.md`。

---

## 13. 实施阶段

### Phase A：导出 adapter 并行写

1. 同步推送/导出时，书签树与浏览历史优先实时调用 Chrome API。
2. 新增 `buildSyncExportFiles()`。
3. 写出新结构文件。
4. 不写旧 `latest.json/current.json`。
5. commit message 加同一 `pushId`。
6. AGENTS 模板改为 manifest + pushId + GitHub compare 规则。

### Phase B：UI 默认切换

1. UI 包选择区切为 3 项。
2. 不提供旧入口文件。
3. `AGENTS.md` 固定写入产品文件夹。
4. 路径说明区切换到新结构。
5. 不提供旧结构写入开关。

### Phase C：继续收敛

1. 清理不再使用的旧字段映射代码。
2. `raw-native/bookmarks-tree.json` 改为真正 `chrome.bookmarks.getTree()` 原生树。
3. 如有必要，评估 Git Data API 单 commit 推送。

---

## 14. 验收标准

1. 用户 UI 看到的是 3 个正式包，不再暴露工程包。
2. GitHub 推送后能看到：
   - `data/manifest.json`
   - `data/packages/bookmark-record.json`
   - `data/packages/bookmark-recommend.json`
   - `data/raw-native/bookmarks-tree.json`
   - `data/raw-native/history-visits.jsonl`
3. `manifest.json` 只包含索引、hash、count、readOrder、pushId，不包含正文和本地变化摘要。
4. 同一次推送产生的 commits 拥有相同 `pushId`，AI 可以聚合 compare。
5. `AGENTS.md` 固定写入产品文件夹，拉取也只读取这个固定文件。
6. 本地 ZIP 导出与 GitHub 推送文件结构一致。
7. 不生成 `latest.json/current.json`，且 GitHub 推送会删除远端旧残留。

---

## 15. 待确认项

1. `history-visits.jsonl` 单次导出上限：当前沿用历史读取上限，manifest 中标注 `limit/truncated`；记录包 `clickRecords.meta` 标注匹配方式和是否来自缓存。
2. Phase A 是否只做 pushId 多 commit 聚合，不切 Git Data API：建议是。
3. 规则文件名不允许改名；产品文件夹只使用 `AGENTS.md`。
