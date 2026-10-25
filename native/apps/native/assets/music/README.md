# bunnyhop.lol OST

The eleven tracks are the same selected, normalized soundtrack shipped by web
v0.0.27. Original music generated with ElevenLabs Music for bunnyhop.lol.
Titles, roles, durations, credits, production-source hashes and packaged hashes
are recorded in `manifest.json`.

The production Opus/WebM files were converted to native-supported MP3 with:

```sh
ffmpeg -v error -y -fflags +bitexact -i TRACK.webm -map_metadata -1 -vn \
  -ar 48000 -ac 2 -c:a libmp3lame -q:a 2 -flags:a +bitexact TRACK.mp3
```

The committed MP3 bytes are the build inputs. Building requires no soundtrack
download or music conversion. `export-music.ts` verifies and copies them into
`native-assets/music`; the package checker requires the full soundtrack and
credits. All copied bytes participate in the package's asset/build identity.

Playback uses the existing bounded native decoder and SDL stream. The menu
track is omitted during gameplay; pause, previous and next controls operate in
the native host.
