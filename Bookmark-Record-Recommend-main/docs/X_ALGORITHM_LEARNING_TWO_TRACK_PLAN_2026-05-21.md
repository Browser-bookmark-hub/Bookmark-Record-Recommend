# 向 X/Grok 推荐算法学习的两线改造计划

状态：精简计划稿  
日期：2026-05-21  
范围：`Bookmark-Record-Recommend`  
参考项目：`/Users/kk/Downloads/ 参考/x-algorithm-main`

---

## 0. 结论

从 X/Grok 推荐系统里只学最适合本项目的精华：

> 先判断用户意图；再用统一 bookmarkId 在推荐包、记录包、原生书签树之间定位同一个书签。

当前导出的 JSON 已经有“缩影”：`bookmark-recommend.json`、`bookmark-record.json`、`bookmarks-tree.json` 用同一套书签 ID 串起来。  
所以本轮不应该新建复杂搜索索引，也不应该在导出阶段硬过滤数据。  
本轮只做 **两项 `AGENTS.md` 约束改造** 和 **两项最小代码改造**。

---

## 1. 从参考项目学到的最精华部分

X/Grok 的推荐管线大致是：

```text
Query Context -> Candidate Sources -> Filters -> Scorers -> Selector
```

对本项目最有价值的不是大模型本身，而是两个思想：

1. **用户意图先行**：找东西、聊天、复盘、推荐、清理不是同一种任务。
2. **候选要有主键**：先在 signals 里找到候选，再用 `bookmarkId/id` 去记录包和原生书签树核验。

映射到本项目：

- `AGENTS.md` 负责告诉 AI：什么时候简单回答，什么时候生成文件，以及如何用 ID 贯通三类包。
- 代码负责保证导出的 JSON 字段稳定、ID 一致、signals 足够作为候选缩影。

---

## 2. 本轮只改两项约束文件

### 2.1 约束一：用户意图优先 + 生成文件条件

目的：避免 `AGENTS.md` 规则太多，冲淡用户当前意图。

建议写进 `AGENTS.md`：

```md
## 用户当前意图优先
先完成用户当前明确提出的目标。不要因为本规则中存在推荐、复盘、网络搜索或候选排序流程，就扩展任务范围。

- 普通交流、想法讨论、单次查找、轻量问答：直接回答，不写结果文件，除非用户明确要求保存。
- 明确关键词、URL、域名、文件夹、bookmarkId、时间范围：先做定向查找或定向分析。
- 系统性分析、周期复盘、模糊推荐、清理建议：再启用推荐分析流程。

## 结果文件生成条件
- 只有当用户明确要求生成报告/分析结果，或请求属于系统性分析、周期复盘、模糊推荐、清理建议时，才写 `ai/results/**.md`。
- 普通交流、单次查找和轻量问答不写文件。
- 一旦写文件，必须遵守输出路径白名单和 Markdown 格式要求。
```

必须保留的判断：

| 用户请求 | 是否生成文件 |
|---|---|
| 普通交流 / 问“你怎么看” | 不生成 |
| 精准查找某个书签 | 默认不生成 |
| 简单推荐几个 | 默认不生成，除非用户要求保存 |
| “分析一下 / 总结一下 / 复盘一下” | 生成 |
| 日报 / 周报 / 月报 | 生成 |
| 清理、屏蔽、系统性推荐 | 生成 |

### 2.2 约束二：复杂任务才启用推荐分析流程

目的：保留 X/Grok 的管线思想，但只在复杂任务触发。

建议写进 `AGENTS.md`：

```md
## 推荐分析流程（仅复杂任务触发）
当用户请求系统性分析、周期复盘、模糊推荐或清理建议时，按：
用户意图 -> 候选召回 -> 过滤 -> 排序 -> 输出解释

过滤是硬约束：`recommend_blocked` 中的书签、文件夹、域名永远排除；网络搜索不能覆盖本地屏蔽规则。

每条推荐至少说明：bookmarkId、标题链接、文件夹路径、命中的本地信号。
```

这段不要写太长。  
`AGENTS.md` 只放短规则，详细解释留在 docs。

---

## 3. 本轮只改两项代码

### 3.1 代码一：明确并校验 ID 贯通关系

当前导出示例已经显示同一个书签 ID 会出现在多处：

- `bookmark-recommend.data.recommendPool.recommend_scores_cache[bookmarkId]`
- `bookmark-recommend.data.signals.*.items[].id`
- `bookmark-record.data.signals.*.items[].id` 或 `bookmarkId`
- `data/raw-native/bookmarks-tree.json.data.records[].id`
- `data/raw-native/history-visits.jsonl` 的 `bookmarkId`

代码侧本轮不新建复杂搜索索引，只做最小保障：

1. 确认导出的 signals 候选都带稳定 `id`。
2. 确认 raw-native 书签树 `records` 可用 `id` 查回标题、URL、路径、父级。
3. 如发现字段命名混用 `id/bookmarkId`，在导出 meta 或文档里说明等价关系。

收益：AI 可以拿一个 ID 在三类包里追踪同一个书签，不需要重新建立大索引。

### 3.2 代码二：只补“提示”，不硬过滤导出数据

不建议在导出阶段删除重复或过滤数据。重复、同域名聚集、屏蔽状态本身也是事实信号。  
代码侧只考虑补轻量提示，或者先只在文档中约束 AI 使用现有字段。

可选 hints：

- `blockedSummary`：已有，继续作为硬约束入口。
- `sameUrlHints`：同 URL 多条时只标注，不删除。
- `sameDomainClusters`：同域名聚集只标注，不删除。
- `lowInfoHints`：标题/URL 信息不足只标注，不删除。

原则：

1. 导出保留事实，不在导出阶段硬删。
2. AI 分析时按用户任务决定是否去重、降权或忽略。
3. 屏蔽是硬约束；重复/聚集只是提示。
4. 本轮不做复杂 embedding、ANN、重模型。

收益：既保留完整事实，又能让 AI 更容易做候选去重和解释。

---

## 4. 暂不做的事

本轮不做：

- 不上 embedding / ANN。
- 不做完整推荐框架重构。
- 不把 X/Grok 复杂说明塞进 `AGENTS.md`。
- 不改所有推荐算法，只先明确 ID 贯通和可选 hints。
- 不默认让普通交流生成 `ai/results` 文件。

---

## 5. 落地顺序

1. 改 `AGENTS.md` 模板：用户意图优先 + 生成文件条件。
2. 改 `AGENTS.md` 模板：明确用 `bookmarkId/id` 贯通推荐包、记录包、原生书签树。
3. 代码核对导出 signals 是否稳定带 ID，并说明 `id/bookmarkId` 等价关系。
4. 如确实需要，再补轻量 duplicate/domain hints；不硬过滤导出数据。

---

## 6. 验收

`AGENTS.md`：

- 普通交流不生成文件。
- 精准查找不跑复杂推荐流程。
- 系统性分析才生成 `ai/results`。
- 屏蔽、路径、格式规则始终生效。

代码：

- 导出的 signals 候选都有可追踪 `id`。
- 同一 `bookmarkId/id` 能查回推荐分、点击/新增记录、原生书签树路径。
- `id` 与 `bookmarkId` 的关系在约束或 meta 中说明清楚。
- 不在导出阶段删除重复数据。
- 如加入 duplicate/domain hints，也只作为提示，不改变事实包。
