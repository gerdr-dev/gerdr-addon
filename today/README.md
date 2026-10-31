# 今日

侧栏里一行：今天 agent 跑完了几个任务、花了多少钱。点开是最近 7 天的柱状图。

![今日](screenshot.png)

- **任务**：正常结束的一轮算一个（被你打断的、出错的不算），Claude Code 和 Codex 都算。
- **花费**：Claude Code 自己报的钱数（和 `/cost` 一样）。Codex 只报 token 不报钱，不计入。
- 数字由 gerdr 后端统计，几个窗口、手机上看到的都一样；从装上新版 gerdr 那天开始记。

用到的扩展能力：`g.slot("sidebar")`、`g.stats()` 和 `g.on("stats")`。
