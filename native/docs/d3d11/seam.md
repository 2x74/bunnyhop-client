# Native rendering seam

`gfx.hpp` aliases the OpenGL context on macOS/Linux and dispatches between OpenGL and D3D11 on Windows.
OpenGL is the default. The Windows renderer choice and startup recovery live in `renderer_launch.hpp`.
`ClientGraphics` creates the backend before HUD, model or map resources.

## Ownership and coordinates

Calls execute immediately on one render thread. Resource handles own their objects until `destroy`;
`TargetView` borrows attachments. Destroy resources before their context. The presenter owns the D3D11 device,
immediate context, scene target and swapchain. Reborrow its scene target after resize and reset cached state
when the presenter uses the immediate context.

Keep GL projection matrices, column-major bytes and bottom-row-first intermediate targets. Shader translation
fixes clip depth and flips vertex Y; the presenter supplies one final vertical flip. The D3D rasterizer maps
winding consistently for reflections and mirrored hands. Use `gfx::no_clip_height` outside water reflections.
See [the shader contract](shaders.md#translation-and-binding-contract).

Color resolve averages samples. D3D11 depth resolve reads sample zero in a shader writing `SV_Depth`.
Readback slots cannot be overwritten while pending; collection honors row pitch and the requested row origin.
Constants and texture bindings resolve names at creation, with no JSON or string search during draws.

## Pixel baseline

Run from `native/`, using the same frozen assets, maps and GPU for both captures:

```sh
cmake --build apps/native/build --parallel 2 --target bunnyhop-native-render-smoke \
  bunnyhop-native-effects-render-smoke bunnyhop-native-display-modes-smoke bunnyhop-native-video-frames-smoke
python3 apps/native/tools/render-goldens.py suite --assets /path/to/frozen-assets \
  --world-map /path/to/bhop_eazy.bsp --water-map /path/to/bhop_lol_aero.bsp \
  --water-eye 175 1135 200 --water-pitch 75 --out target/seam-suite.json
python3 apps/native/tools/render-goldens.py capture --revision "$(git rev-parse HEAD)" \
  --suite target/seam-suite.json --out target/seam-current
```

The 41-image suite covers looks, MSAA, sky, shadows, water, actors, trails, paint, HUD, aspect ratios and video
accumulation. Comparison requires identical input hashes and exact RGB bytes; any changed channel fails.
Keep captures under ignored `target/` or outside Git.

To rebuild the original GL renderer without changing HEAD:

```sh
python3 apps/native/tools/build-golden-reference.py --commit b7843b4 --out target/seam-original-build
```

`b7843b4` adds capture harnesses to the pre-seam renderer without changing its rendering code. In a copy of
`seam-suite.json`, replace the four smoke executable paths with those in `seam-original-build` and add its
`build.json` as `sourceBuild`. Capture it with the same current HEAD, inputs and arguments, then compare:

```sh
python3 apps/native/tools/render-goldens.py capture --revision "$(git rev-parse HEAD)" \
  --suite target/seam-original-suite.json --out target/seam-original
python3 apps/native/tools/render-goldens.py compare target/seam-original target/seam-current
```

The separate reflection smoke exercises actual planar actor targets, composed water and mirrored weapons.
Aero has clockwise upward water triangles, so that smoke uses a front-facing quad for composition.

## Windows proof

[Whole-game fixtures](../../apps/native/tools/d3d11-game/README.md) use the production backend under WARP.
Compare their output with the archived GL inputs; keep the archive intact. WARP checks rendering semantics.
Use a real GPU and display to check Reflex, presentation, exclusive modes, scaling and WebView2 composition.
