/// <reference path="../gerdr.d.ts" />
// The Claude Code / Codex quotas at the bottom of the sidebar: one row per account, always in sight, without typing
// /usage (which goes into the conversation). Collapsed it shows the two that matter (the 5-hour window and the week;
// a per-model weekly quota at 0% steps aside); click for every quota and when it resets.
// A small table: columns 5 小时 and 本周 (named once), a row per account with a ring and the percent used; expanded,
// each cell also says when it resets and the per-model quotas (Fable) hang under their account.
// Asked every 3 minutes while the window is visible; the backend caches, so several windows ask only once.

const POLL = 3 * 60_000;

export default defineAddon({
  setup(g) {
    const { React, ui, icons } = g;
    const { useState, useEffect, useCallback } = React;

    function useUsage() {
      const [list, setList] = useState<UsageInfo[] | null>(null);
      const [loading, setLoading] = useState(false);
      const load = useCallback(async (force?: boolean) => {
        setLoading(true);
        try {
          setList(await g.usage(force));
        } catch {
          // keep the last one
        } finally {
          setLoading(false);
        }
      }, []);
      useEffect(() => {
        load();
        const visible = () => document.visibilityState === "visible";
        const t = setInterval(() => visible() && load(), POLL);
        const onVis = () => visible() && load();
        document.addEventListener("visibilitychange", onVis);
        return () => {
          clearInterval(t);
          document.removeEventListener("visibilitychange", onVis);
        };
      }, [load]);
      return { list, loading, refresh: () => load(true) };
    }

    const tone = (pct: number) => (pct >= 90 ? "stroke-bad" : pct >= 70 ? "stroke-warn" : "stroke-brand");

    /** A ring filled with how much of the quota is used (brand, amber from 70%, red from 90%). */
    function Ring({ used, size }: { used: number; size: number }) {
      const sw = 2;
      const r = (size - sw) / 2;
      const c = 2 * Math.PI * r;
      const v = Math.min(100, Math.max(0, used));
      return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" className="shrink-0">
          <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={sw} className="stroke-muted-foreground/25" />
          {v > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              strokeWidth={sw}
              strokeLinecap="round"
              strokeDasharray={`${(c * Math.max(3, v)) / 100} ${c}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className={tone(v)}
            />
          )}
        </svg>
      );
    }

    const pct = (used: number) => `${Math.round(used)}%`;
    const grid = "grid grid-cols-[4rem_1fr_1fr] items-center gap-x-1.5";

    const isShort = (l: UsageLimit) => (l.windowMins ?? 0) <= 24 * 60;
    const perModel = (l: UsageLimit) => /·/.test(l.label);
    /** The account-wide 5-hour window and week: the row's two columns. */
    function main(limits: UsageLimit[]) {
      const wide = limits.filter((l) => !perModel(l));
      const from = wide.length ? wide : limits;
      return { short: from.find(isShort), week: from.find((l) => !isShort(l)) };
    }

    /** "4h45m", "5d8h", "12m": short enough to sit after the percent. */
    function soon(ms: number, now: number) {
      const m = Math.round((ms - now) / 60_000);
      if (m <= 0) return "已重置";
      if (m < 60) return `${m}m`;
      if (m < 24 * 60) return `${Math.floor(m / 60)}h${m % 60 ? `${m % 60}m` : ""}`;
      const h = Math.floor((m % 1440) / 60);
      return `${Math.floor(m / 1440)}d${h ? `${h}h` : ""}`;
    }
    const when = (ms: number) => {
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 重置`;
    };

    // Adapter errors come as a JSON-RPC error object; the readable part is data.error
    function readable(error: string) {
      try {
        const e = JSON.parse(error);
        return String(e?.data?.error || e?.message || error);
      } catch {
        return error;
      }
    }

    function UsageMeter() {
      const { list, loading, refresh } = useUsage();
      const [open, setOpen] = useState(false);
      const shown = (list ?? []).filter((u) => u.data?.limits.length || u.error);
      if (!shown.length) return null;
      const now = Date.now();
      return (
        <div className="px-1.5">
          {/* A table: the column names once, a row per account (ring, percent used, and expanded, when it resets);
              expanded also lists the per-model quotas (Fable) under their account */}
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left text-[11px] hover:bg-accent/60"
            title={open ? "收起" : "看全部额度和重置时间"}
            onClick={() => setOpen((v) => !v)}
          >
            <div className={ui.cn(grid, "text-[10px] text-muted-foreground/70")}>
              <span />
              <span>5 小时</span>
              <span>本周</span>
            </div>
            {shown.map((u) => {
              const limits = u.data?.limits ?? [];
              const name = u.agent === "claude" ? "Claude" : u.agent === "codex" ? "Codex" : u.name;
              const { short, week } = main(limits);
              const cell = (l?: UsageLimit) =>
                l ? (
                  <span className="flex min-w-0 items-center gap-1" title={`${l.label} 用了 ${pct(l.percent)}${l.resetsAt ? ` · ${when(l.resetsAt)}` : ""}`}>
                    <Ring used={l.percent} size={12} />
                    <span className="w-[29px] shrink-0 tabular-nums">{pct(l.percent)}</span>
                    {open && !!l.resetsAt && <span className="truncate text-[10px] text-muted-foreground/70 tabular-nums">{soon(l.resetsAt, now)}</span>}
                  </span>
                ) : (
                  <span className="text-muted-foreground/40">–</span>
                );
              return (
                <React.Fragment key={u.agent}>
                  <div className={ui.cn(grid, "py-[3px]")}>
                    <span
                      className={ui.cn("truncate", u.error && "text-warn")}
                      title={`${name}${u.data?.plan ? ` · ${u.data.plan}` : ""}${u.error ? `：${readable(u.error)}` : ""}`}
                    >
                      {name}
                    </span>
                    {limits.length === 0 ? (
                      <span className="col-span-2 truncate text-warn" title={u.error ? readable(u.error) : undefined}>
                        拿不到
                      </span>
                    ) : (
                      <>
                        {cell(short)}
                        {cell(week)}
                      </>
                    )}
                  </div>
                  {open &&
                    limits
                      .filter((l) => l !== short && l !== week)
                      .map((l) => (
                        <div key={l.kind + l.label} className={ui.cn(grid, "py-[3px]")}>
                          <span className="truncate pl-2.5 text-[10px] text-muted-foreground">{l.label.split(/\s*·\s*/)[1] ?? l.label}</span>
                          {isShort(l) ? cell(l) : <span />}
                          {isShort(l) ? <span /> : cell(l)}
                        </div>
                      ))}
                </React.Fragment>
              );
            })}
          </button>
          {open && (
            <div className="flex items-center px-2 pb-1 text-[10px] text-muted-foreground">
              <span className="flex-1 tabular-nums">
                {shown[0]?.at ? `${new Date(shown[0].at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 更新` : ""}
              </span>
              <button type="button" className="flex items-center gap-1 rounded-sm px-1 hover:text-foreground" onClick={refresh} disabled={loading}>
                <icons.RefreshCw className={ui.cn("size-3", loading && "animate-spin")} /> 刷新
              </button>
            </div>
          )}
        </div>
      );
    }

    // Below the "today" block when both are installed
    return g.slot("sidebar", UsageMeter, { order: 10 });
  },
});
