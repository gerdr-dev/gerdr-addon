/// <reference path="../gerdr.d.ts" />
// The UI half only lays out the settings (the work is all in service.mjs): the switch first, and the chat / delay only
// while it is on, since off they do nothing. With no chat add-on installed the chat picker has nothing to offer: say
// what to do in a line that stands out, rather than leave it to the picker's description.

export default defineAddon({
  setup(g) {
    const zh = g.locale() === "zh";
    return g.slot("settings", ({ Field, values }) => (
      <div className="space-y-2.5">
        <Field name="on" />
        {values.on !== false && (
          <div className="space-y-2.5 border-l-2 border-border pl-2.5">
            <Field name="chat" />
            {/* A required select is missing only when there is nothing to pick */}
            {values.chat == null && (
              <div className="flex items-center gap-1.5 rounded-sm bg-warn/10 px-2 py-1.5 text-[12px] text-warn">
                <g.icons.CircleAlert className="size-3.5 shrink-0" />
                {zh
                  ? "还没有能收发私信的聊天插件：先在「商店」里装一个，比如 Slack，再回来选它。"
                  : "No chat add-on that does direct messages yet: install one from the Store (e.g. Slack), then pick it here."}
              </div>
            )}
            <Field name="delay" />
          </div>
        )}
      </div>
    ));
  },
});
