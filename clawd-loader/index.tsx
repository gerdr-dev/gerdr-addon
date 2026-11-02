/// <reference path="../gerdr.d.ts" />
import { CSS, Crab, bounds } from "./clawds";

// The box is the bare crab (grid x 3..27, y 10..26), so every costume's body sits in the same place next to the
// text; hats and props draw outside it (overflow visible), the way the dots' row has room above and beside.
const SCALE: Record<string, number> = { small: 0.75, medium: 1 };

export default defineAddon({
  setup(g) {
    function Loader({ paused }: { paused: boolean }) {
      const s = SCALE[g.settings.get<string>("size")] ?? 0.75;
      const costume = g.settings.get<string>("costume") || "clawd";
      return (
        <span aria-hidden className="flex shrink-0 items-center justify-center" style={{ width: 24 * s, height: 16 * s }}>
          <svg width={24 * s} height={16 * s} viewBox="3 10 24 16" shapeRendering="crispEdges" style={{ overflow: "visible" }}>
            <style>{CSS}</style>
            <Crab costume={costume} paused={paused} />
          </svg>
        </span>
      );
    }
    // A face for the rail's add-on buttons (Settings → 扩展 → 窄条): the chosen costume standing still — the rail is
    // always in sight, a walking crab there would pull the eye all day. Framed on what the costume actually covers
    // (hats and props stick out of the bare crab), one CSS pixel per cell so its edges stay crisp, within the 36×28 box.
    function Face() {
      const costume = g.settings.get<string>("costume") || "clawd";
      const [x, y, w, h] = bounds(costume);
      return (
        <svg aria-hidden width={w} height={h} viewBox={`${x} ${y} ${w} ${h}`} shapeRendering="crispEdges" className="block">
          <Crab costume={costume} paused={false} still />
        </svg>
      );
    }
    let loader: () => void;
    try {
      loader = g.slot("loader", Loader);
    } catch {
      // Gerdr before the "loader" slot (2026-11) throws "没有这个插槽": say what to do instead
      throw new Error("这个版本的 Gerdr 还不能替换 loading 动画，请先更新 Gerdr");
    }
    // Gerdr before rail faces (2026-11) has no such use for the "rail" slot: the loader still works without it
    let face = () => {};
    try {
      face = g.slot("rail", Face, { id: "face", title: "像素 Clawd" });
    } catch {}
    return () => (loader(), face());
  },
});
