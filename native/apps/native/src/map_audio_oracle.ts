// Runs the vendored web implementation to generate numeric expectations for map_audio_tests.cpp.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MapSounds,
  ambientLevels,
  soundLevelFromRadius,
  referenceDistance,
  distanceGain,
} from "../../web/src/audio/map-sounds";
import { parseWav, decodeWavSamples, parseSound } from "../../web/src/audio/map-sound-format";

function chunk(id: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.length + (body.length & 1));
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function fmt(codec: number, channels: number, rate: number, bits: number, extra?: Uint8Array): Uint8Array {
  const b = new Uint8Array(16 + (extra?.length ?? 0));
  const v = new DataView(b.buffer);
  v.setUint16(0, codec, true);
  v.setUint16(2, channels, true);
  v.setUint32(4, rate, true);
  v.setUint32(8, (rate * channels * bits) >> 3, true);
  v.setUint16(12, (channels * bits) >> 3, true);
  v.setUint16(14, bits, true);
  if (extra) b.set(extra, 16);
  return b;
}

function wav(opts: {
  seconds: number;
  rate?: number;
  channels?: number;
  loopAt?: number;
  info?: Record<string, string>;
}): Uint8Array {
  const rate = opts.rate ?? 22050;
  const channels = opts.channels ?? 1;
  const frames = Math.round(opts.seconds * rate);
  const data = new Uint8Array(frames * channels * 2);
  const d = new DataView(data.buffer);
  for (let i = 0; i < frames * channels; i++) d.setInt16(i * 2, Math.round(Math.sin(i / 10) * 20000), true);
  const parts = [chunk("fmt ", fmt(1, channels, rate, 16)), chunk("data", data)];
  if (opts.loopAt !== undefined) {
    const cue = new Uint8Array(4 + 24);
    const c = new DataView(cue.buffer);
    c.setUint32(0, 1, true);
    c.setUint32(4, 1, true);
    c.setUint32(24, opts.loopAt, true);
    parts.push(chunk("cue ", cue));
  }
  if (opts.info) {
    const sub = Object.entries(opts.info).map(([k, v]) => chunk(k, new TextEncoder().encode(v)));
    parts.push(chunk("LIST", concat([new TextEncoder().encode("INFO"), ...sub])));
  }
  const body = concat([new TextEncoder().encode("WAVE"), ...parts]);
  return chunk("RIFF", body);
}

