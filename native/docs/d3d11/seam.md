# Native rendering seam

## Pixel baseline

`apps/native/tools/render-goldens.py` captures hidden SDL windows and compares every RGB byte of every PPM.
Missing images, changed dimensions and a single changed channel fail. There is no tolerance or ignored region.
The suite fixes visual time, camera, frame count and settings. It covers Plain, Source, Enhanced and Cinematic,
MSAA on/off, procedural sky, dynamic sun shadows, refracted water, viewmodels, players, ghost trails, paint,
aspect ratios, HUD and asynchronous video frames with supersampling and accumulation.

Build from `native/` at the desired commit, checking each build's exit code:

```sh
bun install --frozen-lockfile
bun apps/native/build.ts
cmake --build apps/native/build --parallel 4 --target bunnyhop-native-effects-render-smoke \
  bunnyhop-native-display-modes-smoke bunnyhop-native-video-frames-smoke
python3 apps/native/tools/render-goldens.py suite \
  --world-map /path/to/bhop_eazy.bsp --water-map /path/to/bhop_lol_aero.bsp \
  --water-eye 175 1135 200 --water-pitch 75 --out target/seam-suite.json
python3 apps/native/tools/render-goldens.py capture --revision "$(git rev-parse HEAD)" \
  --suite target/seam-suite.json --out target/seam-reference
python3 apps/native/tools/render-goldens.py capture --revision "$(git rev-parse HEAD)" \
  --suite target/seam-suite.json --out target/seam-repeat
python3 apps/native/tools/render-goldens.py compare target/seam-reference target/seam-repeat
```

To regenerate a historical baseline, check out that commit and rebuild before capturing; `--revision` rejects
a different HEAD. Use this baseline-tools commit to regenerate the original renderer: its only changes to existing
C++ are test harness calls and CMake registration. Each capture records revision, working diff, executable hashes,
input/asset hashes, commands and OS in `manifest.json`. Keep the maps, suite and captures under ignored `target/`,
or archive them together outside Git. Compare only on the same GPU/driver and with identical input hashes.
The local evidence is in `native/target/d3d11-seam/`.

The base revision is `098e4d082efc338bc75adfdf6aae9d9c2522f6ba`. Qualification uses macOS 27.0.1,
Apple M5 Pro, hidden OpenGL contexts. The original optional effects smoke needed its missing `can_paint=true`
argument restored before it compiled. Water coverage uses Aero's actual water surface, with the smoke's
`--require-water` assertion enabled. Aztec's first attempted camera did not capture refraction and was rejected.
The driver emits an existing unloadable depth-sampler warning on some paths; captures still require `GL_NO_ERROR`.

Three independent captures produced 41 images each, all byte-identical (zero changed pixels).
A real render with brightness changed from 1 to 1.01 failed comparison: 912,097 changed pixels,
maximum channel delta 4. A one-channel, one-unit comparator control also failed. No nondeterminism was observed
in these fixtures; other drivers and uncaptured paths need their own repeatability qualification.

PNG files produced by the effects harness are supplementary; comparison uses the uncompressed PPM pixels.
No portable cross-driver golden or Windows rendering result is established by this baseline.

### Frozen inputs and historical sources

Rebuilding assets revealed existing nondeterminism in `export-viewmodels.ts`: two exports had identical metadata
but 2,437,279 different bytes in the inflated model/pose blob. The initial 41 images still matched after rebuilding,
but this does not qualify every baked clip. Keep a frozen copy of `target/native-assets` for comparisons;
do not rebuild resources between the before/after captures. The comparator rejects differing input hashes.
`suite --assets /path/to/frozen-assets` copies those files into each capture's isolated working directory.

For an existing configured Ninja build on macOS/Linux, regenerate the original renderer without changing HEAD:

```sh
python3 apps/native/tools/build-golden-reference.py --commit b7843b4 \
  --out target/seam-original-build
```

