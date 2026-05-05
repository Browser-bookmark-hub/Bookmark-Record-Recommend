# Active Time Tracking Health Check Plan

## 目标

为时间捕捉增加低频状态健康检查，修复偶发的 session 状态卡住问题，尤其是 `visible`（蓝色，可见参考）和 `paused`（前台静止）长时间残留导致时间排行被污染的问题。

## 背景

当前时间捕捉主要依赖浏览器事件驱动状态变化，例如标签页切换、窗口焦点变化、idle 状态变化、URL 变化和标签页关闭。

小组件虽然会高频刷新显示，但刷新本身只是读取并展示后台 session 状态，不会每次重新校验真实浏览器状态。因此在多窗口、长时间挂机、系统休眠、Service Worker 恢复、标签页被浏览器休眠等场景下，可能出现旧状态残留。

典型表现是某个页面长期显示蓝色 `visible`，但实际它已经不是当前标签页，甚至页面已经休眠。用户手动重新打开该页面再切走后，状态会恢复正常，说明这是状态残留而不是正常语义。

## 设计原则

1. 低频检查，不做高频监控。
2. 串行检查，不并行查询大量标签页。
3. 覆盖所有正在进行的 session，但按风险优先级处理。
4. 只纠正明显不符合真实浏览器状态的 session，不主动清理用户保留的后台工作页面。
5. 保护多窗口、多标签页长期保留的使用习惯。

## 检查频率

建议使用每个 session 自身的捕捉时长作为检查标准：当 session 时长达到 30 分钟、1 小时、1.5 小时等 30 分钟倍数节点时，执行一次健康检查。

原因：

- 该问题属于低频异常，不需要秒级修复。
- 30 分钟节点足以限制异常状态对时间排行的长期污染。
- 相比 15 分钟更保守，对大量标签页用户更友好。
- 相比 1 小时能更早纠正蓝色或前台静止残留。
- 不使用全局半小时全量扫描；短时间刚开始捕捉的 session 不需要被检查。

## 检查范围

每次健康检查覆盖所有未结束的 active time sessions：

- `active`：绿色，当前活跃。
- `paused`：黄色，前台静止。
- `visible`：蓝色，可见参考。
- `background`：灰色，后台。
- `sleeping`：睡眠。

## 优先级

虽然覆盖所有正在进行的 session，但处理顺序按风险排序：

1. `visible`：蓝色，可见参考，倍率 0.5，最容易出现用户可见误判。
2. `paused`：前台静止，倍率 0.8，卡住后对时间排行污染较大。
3. `active`：活跃，倍率 1.0，通常会被 idle 事件纠正，但仍需兜底。
4. `background`：后台，倍率 0.1，影响较小。
5. `sleeping`：睡眠，理论上不继续计时，最低优先级。

## 执行方式

定时器只负责低频调度；实际是否检查由每个 session 自身的捕捉时长决定。只有当某个 session 已经跨过下一个 30 分钟检查点，才进入候选队列。

推荐流程：

1. 收集所有 `state !== INACTIVE` 且 `state !== ENDED` 的 session。
2. 计算 session 自身捕捉时长：优先使用 `originalStartTime`，否则使用 `startTime`。
3. 只保留时长已达到 30 分钟倍数检查点，且距离上次检查已经超过 30 分钟的 session。
4. 根据显示状态和风险优先级排序。
5. 一个一个执行真实状态查询，不并行。
6. 对每个 session 校验 tab/window/idle 状态。
7. 如果真实状态与 session 状态不一致，则结算当前状态时间并切换到真实状态。
8. 记录该 session 已检查到的捕捉时长节点。
9. 检查完成后持久化 session 状态。

## 真实状态校验内容

对每个 session 做以下轻量检查：

1. `tabs.get(tabId)`：确认标签页是否仍存在，读取 URL、窗口 ID、`discarded` 等信息。
2. `windows.get(windowId)`：确认窗口是否存在以及是否 focused。
3. `tabs.query({ active: true, windowId })`：确认该 session 的 tab 是否为所在窗口的当前标签页。
4. 使用已有 `currentIdleState` 判断用户是否 active / idle。

