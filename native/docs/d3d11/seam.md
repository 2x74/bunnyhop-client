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
