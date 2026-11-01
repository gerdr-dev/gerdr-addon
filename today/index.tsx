/// <reference path="../gerdr.d.ts" />
// Today's work in the sidebar: how many tasks you handed the agents finished, and what they cost. Click for the last
// 7 days. Gerdr logs every finished turn once (g.turns); the counting is done here:
// - a task = a turn that ended normally (end_turn) and that a person started. Turns the agent opened itself (auto: a
//   background task finished and it reported back) aren't one; they were a quarter of all turns.
// - cost = what Claude Code reported for each turn (its estimate at API prices); for Gerdr Agent, its tokens priced
//   from the "prices" setting (a table the user keeps: list prices change, and a gateway charges its own). A model
//   the table doesn't match costs nothing and is named in the tooltip. Codex reports neither.
// - a turn belongs to the local day it ended on.

const DAYS = 7;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

type Day = { date: string; done: number; cost: number; unpriced: string[] };
type Price = { re: RegExp; input: number; output: number; cacheRead: number; cacheWrite: number };

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const dateKey = (t: number | Date) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isTask = (t: TurnRecord) => t.stopReason === "end_turn" && !t.auto;

/**
 * The "prices" setting: one model a line, `pattern input output [cacheRead [cacheWrite]]`, USD per million tokens.
 * The pattern matches the whole model key ("anthropic/claude-opus-4-5") or the part after the provider, * is a
 * wildcard, the first matching line wins. A missing cache price is the input price. # starts a comment.
 */
