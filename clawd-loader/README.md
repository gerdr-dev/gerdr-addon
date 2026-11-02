# Pixel Clawd

Replaces the 3×3 working dots in front of a running turn ("Pondering…") with a pixel Clawd.

![Demo](demo.gif)

- **Running**: it walks and plays with its prop (the pirate fences, the detective sweeps the magnifier, the engineer
  turns the wrench, the chef tosses the omelette, the racer runs with a fluttering flag, the astronaut floats).
- **Waiting on you** (a permission, a question): it stands still, breathing, and waves its free claw.

![Seven costumes](costumes.png)

## Add-on button face

It also offers a face for Gerdr's add-on buttons (the column on the far left): the chosen costume, standing still,
since that column is always in sight. Settings → Add-ons → 分组, click a group's icon, pick "Pixel Clawd" under the
add-on faces.

## Settings

Settings → Add-ons → Pixel Clawd:

- **Replace the working dots** (on by default): switch it off to keep Gerdr's own dots and use Clawd only as a
  button face.
- **Costume**: Classic, Pirate, Detective, Engineer, Chef, Racer, Astronaut.
- **Size**: Small 18×12 (default) or Medium 24×16. Medium is one CSS pixel per grid cell, so its edges are crisper.

Switch it off or remove it to get Gerdr's dots back.

## Requires

Gerdr from November 2026 (`g.slot("loader")`); an older one shows "update Gerdr first" under the add-on in Settings.
The button face and the switch above need a Gerdr with Settings → Add-ons → 分组; without it you just can't pick the
face, and the switch can't bring the dots back.

## Credits

The pixel art and animations come from [savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress)
by johnnyvizz (MIT), itself traced from DockCrab. Clawd is Anthropic's mascot; this is an unofficial community add-on,
not affiliated with or endorsed by Anthropic.
