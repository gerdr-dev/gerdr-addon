// The pixel Clawds of savvy-progress (github.com/johnnyvizz/claude-kit, plugins/savvy-progress/hooks/register.tsx,
// MIT), itself traced from DockCrab: a 24×18 crab on a 30×28 grid, one costume per worker tier. Ported as is, with
// classes prefixed `cl-` since an inline SVG <style> applies to the whole page.

export const CLAY = "#D97757";
export const INK = "#1F1E1D";

// `cls`: "bd" (body and costume), "la" / "lb" (the two leg pairs), anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void;

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string) =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch], cls)));

// armCls: a raised claw travels with the prop it holds. A claw left down is "arm", which waves while waiting.
const body = (f: Fill, armFront = 0, armCls?: string) => {
  f(7, 10, 16, 12, CLAY);
  f(3, 14, 4, 4, CLAY);
  f(23, 14 + armFront, 4, 4, CLAY, armCls ?? (armFront ? "bd" : "arm"));
  f(9, 12, 2, 2, INK);
  f(19, 12, 2, 2, INK);
  f(7, 22, 2, 4, CLAY, "la");
  f(17, 22, 2, 4, CLAY, "la");
  f(11, 22, 2, 4, CLAY, "lb");
  f(21, 22, 2, 4, CLAY, "lb");
};

// The tier colours of savvy-progress, carried by each costume's accent.
const TIER: Record<string, string> = { fable: "#7F77DD", heavy: "#D85A30", careful: "#BA7517", medium: "#378ADD", light: "#1D9E75" };

export const COSTUMES: Record<string, { name: string; draw: (f: Fill, t: string) => void }> = {
  clawd: { name: "原版 Clawd", draw: (f) => body(f) },
  explore: {
    name: "海盗",
    draw: (f) => {
      body(f);
      stamp(f, 5, 3, [".kk..............kk.", ".kkk....kkkk....kkk.", "..kkkkkkkwwkkkkkkk..", "..kkkkkkkkkkkkkkkk..", ".gggggggggggggggggg."], { k: "#55514C", w: "#F8F6F1", g: "#F5C542" });
      f(7, 11, 11, 1, INK);
      f(18, 11, 4, 3, INK);
      f(27, 6, 1, 9, "#C9CCD2", "it");
      f(26, 15, 3, 1, "#7A4A26", "it");
    },
  },
  heavy: {
    name: "侦探",
    draw: (f, t) => {
      body(f, -4, "it");
      stamp(f, 6, 3, ["......bbbbbb......", "....bbcbbcbbbb....", "...bbbbbbbbbbbb...", "..bcbbcbbcbbcbbb..", ".bbbbbbbbbbbbbbbb.", "dddddddddddddddddd"], { b: "#7A4A26", c: "#A0703F", d: "#5A3519" });
      f(6, 9, 18, 1, t);
      stamp(f, 23, 1, [".kkk.", "k...k", "k...k", "k...k", ".kkk."], { k: "#3A3A3C" }, "it");
      f(24, 2, 3, 3, "rgba(169,214,245,.7)", "it");
      f(25, 6, 1, 4, "#7A4A26", "it");
      f(24, 2, 1, 1, "#fff", "gl");
    },
  },
  careful: {
    name: "工程师",
    draw: (f, t) => {
      body(f);
      stamp(f, 6, 4, [".....yyyyyyyy.....", "...yyyyyhhyyyyy...", "..yyyyyyhhyyyyyy..", "..yyyyyyhhyyyyyy..", ".yyyyyyyhhyyyyyyy.", "dddddddddddddddddd"], { y: "#F5C542", h: "#FBE08A", d: "#C99A1E" });
      f(13, 5, 4, 2, t);
      stamp(f, 0, 10, [".s.s", "sss.", ".s..", ".s.."], { s: "#8E929A" }, "it");
    },
  },
  medium: {
    name: "厨师",
    draw: (f, t) => {
      body(f, -4, "pan");
      stamp(
        f,
        6,
        0,
        ["........lll.......", ".......lllll......", ".wwwwgwwwwwwgwwwww", "wwwwwwwwwwwwwwwwww", "wwwwwwwwwwwwwwwwww", "wwwwwgwwwwwggwwwww", ".wwwwgwwwwwggwwwww", ".dddbbbbbbbbbbbbb.", ".dddbbbbbbbbbbbbb.", ".dddbbbbbbbbbbbbb."],
        { w: "#F4F3EE", l: "#F7F6F2", g: "#D2D1C8", b: t, d: "#B45F43" },
      );
      f(22, 8, 7, 2, "#4A4A48", "pan");
      f(26, 10, 1, 1, "#4A4A48", "pan");
      f(24, 7, 3, 1, "#F5B731", "egg");
    },
  },
  light: {
    name: "赛车手",
    draw: (f, t) => {
      body(f, -4);
      stamp(f, 6, 5, ["....rrrrrrrrrr....", "..rrrrrrwwrrrrrr..", ".rrrrrrrwwrrrrrrr.", ".rrrrrrrwwrrrrrrr.", ".rrrrrrrwwrrrrrrr.", ".kkkkkkkkkkkkkkkkr"], { r: t, w: "#F8F6F1", k: INK });
      f(25, 1, 1, 9, "#8E929A");
      stamp(f, 26, 1, ["wkwk", "kwkw", "wkwk"], { w: "#F8F6F1", k: INK }, "flag");
    },
  },
  fable: {
    name: "宇航员",
    draw: (f, t) => {
      body(f);
      f(6, 7, 18, 1, "#E6E8EE");
      f(5, 8, 1, 14, "#E6E8EE");
      f(24, 8, 1, 14, "#E6E8EE");
      f(6, 22, 18, 1, "#C9CCD2");
      f(6, 8, 18, 14, "rgba(169,214,245,.32)");
      f(8, 9, 2, 1, "#fff");
      f(8, 10, 1, 2, "#fff");
      f(14, 4, 2, 3, "#C9CCD2");
      f(14, 2, 2, 2, t, "ant");
      f(13, 18, 4, 2, t);
      f(27, 3, 1, 3, "#F5C542", "star");
      f(26, 4, 3, 1, "#F5C542", "star");
    },
  },
};

