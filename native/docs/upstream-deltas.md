# Vendored delta audit

Current sync: website `hotfix/0030-wasm` at `6a37d059f59291a25ac3bbfefd5d1aa6ad5f45f4`.
The two patches were refreshed against that source; `classification.json` records its Git blob baselines.
The rows below describe why each native delta exists.

Baseline: native `4ca38014`; upstream `9cde9db9d37ea1b0752da6222b10f65e52d5f3d1`.
Resynced to upstream `042dca417ae08ab7cf3fd37591eae21ef772aab1`, then `b29f5037fb8367d487cd3513fc8f19c9a467392b`, then
`59fd424c388005d9de1e18366ef89a6e6a9ae27d`; those syncs changed only the rows marked 042dca41, b29f5037 and 59fd424c.
The audit compared tracked files and both repositories' history, not working-tree timestamps.
`tools/upstream-patches/classification.json` records the current upstream blob for each native delta.

| Paths under native/ | Classification and action | Native history |
| --- | --- | --- |
| crates/core/Cargo.toml, src/lib.rs | Keep native math feature/dependency and optional native-web adapter | ae531d1 |
| crates/core/src/game/{kin,minigame,practice,propdoor,usable,weapons}.rs; src/{game,physics,props}.rs | Keep portable WASM math calls; take upstream observational timing changes | ae531d1, af57feb, d30cf10 |
| crates/core/src/{wasm,wasm_content,wasm_studio}.rs | Keep optional native-web export attributes; take upstream timing-path exports | ae531d1 |
| crates/core/src/lightmap.rs | Keep native switchable/animated light atlas | 528be01 |
| crates/core/tests/{entities,render}.rs | Restore upstream tests; retain small native suites separately as native_entities.rs/native_render.rs | 528be01, d30cf10 |
| crates/core/tests/physics_v16_cooks.rs | Whitespace only: take upstream | 5edd2d3 |
| crates/vendor/{collision,movement} manifests and math calls; collision/src/math.rs | Keep native-wasm-math and pinned libm; take upstream accepted-path observer | ae531d1, af57feb |
| crates/vendor/SOURCE-SDK-NOTICES.md, thirdpartylegalnotices.txt | Keep native distribution notices | ae531d1 |
| apps/web/src/core.ts, native-{runtime,input}.ts | Keep opt-in native transport and exported memory access; retain upstream additions | ae531d1, af57feb, d30cf10 |
| apps/web/src/api.ts; ui/{account-name,card-editor,country-picker,gifting,player-glow-controls,profile,profile-write,support}.ts | Keep account ownership fences; retain upstream API additions. Native heartbeat keeps device-header dispatch fencing | 2460a2b |
| apps/web/src/feedback/{modal,state}.ts, social/dock.ts | Keep native game metadata and window-scoped event handlers | 5b746a1, 2460a2b |
| apps/web/src/net/scoreboard.ts, player/model.d.ts, ui/loadout-ui.ts, viewmodel/inspects/third.ts | Keep renderer-free shared exports/imports needed by native builders | 2460a2b |
| apps/web/src/net/scoreboard.ts | 042dca41: follow upstream's T7+ tier label in the shared scoreboard copy | native-web.patch |
| apps/web/src/net/hud.ts | 042dca41: dropped. The hunk removed imports the scoreboard still used; menu builds map `net/hud` to `chat-hud.ts` | native-web.patch |
| apps/web/src/{api,social/dock,ui/profile}.ts | 042dca41: hunks unchanged, refreshed for upstream line offsets | native-web.patch |
| apps/web/src/ui/run-stats.ts | b29f5037: window-scoped key, pointer and resize handlers, so the tests' Bun globals typecheck. Drop once upstream takes the same change | native-web.patch |
| apps/web/src/ui/account-state.ts | 59fd424c: no background avatar re-render (avatar/refresh.ts loads Three); the website refreshes a stale avatar | native-web.patch |
| apps/web/src/sky-packs/settings.ts | b29f5037: menu builds map it to `sky-settings.ts` (its converters load Three); only Sky brightness stays | menu-boundary.ts |
| apps/web/src/assets/audio/manifest.json; optional announcer samples | Preserve native omission of three optional samples and its manifest metadata | ae531d1, 2460a2b |
| apps/web/src/{badge-glyphs,ui/profile-social}.ts | Whitespace only: take upstream | 2460a2b |
| apps/web/src/wasm/.gitignore | Keep generated WASM out of Git | ae531d1 |
| Other differing/missing source paths | Older or deliberately partial upstream snapshot: take pinned upstream verbatim | ae531d1 through d30cf10 |
| crates/native-bridge, crates/native-web | Native-owned overlay, no release-branch counterpart; leave in place | ae531d1 |

The initial web comparison found 516 differing/missing tracked paths: 38 shared paths, six native-only paths, and 472 upstream-only paths. Most missing paths were previously unvendored source/assets. No hand-authored frontend redesign is part of this sync.

Run from native/:

```sh
bun tools/sync-upstream.ts --upstream /path/to/bunnyhop --commit FULL_SHA --dry-run
bun tools/sync-upstream.ts --upstream /path/to/bunnyhop --commit FULL_SHA
```

The tool reads immutable Git objects, applies explicit patches in a temporary directory, and records source/output SHA-256s and patch hashes in upstream-manifest.json. Repeated syncs reject local vendor edits. Update patches before syncing; a patch conflict stops before destination writes. Bridge and native UI files are outside the sync roots.
