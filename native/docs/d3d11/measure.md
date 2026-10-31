# Compare Windows presentation paths

This tool runs a local map without a game account, network client or recorded player inputs. It compares the current
OpenGL swap with Low latency On and Boost, each uncapped and capped at 240 fps. VSync is off in all six cases. It
also measures the runtime compilation of every current player material cache key. It does not contain a D3D11 renderer.

## For testers

1. Open [D3D11 WARP experiment runs](https://github.com/2x74/bunnyhop-client/actions/workflows/d3d11-warp.yml).
   Pick the successful run on `ci/d3d11-warp` whose commit the developer gave you. Under **Artifacts**, download
   **renderer-measure-windows**, then extract the ZIP fully. GitHub may require a login to download an artifact;
   running the extracted tool needs no account or token. Artifacts expire after 30 days; a developer can share the ZIP.
2. Have a local Source BSP map and its game content available. Use the same map/content for every comparison.
   The tool does not download maps. Plug in the PC, use your normal monitor refresh rate and VRR setting, close busy
   applications, and keep the test window focused. Use the primary monitor. Do not change driver settings between runs.
3. Open **Windows PowerShell as administrator** (Start menu, search PowerShell, right-click, Run as administrator).
   Administrator access lets bundled PresentMon read presentation events through ETW. Without it, frame and GPU
   measurements still work, but actual presentation mode can be unknown. Navigate to the extracted folder with `cd`.
4. Run this one command, replacing the two example paths:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\measure-renderer.ps1 -Map 'D:\Maps\bhop_lol_aero.bsp' -ContentRoot 'D:\Games\Counter-Strike Source\cstrike'
   ```

   `ContentRoot` is the directory with the map's materials, models and game packs. Omit it for a self-contained map.
   The tool uses your desktop's pixel resolution in borderless fullscreen. Leave it focused and unobscured; overlays,
   notifications, other displays and the desktop compositor can affect the actual presentation path. Escape cancels.
   Three repeats alternate forward/reverse case order; each case has 300 warmup frames and 3,000 measured frames.
   Allow a few minutes. For a shorter check add `-Repeats 1 -Frames 1000`. Do not use a short check as the final comparison.
5. Paste **renderer-measurement\summary.txt** into Discord yourself, and attach **measurement.json** if requested.
   These contain GPU/driver/OS strings, a map SHA-256, camera coordinates and performance data. They omit local paths,
   process IDs, timestamps identifying a session, account names and tokens. Temporary specs, stderr and raw ETW CSVs
   are deleted. Nothing is uploaded by the tool. An unavailable mode is reported; it is never silently replaced by Off.

If the shader step fails, check that the ZIP was fully extracted and that the PC supports OpenGL 3.3. On/Boost also
require WGL_NV_DX_interop2. Boost changes NVIDIA clock policy when Reflex supports it; on other GPUs it can behave
like On. A hybrid-GPU laptop can fail interop if GL and D3D cannot use the same adapter. A failed capture produces an
error instead of comparing incomplete data. Re-run after fixing the setup. Very large desktops above 4096 pixels on
either axis need a lower desktop resolution for this benchmark.

## What the report measures

- Frame wall time: p50, p95, p99, p99.9, maximum, mean, derived average fps, every measured frame and the 20 worst
  frame indices. Percentiles use sorted samples at `floor(N * percentile)` (clamped to the last sample).
- CPU elapsed time per phase, including presenter pacing, input pump, simulation, feedback, diagnostics, heartbeat,
  actor preparation, render start, world, HUD, swap, queue fencing and the fps limiter. Renderer subphases and work
  counts are retained per frame. These are wall-clock CPU intervals, including waits, rather than CPU thread-cycle time.
- OpenGL `GL_TIME_ELAPSED` queries around world and HUD submission, excluding interop lock/unlock and presentation.
  A delayed ring reads completed queries without waiting in the measured loop. Unsupported/missed samples are null.
- On/Boost: CPU time inside the interop lock and unlock calls, CPU time submitting the orientation-correcting D3D
  triangle copy, D3D11 timestamp/disjoint queries around that copy, and CPU time inside `Present`. The current copy is
  a shader blit, not `CopyResource`. These GPU intervals come from different API queues and must not be added as
  though they formed one continuous end-to-end interval. Timestamp collection/Reflex polling adds some overhead.
- On NVIDIA where available: `NvAPI_D3D_GetLatency` reports for completed frames, with simulation, render-submit,
  present, driver, OS render-queue, GPU and GPU-active durations. Report frame IDs include warmup; subtract warmup
  plus one to relate them to zero-based measured frame indices. Reports can lag the application, so the last frames
  may be absent. A missing endpoint yields null, never a fabricated zero. Unsupported APIs have a status/reason.
- PresentMon 2.6.0 ETW `PresentMode` counts, filtered to the benchmark process and measured QPC interval. Hardware
  Independent Flip and composed modes are observed labels, rather than conclusions drawn from a flip-discard flag.
  If ETW is unavailable the mode is unknown. Counts cover the whole measured interval and can include transitions.
- Player material shader compilation: vertex, fragment and link time for 124 lazy cache keys (solid finishes 0–27,
  glove/detail combinations, ghost, gun and world gun). The probe uses `player_defines` and the same generated GLSL
  selection as `NativeViewmodel::link_player_program`. Identical shader sources under different cache keys are
  intentionally included. Each program is requested once at runtime and retained, as in the lazy cache. This isolated
  probe excludes uniform lookup, first-draw specialization and all other map/texture loading hitches.

The camera follows the same frame-indexed 16-unit circle with a 360-degree yaw sweep and 10-degree pitch sine in each
case, starting at the map spawn. Warmup uses the initial pose. One canonical simulation tick runs per frame, giving
matched simulation work across fps limits; this is a comparison workload rather than real-time play. Shader/actor
animation clocks still use wall time. The report records the camera origin, resolution, frame count and settings.
It uses the benchmark's default renderer settings; audio, menus, networking and real mouse input are absent.

Driver shader caches remain intact. The first run can be slower, and repeated runs reveal cached compilation rather
than a guaranteed clean-driver install. Do not call these cold-cache numbers. A D3D11 port can move HLSL compilation
to build time, but still needs separate first-draw and pipeline/driver-cache measurements.

Software timers cannot measure end-to-end click-to-photon latency. They do not include mouse electronics, all input
transport, display scanout or pixel response. In the normal game's Reflex flash-indicator mode, a click emits a
flash marker that a compatible Reflex Analyzer monitor/mouse can observe. An LDAT or another optical sensor paired
with a physical input trigger measures the actual input-to-light interval. Those hardware measurements add the
missing display/input portion and should be taken separately during actual gameplay; this scripted camera tool does
not generate physical clicks or claim an end-to-end latency number.

## Build and run without Windows

From `native/`:

```sh
bun install --frozen-lockfile
bun apps/native/build.ts
apps/native/build/bunnyhop-native-shader-benchmark target/native-assets target/player-shader-times.json
```

The shader tool works on Windows, Linux with a GL context, and macOS. On macOS it creates an offscreen CGL context;
no SDL window or desktop automation is used. On a Linux machine without a display, provide an EGL/SDL offscreen
video driver supported by that installation. Shader timings are local output, not a committed hardware baseline.
The existing native/web `compare-render-performance.py` and plotting tool measure synchronized scene throughput with
a different schema; use the PowerShell tool for this presentation comparison.

## WARP CI and backend notes

The new `.github/workflows/d3d11-warp.yml` runs only on pushes to `ci/d3d11-warp`; it leaves release workflows untouched.
The standalone probe needs only the Windows SDK and MSVC, not SDL, Rust, maps or OpenGL:

```powershell
cmake -S native/apps/native/tools/d3d11-warp -B warp-build -A x64
cmake --build warp-build --config Release
.\warp-build\Release\d3d11-warp-probe.exe warp-evidence
```

Check the build exit code before running the executable. **d3d11-warp-evidence** contains `report.json` and four PNGs:
colour/cube/clip/MSAA, shader-resolved depth, a copied subregion and compute UAV output. Every pixel is checked by the
program before success. It requests only WARP at feature level 11_0 and compiles SM5 shaders through
`d3dcompiler_47.dll`. It exercises a 4x MSAA colour/depth target, colour resolve, `Texture2DMS` depth resolve writing
`SV_Depth`, cube sampling, `SV_ClipDistance`, `CopySubresourceRegion`, staging readback, compute UAV writes and timestamp
queries. Stage wall times include shader compilation, readback and PNG writing; the timestamp interval includes
queue idles between stages, so neither is a hardware GPU performance estimate. Failure is fatal for offscreen tests.

The separate session probe creates an HWND and a real flip-discard swapchain and attempts `Present(0, 0)`. Its HRESULTs
and occlusion status are reported; failure is nonfatal. Even a successful swapchain/Present does not prove scanout or
independent flip on the hosted runner. WARP validates D3D11 API/shader/pixel semantics, not hardware performance,
WGL interop, Reflex, Anti-Lag, tearing/VRR or real monitor latency. The future renderer can use a similar WARP fixture
for Windows render smoke tests without relying on the runner's OpenGL 1.1 implementation.

Only the gameplay benchmark compiles an instrumented copy of the existing presenter. `measure-presenter.cmake`
inserts measurement hooks at checked source anchors and fails configuration if those anchors move. The normal client
still compiles `low_latency_windows.cpp` directly. Keep those anchors in sync if presenter code changes. No renderer,
gameplay, replay, verifier or release code path is switched by these tools.
