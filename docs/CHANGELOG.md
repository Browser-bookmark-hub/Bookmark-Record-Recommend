# 版本更新日志

整理基准：2026-07-08  
当前扩展版本：`0.3.9`

本文件根据当前 README、manifest、CodeGraph 和代码搜索整理。历史计划中的版本号和状态未逐条采信。

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
