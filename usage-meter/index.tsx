/// <reference path="../gerdr.d.ts" />
// The Claude Code / Codex quotas at the bottom of the sidebar: one row per account, always in sight, without typing
// /usage (which goes into the conversation). Collapsed it shows the two that matter (the 5-hour window and the week;
// a per-model weekly quota at 0% steps aside); click for every quota and when it resets.
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

    const tone = (pct: number) => (pct >= 90 ? "bg-bad" : pct >= 70 ? "bg-warn" : "bg-brand");

    function Bar({ pct, className }: { pct: number; className?: string }) {
      return (
        <div className={ui.cn("h-1 overflow-hidden rounded-full bg-muted", className)}>
          <div className={ui.cn("h-full rounded-full", tone(pct))} style={{ width: `${Math.min(100, Math.max(pct > 0 ? 3 : 0, pct))}%` }} />
        </div>
      );
    }

    // "5 小时" → "5h", "本周" → "周": two have to fit on one collapsed row
    const short = (label: string) => label.replace(/^(\d+) 小时$/, "$1h").replace(/^本周$/, "周").replace(/^本周 · /, "周·");

    function fmtReset(ms: number, now: number) {
      const d = new Date(ms);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      const left = ms - now;
      if (left <= 0) return `${when} 重置`;
      const mins = Math.round(left / 60_000);
      const rest = mins < 60 ? `${Math.max(1, mins)}m` : mins < 48 * 60 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)} 天`;
      return `${when} 重置 · 还剩 ${rest}`;
    }

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
                <div key={u.agent} className="py-0.5">
                  {open ? (
                    <>
                      <div className="flex items-baseline gap-1.5 text-[11px]">
                        <span className="font-medium">{name}</span>
                        {u.data?.plan && <span className="text-muted-foreground">{u.data.plan}</span>}
                        {u.error && (
                          <span className="ml-auto truncate text-warn" title={readable(u.error)}>
                            {u.data ? "没刷新上" : "拿不到"}
                          </span>
                        )}
                      </div>
                      {limits.map((l) => (
                        <div key={l.kind + l.label} className="mt-1">
                          <div className="flex items-baseline gap-2 text-[11px]">
                            <span className="min-w-0 flex-1 truncate text-muted-foreground">{l.label}</span>
                            <span className="tabular-nums">{Math.round(l.percent)}%</span>
                          </div>
                          <Bar pct={l.percent} className="mt-0.5" />
                          {!!l.resetsAt && <div className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{fmtReset(l.resetsAt, now)}</div>}
                        </div>
                      ))}
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
                        <span key={l.kind + l.label} className="flex min-w-0 flex-1 items-center gap-1" title={`${l.label} ${Math.round(l.percent)}%`}>
                          <span className="shrink-0 text-muted-foreground">{short(l.label)}</span>
                          <Bar pct={l.percent} className="min-w-3 flex-1" />
                          <span className="shrink-0 tabular-nums">{Math.round(l.percent)}%</span>
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