This compiles the archived historical smoke sources with the current configured compiler/linker flags, reusing
the unchanged Rust bridge and text library. It records the source archive, bridge and executable hashes.
In a copy of the suite JSON, replace each command's executable with the matching executable in that directory;
keep the same inputs, assets and arguments. Record its `build.json` as the suite's `sourceBuild` field.
The capture's HEAD/diff describe the harness checkout; `sourceBuild.revision` describes historical binaries.
The first baseline commit's renderer is identical to `098e4d0`; only its effects smoke call signature was repaired.

## Interface and ownership

`gfx.hpp` aliases `OpenGlContext` on macOS/Linux and uses an inlined, non-virtual dispatcher on Windows.
Each forwarding call branches once on the stored backend. OpenGL remains the default; an explicitly requested
D3D11 context can be injected before resource creation, with an OpenGL fallback when no D3D11 context is supplied.
`BUNNYHOP_GFX_DISPATCH` enables the dispatcher with an unavailable second backend on non-Windows benchmark builds.
`gfx_types.hpp` contains API-independent descriptions and native-value handles with explicit bool/equality.
`gfx_opengl.hpp` and `gfx_d3d11.cpp` implement operations; `gfx_gl_api.hpp` owns the GL loader/compiler.
`gfx_window.hpp` centralizes backend availability and SDL flags. The legacy client startup still creates OpenGL;
whole-renderer startup and presentation integration follow the offscreen seam milestone.

All calls execute immediately on one render/context thread, in call order. There are no recorded command lists,
barriers, queue ownership or per-draw virtual calls. `Context` borrows the GL table; resources must be destroyed
before that table's SDL context. Resource handles are explicit owners released with `destroy`; copying a handle
does not create another owner. `TargetView` borrows attachments and cannot be destroyed through the seam.

| Operation | OpenGL implementation | D3D11 mapping |
| --- | --- | --- |
| `create_pipeline`, `pipeline` | Immutable descriptor, inline state application | Precreate blend/depth/raster objects, bind on immediate context |
| `create_constants`, `constants` | Resolve names once, then typed `glUniform` calls | Reflection-backed CPU block, map/write cbuffer and bind stage/slot |
| Texture/cube/sampler | Typed texture descriptors, six cube faces, sampler objects | Texture2D/SRV and sampler state |
| Target/view, viewport, clear | FBO with color/depth textures | RTV/DSV and viewport |
| `resolve_color` | Color-only blit | `ResolveSubresource` |
| `resolve_depth` | Separate nearest depth blit | Shader over a multisampled depth SRV; never `ResolveSubresource` |
| `copy_color` | Framebuffer rectangle to existing texture | `CopySubresourceRegion`, or shader when a format conversion is necessary |
| Geometry/stream/index/instance draw | VAO, streaming VBO, index buffer, instance divisor | Input layout, vertex/index buffers, `Draw*Instanced` |
| Signal/wait/readback/map | Fence plus reusable PBO; poll never blocks | Event query plus staging texture; `GetData` poll and mapped row pitch |

Pipeline creation allocates only at resource setup. The GL backend applies state each time because unmigrated
code still changes GL directly: a private state cache would become stale. A D3D11 pipeline owns immutable native
objects. The small depth/blend setters used to restore legacy pass state must select precreated variants or a
cheap state cache there. Polygon offset uses GL slope and depth-format units; D3D11 converts those units when
creating its raster state. The seam currently covers the client's additive blend equation and float vertex inputs;
new vertex formats or independent stencil/blend modes should be added when a migrated caller needs them.

`ProgramDesc` identifies a program and permutation with `ProgramKey`, plus an OpenGL source fallback.
The D3D11 backend must look up ahead-of-time DXBC/reflection by that key, including the manifest's aliases;
it never runs FXC while rendering. Fixed migrated keys are `hud`, `presentation` and `video`, with empty permutation.
The shader inventory has 135 cache entries / 105 distinct pairs; player keys include material, finish, glove and
detail flags as defined by its manifest.

