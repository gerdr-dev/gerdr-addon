/// <reference path="../gerdr.d.ts" />
// Lid awake: a rail button that turns "don't sleep, even with the lid closed" on and off. The work is done by the
// service (service.sh, pmset disablesleep); this half only draws its state and sends it commands. The state shown
// is always what the service last reported, never a guess, so a window reloaded or a backend restarted shows the
// truth as soon as the (new) service speaks.

type State = {
  on: boolean; // the person's choice (kept in a file: it survives restarts)
  active: boolean; // disablesleep is on right now
  low: boolean; // on battery at or under lowLine: let go for now
  ready: boolean; // the sudoers rule is there
  percent: number; // -1 = no battery
  onBattery: boolean;
  lowLine: number;
  error: string;
};

export default defineAddon({
  setup(g) {
    const { useState, useEffect } = g.React;
    const zh = g.locale() === "zh";
    const tx = (a: string, b: string) => (zh ? a : b);

    let state: State | undefined;
    const subs = new Set<() => void>();
    const offMsg = g.service.on("message", (d: State) => {
      state = d;
      subs.forEach((f) => f());
    });
    // A window opened after the service's last report asks for one
    g.service.send({ cmd: "status" }).catch(() => {});
    const offStatus = g.service.on("status", () => subs.forEach((f) => f()));

    function useState_() {
      const [, re] = useState(0);
      useEffect(() => {
        const f = () => re((n) => n + 1);
        subs.add(f);
        return () => {
          subs.delete(f);
        };
      }, []);
      return state;
    }
    const running = () => g.service.status()?.state === "running";
    const send = (cmd: string) =>
      g.service.send({ cmd }).catch((e) => g.notify(tx("合盖不休眠：", "Lid awake: ") + String(e?.message ?? e)));
    const toggle = () => send("toggle");

    // g.ui.Icon draws every kind an "icon" setting can hold (glyphs, sprites from picture add-ons, lucide names);
    // older Gerdr builds lack it, so fall back to a lucide name there
    function Pic({ icon, className, moving }: { icon: string; className?: string; moving?: boolean }) {
      const Icon = (g.ui as any).Icon;
      // "working": a sprite plays its own animation (Pixel Clawd walks); "idle" is its still picture
      if (Icon) return <Icon icon={icon} className={className} state={moving ? "working" : "idle"} />;
      const L = g.icons[icon] ?? g.icons.Coffee;
      return <L className={className} />;
    }

    const title = (s?: State) =>
      !s
        ? tx("合盖不休眠", "Lid awake")
        : s.error
          ? s.error
          : s.active
            ? tx("合盖不休眠：开着（点一下关）", "Lid awake: on (click to turn off)")
            : s.on && s.low
              ? tx(`合盖不休眠：电量 ≤ ${s.lowLine}%，暂时放手`, `Lid awake: battery ≤ ${s.lowLine}%, let go for now`)
              : tx("合盖不休眠：关着（点一下开）", "Lid awake: off (click to turn on)");

    const animated = (on: boolean) => {
      const a = g.settings.get<string>("animate") ?? "on";
      return a === "always" || (a === "on" && on);
    };
    const iconOf = (on: boolean) => g.settings.get<string>(on ? "iconOn" : "iconOff") || (on ? "Coffee" : "Moon");
    const look = (s?: State) =>
      g.ui.cn(!s || !running() ? "opacity-50" : "", s?.error ? "text-bad" : s?.active ? "bg-brand/15 text-brand hover:bg-brand/25 hover:text-brand" : s?.on ? "bg-warn/15 text-warn" : "");

    // The whole rail button is ours ("railButton" slot): a click toggles, hovering shows the details. Gerdr hands
    // its own button classes (size, colours, hover) so it sits like its neighbours; the state goes on top.
    function RailButton({ place, className }: { place: "rail" | "phone"; className: string }) {
      const s = useState_();
      const on = !!s?.on;
      const [open, setOpen] = useState(false);
      const timer = g.React.useRef(0);
      // Mouse only: a tap sends pointerenter too, and the tap is the toggle
      const hover = (v: boolean) => (e: any) => {
        if (e.pointerType !== "mouse") return;
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setOpen(v), v ? 400 : 200);
      };
      useEffect(() => () => clearTimeout(timer.current), []);
      const Content = g.ui.PopoverContent as any;
      return (
        <g.ui.Popover open={open} onOpenChange={setOpen}>
          <g.ui.PopoverTrigger asChild>
            <button
              role="switch"
              aria-checked={on}
              aria-label={title(s)}
              className={g.ui.cn(className, look(s))}
              onPointerEnter={hover(true)}
              onPointerLeave={hover(false)}
              onClick={(e: any) => {
                e.preventDefault(); // the trigger would open the popup: a click is the switch
                clearTimeout(timer.current); // the hover that led to the click doesn't pop the details up after it
                setOpen(false);
                toggle();
              }}
            >
              <Pic icon={iconOf(on)} className={place === "rail" ? "size-5" : "size-4"} moving={animated(on)} />
            </button>
          </g.ui.PopoverTrigger>
          <Content
            side={place === "rail" ? "right" : "top"}
            align={place === "rail" ? "end" : "center"}
            className="w-72 p-0 py-1.5"
            onPointerEnter={hover(true)}
            onPointerLeave={hover(false)}
            onOpenAutoFocus={(e: any) => e.preventDefault()}
          >
            <Panel />
          </Content>
        </g.ui.Popover>
      );
    }

    // Gerdr before the "railButton" slot: the face of a panel button, taking the click itself
    function Face({ width, height }: { width: number; height: number }) {
      const s = useState_();
      const on = !!s?.on;
      return (
        <span
          role="switch"
          aria-checked={on}
          title={title(s)}
          onClick={(e: any) => {
            e.stopPropagation();
            e.preventDefault();
            toggle();
          }}
          style={{ width, height }}
          className="flex cursor-pointer items-center justify-center"
        >
          <span style={{ width: height, height }} className={g.ui.cn("flex items-center justify-center rounded-md", look(s) || "text-muted-foreground")}>
            <Pic icon={iconOf(on)} className="size-4" moving={animated(on)} />
          </span>
        </span>
      );
    }

    function power(s: State) {
      if (s.percent < 0) return tx("插着电（没有电池）", "On power (no battery)");
      return s.onBattery ? tx(`用电池，${s.percent}%`, `On battery, ${s.percent}%`) : tx(`插着电，${s.percent}%`, `On power, ${s.percent}%`);
    }

    function Panel() {
      const s = useState_();
      if (!s || !running())
        return <div className="px-3.5 py-1 text-[12px] text-muted-foreground">{tx("后台进程还没起来…", "The service isn't running yet…")}</div>;
      return (
        <div className="space-y-1.5 px-3.5 py-1 text-[12px]">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{tx("合上盖子也不睡", "Stay awake with the lid closed")}</span>
            <g.ui.Switch checked={s.on} onCheckedChange={(v) => send(v ? "on" : "off")} />
          </div>
          <div className={s.error ? "text-bad" : s.active ? "text-ok" : s.on && s.low ? "text-warn" : "text-muted-foreground"}>{title(s)}</div>
          <div className={s.onBattery && s.percent >= 0 && s.percent <= s.lowLine ? "text-warn" : "text-muted-foreground"}>
            {power(s)}
            {s.lowLine > 0
              ? tx(` · 用电池且 ≤ ${s.lowLine}% 时放手`, ` · lets go on battery at ≤ ${s.lowLine}%`)
              : tx(" · 电量低也不放手", " · never lets go on low battery")}
          </div>
          {!s.ready && (
            <g.ui.Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => send("authorize")}>
              {tx("授权（在电脑上输一次密码）", "Authorize (password once, on this computer)")}
            </g.ui.Button>
          )}
        </div>
      );
    }

    // Settings drawn by us only for the authorize row: a plain "action" button can't say it's already done. The rest
    // are Gerdr's own fields
    function Settings({ Field }: { Field: any }) {
      const s = useState_();
      return (
        <div className="space-y-2.5">
          <Field name="iconOff" />
          <Field name="iconOn" />
          <Field name="animate" />
          <Field name="lowBattery" />
          <div className="text-[12px]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{tx("授权", "Authorize")}</span>
              {s?.ready ? (
                <span className="flex items-center gap-1 text-ok">
                  <g.icons.Check className="size-3.5" />
                  {tx("已授权", "Authorized")}
                </span>
              ) : (
                <g.ui.Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={!s} onClick={() => send("authorize")}>
                  {tx("授权", "Authorize")}
                </g.ui.Button>
              )}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {s?.ready
                ? tx("sudo 已放行 pmset disablesleep，不用再输密码。", "sudo already allows pmset disablesleep: no password needed.")
                : tx(
                    "装一条 sudoers 规则，只放行 pmset disablesleep 1 / 0；在电脑上输一次密码。",
                    "Installs a sudoers rule allowing only pmset disablesleep 1 / 0; enter your password once on this computer.",
                  )}
            </div>
          </div>
        </div>
      );
    }
    g.slot("settings", Settings);

    try {
      g.slot("railButton", RailButton);
    } catch {
      g.slot("panel", Panel, { title: tx("合盖不休眠", "Lid awake"), icon: Face, open: "click" });
    }
    g.command({ id: "lid-awake.toggle", title: tx("合盖不休眠：开 / 关", "Lid awake: toggle"), run: toggle });
    g.settings.onAction("authorize", () => send("authorize"));
    return () => {
      offMsg();
      offStatus();
    };
  },
});
