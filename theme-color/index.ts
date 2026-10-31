/// <reference path="../gerdr.d.ts" />
// Recolors gerdr's accent (the brand token: user bubbles, buttons, links) with the color picked in Settings → Add-ons.
// A function theme, so a changed setting applies at once without reloading.

export default defineAddon({
  setup(g) {
    if (typeof g.theme !== "function") throw new Error("需要 Gerdr 0.2.14 或更新的版本");
    return g.theme(() => {
      const c = g.settings.get<string>("color");
      if (!/^#[0-9a-f]{6}$/i.test(c ?? "")) return;
      // On a dark background links and bubbles need light: lift it, and never below gerdr's own dark brand (0.7), or a
      // dark pick (gray, navy) leaves links unreadable
      const dark = g.settings.get<string>("dark") === "same" ? c : `oklch(from ${c} clamp(0.7, calc(l + 0.1), 0.85) c h)`;
      // The focus ring follows the accent: gerdr's own ring is its blue, which clashes with any other pick
      return { light: { brand: c, ring: c }, dark: { brand: dark, ring: dark } };
    });
  },
});
