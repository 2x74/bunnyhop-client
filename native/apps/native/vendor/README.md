# Vendored headers

Single-header libraries copied in verbatim. Nothing here is modified; to
update, re-download from the upstream URL and refresh the `LICENSE` beside it
(each one carries its licence text at the end of the header itself).

| Directory | Upstream | Used for |
|---|---|---|
| `nlohmann/` | https://github.com/nlohmann/json | JSON throughout the client |
| `dr_libs/` | https://github.com/mackron/dr_libs | Decoding custom WAV, MP3 and FLAC |
| `stb/` | https://github.com/nothings/stb | Decoding custom Ogg Vorbis |

`dr_libs` and `stb` exist only for the custom audio packs: a player's own files
in `sound/` and `bgm/` can be in any of those formats, so the client has to
decode them itself. The shipped bunnyhop.lol audio is raw float32 (`.f32`) and
needs no decoder — none of this is on the path for the default packs.

Each decoder is compiled into exactly one translation unit (`src/audio_pack.cpp`)
rather than being header-only everywhere, so the implementation is emitted once
and the ~1.3 MB of source does not land in every object file that touches audio.
