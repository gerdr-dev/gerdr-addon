/// <reference path="../gerdr.d.ts" />
// Is the prompt cache still warm? Colors the time under the newest finished Claude Code turn by how long ago it ended:
// green while the cache surely holds, yellow in its last minutes, red once it has expired — then the next message
// reads the whole conversation at full price (and slower).
//
// The cache lives TTL minutes from the start of the last request that read or wrote it (Claude Code on a subscription
// uses the 1-hour TTL; API keys and usage overage get 5 minutes: change it in the command palette). The turn's end
// time is a little later than that start, so the estimate errs on the warm side by the last request's own duration.

const WARN_BEFORE = 0.15; // the last 15% of the TTL is yellow (9 of 60 minutes, 45s of 5)

export default defineAddon({
  setup(g) {
    const ttlMin = () => g.storage.get<number>("ttlMinutes") ?? 60;

    const offs = [
      g.turnStat((t) => {
        if (!t.latest || !t.ts || t.agent !== "claude") return;
        const ttl = ttlMin() * 60_000;
        const left = t.ts + ttl - t.now;
        const mins = Math.max(0, Math.round(left / 60_000));
        if (left <= 0) return { className: "text-bad", title: `提示缓存已过期（按 ${ttlMin()} 分钟算）：下一句会全价重读整段对话` };
        if (left < ttl * WARN_BEFORE) return { className: "text-warn", title: `提示缓存快过期了：约剩 ${mins} 分钟（按 ${ttlMin()} 分钟算）` };
        return { className: "text-ok", title: `提示缓存还在：约剩 ${mins} 分钟（按 ${ttlMin()} 分钟算）` };
      }),
      g.command({
        id: "cache-clock.ttl",
        title: "缓存时钟：切换 1 小时 / 5 分钟",
        run() {
          const next = ttlMin() === 60 ? 5 : 60;
          g.storage.set("ttlMinutes", next);
          g.notify(`缓存时钟按 ${next === 60 ? "1 小时" : "5 分钟"}算`);
        },
      }),
    ];
    return () => offs.forEach((off) => off());
  },
});
