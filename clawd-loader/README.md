# 像素 Clawd · Pixel Clawd

把对话运行中那个 9 个点的 loading 换成像素小螃蟹 Clawd。

Replaces the 3×3 working dots in front of a running turn ("Pondering…") with a pixel Clawd.

![Demo](demo.gif)

- **运行中 Running**：走路，手里的道具在动（海盗挥刀、侦探扫放大镜、工程师拧扳手、厨师颠锅翻蛋、赛车手快跑摇旗、宇航员漂浮）。
  It walks and plays with its prop.
- **等你确认 Waiting on you**（权限、提问）：停下来轻轻呼吸，空着的爪子朝你挥。
  It stands still, breathing, and waves its free claw.

![7 个造型 · Seven costumes](costumes.png)

## 设置 · Settings

设置 → 扩展 → 像素 Clawd · Settings → Add-ons → Pixel Clawd

- **造型 Costume**：原版、海盗、侦探、工程师、厨师、赛车手、宇航员。
  Classic, Pirate, Detective, Engineer, Chef, Racer, Astronaut.
- **尺寸 Size**：小 18×12（默认）或中 24×16。中号每格正好 1 个像素，边缘更清楚。
  Small 18×12 (default) or Medium 24×16; Medium is one CSS pixel per grid cell, so its edges are crisper.

关掉或删除扩展，就回到 Gerdr 自己的点点。
Switch it off or remove it to get Gerdr's dots back.

## 需要 · Requires

用到 `g.slot("loader")`，需要 2026 年 11 月之后的 Gerdr；旧版本会在扩展设置里提示先更新 Gerdr。
Uses `g.slot("loader")`, in Gerdr from November 2026; an older Gerdr shows "update Gerdr first" in Settings → Add-ons.

## 来源 · Credits

像素画和动画来自 [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress)（johnnyvizz，MIT），它又是从 DockCrab 描出来的。Clawd 是 Anthropic 的吉祥物，本扩展是非官方的社区作品，和 Anthropic 无关。

The pixel art and animations come from [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress) by johnnyvizz (MIT), itself traced from DockCrab. Clawd is Anthropic's mascot; this is an unofficial community add-on, not affiliated with or endorsed by Anthropic.
