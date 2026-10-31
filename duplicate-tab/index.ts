/// <reference path="../gerdr.d.ts" />
// prefix+a duplicates the current tab after itself, prefix+i before (tmux's a / i).
// What is duplicated is the workplace: the same folder and the same agent, in a new session — the conversation
// itself can't be copied.
export default defineAddon({
  setup(g) {
    const dup = (where: "after" | "before") => async () => {
      const tab = g.state().activeTab;
      if (tab) await g.actions.duplicateTab(tab.id, where);
    };
    const a = g.command({ id: "duplicate-tab.after", title: "Duplicate tab (after)", key: "prefix+a", run: dup("after") });
    const b = g.command({ id: "duplicate-tab.before", title: "Duplicate tab (before)", key: "prefix+i", run: dup("before") });
    return () => {
      a();
      b();
    };
  },
});
