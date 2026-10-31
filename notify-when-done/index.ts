/// <reference path="../gerdr.d.ts" />
// A session finished, or waits for an approval, while it isn't in front of you: a system notification.
// (gerdr already marks it in the sidebar; this also shows how g.on and g.notify are used.)
export default defineAddon({
  setup(g) {
    const off1 = g.on("turnEnd", (e) => {
      if (!e.visible) g.notify(`${e.session.title || e.session.agent} 跑完了`, { system: true });
    });
    const off2 = g.on("needsInput", (e) => {
      if (!e.visible) g.notify(`${e.session.title || e.session.agent} 在等你`, { system: true });
    });
    return () => {
      off1();
      off2();
    };
  },
});
