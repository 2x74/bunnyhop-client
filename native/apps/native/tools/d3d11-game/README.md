# Whole-game D3D11 proof

The `ci/d3d11-windows` workflow builds the actual client and renders the frozen golden suite through WARP,
including reflections, mirrored hands, display/HUD shapes, avatar editor pictures, loadout previews and a
hidden frame-counted client on a real BSP. The separate video export process still selects OpenGL.

Prepare inputs on the OpenGL reference machine, using the frozen suite described in
[seam.md](../../../../docs/d3d11/seam.md):

```sh
python3 apps/native/tools/d3d11-game/prepare.py /path/to/frozen-suite.json target/d3d11-fixtures
python3 apps/native/tools/d3d11-game/capture.py target/d3d11-fixtures target/d3d11-reference --renderer opengl
```

Archive inputs under `d3d11-fixtures/` in `target/d3d11-windows-fixtures.tar.gz`, split into numbered
`target/d3d11-windows-fixtures.part-*` files on the temporary CI branch. Archive the canonical reference PNGs
under `goldens/` in `target/d3d11-windows-goldens.tar.gz`; select PPM over a same-named smaller supplementary PNG.
The suite hashes every input. Never rebuild its assets between captures. The archive is CI input, not a release asset.

`d3d11-whole-game-evidence` contains every reference/candidate image, logs, input hashes, metrics and RGB difference
heatmaps amplified four times. Comparison requires the complete inventory and equal dimensions. RGB SSIM averages
8×8 windows with edge padding, retaining thin silhouettes and shadow structure without registering or rescaling
images. SSIM must be at least .98 and mean absolute RGB error at most 3/255. These bounds allow small cross-driver
rounding and raster edges while rejecting black passes, vertical flips and missing scene content. Read every image
and heatmap even when it passes. Procedural noise and sample-zero MSAA depth edges need particular attention.
Aero's existing backface water behavior is preserved; the reflection fixture's front-facing quad tests composition.

WARP qualifies image paths and startup, not GPU speed or display behavior. Real Windows displays must check
tearing/VRR, actual flip/independent presentation, Reflex/Anti-Lag, exclusive mode changes and ten-second reverts,
4:3 stretching/bars, WebView2 child-window composition, resizing, focus and alt-tab.
