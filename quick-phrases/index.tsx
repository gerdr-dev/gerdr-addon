/// <reference path="../gerdr.d.ts" />
// Phrases you type all day, one click away: a ⚡ button in the composer's bottom bar opens the list, a pick is added
// to what you are typing. Also a right-click item that quotes the selected text into that pane's composer.
// The list is kept per browser / App (g.storage); edit it from the command palette.

const DEFAULTS = ["继续", "先提交一下", "跑一下测试，有失败就修", "解释一下你刚才改了什么、为什么"];

export default defineAddon({
  setup(g) {
    const { React, ui, icons } = g;
    const { useState } = React;
    const phrases = () => g.storage.get<string[]>("phrases") ?? DEFAULTS;

    // The composer this click came from: run(ctx) fires on the button's click, before a phrase is picked.
    let target: ComposerContext | null = null;

    // A composerAction's icon can be any element: here a popover trigger, so the button opens the list itself.
    function Picker() {
      const [open, set] = useState(false);
      return (
        <ui.Popover open={open} onOpenChange={set}>
          <ui.PopoverTrigger asChild>
            <span className="flex items-center">
              <icons.Zap className="size-3.5" />
            </span>
          </ui.PopoverTrigger>
          <ui.PopoverContent side="top" align="start" className="w-64 p-1">
            {phrases().map((p) => (
              <button
                key={p}
                type="button"
                className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-[13px] hover:bg-accent"
                onClick={() => {
                  if (target) target.insert((target.text && !target.text.endsWith(" ") ? " " : "") + p);
                  set(false);
                }}
              >
                {p}
              </button>
            ))}
          </ui.PopoverContent>
        </ui.Popover>
      );
    }

    const offs = [
      g.composerAction({
        id: "quick-phrases.open",
        title: "常用短语",
        icon: <Picker />,
        run(ctx) {
          target = ctx;
        },
      }),
      g.contextMenu({
        id: "quick-phrases.quote",
        title: "引用到输入框",
        when: (ctx) => !!ctx.selection.trim() && !!ctx.sessionId,
        run(ctx) {
          const quoted = ctx.selection.trim().replace(/^/gm, "> ");
          g.actions.insertText(ctx.sessionId!, quoted + "\n\n");
        },
      }),
      g.command({
        id: "quick-phrases.edit",
        title: "编辑常用短语",
        run() {
          const text = prompt("常用短语，一行一条：", phrases().join("\n"));
          if (text == null) return;
          const list = text.split("\n").map((s) => s.trim()).filter(Boolean);
          g.storage.set("phrases", list.length ? list : DEFAULTS);
          g.notify(`常用短语：${list.length || DEFAULTS.length} 条`);
        },
      }),
    ];
    return () => offs.forEach((off) => off());
  },
});
