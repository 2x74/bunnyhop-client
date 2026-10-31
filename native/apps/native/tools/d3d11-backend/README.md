# D3D11 seam proof

`gfx_smoke.cpp` runs the same offscreen checks with OpenGL and D3D11. The Windows workflow creates a
WARP device with the debug layer and fails on device errors or SRV/output hazards. Production contexts
borrow a device and immediate context; only `D3D11Context::warp()` creates a device.

The committed PNGs are Apple M5 Pro OpenGL references from the hidden-window smoke. They cover
MSAA color/copy, instancing, six nonconstant cube faces, vertex-stage textures, RGBA32F bone fetches,
and the real video/presentation classes at 1x/one sample and 2x/three samples across two ring wraps.
The WARP test additionally writes different depths to each MSAA sample and requires sample zero
(.625, larger than every other sample) after the shader resolve. Depth checks use numeric readback.

`compare.py` requires matching inventories and dimensions, mean absolute RGB error <= 2 code values,
and at most 0.5% of channels differing by more than 16. This allows small UNORM/half-float rounding
and a thin rasterization boundary while rejecting flipped images, missing quads, incorrect cube faces
and stale black SRVs. There is no registration, ignored region or rescaling. It compares RGB only;
numeric assertions cover depth, ring reuse and row origin.
This fixture qualifies these seam operations and subsystems. It does not qualify world rendering,
procedural materials, planar reflections, viewmodels, real swapchain presentation or hardware speed.

## Building

The regular Windows CMake build runs `d3d-shaders/package.py --build` before compiling resources.
That uses the pinned translators and compiler, resolves every manifest alias, deduplicates DXBC and
reflection, and embeds the archive as RCDATA 201 in each executable. The executable identity therefore
covers the shaders. No runtime FXC, external shader search path or additional release workflow step is
needed. Compiler diagnostics remain in `target/d3d-shaders/output`.

The standalone proof CMake project needs `SHADER_RESOURCES` pointing at package.py's output. It builds
SDL at the native client's pinned revision and compiles the actual backend and subsystem headers.
