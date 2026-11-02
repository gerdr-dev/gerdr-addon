# 像素 Clawd

7 个像素小螃蟹 Clawd：可以换掉对话运行中那个 9 个点的 loading（「Pondering…」前面那个），也可以当角色图标。

![演示](demo.gif)

- **运行中**：走路，手里的道具在动（海盗挥刀、侦探扫放大镜、工程师拧扳手、厨师颠锅翻蛋、赛车手快跑摇旗、宇航员漂浮）。
- **等你确认**（权限、提问）：停下来轻轻呼吸，空着的爪子朝你挥。
- **当图标**：造型站着不动，会话列表一直在眼前，动起来太抢眼。

![7 个造型](costumes.png)

## 怎么用

装上之后什么都不会变，要你自己放：

- **loading**：设置 → 通用 → Loading 动画，挑一个造型。Gerdr 自带的几种也在同一个列表里。
- **角色图标**：设置 → Agent，编辑一个角色，在内置图标下面挑一个造型。

每个地方可以用不同的造型。

## 需要

2026 年 11 月之后、设置 → 通用里有「Loading 动画」的 Gerdr（`g.slot("sprite")`）；旧版本会在扩展设置里提示先更新 Gerdr。

## 来源

像素画和动画来自 [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress)（johnnyvizz，MIT），
它又是从 DockCrab 描出来的。Clawd 是 Anthropic 的吉祥物，本扩展是非官方的社区作品，和 Anthropic 无关。
