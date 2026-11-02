/// <reference path="../gerdr.d.ts" />
import { CSS, Crab, bounds } from "./clawds";

// Seven Clawds as sprites: Gerdr draws them only where the user puts them — the working indicator (Settings → General
// → Loading 动画), a rail button (→ 扩展 → 分组), an agent's icon — one costume per place if they like. This add-on used to be the working indicator
// itself plus one button face, both in the costume set here, with a switch to keep Gerdr's dots.

// The costumes in the order they're listed, with their titles per language
const COSTUMES: [string, string, string][] = [
  ["clawd", "Classic", "原版"],
  ["explore", "Pirate", "海盗"],
  ["heavy", "Detective", "侦探"],
  ["careful", "Engineer", "工程师"],
  ["medium", "Chef", "厨师"],
  ["light", "Racer", "赛车手"],
  ["fable", "Astronaut", "宇航员"],
];

// In the working indicator the box is the bare crab (grid x 3..27, y 10..26), so every costume's body sits in the
// same place next to the text; hats and props draw outside it (overflow visible), the way the dots' row has room
// above and beside. Scaled to the box Gerdr gives (24×16 there: one CSS pixel per cell). No size setting: how big a
// sprite is belongs to the place that shows it, a picture set has nothing to configure.

export default defineAddon({
  setup(g) {
    const sprite = (costume: string) =>
      function Clawd({ state, width, height }: { state: "idle" | "working" | "waiting"; width: number; height: number }) {
        // A rail button: standing still (the rail is always in sight, a walking crab there pulls the eye all day),
        // framed on what the costume covers, one CSS pixel per cell unless the box is smaller
        if (state === "idle") {
          const [x, y, w, h] = bounds(costume);
          const s = Math.min(1, width / w, height / h);
          return (
            <svg aria-hidden width={w * s} height={h * s} viewBox={`${x} ${y} ${w} ${h}`} shapeRendering="crispEdges" className="block">
              <Crab costume={costume} paused={false} still />
            </svg>
          );
        }
        const s = Math.min(width / 24, height / 16);
        return (
          <svg aria-hidden width={24 * s} height={16 * s} viewBox="3 10 24 16" shapeRendering="crispEdges" style={{ overflow: "visible" }}>
            <style>{CSS}</style>
            <Crab costume={costume} paused={state === "waiting"} />
          </svg>
        );
      };
    const off: (() => void)[] = [];
    try {
      for (const [id, en, zh] of COSTUMES) off.push(g.slot("sprite", sprite(id), { id, title: g.locale() === "zh" ? zh : en }));
    } catch {
      // Gerdr before sprites (Nov 2026) throws "没有这个插槽"
      off.forEach((f) => f());
      throw new Error(g.locale() === "zh" ? "这个版本的 Gerdr 还不支持素材，请先更新 Gerdr" : "This Gerdr can't take sprites yet: update Gerdr first");
    }
    return () => off.forEach((f) => f());
  },
});
