/// <reference path="../gerdr.d.ts" />
// Is the prompt cache still warm? Watches the time under the newest finished Claude Code turn:
// nothing while the cache surely holds, a yellow note in its last minutes, a red one once it expired — then the next message
// reads the whole conversation at full price (and slower).
//
// The cache lives TTL minutes from the start of the last request that read or wrote it (Claude Code on a subscription
// uses the 1-hour TTL; API keys and usage overage get 5 minutes: set it in Settings → Add-ons). The turn's end
// time is a little later than that start, so the estimate errs on the warm side by the last request's own duration.

export default defineAddon({
  setup(g) {
    return g.turnStat((t) => {
      if (!t.latest || !t.ts || t.agent !== "claude") return;
      // Read each time: a change in Settings → Add-ons applies at once
      const ttl = (g.settings.get<number>("ttlMinutes") || 60) * 60_000;
      const warn = Math.min((g.settings.get<number>("warnMinutes") || 10) * 60_000, ttl);
      const left = t.ts + ttl - t.now;
      // Warm: say nothing, the line stays as it was. Only the last stretch and the expired state speak up, in a small
      // pill beside the time (text, not a tooltip: a phone has no hover)
      if (left >= warn) return;
      const expired = left <= 0;
      const text = expired ? "缓存已过期" : left < 60_000 ? "缓存不到 1 分钟就过期" : `缓存 ${Math.round(left / 60_000)} 分钟后过期`;
      return {
        className: expired ? "text-bad" : "text-warn",
        title: expired ? "下一句会全价重读整段对话" : undefined,
        after: <span className={g.ui.cn("ml-1 rounded-sm px-1.5 text-[11px] leading-[18px]", expired ? "bg-bad/10 text-bad" : "bg-warn/10 text-warn")}>{text}</span>,
      };
    });
  },
});