function zip(files: [string, Uint8Array][]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, bytes] of files) {
    const n = new TextEncoder().encode(name);
    const lf = new Uint8Array(30 + n.length);
    const l = new DataView(lf.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint32(18, bytes.length, true);
    l.setUint32(22, bytes.length, true);
    l.setUint16(26, n.length, true);
    lf.set(n, 30);
    const cf = new Uint8Array(46 + n.length);
    const c = new DataView(cf.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint32(20, bytes.length, true);
    c.setUint32(24, bytes.length, true);
    c.setUint16(28, n.length, true);
    c.setUint32(42, offset, true);
    cf.set(n, 46);
    locals.push(lf, bytes);
    central.push(cf);
    offset += lf.length + bytes.length;
  }
  const cd = concat(central);
  const eocd = new Uint8Array(22);
  const e = new DataView(eocd.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cd.length, true);
  e.setUint32(16, offset, true);
  return concat([...locals, cd, eocd]);
}

class FakeParam {
  value = 0;
  setTargetAtTime(v: number) {
    this.value = v;
  }
  setValueAtTime(v: number) {
    this.value = v;
  }
  cancelScheduledValues() {}
}

class FakeNode {
  connections = 0;
  connect() {
    this.connections++;
  }
  disconnect() {
    this.connections = 0;
  }
}

class FakeSource extends FakeNode {
  static live = 0;
  static created = 0;
  buffer: unknown = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new FakeParam();
  offset = -1;
  private ended: ((e: Event) => void) | null = null;
  addEventListener(_: string, f: (e: Event) => void) {
    this.ended = f;
  }
  start(_: number, offset: number) {
    this.offset = offset;
    FakeSource.live++;
    FakeSource.created++;
  }
  stop() {
    if (!this.ended) return;
    const f = this.ended;
    this.ended = null;
    FakeSource.live--;
    f({ target: this } as unknown as Event);
  }
}

class FakeBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  constructor(o: { numberOfChannels: number; length: number; sampleRate: number }) {
    this.numberOfChannels = o.numberOfChannels;
    this.length = o.length;
    this.sampleRate = o.sampleRate;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  copyToChannel() {}
}

function fakeEngine() {
  const sources: FakeSource[] = [];
  const ctx = {
    state: "running",
    currentTime: 0,
    createGain: () => Object.assign(new FakeNode(), { gain: new FakeParam() }),
    createPanner: () =>
      Object.assign(new FakeNode(), {
        positionX: new FakeParam(),
        positionY: new FakeParam(),
        positionZ: new FakeParam(),
        refDistance: 0,
        rolloffFactor: 0,
        distanceModel: "",
        panningModel: "",
        maxDistance: 0,
      }),
    createBufferSource: () => {
      const source = new FakeSource();
      sources.push(source);
      return source;
    },
  };
  return {
    ctx,
    sources,
    buses: { map: new FakeNode() },
    listenerX: 0,
    listenerY: 0,
    listenerZ: 0,
    mapSilent: false,
    get now() {
      return ctx.currentTime;
    },
  };
}

/** A core with `ents` and a pak; `states` plays the wasm's export. */
function fakeCore(ents: Record<string, string>[], pak: Uint8Array, withExport = true) {
  const core = {
    x: {},
    entities: () => ents,
    pakView: () => pak,
    serial: 0,
    rows: [] as number[],
    commands: [] as string[],
    mapSoundSerial() {
      return withExport ? this.serial : 0;
    },
    mapSoundStates(out: Float32Array) {
      out.set(this.rows);
      return this.rows.length;
    },
    mapSoundCommands() {
      const c = this.commands;
      this.commands = [];
      return c;
    },
    brushOrigins: () => new Map(),
  };
  return core;
}

const output = Bun.argv[2];
if (!output) throw new Error("usage: map_audio_oracle.ts OUTPUT_DIRECTORY");
mkdirSync(output, { recursive: true });
globalThis.AudioBuffer = FakeBuffer as unknown as typeof AudioBuffer;
Object.assign(globalThis, { requestIdleCallback: (callback: () => void) => setTimeout(callback, 0) });
const levels = [-1, 0, 0.01, 1, 36, 72, 128, 512, 1250, 3000, 10000].flatMap((radius) =>
  [false, true].map((everywhere) => ({ radius, everywhere, level: soundLevelFromRadius(radius, everywhere) })),
);
const falloff = [0, 20, 40, 60, 70, 90, 120].flatMap((level) =>
  [0, 1, 36, 100, 250, 1250, 10000, 1e6].map((distance) => ({
    level,
    distance,
    reference: referenceDistance(level),
    gain: distanceGain(level, distance),
  })),
);
const entities: Record<string, string>[] = [
  {},
  {
    health: "3",
    pitch: "150",
    pitchstart: "40",
    spinup: "80",
    spindown: "20",
    volstart: "1",
    fadein: "90",
    fadeout: "70",
  },
  { health: "10", fadeinsecs: "3", fadeoutsecs: "8" },
  ...Array.from({ length: 29 }, (_, index) => ({ preset: String(index) })),
];
const ramps = entities.map((entity) => ({ entity, expected: ambientLevels(entity) }));
const pcm = wav({ seconds: 0.125, loopAt: 100, channels: 2 });
function encode(codec: string, format: string): Uint8Array {
  const process = Bun.spawnSync(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-map_metadata",
      "-1",
      "-c:a",
      codec,
      ...(format === "mp3" ? ["-write_xing", "0"] : []),
      "-f",
      format,
      "pipe:1",
    ],
    { stdin: pcm, stdout: "pipe", stderr: "pipe" },
  );
  if (process.exitCode !== 0) throw new Error(new TextDecoder().decode(process.stderr));
  return process.stdout;
}
const formats = [
  { name: "pcm.wav", bytes: pcm },
  { name: "adpcm.wav", bytes: encode("adpcm_ms", "wav") },
  { name: "tone.mp3", bytes: encode("libmp3lame", "mp3") },
].map(({ name, bytes }) => {
  writeFileSync(join(output, name), bytes);
  const info = parseSound(name, bytes);
  const samples = info.format === "wav" ? decodeWavSamples(bytes, info) : null;
  return {
    name,
    channels: info.channels,
    rate: info.rate,
    loopStart: info.loopStart,
    loopEnd: info.loopEnd,
    samples: samples ? samples.map((channel) => Array.from(channel)) : null,
  };
});
const loops = [0, 10, 100, 2000].map((loopAt) => {
  const bytes = wav({ seconds: 0.125, loopAt });
  const name = `cue-${loopAt}.wav`;
  writeFileSync(join(output, name), bytes);
  const info = parseWav(bytes);
  return { name, start: info.loopStart, end: info.loopEnd };
});
const sampleLoop = new Uint8Array(60);
const sampleView = new DataView(sampleLoop.buffer);
sampleView.setUint32(28, 1, true);
sampleView.setUint32(44, 200, true);
sampleView.setUint32(48, 900, true);
for (const [name, bytes] of [
  ["cue-and-smpl.wav", concat([pcm, chunk("smpl", sampleLoop)])],
  ["smpl.wav", concat([wav({ seconds: 0.125 }), chunk("smpl", sampleLoop)])],
] as const) {
  writeFileSync(join(output, name), bytes);
  const info = parseWav(bytes);
  loops.push({ name, start: info.loopStart, end: info.loopEnd });
}
const ambient = (index: number) => ({
  classname: "ambient_generic",
  health: "10",
  pitch: "100",
  radius: "1250",
  spawnflags: "0",
  origin: `${index * 100} 0 0`,
  message: "a.wav",
});
const many = Array.from({ length: 300 }, (_, index) => ambient(index));
const engine = fakeEngine();
const core = fakeCore(many, zip([["sound/a.wav", wav({ seconds: 1, loopAt: 0 })]]));
const sounds = new MapSounds(
  engine as unknown as ConstructorParameters<typeof MapSounds>[0],
  { files: { "sound/a.wav": { sha256: "fixture", size: 1 } } },
  "",
  core as unknown as ConstructorParameters<typeof MapSounds>[3],
  null,
);
for (let attempt = 0; attempt < 100 && !sounds.stats().ready; ++attempt)
  await new Promise((resolve) => setTimeout(resolve, 2));
