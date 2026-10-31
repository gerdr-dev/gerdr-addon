# gerdr-addon

The default add-on store of [gerdr](https://github.com/gerdr-dev/gerdr). Open Settings → Add-ons → Store in gerdr to
browse and install these; nothing to run by hand.

| add-on | what it does |
|---|---|
| [duplicate-tab](duplicate-tab) | `prefix+a` / `prefix+i` duplicates the current tab after / before itself |
| [notify-when-done](notify-when-done) | a system notification when a session you can't see finishes or waits for you |
| [session-title](session-title) | example: retitle a session every 5 messages, the agent in front |

## Writing one

An add-on is a folder with an `addon.json` (that is how a store finds it) and an `index.ts`:

```
my-addon/
  addon.json   {"name": "…", "version": "1.0.0", "description": "…", "icon": "icon.png"}
  index.ts     export default defineAddon({ setup(g) { … } })
  README.md    shown under "说明" in the store
  icon.png     optional; any file the add-on ships is reachable as g.asset("…")
```

The API is in [gerdr.d.ts](gerdr.d.ts) (a copy of the one gerdr writes into `~/.gerdr/addons`). To try an add-on
while writing it, either put its folder in `~/.gerdr/addons` (saving reloads it), or add this repository's folder as
a store in Settings → Add-ons → Store (an absolute path works as a store) and install from there.

Any GitHub repository laid out like this one is a store: add it as `owner/repo` in the Store tab.
