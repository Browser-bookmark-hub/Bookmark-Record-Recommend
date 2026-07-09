# 版本更新日志

整理基准：2026-07-08  
当前扩展版本：`0.4.5`

本文件根据当前 README、manifest、CodeGraph 和代码搜索整理。历史计划中的版本号和状态未逐条采信。

## v0.4.5

本节汇总 `0.3.9(3)` 之后到当前版本的主要变化。

- 浏览历史持久化升级：
  - 浏览记录链路从依赖浏览器 History API 的即时查询，迁移到本地持久缓存与维护桶。
  - 点击历史可突破原先约 90 天窗口；同步、删除、迁移和修复逻辑也随之重构。
  - 相关主线提交包括 `f62a074`、`6d4a765` 及后续修补。
- 导出生态与书签画布兼容：
  - 扩展点击排行、关联记录、正在追踪、时间排行、待复习、添加至复习等导出。
  - JSON 导出补齐标签/备注语义与临时栏目结构，服务于 [Bookmark Canvas](https://github.com/Browser-bookmark-hub/Bookmark-Canvas) 的导入与整理流程。
- 默认快捷键调整：
  - `Ctrl/Command+Shift+6`：激活扩展。
  - `Ctrl/Command+Shift+7`：打开推荐视图。
  - `Ctrl/Command+Shift+8`：打开记录视图。
  - `Ctrl/Command+Shift+9`：快捷复习下一张卡片。
- 体验与性能修复：
  - 关联记录改为更轻的滑动/懒加载窗口，减少大数据量下的卡顿。
  - 小组件 UI、硬件加速、favicon 删除机制、待复习/时间捕捉折叠队列清理等细节继续修复。
- 工程与文档整理：
  - `history.js` 注释与结构整理，CSS 拆分，待复习/屏蔽中的书签树 UI 重构。
  - 推送与分析修复，并暴露 `AGENTS.md` / `CLAUDE.md` 约束文件模板用于共建。

## v0.3.9

- Side Panel 主入口稳定为 `panel-shell.html`，并复用 `history_html/history.html` 承载 widgets / recommend / additions / sync 视图。
- Manifest 当前声明快捷键：
  - `Ctrl/Command+Shift+6`：激活扩展。
  - `Ctrl/Command+Shift+7`：打开推荐视图。
  - `Ctrl/Command+Shift+8`：打开记录视图。
  - `Ctrl/Command+Shift+9`：快捷复习下一张卡片。
- 推荐算法主版本已演进到 `SCORE_ALGO_VERSION = 6.4`。
- 后台包含推荐刷新闹钟、浏览历史后台同步闹钟和推荐复习提醒闹钟。
- 浏览历史链路已引入本地缓存库，日常后台同步周期为每日一次，失败后 15 分钟重试。
- 同步页支持 GitHub Repo 配置、数据包推送、Markdown 文档查看/编辑和 AI 结果拉取。
- Markdown 渲染链路包含 `marked`、`DOMPurify` 和 Obsidian Markdown vendor 文件。
- 文档目录按“当前入口文档 + 历史归档”重新整理。
- 新增 `S_SCORE_ALGORITHM_V6_4.md`，记录 `f62a074f...` / `6d4a765...` 之后的当前 S 值算法、书签树/浏览历史维护桶和推送结构。

## 历史说明

- 旧文档中的推荐池 v6.2/v6.3、AI 同步包重构、时间范围、快捷复习、浏览历史库等计划，已移入 `docs/归档/`。
- 归档文档只保留设计源流和历史审计价值，不再作为当前实现规范。
