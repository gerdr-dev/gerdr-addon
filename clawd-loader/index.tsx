/// <reference path="../gerdr.d.ts" />
import { CSS, Crab } from "./clawds";

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
    try {
      return g.slot("loader", Loader);
    } catch {
      // Gerdr before the "loader" slot (2026-11) throws "没有这个插槽": say what to do instead
      throw new Error("这个版本的 Gerdr 还不能替换 loading 动画，请先更新 Gerdr");
    }
  },
});