## 纠偏规则

建议根据真实状态得出目标状态：

1. 标签页不存在：结束 session，达到最小时长则保存。
2. 标签页已 discarded / 休眠：将 session 纠正为 sleeping，避免继续按 active / paused / visible 计时。
3. 标签页不是所在窗口的当前标签页：纠正为 background。
4. 标签页是当前标签页，窗口 focused，用户 active：纠正为 active。
5. 标签页是当前标签页，窗口 focused，用户 idle：纠正为 paused。
6. 标签页是当前标签页，窗口无焦点，用户 active：纠正为 visible。
7. 标签页是当前标签页，窗口无焦点，用户 idle：纠正为 sleeping 或 paused，避免继续按 visible 长时间累计。

## 状态切换注意事项

状态纠偏不能只改布尔值，需要先结算旧状态已经产生的时间，再切换到新状态。

例如：

- `visible -> background`：先把当前 visible 持续时间累计进 `visibleTotalMs`，再进入 background。
- `paused -> sleeping`：先把当前 paused 持续时间累计进 `pauseTotalMs`，再进入 sleeping。
- `active -> paused`：先把当前 active 持续时间累计进 `accumulatedActiveMs`，再进入 paused。

建议新增统一的状态切换辅助函数，避免各分支重复处理时间结算逻辑。

## 升级兼容

旧版本已经存在的 active sessions 没有 `lastHealthCheckElapsedMs` 字段。升级后恢复这些 session 时，需要进行一次过渡兼容：

1. 根据 `originalStartTime` / `startTime` 计算当前 session 已捕捉时长。
2. 将 `lastHealthCheckElapsedMs` 初始化为当前已完成的 30 分钟检查点。
3. 这样旧 session 不会在升级后全部立即进入健康检查队列，避免大量标签页用户出现一次性检查。
4. 后续仍按下一个 30 分钟节点继续检查，例如已运行 2 小时 10 分钟的旧 session，会从 2 小时检查点之后继续，到 2 小时 30 分钟附近再检查。

## 对时间排行的影响

该方案不会改变正常计时模型，只修复异常状态残留。

预期效果：

- 减少蓝色 `visible` 长时间卡住造成的 0.5 倍计时污染。
- 减少前台静止 `paused` 长时间卡住造成的 0.8 倍计时污染。
- 提高长期运行、多窗口、多标签页场景下的时间排行稳定性。

## 不做的事情

1. 不每秒检查真实 tab/window 状态。
2. 不并行扫描所有标签页。
3. 不主动关闭或删除用户保留的后台标签页。
4. 不因为 background 时间长就强行结束 session。
5. 不改变用户现有的多窗口、多标签页工作流。

## 实施步骤

1. 在 `active_time_tracker/index.js` 中增加健康检查间隔配置，例如 `SESSION_HEALTH_CHECK_INTERVAL_MS = 30 * 60 * 1000`。
2. 增加健康检查调度定时器，初始化时启动，停止追踪时关闭。
3. 为 session 记录上次健康检查对应的捕捉时长节点。
4. 实现 session 自身时长是否到达检查点的判断。
5. 恢复旧 session 时补齐 `lastHealthCheckElapsedMs`，避免升级后立即全量检查。
6. 实现 session 风险优先级排序。
7. 实现真实状态查询函数。
8. 实现统一状态纠偏函数，确保切换前正确结算旧状态时间。
9. 健康检查后持久化当前 session 状态。
10. 手动验证多窗口、窗口失焦、用户 idle、标签页切换、标签页关闭、discarded 标签等场景。

## 验证场景

1. 当前页面绿色 active，切到别的标签后应变灰色 background。
2. 当前页面绿色 active，用户 idle 后应变 paused。
3. 窗口失焦且用户仍 active 时，当前标签可显示 visible。
4. 窗口失焦且用户 idle 时，不应长期保持 visible。
5. 标签页关闭后，session 应结束并保存。
6. 标签页 discarded 后，不应继续按 visible / paused / active 计时。
7. 多窗口同时打开大量标签时，健康检查应串行执行，不造成明显卡顿。