// savvy-progress's CRAB_CSS, plus the waiting state it doesn't have (cl-wait): standing still, breathing like
// Gerdr's own paused dots, the free claw waving.
export const CSS = `
.cl-run .cl-la{animation:cl-st .5s steps(1) infinite}.cl-run .cl-lb{animation:cl-st .5s steps(1) infinite -.25s}
.cl-run .cl-bd{animation:cl-bob .5s steps(1) infinite -.125s}
.cl-run g,.cl-wait g{transform-box:fill-box}
@keyframes cl-st{50%{transform:translateY(-1px)}}@keyframes cl-bob{50%{transform:translateY(1px)}}
.cl-fable.cl-run{animation:cl-float 1s ease-in-out infinite}
.cl-fable.cl-run .cl-la,.cl-fable.cl-run .cl-lb,.cl-fable.cl-run .cl-bd{animation:none}
.cl-fable.cl-run .cl-ant{animation:cl-blink 1s steps(1) infinite}
.cl-fable.cl-run .cl-star{animation:cl-blink .5s steps(1) infinite -.25s}
@keyframes cl-float{50%{transform:translateY(-2px)}}@keyframes cl-blink{50%{opacity:.15}}
.cl-heavy.cl-run .cl-it{animation:cl-scan 1s steps(1) infinite}
.cl-heavy.cl-run .cl-gl{animation:cl-blink 1s steps(1) infinite -.5s}
@keyframes cl-scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.cl-careful.cl-run .cl-it{transform-origin:100% 100%;animation:cl-twist .5s ease-in-out infinite}
@keyframes cl-twist{50%{transform:rotate(-35deg)}}
.cl-medium.cl-run .cl-pan{transform-origin:0 50%;animation:cl-tilt 1s ease-in-out infinite}
.cl-medium.cl-run .cl-egg{animation:cl-flip 1s ease-in-out infinite}
@keyframes cl-tilt{20%,40%{transform:rotate(-12deg)}}@keyframes cl-flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.cl-light.cl-run .cl-la{animation-duration:.25s}.cl-light.cl-run .cl-lb{animation-duration:.25s;animation-delay:-.125s}
.cl-light.cl-run .cl-flag{transform-origin:0 50%;animation:cl-wave .25s steps(1) infinite}
@keyframes cl-wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.cl-explore.cl-run .cl-it{transform-origin:50% 100%;animation:cl-fence .5s ease-in-out infinite}
@keyframes cl-fence{50%{transform:rotate(25deg)}}
.cl-wait{animation:cl-breathe 1.6s ease-in-out infinite}
.cl-wait .cl-arm{animation:cl-hi .8s steps(1) infinite}
@keyframes cl-breathe{0%,100%{opacity:.55}50%{opacity:1}}@keyframes cl-hi{50%{transform:translateY(-4px)}}
@media (prefers-reduced-motion: reduce){.cl-run,.cl-run *,.cl-wait,.cl-wait *{animation:none!important}}
`;

/** The grid cells a costume covers, hat and prop included: [x, y, width, height]. */
export function bounds(costume: string): [number, number, number, number] {
  const c = COSTUMES[costume] ?? COSTUMES.clawd;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  c.draw((x, y, w, h) => {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }, "#000");
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * The costume's rects, grouped as savvy-progress nests them: props inside the body (they ride its bob), legs apart.
 * still: no animation at all (the rail face, which is always in sight).
 */
export function Crab({ costume, paused, still }: { costume: string; paused: boolean; still?: boolean }) {
  const c = COSTUMES[costume] ?? COSTUMES.clawd;
  const groups = new Map<string, unknown[]>([["bd", []]]);
  const f: Fill = (x, y, w, h, fill, cls = "bd") => {
    if (!groups.has(cls)) groups.set(cls, []);
    const list = groups.get(cls)!;
    list.push(<rect key={list.length} x={x} y={y} width={w} height={h} fill={fill} />);
  };
  c.draw(f, TIER[costume] ?? "#888780");
  const group = (cls: string) => (
    <g key={cls} className={`cl-${cls}`}>
      {groups.get(cls) ?? []}
    </g>
  );
  const props = [...groups.keys()].filter((k) => k !== "bd" && k !== "la" && k !== "lb");
  return (
    <g className={`cl-${costume in COSTUMES ? costume : "clawd"} ${still ? "" : paused ? "cl-wait" : "cl-run"}`}>
      <g className="cl-bd">
        {groups.get("bd")}
        {props.map(group)}
      </g>
      {group("la")}
      {group("lb")}
    </g>
  );
}