Constant blocks are named through `ConstantField` entries. `ConstantLayout` describes caller bytes and selected
shader stage(s); fields include name, source offset, size, type, count and array/matrix stride.
`ReflectedConstants` holds each stage's independent destination layout and reflected cbuffer slot. At creation,
match names to every selected stage and precompute source/destination copies. A name in both stages can have
different offsets; do not assume a shared physical block. Allocate stage staging bytes once, scatter writes into
those offsets, then map/write the D3D cbuffers. Optimized-out/absent names are no-ops in either stage.
`bool32` consumes a uint32 value and uploads 0/1, never C++ bool bytes. Matrix bytes stay column-major with a
16-byte column stride: generated HLSL's row-major declarations and reversed `mul` already account for them.
Padded vec3 arrays use reflected 16-byte strides. Import the authoritative JSON schema described in
[shaders.md](shaders.md#translation-and-binding-contract); do not infer destination layout from C++ packing.

`texture_unit(program, name, unit)` names a logical GL-compatible unit, not an HLSL register. Precompute the
per-program fanout to `ReflectedTexture` stage-local texture/sampler slots. `bind_texture(unit, ...)` binds the
same resources to every surviving reflected pair for that unit; unit 9 can feed `uFinEnv`, `uCosEnv` and
`uPlayerEnv` simultaneously. An optimized-out sampler can have slot -1 while its texture SRV survives.
`boneMatrices` uses a 2D RGBA32F texture/SRV (three texels per bone), not constant-buffer matrices.
Sampler descriptions preserve filtering, mip LOD clamps, compare function, border color and addressing.
No JSON, string lookup, allocation or virtual dispatch occurs in constants, pipeline binding, stream upload or draw.
GL array constants use one upload per field; packed arrays are direct and padded arrays use reusable packing storage.
D3D11 scatters packed caller arrays into each reflected stage's array stride.

Readback slots are created once, enqueued once, then polled or collected. A pending slot cannot be overwritten.
Mapped pointers live until `unmap`; collection copies tightly packed rows to caller-owned memory, honoring the
mapped row pitch and requested `RowOrigin`. Timeouts/failures remain errors rather than silently reusing old pixels.
Standalone fences cover frame pacing without requiring a readback. Scalar float/depth formats cover exposure and
depth consumers as well as RGBA video. Callers own ring size and scheduling.

Resolve and copy calls mutate current bindings; the next pass binds its target/program/resources explicitly.
Color and depth resolve are separate even when both attachments originate in the same target. The existing GL
depth blit selects an implementation-dependent sample and does not average depth. D3D11 resolves depth with a fullscreen `Texture2DMS.Load(position, 0)` pass writing `SV_Depth`.
The WARP check writes a larger value to sample zero than to every other sample, rejecting minimum and averaged depth.
See Microsoft's [resolve API](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/nf-d3d11-id3d11devicecontext-resolvesubresource)
and [resource usage rules](https://learn.microsoft.com/en-us/windows/win32/api/d3d11/ne-d3d11-d3d11_usage).

## Coordinates and presentation

The seam preserves the existing camera math: column-major matrices, clip depth `-w..+w`, depth-test values `0..1`,
and logical render-target rectangles/texture UVs with Y increasing from the bottom. Uploaded images and cube faces
retain their existing GL orientation; cube face order is +X, -X, +Y, -Y, +Z, -Z. Readback declares its row origin.

The shader pipeline already applies `--fixup-clipspace` (`z = (z + w) * .5`) and `--flip-vert-y`.
Keep GL projection matrices and depth reconstruction unchanged; do not apply either conversion a second time.
Intermediate targets retain GL's numeric row order, including `SV_Position`, derivatives, texture UVs, framebuffer
copies and integer texel fetches. Present performs exactly one vertical flip to the top-left swapchain; the
existing DXGI blit already does this. Direct swapchain rendering must honor the same policy, not bypass it.
The vertex flip changes winding, so the D3D raster state swaps the GL CCW/CW interpretation consistently,
including planar reflections, mirrored viewmodels and two-sided `SV_IsFrontFace` shader branches.

World/depth shaders always emit `SV_ClipDistance0`; D3D11 has no enable bit for it. Supply
`gfx::no_clip_height` (-1e30) outside planar reflections and the actual water plane inside them.
No camera caller changes its math. Nonconstant cube face orientation needs a Windows test; current native
reflection cubes are black on all six faces. The authoritative semantics are in
[the shader contract](shaders.md#semantic-requirements-for-the-backend).

`window_target` and `borrow_target` provide non-owning views. The latter leaves the existing WGL interop FBO owned
by `LowLatencyPresenter`. Presentation still runs through the existing client/presenter path in this milestone.
The future D3D11 context should borrow the device and immediate context already owned by
`LowLatencyPresenter::Impl`, and borrow its current swapchain RTV as a target view. The presenter remains the sole
swapchain/resize/Present owner and retains Reflex/Anti-Lag markers and pacing. The native D3D path bypasses the
WGL interop copy; it must not create a second device or swapchain. Inject the context before creating renderer
resources. `startup.cpp` and `window_sdl.hpp` now share `gfx_window.hpp`; the eventual non-GL startup branch omits
`SDL_WINDOW_OPENGL` and SDL GL context creation. No user-facing backend switch is enabled yet.

## Migrated callers

`video_frames.hpp` uses the seam for targets, shaders, named constants, samplers, geometry, accumulation draws,
readback rings and fences. Its public dimensions and bottom-row-first video contract are unchanged.
`native_presentation.hpp` uses it for streaming effect/paint geometry, constants, pipeline state and draws.
`hud.hpp` borrows the context for atlas/raster textures, named constants, a UI pipeline and one streamed
vertex buffer per flush. Texture-owner addresses identify batches without inspecting backend handles; numeric
text keeps its warmed digit cache. `hud_area.hpp` uses seam viewports; `hud_text.hpp` has no graphics calls.
`frame_pacing.hpp` uses standalone fences with the existing 100 ms bounded wait, which maps to D3D11 event
queries. Avatar readback is enqueued once and polled on later frames, with a five-second failure deadline;
a separate submission fence supplies the flush option absent from `poll(Readback)`.
`target_png` takes an explicit target and collects seam readback while retaining the original PNG filtering.
Temporary bridges remain for legacy screenshot callers' read target/pack state, the avatar caller's current
target/viewport, and construction of the backdrop renderer and avatar viewmodel from the GL table.
Those hosts must pass explicit target views/rectangles and the shared context when their renderers migrate.
Presentation, video, HUD and avatar service constructors borrow `gfx::Context` directly. The legacy
renderer owns the temporary OpenGL adapter shared with presentation and video capture.
`shader()` is a temporary native-handle bridge for `renderer.hpp`'s existing shared water uniforms; remove it
when water constants move to reflected blocks. `Renderer(Gl&)` remains during the remaining migration.

The shader integration merge is `5d0b612`. The extractor recognizes the two keyed program descriptors and verifies
their fixed keys against the manifest; extraction still produces 135 entries / 105 distinct pairs, with nine
pipeline tests passing. Its FXAA loop rewrite was compared with and without the edit on the frozen suite:
all 41 images are exactly identical, including Enhanced/Cinematic with MSAA on and off. The seam build also
matches the original pre-seam renderer for all 41 images with identical input hashes.

`native_gfx` checks real offscreen color/depth MSAA resolve, framebuffer copy, reflected constant arrays,
instanced geometry and both readback row orders. The video golden exercises ring wraparound, supersampling and
three-sample accumulation. Windows/MSVC and Linux builds have not run locally.

## Performance and qualification

`render_benchmark.cpp` accepts `presentationDraws` (default zero). The 128-draw case adds repeated streaming
presentation draws to the same world scene, so a world-only result cannot hide overhead in the migrated draw
path. `compare-render-performance.py --native-pair` alternates before/after order and preserves every frame
sample and spec. It reports paired mean deltas with 95% Student intervals rather than an arbitrary tolerance.

The pre-seam benchmark is from `51e322b`, which includes this benchmark option but no rendering seam.
To regenerate it with the configured native toolchain and unchanged bridge:

```sh
python3 apps/native/tools/build-golden-reference.py --commit 51e322b \
  --target render-benchmark --out target/seam-performance-original
python3 apps/native/tools/compare-render-performance.py --native-pair \
  --baseline target/seam-performance-original/bunnyhop-native-render-benchmark \
  --candidate apps/native/build/bunnyhop-native-render-benchmark \
  --spec target/d3d11-seam/perf/world.json --spec target/d3d11-seam/perf/draws.json \
  --output target/seam-performance --runs 7
```

Local inputs: bhop_eazy, fixed spawn camera, 160x90, Source look, MSAA off, effects/floor weapons on,
500 warmup + 5,000 measured frames per run, seven alternating pairs. `sync=batch` includes final GPU completion;
it measures scene throughput without presentation, input, HUD or network. Apple M5 Pro, macOS 27.0.1,
OpenGL 4.1 Metal 91.7. No build or CTest ran concurrently with the measured batches.

| Workload | Before mean (us/frame) | After mean (us/frame) | Paired delta, 95% interval (us) |
| --- | ---: | ---: | ---: |
| World, GPU-completed batch | 493.493 | 492.980 | -0.512 [-12.366, +11.342] |
| World + 128 presentation draws, GPU-completed batch | 672.298 | 665.354 | -6.944 [-12.800, -1.087] |

No regression was detected. The draw-heavy workload is faster, with uniform lookup removed from its hot path.
The world interval includes zero; it does not establish a world-render speedup. The bound is local measurement
uncertainty, not a guarantee for 3,000+ FPS Windows hardware. Draw calls add no heap allocation or virtual dispatch.
An identical-binary control also showed run-to-run variation; raw results remain in
[`target/d3d11-seam/perf/qualification/comparison.json`](../../target/d3d11-seam/perf/qualification/comparison.json).
The fixed specs and preserved baseline binary live beside it under ignored `target/`.

The final full build returned zero before CTest. 98/98 selected CTests passed (100 registered);
`native_menu_focus` and `native_window_sdl` were excluded to avoid desktop/window-mode interaction.
The new GPU smoke ran, rather than skipping. Nine shader pipeline tests passed and all 135 keys / 105 pairs
extracted after the seam change. The Windows DXBC compilation from the shader work was not rerun locally;
neither Windows/MSVC nor Linux client builds, real presentation/latency tests, or the full menu UI suite ran.

### D3D11 backend qualification

The [backend proof](../../apps/native/tools/d3d11-backend/README.md) documents the resource APIs, caller handoff,
shader embedding and comparison limits. The Windows build embeds deduplicated DXBC and reflection as an executable
resource; every manifest alias is addressable and the executable hash covers the archive. The presenter remains
the only owner of the real device, swapchain, resize, Present and latency markers.

[Windows WARP qualification](https://github.com/2x74/bunnyhop-client/actions/runs/41226181036) passed MSVC,
the debug-layer hazard checks and 16 image comparisons against Apple OpenGL. Maximum RGB channel error was 1.
The same run passes the real SourceHdr/EnhancedLook tests, packed/padded array upload checks, borrowed RTV/DSV
metadata and RGBA8-to-RGBA16F refraction conversion. The GL test skips on the runner's OpenGL 1.1 path;
all four non-GL-context tests execute. The shader archive contains 11,250,406 deduplicated DXBC/reflection bytes.
The frozen 41-image Mac suite also remains byte-identical with the forced dispatcher and R8 contact target.
These results cover offscreen seam operations, video, presentation and postprocessing; real world rendering and
swapchain presentation require the later caller integration and hardware qualification.

The forced-dispatch benchmark against `9b46cf7` used seven alternating pairs with the frozen 160x90 Source specs,
500 warmup and 5,000 measured frames per run. The isolated dispatcher binary is `0a6604e`, before merging other
callers. A second comparison uses the merged caller tree. No local build/test ran during either measurement;
process checks found no compiler load at the boundaries of the isolated comparison. A first attempt overlapped
compilation and was interrupted and excluded. Results are GPU-completed batch microseconds per frame:

| Workload | Seam baseline | Dispatcher | Paired delta, 95% interval |
| --- | ---: | ---: | ---: |
| World | 490.984 | 477.883 | -13.101 [-30.053, +3.852] |
| World + 128 presentation draws | 710.149 | 713.950 | +3.801 [-7.938, +15.540] |
| Merged callers, world | 498.400 | 493.519 | -4.881 [-17.610, +7.847] |
| Merged callers, world + 128 draws | 698.697 | 702.180 | +3.483 [-7.888, +14.853] |

The intervals include zero; no regression was detected. These Mac offscreen results do not measure Windows
hardware or a 330-microsecond presented frame. Raw frame samples/specs are preserved under
`target/d3d11-backend/performance-quiet` and `performance-final`. The full Mac build passed before CTest;
100 selected tests passed, with menu-focus/window-mode tests excluded. Ten shader pipeline tests and 51 release
evidence tests passed; the pinned release workflow is unchanged.

## Remaining migration split

Keep one integration owner for `renderer.hpp` and the public gfx headers. Other workstreams change their own
headers and hand the integrator constructor/binding changes. Perform the extraction step first, with exact
goldens after each extraction, so later API conversion does not require concurrent edits to the large class.

| Order | Workstream and files | Boundary and integration handoff |
| --- | --- | --- |
| 1 | Shader layouts/assets | Adapt generated reflection to `ConstantLayout`; agree asset IDs, stage/slot, matrix layout and texture bindings |
| 1 | Renderer extraction, one owner | Extract `prepare_world`/`prepare_props` and world submission into `world_pass.hpp`; sky setup/draw into `sky_pass.hpp`; water setup/uniforms/refraction into `water_pass.hpp`; sun caster submission into `shadow_pass.hpp`. Preserve class-facing methods initially |
| 2, parallel | Source postprocessing: `source_hdr.hpp` | Targets, exposure PBO/fence ring, constants, explicit color and depth resolves; owns its own shared code |
| 2, parallel | Enhanced postprocessing: `enhanced_look.hpp` | Its own targets/fullscreen passes and explicit depth resolve; no edits to Source header |
| 2, parallel | Shadow/reflection targets: `sun_shadows.hpp`, `water_reflection.hpp` | Independent target resources; integrate with extracted shadow/water passes |
| 2, parallel | HUD: `hud.hpp`, `hud_area.hpp`, `hud_text.hpp` | Atlas textures, streaming batches, UI pipeline; keep text rasterization unchanged |
| 2, parallel | Readback services: `menu_backdrop.hpp`, `avatar_stage.hpp`, `frame_pacing.hpp` | Independent asynchronous slot/fence callers; Source exposure remains with its postprocess owner |
| 3, parallel | `native_viewmodel.hpp` | One owner first extracts GPU mesh/program/constants into a dedicated header; keep animation/pose logic untouched, then migrate rendering |
| 3, parallel | `native_map_effects.hpp` and other leaf geometry | Own shader/geometry resources; shared water constants handed off through the extracted water pass |
| 3, parallel | Extracted world, sky, water, shadow pass headers | Each pass owner converts its own code; only integration owner edits `renderer.hpp` wiring and cleanup |
| 4 | Startup/presentation/Windows, one owner | Inject existing D3D device/context, borrowed swapchain target, resize/present and low-latency markers; add opt-in backend selection |

Before Windows backend implementation, implement the per-stage reflection adapter and decide the depth-resolve
sample policy. The coordinate and presentation policy is fixed by the shader contract above.
Keep OpenGL as the Windows default until target hardware measurements justify changing it. No physics, replay,
shared Rust code, WASM pin or release workflow changes are needed for this migration.
