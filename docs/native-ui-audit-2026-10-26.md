# Native menu UI audit — 26 October 2026

> Historical audit snapshot. The subsequent [menu implementation follow-up](native-parity-2026-10-26.md#menu-feature-completion-follow-up) implements presets/search/HUD editing, onboarding, gamepad navigation and live native Loadout previews. Custom CSS is now intentionally out of scope. Platform qualification remains open.
Scope: the embedded WebView menu of `feat/native-web-parity-20261026` (`native/apps/native/ui`, the shared copy in `native/apps/web/src`) against the current web client (`bunnyhop-gfx-native/apps/web/src`). It covers routes, the bridge, profile rendering and actions, loading/error/empty states, navigation and window sizes. Native gameplay, C++ and Rust code were read only where the menu depends on them. They were not changed.

Method: source review; the repo's mocked Playwright tests; and a scratch harness against the built `target/native-menu/menu.html`. The harness used fixture GET responses and refused every non-GET request with 409. No account, payment, public chat or score endpoint received a successful write. The harness ran in Chromium and in Playwright WebKit 26.6, which is closer to the WKWebView/WebKitGTK menus. The harness, screenshots and its report are in `native/artifacts/native-ui-audit-20261026/`, which Git ignores.

## Fixed in this pass

| # | Defect (evidence) | Fix |
| --- | --- | --- |
| 1 | **Back/Esc always went Home.** Harness: Maps → profile → Esc = `home`, and Ranks → profile → Back = `home`. The web returns to the screen that opened the profile (`menu.ts` push/pop). | A bounded back stack (16 entries) stores each screen's profile, gauntlet and Loadout state, and Home clears it: [`main.ts:121`](../native/apps/native/ui/main.ts#L121), [`back()` `main.ts:133`](../native/apps/native/ui/main.ts#L133). Gauntlet page → Esc → hub still works. |
| 2 | **After a map was picked from Maps, a profile or Ranks, the in-game Esc reopened that browser screen**, not the pause menu. The host only shows or hides the WebView, so the menu stayed on `maps` (harness: `["maps","maps"]`). | When a different map comes up and no replay is playing, browse screens reset to the pause menu. Picking the map that is already loaded resets the menu the same way. Room, Replays, Settings and Tutorial keep their own screen: [`main.ts:140`](../native/apps/native/ui/main.ts#L140), [`main.ts:263`](../native/apps/native/ui/main.ts#L263), [`main.ts:113`](../native/apps/native/ui/main.ts#L113). |
| 3 | **`navigate({screen:"loadout", slot})` dropped the slot.** The unlock celebration's Equip ([`unlocks.ts:376`](../native/apps/web/src/ui/unlocks.ts#L376), which is in the bundle) always opened the Knife category. | The slot now passes to the shared Loadout ([`cosmetics.ts:28`](../native/apps/native/ui/cosmetics.ts#L28), [`main.ts:328`](../native/apps/native/ui/main.ts#L328)). The host can also call `open('loadout', slot)`, matching `open('settings', section)`. |
| 4 | **Profile overlapped at narrow or short windows** (800×600, 960×540, 1280×480). The web stacks the profile and scrolls the page. The native body is the scroller, so the stacked grid squeezed the card over the runs column. | Under the web's own breakpoint, the stacked layout keeps its content height: [`native.css:89`](../native/apps/native/ui/native.css#L89). |
| 5 | **Loadout stage: dead "First person / Close-up" buttons sat under the caption strip.** The static stage draws the same image for both views. | The control is hidden for the static stage, alongside the existing hidden Inspect and Drag controls ([`support-panel.css:12`](../native/apps/native/ui/support-panel.css#L12)). |
| 6 | **Every thumbnail had a 12 px item name baked into the canvas**, repeating the name printed under the tile. | Removed the caption from the canvas ([`loadout-stage.ts`](../native/apps/native/ui/loadout-stage.ts)). |
| 7 | **The stage canvas was pinned to the top with `height:auto`.** Support's tall stage was about 60 % empty. The stage also painted its own grey rectangle over the web's stage lighting for each rarity and supporter set. | The canvas fills and centres like the web `.lo-canvas` ([`support-panel.css:8`](../native/apps/native/ui/support-panel.css#L8)). The large preview no longer paints a background, so the themed stage shows through ([`loadout-stage.ts:24`](../native/apps/native/ui/loadout-stage.ts#L24)). |
| 8 | **The stage stretched to the full height of the item grid** on the standalone Loadout screen and on narrow profiles, which leaves the item below the fold. The web bounds the Loadout to the window; the native body scrolls. | In those contexts the stage keeps the web's 16:10 shape, aligns to the top and stays sticky while the grid scrolls ([`support-panel.css:17`](../native/apps/native/ui/support-panel.css#L17)). Measured at 1440×1000, 1920×1080, 800×600, 1440×900 signed out and 1280×720. |
| 9 | **Test gap:** the profile test's activity fixture used `Date.now()` instead of a UTC day start, so the "Last 30 days" graph rendered empty. The parity doc nevertheless said the graph was verified. | Fixed the fixture. The test now asserts one non-zero bar and "11 finishes" ([`profile-panel.browser.test.ts`](../native/apps/native/ui/profile-panel.browser.test.ts)). |

New regression test: [`menu-navigation.browser.test.ts`](../native/apps/native/ui/menu-navigation.browser.test.ts) has 2 tests and 22 assertions. It covers items 1–5 and 8, uses reads only and fails on any write. `NATIVE_UI_ENGINE=webkit` runs the same file on WebKit.

Verification after the fixes:
- `bun run check`: menu build (208 modules, no Three or game entry), typecheck, and **176 tests / 1,505 assertions / 0 failures** across 37 files.
- The new test passes on Chromium and WebKit.
- The existing profile, support and window browser tests also pass on WebKit, via one-off copies in `target/ui-audit/`.
- I inspected the screenshots.

`bridge.ts`, `settings-panel.ts` and a new `mouse-diagnostics.ts` were changed by someone else while this audit ran; that work accounts for the module count rising from 207 to 208.

## Verified working (mocked, Chromium + WebKit)

- **Routes:** every web `NavRequest` (`profile`, `ranks`, `maps`, `servers`, `stats`, `loadout`, `support`, `gauntlets`, `gauntlet`) reaches a native screen. The fallback notice in [`main.ts`](../native/apps/native/ui/main.ts) cannot be reached for the current union. URL routes cover `/u/`, `?u=`, `/replay/`, `/g/…`, `?server=`, `?map=`, `?support`, `/maps/<name>` and the auth paths. Off-site links go only through the `EXTERNAL_HOSTS` allowlist and validated Stripe checkout URLs.
- **Bridge:** `send` posts JSON through `window.webkit.messageHandlers.bunnyhop`. The Windows WebView2 shim ([`menu_webview_windows.cpp:158`](../native/apps/native/src/menu_webview_windows.cpp#L158)) and the frozen GTK shim ([`menu_webview_gtk.cpp:155`](../native/apps/native/src/menu_webview_gtk.cpp#L155)) supply that handler. The host calls `onState`, `open('room'|'settings')`, `joinRoom`, `onChatLink`, `onLeaveMap`, `onRunEvent` and `onActivity`, and all of them exist on `window.bunnyhopNativeMenu`.
- **Own profile:** card, level, rank, tier clears, featured and recent runs, top points, totals, the activity graph (after fix 9), most played, followers/following/friends, Edit card (all five tabs), a mocked cosmetic autosave, the Runs tab with PB/All replays and pin hint, and the full Loadout tab. Loadout works signed out and offline: free items save on the device.
- **Another player's profile:** Follow, Race best run, Watch/Race per run, Share and ⋯ menu, followers counts, and "Not shared yet" sensitivity.
- **States:**
  - Loading: tabs show and the content area waits.
  - 404: "Couldn't load profile · No player with that id."
  - Offline: "Leaderboard server unreachable."
  - Empty: "No ranked runs yet", "No points yet." and "No personal bests yet."
  - No page errors in either engine.
- **Window sizes:** no document overflow at 800×600, 1024×640, 1440×900 or 1920×1080 (the 800 px case needed fix 4). Keyboard arrow keys move between profile tabs.
- **Support and account (existing tests):** support tiers, gifting with a server-priced confirmation dialog, and account rename/link/sign-out controls render in both engines, with mocked writes only.

## Remaining functionality gaps (not built in the native menu)

Priority: **P1** = visible to users and shipped on the web; **P2** = noticeable drift; **P3** = nice to have.

1. **P1 — Custom CSS.** The web's Settings → Custom CSS, the `/custom-css` guide, `@import` themes and the asset proxy (`apps/web/src/custom-css/*`, `#custom-art` in `style.css`) are absent from the native bundle. These shipped on 10-25 on the web and in the desktop client. Menu theming could be ported to the WebView. The HUD is native C++, so the HUD `LIVE_VARS` would need a native counterpart or should be documented as unsupported.
2. **P2 — Loadout preview fidelity.**
   - The stage shows one authored PNG per item. There is no rotation, inspect, close-up or combined knife+finish+glove render; the caption says "combinations shown in game".
   - Outfit and body previews are only 70–72 × 111–121 px (`authored-previews.json`; median longest side ≈ 300 px) and are upscaled about 3× on the stage, so they look soft or pixelated.
   - Re-exporting at about 2× (`export_previews.cpp`, owned by the parent stream) would fix most of this without a 3D stage.
3. **P2 — Settings parity.** The native [`settings-panel.ts`](../native/apps/native/ui/settings-panel.ts) is its own implementation with a simple substring search. It lacks the web's settings profiles (named presets, `settings-profile-menu.ts`), registry-based search with did-you-mean, and the drag-to-place HUD editor (`hud/editor.ts`); the `hudEditor` bind opens Settings instead. Web graphics presets do not apply to the native renderer.
4. **P3 — First-visit onboarding intro** (`ui/onboarding.ts`) is absent. Native tests set `bunnyhop:onboarded`, and Tutorial covers teaching.
5. **P3 — Gamepad menu navigation** (`ui/gamepad.ts`) is absent.
6. **P3 — Small copy and title drift.**
   - The profile screen is titled "Player" for everyone.
   - The signed-out Loadout shows "Loadout" as both the screen title and its only tab.
   - The web Player-glow hint "…so you won't see it in game." is shortened natively.

## Remaining qualification (built, not proven on target platforms)

- **Real WKWebView, WebView2 and WebKitGTK rendering of profiles, Support and Loadout.** The only real-host evidence is the app-owned `--menu-home-smoke`, which covers Home only. `target/native-menu/menu-smoke.json` dates from 10-25, before today's profile and Support work. Playwright WebKit is a proxy, not the system WebView. A host smoke mode that opens `/u/<fixture>` would close this; it needs a C++ change and was not made here.
- Physical Windows and Linux WebView focus, IME in menu inputs, DPI scaling, and system-browser hand-off (Stripe and auth) are unverified.
- Live production reads for real profiles (large run lists, many badges, long names, CJK/RTL names in the card) have not been checked. All evidence here comes from fixtures.
- The signed-out Loadout made the web's eager `POST /api/auth/guest` (refused by the harness). This matches the web, but it is a real account write on first open, so the operator should be aware of it.
- The existing browser tests screenshot right after `waitFor`. WebKit can capture before paint, which produced a blank editor grid in one shot; the DOM was correct and a settled capture was fine (`webkit/ce-webkit.png`). Settle before screenshots before treating WebKit captures as visual evidence.

## Corrections to existing docs

- [`native-parity-2026-10-26.md`](native-parity-2026-10-26.md), *Profile and account UI follow-up*, still says Loadout previews are "explicitly labeled native catalog color swatches". The 0.4.0 section and the code use 126 authored preview images. The earlier sentence is stale.
- The same doc says the mocked test covered the "activity totals and graph". Before fix 9 the graph rendered empty in that test.
