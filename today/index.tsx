/// <reference path="../gerdr.d.ts" />
// Today's work in the sidebar: how many tasks you handed the agents finished, and what they cost. Click for the last
// 7 days. Gerdr logs every finished turn once (g.turns); the counting is done here:
// - a task = a turn that ended normally (end_turn) and that a person started. Turns the agent opened itself (auto: a
//   background task finished and it reported back) aren't one; they were a quarter of all turns.
// - cost = what Claude Code reported for each turn (its estimate at API prices); Codex reports tokens, not money.
// - a turn belongs to the local day it ended on.

const DAYS = 7;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

type Day = { date: string; done: number; cost: number };

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const dateKey = (t: number | Date) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const isTask = (t: TurnRecord) => t.stopReason === "end_turn" && !t.auto;

/** The last DAYS days, today last, empty days included. */
function bucket(turns: TurnRecord[]): Day[] {
  const days: Day[] = [];
  const at: Record<string, Day> = {};
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = { date: dateKey(d), done: 0, cost: 0 };
    days.push(day);
    at[day.date] = day;
  }
  for (const t of turns) {
    const day = at[dateKey(t.ts)];
    if (!day) continue;
    if (isTask(t)) day.done++;
    day.cost += t.costUsd ?? 0;
  }
  return days;
}

export default defineAddon({
  setup(g) {
    const { React, ui, icons } = g;
    const { useState, useEffect } = React;

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
            ? old.stats(DAYS).then((ds: any[]) => ds.map((d) => ({ date: d.date, done: d.done, cost: Object.values<number>(d.cost ?? {}).reduce((a, b) => a + b, 0) })))
            : g.turns({ since: since() }).then((ts) => bucket((turns = ts)))
          )
            .then((d: Day[]) => live && setDays(d))
            .catch(() => {});
        load();
        const off = old
          ? old.on("stats", load)
          : g.on("turn", (t) => {
              turns = [...turns.filter((x) => x.ts >= since()), t];
              if (live) setDays(bucket(turns));
            });
        // A new day starts at midnight with nothing in it, and a window asleep may have missed turns: look again
        const t = setInterval(load, 5 * 60_000);
        return () => {
          live = false;
          off();
          clearInterval(t);
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
              <span className="ml-auto flex items-center gap-1" title="Claude Code 报的花费（按 API 价格估算，不是实际账单）">
                <icons.Coins className="size-3 text-warn" />
                <span className="tabular-nums">{usd(cost)}</span>
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
