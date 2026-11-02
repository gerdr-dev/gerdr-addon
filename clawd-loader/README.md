# Pixel Clawd

Seven pixel Clawds for Gerdr: put one in place of the 3×3 working dots in front of a running turn ("Pondering…"),
and any of them as an agent's icon.

![Demo](demo.gif)

- **Running**: it walks and plays with its prop (the pirate fences, the detective sweeps the magnifier, the engineer
  turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag, the astronaut floats).
- **Waiting on you** (a permission, a question): it stands still, breathing, and waves its free claw.
- **As an icon**: the costume standing still, since the session list is always in sight.

![Seven costumes](costumes.png)

## Using it

Installing it changes nothing by itself; the Clawds are sprites you place:

- **Working indicator**: Settings → General → Loading 动画, pick a costume. Gerdr's own ones are in the same list.
- **Agent icon**: Settings → Agent, edit a role, pick a costume below the built-in icons.

Each place can have its own costume.

## Requires

Gerdr from November 2026 with Settings → General → Loading 动画 (`g.slot("sprite")`); an older one shows "update Gerdr
first" under the add-on in Settings.

## Credits

The pixel art and animations come from [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress)
by johnnyvizz (MIT), itself traced from DockCrab. Clawd is Anthropic's mascot; this is an unofficial community add-on,
not affiliated with or endorsed by Anthropic.
