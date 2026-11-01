# Compare Windows renderers

The tester compares OpenGL and D3D11 with Low latency Off, On and Boost, uncapped and capped at 240 FPS.
It uses a local BSP without an account, upload or replay recording. D3D11 always presents through DXGI;
its Low latency setting controls Reflex and Anti-Lag.

## Run

Download `renderer-measure-windows` from the successful whole-game workflow run supplied by the contributor.
Extract it fully. Have a local BSP and matching Source content ready. Plug in the PC, use the primary display,
close busy applications and leave driver, VRR and refresh settings unchanged between cases.

Open an administrator PowerShell in the extracted folder, then run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\measure-renderer.ps1 `
  -Map 'D:\Maps\bhop_lol_aero.bsp' -ContentRoot 'D:\Games\Counter-Strike Source\cstrike'
```

Omit `ContentRoot` for a self-contained map. The tool uses the desktop resolution in borderless fullscreen.
Three repeats alternate case order, with 300 warmup and 3,000 measured frames per case. Escape cancels.
For setup checks only, add `-Repeats 1 -Frames 1000`. Desktops above 4096 pixels on either axis need lowering.

Share `renderer-measurement/summary.txt` and `measurement.json` manually. They contain GPU, driver, OS,
map digest, camera and performance data; the tool uploads nothing. Unavailable modes have a failure reason.
OpenGL On/Boost require WGL interop on the same adapter. D3D11 needs no GL context. Boost requires Reflex.

## Interpretation

The report includes frame percentiles and worst frames, CPU phase times, delayed GPU timestamp queries,
Reflex reports when available, shader creation times and PresentMon presentation modes. Administrator access
lets PresentMon use ETW; without it the actual presentation mode can be unknown. Warmup is excluded.

CPU phase durations include waits. GL, interop and D3D intervals come from separate queues and cannot be added
into an end-to-end latency measurement. Driver shader caches remain intact. The D3D shader probe measures
lookup, reflection and program creation, excluding first draws and pipeline setup.

The benchmark runs matched simulation work per rendered frame with a scripted camera. It does not measure a
physical mouse, audio, menus or input-to-light latency. Use actual gameplay and optical hardware for that.
WARP output establishes API and pixel behavior, not real GPU speed, Reflex, VRR or monitor latency.

## Build

`apps/native/tools/build-measure-windows.ps1` builds the client, tester and pinned dependencies in an x64 MSVC
shell. The [whole-game workflow](../../../.github/workflows/d3d11-windows.yml) packages this tool and captures
frozen fixtures. Instrumentation is compiled only into the gameplay benchmark; keep checked source anchors in
`measure-presenter.cmake` synchronized when changing the presenter.
