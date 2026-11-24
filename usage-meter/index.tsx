/// <reference path="../gerdr.d.ts" />
// The Claude Code / Codex quotas at the bottom of the sidebar: one row per account, always in sight, without typing
// /usage (which goes into the conversation). Collapsed it shows the two that matter (the 5-hour window and the week;
// a per-model weekly quota at 0% steps aside); click for every quota and when it resets.
// Each quota is its percent used and a ring filled by it; expanded, the 5-hour window and the week sit side by side
// with the reset countdown under each, so the list stays short.
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

    /** Expanded, the quotas go two to a row: the 5-hour window left, the week right, each extra one (a per-model
     * week) on a row of its own in its period's column. */
    function columns(limits: UsageLimit[]) {
      const isShort = (l: UsageLimit) => (l.windowMins ?? 0) <= 24 * 60;
      const shorts = limits.filter(isShort);
      const longs = limits.filter((l) => !isShort(l));
      const out: (UsageLimit | null)[] = [shorts.shift() ?? null, longs.shift() ?? null];
      for (const l of shorts) out.push(l, null);
      for (const l of longs) out.push(null, l);
      return out;
    }

    // "5 小时" → "5h", "本周" → "周": two have to fit on one collapsed row
    const short = (label: string) =>
      label
        .replace(/^(\d+) 小时$/, "$1h")
        .replace(/^本周$/, "周")
        .replace(/^本周 · /, "周·");

    /** "4h 12m 后重置", "5d 8h 后重置"; the date and time go in the tooltip. */
    function resetIn(ms: number, now: number) {
      const m = Math.round((ms - now) / 60_000);
      if (m <= 0) return "已重置";
      const d = Math.floor(m / 1440);
      const h = Math.floor((m % 1440) / 60);
      const rest = m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${h}h${m % 60 ? ` ${m % 60}m` : ""}` : `${d}d${h ? ` ${h}h` : ""}`;
      return `${rest} 后重置`;
    }
    const when = (ms: number) => {
      const d = new Date(ms);
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 重置`;
    };

    // The short window first, then the week; a per-model quota at 0% goes last
    function pick(limits: UsageLimit[]) {
      const rank = (l: UsageLimit) => (l.percent === 0 && /·/.test(l.label) ? 2 : 0) + ((l.windowMins ?? 0) > 24 * 60 ? 1 : 0);
      return [...limits].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
    }

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
          {/* py-1.5 plus each row's py-0.5 = 8px, the same as px-2 at the sides, so the hover fill is even all round */}
          <button
            type="button"
            className="w-full rounded-md px-2 py-1.5 text-left hover:bg-accent/60"
            title={open ? "收起" : "看全部额度和重置时间"}
            onClick={() => setOpen((v) => !v)}
          >
            {shown.map((u) => {
              const limits = u.data?.limits ?? [];
              const name = u.agent === "claude" ? "Claude" : u.agent === "codex" ? "Codex" : u.name;
              return (
                <div key={u.agent} className={ui.cn("py-0.5", open && "mt-1.5 first:mt-0")}>
                  {open ? (
                    <>
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-[12px] font-semibold">{name}</span>
                        {u.data?.plan && <span className="text-[11px] text-muted-foreground">{u.data.plan}</span>}
                        {u.error && (
                          <span className="ml-auto truncate text-[11px] text-warn" title={readable(u.error)}>
                            {u.data ? "没刷新上" : "拿不到"}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                        {columns(limits).map((l, i) =>
                          l ? (
                            <div
                              key={l.kind + l.label}
                              className="min-w-0"
                              title={`${l.label} 用了 ${pct(l.percent)}${l.resetsAt ? ` · ${when(l.resetsAt)}` : ""}`}
                            >
                              <div className="flex items-center gap-1.5">
                                <span className="min-w-0 truncate text-muted-foreground">{short(l.label)}</span>
                                <span className="ml-auto shrink-0 tabular-nums">{pct(l.percent)}</span>
                                <Ring used={l.percent} size={12} />
                              </div>
                              {!!l.resetsAt && <div className="truncate text-[10px] text-muted-foreground tabular-nums">{resetIn(l.resetsAt, now)}</div>}
                            </div>
                          ) : (
                            <span key={i} />
                          ),
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="w-11 shrink-0 truncate text-muted-foreground">{name}</span>
                      {limits.length === 0 && (
                        <span className="truncate text-warn" title={u.error ? readable(u.error) : undefined}>
                          拿不到
                        </span>
                      )}
                      {pick(limits).map((l) => (
                        <span
                          key={l.kind + l.label}
                          className="flex min-w-0 flex-1 items-center gap-1"
                          title={`${l.label} 用了 ${Math.round(l.percent)}%${l.resetsAt ? ` · ${resetIn(l.resetsAt, now)}` : ""}`}
                        >
                          <span className="shrink-0 text-muted-foreground">{short(l.label)}</span>
                          <span className="min-w-0 truncate tabular-nums">{pct(l.percent)}</span>
                          <Ring used={l.percent} size={12} />
                        </span>
                      ))}
                    </div>
                  )}
                </div>
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
