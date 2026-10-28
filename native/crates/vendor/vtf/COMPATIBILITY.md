# Excessive authored mip-count compatibility

Investigation 2026-10-12: the original `kz_bhop_solitude` archive and packed BSP have identical `materials/kz_bhop_genkai/bhop_single.vtf` and `wall.vtf` files. Both are VTF 7.3, 64×64, one frame, DXT5, header mipCount 10, high-image offset 224 and file length 41,184. A natural chain has seven levels; treating the extra count as three repeated 1×1 levels would shift the top image by 48 bytes.

The public Valve SDK has the VTF interface but ships the implementation as an official binary archive rather than C++ source:

- [VTF interface](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/public/vtf/vtf.h)
- [Official Source SDK VTF library](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/lib/public/linux64/vtf.a)
- [ImageLoader mip interface](https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/public/bitmap/imageformat.h)

Inspected SDK tree `be57e3d01ac7d7aa6a2cacbfef187c0b46616db0`, VTF archive Git blob `78f905427a971b82f71e86c3cf4c014ca7b68f37`, downloaded archive SHA-256 `1b8026da511652b513a4467c233096473e43efdf1ad3e20ab7ad258f61b5b928`.

Inspection with `objdump -dr --demangle` shows `CVTFTexture::UnserializeEx` loading width/height/depth and calling `ImageLoader::GetNumMipMapLevels(int,int,int)` at offset `0x655c`, storing its result as the object's mip count at `0x6561`. It does not read the header mipCount byte to enlarge that count. `ComputeMipLevelDimensions` right-shifts dimensions and clamps each to one; that alone is not evidence for accepting extra authored levels. This conclusion comes from inspection of Valve's published reader binary, not execution of a CS:S client.

The decoder now caps **excessive** declared mip counts to the natural dimension chain for its `Source2013Pc` dialect. Valid authored shorter chains are unchanged. Zero mip counts remain errors. Image/resource range checks, overflow checks, encoded/decoded allocation limits and subresource limits are unchanged; no missing bytes or image data are synthesized. The change does not admit three additional fictitious 1×1 subresources. The original Solitude top images read bytes `1616..5712`, matching the seven-level chain starting at 224. Unused trailing payload is not decoded.

Regression commands:

```sh
cargo test -p playsrc-vtf
cargo test -p playsrc-vtf --test solitude_excess_mips -- --ignored
```

The synthetic test checks the top-plane pixel offset and still rejects truncation and zero counts. The optional archive regression decodes both actual files, checks the natural chain and top-image offsets, and verifies all seven planes. No texture file was altered. The content WASM was subsequently rebuilt at the coordinating agent's request, SHA-256 `3d52f9b2ec5c1246b730fa6ba800f3c0215c5fc72353772c1d5a4c13de7608aa`; native VTF (14 tests), actual archive (1), Low Gravity (1) and physics-version (9) regression groups passed. Final map rendering QA is recorded separately by the integration workflow.

Final browser check on the rebuilt WASM at local `?map=kz_bhop_solitude`: both named texture paths return 64×64 RGBA8 (16,384 bytes) and full seven-level DXT5 chains (4,096/1,024/256/64/16/16/16 bytes). The map renderer reports 0/124 missing world materials, 207 uploaded textures, no page/console/shader errors and WebGL error 0. The map still reports no zones; this texture fix does not establish playable route or verifier readiness. A local render screenshot is retained at `research/next-update-2026-10-12/screenshots/solitude-vtf-after.png`.
