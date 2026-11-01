# D3D11 seam proof

`gfx_smoke.cpp` runs the same offscreen checks with OpenGL and D3D11. The Windows workflow creates a
WARP device with the debug layer and fails on device errors or SRV/output hazards. Production contexts
borrow a device and immediate context; only `D3D11Context::warp()` creates a device.

The committed [reference PNGs](goldens/) are Apple M5 Pro OpenGL references from the hidden-window smoke. They cover
MSAA color/copy, static/indexed instancing, six nonconstant cube faces, sRGB decode, mip generation,
anisotropic samplers, vertex-stage textures, partial RGBA32F bone updates,
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
reflection, and embeds the archive as RCDATA 201 in each graphics executable. The executable identity therefore
covers the shaders. No runtime FXC, external shader search path or additional release workflow step is
needed. Compiler diagnostics remain in `target/d3d-shaders/output`.

The standalone proof CMake project needs `SHADER_RESOURCES` pointing at package.py's output. It builds
SDL at the native client's pinned revision and compiles the actual backend and subsystem headers.

## Caller APIs

- `Context(gl)` keeps OpenGL. Windows can opt in with `Context(gl, &d3d11, Backend::d3d11)`;
  a null D3D11 pointer selects OpenGL. `Context(d3d11)` is for a D3D-only caller or WARP.
  Call `reset_state()` after any presenter/external use of the immediate context. This clears D3D
  bindings and their caches, including untracked SRVs; OpenGL continues to tolerate legacy state changes.
- `D3D11Context({device, immediate_context})` borrows both pointers. Resources must die before
  their context/device. The presenter remains responsible for resize, the swapchain, Present and
  the final Y flip. `Context::borrow_d3d11_target(rtv, desc, dsv)` borrows views until resize.
  Metadata must match the actual dimensions, samples and view formats. A non-none depth format requires a DSV.
  `prepare_color_copy(borrowed_output)` at setup/resize preallocates a matching texture/SRV for format-converting
  refraction copies from an RTV without an SRV. `copy_color` then reuses that cache; an unprepared first copy
  creates it. The single cache follows the presenter's one current output.
- `Format::srgb8` is four RGBA8 bytes, with hardware sRGB decode for RGB and unchanged alpha.
  `Format::r8` is one UNORM byte. `rgba16f` uploads packed RGBA half floats; convert RGB float
  panoramas at load. Set `TextureDesc::levels` to the full mip count before `generate_mips()`.
- `bind_image(unit, texture)` preserves the logical sampler. `bind_sampler(unit, sampler)` preserves
  the texture. Material passes can bind shared samplers once, then change images alone per draw.
- `SamplerDesc::max_anisotropy` is clamped to `max_anisotropy()`. `wrap_s/t/r` override the
  common `address`; their default `Address::inherit` preserves existing initializers.
- `upload_vertices(geometry, bytes)` creates static storage; interleave blend attributes at load.
  `stream_vertices` uses a 4 MiB dynamic ring per geometry. Static geometry can exceed that size.
- `update_texture(texture, rect, pixels)` updates tightly packed mip-zero rows without backend
  allocation. RGBA32F bone texels use floats. D3D11 uses ordered `UpdateSubresource` copies.
- `max_samples(color, depth)` queries the shared supported sample limit. `current_target()` and
  `current_viewport()` query actual GL bindings/state, including legacy changes. The dimensions of
  an unknown legacy framebuffer are unspecified; borrow it explicitly when dimensions are needed.
  D3D11 tracks both values. `RasterState::clip_distance` controls GL clip distance zero;
  D3D11 always uses the shader clip distance and requires `no_clip_height` outside reflections. `poll(readback, true)` requests a nonblocking flush before polling.
- The context releases orphaned owned handles when startup unwinds, so a failed D3D11 asset load releases
  its GPU memory before OpenGL recovery. Borrowed presenter targets stay owned by the presenter.
- Handles support explicit `bool`, `==` and `!=`; callers must not interpret their native fields.
  `destroy(ConstantBinding&)` releases the binding layout. D3D11 stage buffers are shared by the
  program's layouts and released with that program. Destroy bindings before their program.
- Packed array constants upload with one GL call per field. Padded arrays reuse setup-time packing
  storage. D3D11 scatters each element into the stage's authoritative reflected stride.

`BUNNYHOP_GFX_DISPATCH=ON` forces the Windows-style branch on macOS/Linux with an unavailable D3D stub.
It does not change the shipping default. Depth readback currently requires the entire subresource;
color readback supports rectangles. Standalone fences reuse 64 precreated event queries;
released queries are reused after completion, and saturation is an explicit error. The backend never applies another clip-space or vertex-Y fixup.
