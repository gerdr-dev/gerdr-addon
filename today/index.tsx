/// <reference path="../gerdr.d.ts" />
// Today's work in the sidebar: how many tasks the agents finished (turns that ended normally, every agent) and what
// they cost (what Claude Code reports; Codex reports tokens, not money). Click for the last 7 days.
// The numbers are gerdr's (g.stats): every window shows the same ones, counted once.

const DAYS = 7;
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

const usd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : n >= 10 ? `$${n.toFixed(1)}` : `$${n.toFixed(2)}`);
const total = (d?: DayStats) => Object.values(d?.cost ?? {}).reduce((a, b) => a + b, 0);

export default defineAddon({
  setup(g) {
    const { React, ui, icons } = g;
    const { useState, useEffect } = React;

    function useDays() {
      const [days, setDays] = useState<DayStats[] | null>(null);
      useEffect(() => {
        let live = true;
        const load = () =>
          g
            .stats(DAYS)
            .then((d) => live && setDays(d))
            .catch(() => {});
        load();
        const off = g.on("stats", load);
        // A new day starts at midnight with nothing in it: look again every few minutes
        const t = setInterval(load, 5 * 60_000);
        return () => {
          live = false;
          off();
          clearInterval(t);
        };
      }, []);
      return days;
    }

    function Bars({ days, value, fmt }: { days: DayStats[]; value: (d: DayStats) => number; fmt: (n: number) => string }) {
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
      const cost = total(t);
      return (
        <div className="px-1.5 py-1">
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left hover:bg-accent/60"
            title={open ? "收起" : "看最近 7 天"}
            onClick={() => setOpen((v) => !v)}
          >
            <div className="flex items-center gap-2 text-[11px]">
              <span className="w-11 shrink-0 text-muted-foreground">今日</span>
              <span className="flex items-center gap-1" title="今天跑完的任务（正常结束的轮次）">
                <icons.CircleCheck className="size-3 text-ok" />
                <span className="tabular-nums">{t.done}</span>
                <span className="text-muted-foreground">个任务</span>
              </span>
              <span className="ml-auto flex items-center gap-1" title="Claude Code 报的花费">
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
                    <span className="tabular-nums">7 天 {usd(days.reduce((a, d) => a + total(d), 0))}</span>
                  </div>
                  <Bars days={days} value={total} fmt={usd} />
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