function parsePrices(text: string): Price[] {
  const out: Price[] = [];
  for (const raw of text.split("\n")) {
    const [pat, ...nums] = raw.replace(/#.*/, "").trim().split(/\s+/);
    const n = nums.map(Number);
    if (!pat || n.length < 2 || n.some((x) => !Number.isFinite(x))) continue;
    const re = new RegExp("^" + pat.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
    out.push({ re, input: n[0], output: n[1], cacheRead: n[2] ?? n[0], cacheWrite: n[3] ?? n[0] });
  }
  return out;
}

const findPrice = (prices: Price[], model: string) => {
  const short = model.slice(model.lastIndexOf("/") + 1);
  return prices.find((p) => p.re.test(model) || p.re.test(short));
};

/** What a turn cost: the agent's own figure when it gave one, else its tokens priced. Models with no price go to unpriced. */
function turnCost(t: TurnRecord, prices: Price[], unpriced: Set<string>) {
  if (t.costUsd) return t.costUsd;
  let usd = 0;
  for (const k of t.tokens ?? []) {
    const p = findPrice(prices, k.model);
    if (!p) {
      unpriced.add(k.model);
      continue;
    }
    const cr = k.cacheRead ?? 0;
    const cw = k.cacheWrite ?? 0;
    const plain = Math.max(0, (k.input ?? 0) - cr - cw);
    usd += (plain * p.input + cr * p.cacheRead + cw * p.cacheWrite + (k.output ?? 0) * p.output) / 1e6;
  }
  return usd;
}

/** The last DAYS days, today last, empty days included. */
function bucket(turns: TurnRecord[], prices: Price[]): Day[] {
  const days: Day[] = [];
  const at: Record<string, { day: Day; unpriced: Set<string> }> = {};
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = { date: dateKey(d), done: 0, cost: 0, unpriced: [] };
    days.push(day);
    at[day.date] = { day, unpriced: new Set() };
  }
  for (const t of turns) {
    const b = at[dateKey(t.ts)];
    if (!b) continue;
    if (isTask(t)) b.day.done++;
    b.day.cost += turnCost(t, prices, b.unpriced);
  }
  for (const b of Object.values(at)) b.day.unpriced = [...b.unpriced];
  return days;
}

export default defineAddon({
  setup(g) {
    const { React, ui, icons } = g;
    const { useState, useEffect } = React;

    // Settings don't reload an add-on (g.settings.get reads the latest each call): look at the table now and then so
    // an edit shows without waiting for the next turn
    const pricesText = () => String(g.settings.get<string>("prices") ?? "");
    const prices = () => parsePrices(pricesText());

    function useDays() {
      const [days, setDays] = useState<Day[] | null>(null);
      useEffect(() => {
        let live = true;
        let turns: TurnRecord[] = [];
        const since = () => {
          const d = new Date();
          d.setDate(d.getDate() - (DAYS - 1));
          return d.setHours(0, 0, 0, 0);
        };
        // A Gerdr older than g.turns keeps daily totals itself (g.stats, gone since 2026-11): show those
        const old = typeof g.turns !== "function" ? (g as any) : undefined;
        const load = () =>
          (old
            ? old.stats(DAYS).then((ds: any[]) => ds.map((d) => ({ date: d.date, done: d.done, cost: Object.values<number>(d.cost ?? {}).reduce((a, b) => a + b, 0), unpriced: [] })))
            : g.turns({ since: since() }).then((ts) => bucket((turns = ts), prices()))
          )
            .then((d: Day[]) => live && setDays(d))
            .catch(() => {});
        load();
        const off = old
          ? old.on("stats", load)
          : g.on("turn", (t) => {
              turns = [...turns.filter((x) => x.ts >= since()), t];
              if (live) setDays(bucket(turns, prices()));
            });
        // A new day starts at midnight with nothing in it, and a window asleep may have missed turns: look again
        const t = setInterval(load, 5 * 60_000);
        let table = pricesText();
        const watch = setInterval(() => {
          if (old || pricesText() === table) return;
          table = pricesText();
          if (live) setDays(bucket(turns, prices()));
        }, 2000);
        return () => {
          live = false;
          off();
          clearInterval(t);
          clearInterval(watch);
        };
      }, []);
      return days;
    }

    function Bars({ days, value, fmt }: { days: Day[]; value: (d: Day) => number; fmt: (n: number) => string }) {
      const max = Math.max(...days.map(value), 0);
      return (
        <div className="flex items-end gap-1">
          {days.map((d, i) => {
            const v = value(d);
            const today = i === days.length - 1;
            return (
              <div key={d.date} className="flex flex-1 flex-col items-center gap-0.5" title={`${d.date} ${fmt(v)}`}>
                <div className="flex h-9 w-full items-end">
                  <div
                    className={ui.cn("w-full rounded-sm", today ? "bg-brand" : "bg-muted-foreground/30")}
                    style={{ height: max > 0 && v > 0 ? Math.max(3, Math.round((v / max) * 36)) : 0 }}
                  />
                </div>
                <span className={ui.cn("text-[9px]", today ? "text-foreground" : "text-muted-foreground")}>{WEEK[new Date(d.date + "T00:00").getDay()]}</span>
              </div>
            );
          })}
        </div>
      );
    }

    function Today() {
      const days = useDays();
      const [open, setOpen] = useState(false);
      if (!days) return null;
      const t = days[days.length - 1];
      const cost = t.cost;
      return (
        <div className="px-1.5">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left hover:bg-accent/60"
            title={open ? "收起" : "看最近 7 天"}
            onClick={() => setOpen((v) => !v)}
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-11 shrink-0 text-muted-foreground">今日</span>
              <span className="flex items-center gap-1" title="今天你交代、正常结束的轮次（agent 自己开的、取消的、出错的不算）">
                <icons.CircleCheck className="size-3 text-ok" />
                <span className="tabular-nums">{t.done}</span>
                <span className="text-muted-foreground">个任务</span>
              </span>
              <span
                className="ml-auto flex items-center gap-1"
                title={
                  "Claude Code 报的花费，加上 Gerdr Agent 的 token 按设置里的价格表换算（估算，不是实际账单）" +
                  (t.unpriced.length ? `\n价格表里没有、没算进去的模型：${t.unpriced.join("、")}` : "")
                }
              >
                <icons.Coins className="size-3 text-warn" />
                <span className="tabular-nums">{usd(cost)}</span>
                {t.unpriced.length > 0 && <span className="text-warn">*</span>}
              </span>
            </div>
            {open && (
              <div className="mt-2 space-y-2 pb-1">
                <div>
                  <div className="mb-1 flex text-[10px] text-muted-foreground">
                    <span className="flex-1">任务</span>
                    <span className="tabular-nums">7 天 {days.reduce((a, d) => a + d.done, 0)}</span>
                  </div>
                  <Bars days={days} value={(d) => d.done} fmt={(n) => `${n} 个`} />
                </div>
                <div>
                  <div className="mb-1 flex text-[10px] text-muted-foreground">
                    <span className="flex-1">花费</span>
                    <span className="tabular-nums">7 天 {usd(days.reduce((a, d) => a + d.cost, 0))}</span>
                  </div>
                  <Bars days={days} value={(d) => d.cost} fmt={usd} />
                </div>
              </div>
            )}
          </button>
        </div>
      );
    }

    return g.slot("sidebar", Today, { order: 0 });
  },
});