if (!sounds.stats().ready) throw new Error("web sound fixture did not load");
const voices = [0, 500, 1500, 5000, 15000, 29900].map((listenerX) => {
  engine.listenerX = listenerX;
  engine.ctx.currentTime += 0.25;
  sounds.frame(core as unknown as ConstructorParameters<typeof MapSounds>[3]);
  return {
    listenerX,
    entities: sounds
      .stats()
      .voices.map((voice) => voice.ent)
      .sort((a, b) => a - b),
  };
});
sounds.dispose();
writeFileSync(join(output, "oracle.json"), JSON.stringify({ levels, falloff, ramps, formats, loops, many, voices }));
console.log(
  `map audio oracle: ${levels.length} levels, ${falloff.length} falloffs, ${ramps.length} ramps, ` +
    `${formats.length} formats, ${loops.length} loops, ${voices.length} voice rankings`,
);
const pakBytes = zip([
  ["sound/a.wav", pcm],
  ["sound/aoki/xfiles.wav", pcm],
]);
const bsp = new Uint8Array(1036 + pakBytes.length);
bsp.set(new TextEncoder().encode("VBSP"));
const header = new DataView(bsp.buffer);
header.setUint32(4, 20, true);
header.setUint32(8 + 40 * 16, 1036, true);
header.setUint32(12 + 40 * 16, pakBytes.length, true);
bsp.set(pakBytes, 1036);
writeFileSync(join(output, "map.bsp"), bsp);
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
writeFileSync(
  join(output, "manifest.json"),
  JSON.stringify({
    mapSha256: sha(bsp),
    optional: {
      mapSounds: {
        files: {
          "sound/a.wav": { sha256: sha(pcm), size: pcm.length },
        },
      },
    },
  }),
);
const scapeBody = {
  loops: [{ wave: "sound/a.wav", volume: [0.4, 0.3] as [number, number], pitch: [90, 20] as [number, number] }],
  randoms: [
    {
      waves: ["sound/b.wav"],
      time: [1, 1] as [number, number],
      volume: [0.3, 0.1] as [number, number],
      pitch: [80, 40] as [number, number],
      position: "random" as const,
    },
  ],
  subs: [{ name: "sub", volume: [0.3, 0.6] as [number, number] }],
};
const subBody = {
  loops: [{ wave: "sound/a.wav", volume: [0.5, 0.2] as [number, number], pitch: [60, 20] as [number, number] }],
  randoms: [],
  subs: [],
};
const scapeEntities = [{ classname: "env_soundscape", soundscape: "outdoor", radius: "-1" }];
const scapeGroup = {
  files: { "sound/a.wav": { sha256: "a", size: 1 }, "sound/b.wav": { sha256: "b", size: 1 } },
  scapes: { outdoor: scapeBody, sub: subBody },
};
const scapeEngine = fakeEngine();
const scapeCore = fakeCore(
  scapeEntities,
  zip([
    ["sound/a.wav", wav({ seconds: 1, loopAt: 0 })],
    ["sound/b.wav", wav({ seconds: 0.2 })],
  ]),
);
let randomState = 977;
const random = () => {
  randomState ^= randomState << 13;
  randomState ^= randomState >>> 17;
  randomState ^= randomState << 5;
  return (randomState >>> 0) / 4294967296;
};
const scapeSounds = new MapSounds(
  scapeEngine as unknown as ConstructorParameters<typeof MapSounds>[0],
  scapeGroup,
  "",
  scapeCore as unknown as ConstructorParameters<typeof MapSounds>[3],
  null,
  undefined,
  random,
);
for (let attempt = 0; attempt < 100 && !scapeSounds.stats().ready; ++attempt)
  await new Promise((resolve) => setTimeout(resolve, 2));
const scapeFrames = [0.25, 1, 1.5, 2, 3.5, 4, 5].map((now) => {
  scapeEngine.ctx.currentTime = now;
  scapeSounds.frame(scapeCore as unknown as ConstructorParameters<typeof MapSounds>[3]);
  return {
    now,
    voices: scapeSounds
      .stats()
      .voices.map((voice) => ({
        path: voice.path,
        volume: voice.vol,
        rate: voice.rate,
        level: voice.level,
        position: [voice.x, voice.y, voice.z],
      }))
      .sort((first, second) => first.rate! - second.rate!),
  };
});
scapeSounds.dispose();
writeFileSync(
  join(output, "scapes.json"),
  JSON.stringify({ entities: scapeEntities, group: scapeGroup, frames: scapeFrames }),
);
