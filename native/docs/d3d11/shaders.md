# GLSL to D3D11 shader pipeline

D3D11 programs are generated from the same C++ GLSL and vendored player sources used by OpenGL.
Do not maintain HLSL copies by hand. CMake embeds precompiled DXBC in the Windows executable.

## Build

From the repository root:

```sh
python3 native/apps/native/tools/d3d-shaders/run.py --translate-only --jobs 2
```

Windows also compiles SM5 DXBC and checks reflection. Use an x64 Visual Studio developer shell with the SDK
pinned in `tools/d3d-shaders/toolchain.json`, and omit `--translate-only`. Tool revisions and compiler hashes
are checked. Output lives in `native/target/d3d-shaders/output`: manifest, per-key reflection, generated sources,
compiler diagnostics and `report.json`. A failed compilation or interface check returns nonzero.

The extractor checks creation sites and evaluates the actual C++ source factories and player permutations.
There are 135 cache keys, including aliases, for 105 distinct program pairs. New keys must be represented in
both extraction and runtime lookup. Program creation loads DXBC rather than compiling shaders during play.

## Translation and binding contract

The pipeline links GLSL with relaxed Vulkan rules and a named default uniform block:

```text
-V -R --auto-map-bindings --auto-map-locations --set-default-uniform-block NativeUniforms 0 0 -l
```

It matches varying locations by GLSL name, preserves the complete vertex-output order in pixel inputs and
checks compiled DXBC signatures. Keep those steps: automatic locations alone do not match player stages.
SPIRV-Cross uses `--hlsl --shader-model 50 --fixup-clipspace --flip-vert-y`. FXC uses strictness, IEEE strictness
and optimization level 3. Keep the bounded ten-iteration FXAA search; unbounded lowering fails FXC unrolling.

Bindings come from each stage's DXBC reflection. A uniform can have different offsets in vertex and pixel
buffers. Scatter caller bytes into precomputed layouts; optimized-out names do nothing. Booleans are uint32
0/1, vec3 arrays use reflected strides, and matrices retain GL column-major source bytes. Generated row-major
HLSL declarations and reversed `mul` operands account for the matrix convention.

Logical texture units fan out to reflected stage-local SRV and sampler slots. Unit 9 feeds multiple player
environment names. `boneMatrices` is an RGBA32F texture, with three texels per bone. Preserve filter, mip,
comparison, border and address settings. An optimized-out sampler can coexist with a surviving texture.

## Coordinates

Keep GL projection and depth reconstruction unchanged: translation converts clip Z once. Intermediate targets
retain GL numeric row order, including fragment coordinates, derivatives, texture UVs, copies and integer loads.
The presenter flips once for the swapchain. Rasterizer winding must account for the vertex Y flip.
World/depth shaders always emit clip distance; disable clipping with `gfx::no_clip_height` outside reflections.

Compare water, shadows, ghost dithering, mirrored weapons and procedural finishes on Windows after shader or
backend changes. Cross-driver transcendental approximations and undefined shader inputs can change pixels.
