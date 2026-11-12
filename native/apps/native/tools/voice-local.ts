// Loopback-only interoperability proof for voice chat: the native client's voice (the voice harness behind the real
// menu room service, as the game sits behind the menu) and the website's voice in headless Chromium, in one real room
// on a local stack. Nothing leaves this machine.
//
// Start the website's local voice stack first (its tools/voice/voice-dev.ts: the API on 18961, the site on 5497), and
// build bunnyhop-native-voice-harness. Then, from native/:
//   bun apps/native/tools/voice-local.ts --web-repo ~/src/bunnyhop-party-voice [--out DIR]
// The website talks at 440 Hz and the native side at 550 Hz; each side checks it heard the other's pitch. It runs
// twice: with the browser's WebCodecs Opus and with the libopus-wasm fallback (?voicecodec=wasm).
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { NativeRoomService, type RoomTransport } from "../ui/room-service";
import type { RoomHandlers } from "../../web/src/net/room";
import { decodeSnapshot, parseServerMsg, WIRE_STYLES } from "../../web/src/net/protocol";

const arg = (name: string, fallback: string): string => {
  const at = Bun.argv.indexOf(name);
  return at >= 0 ? Bun.argv[at + 1] : fallback;
};
const API = arg("--api", "http://localhost:18961");
const WEB = arg("--web", "http://localhost:5497");
const ROOM = arg("--room", "voice-bhop");
const MAP = arg("--map", "bhop_eazy");
const WEB_REPO = resolve(arg("--web-repo", ""));
const OUT = resolve(arg("--out", "target/voice-local"));
const harnessPath = resolve(import.meta.dir, "../build/bunnyhop-native-voice-harness");
for (const url of [API, WEB]) assert(["127.0.0.1", "localhost"].includes(new URL(url).hostname), "Use a local stack");
mkdirSync(OUT, { recursive: true });

const sleep = (ms: number) => Bun.sleep(ms);
async function until(ready: () => boolean | Promise<boolean>, label: string, timeout = 20_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await ready())) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await sleep(50);
  }
}

/** Local D1 only: guests can't talk, so the talkers become accounts. The release tree's stack keeps its own state. */
async function makeAccounts(ids: string[]): Promise<void> {
  const api = join(WEB_REPO, "apps/api");
  const own = existsSync(join(api, ".wrangler/voice-dev/wrangler.jsonc"));
  const state = own
    ? [".wrangler/voice-state", ".wrangler/voice-dev/wrangler.jsonc"]
    : [".wrangler/state", "wrangler.jsonc"];
  const list = ids.map((id) => `'${id.replace(/[^\w-]/g, "")}'`).join(",");
  const command = `UPDATE users SET provider = 'discord' WHERE id IN (${list})`;
  const args = ["d1", "execute", "DB", "--local", "--persist-to", state[0], "--config", state[1], "--command", command];
  const env = { ...Bun.env, WRANGLER_SEND_METRICS: "false" };
  const process = Bun.spawn(["bunx", "wrangler", ...args], { cwd: api, env, stdout: "pipe", stderr: "pipe" });
  if ((await process.exited) !== 0) throw new Error(await new Response(process.stderr).text());
}

// ------------------------------------------------------------------------------------------------- the native side

interface Report {
  heard: Record<string, { frames: number; seconds: number; pitch: number; purity: number; playout?: unknown }>;
  mixedRms: number;
  mixedSeconds: number;
  sentPackets: number;
  sentFrames: number;
  concealed: number;
  active: boolean;
}

interface NativeClient {
  id: string;
  service: NativeRoomService;
  key(down: boolean): void;
  report(): Promise<Report>;
  stop(): void;
}

// Bun's WebSocket takes request headers; the menu's DOM WebSocket gets the cookie from the web view instead.
const HeaderSocket = WebSocket as unknown as new (url: URL, options: { headers: Record<string, string> }) => WebSocket;

function transport(cookie: string, handlers: RoomHandlers): RoomTransport {
  const url = new URL(`${API}/servers/${ROOM}/ws`);
  url.protocol = "ws:";
  url.search = new URLSearchParams({
    v: "1",
    style: "autohop",
    roomrace: "1",
    wire: String(WIRE_STYLES.length),
  }).toString();
  const socket = new HeaderSocket(url, { headers: { cookie, origin: WEB } });
  socket.binaryType = "arraybuffer";
  let offset = 0;
  const out: RoomTransport = {
    send: (message) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message)),
    sendBinary: (bytes) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(bytes);
      return true;
    },
    onVoice: null,
    pushSample() {},
    flushSamples() {},
    close: () => socket.close(1000),
    serverNow: () => Date.now() + offset,
    toLocal: (time) => time - offset,
  };
  socket.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const buf = event.data as ArrayBuffer;
      if (new Uint8Array(buf)[0] === 0x11) return out.onVoice?.(buf);
      const snapshot = decodeSnapshot(buf);
      if (snapshot) handlers.snapshot(snapshot, performance.now());
      return;
    }
    if (event.data === "pong") return;
    const message = parseServerMsg(event.data);
    if (!message) return;
    if (message.t === "welcome") {
      offset = message.now - Date.now();
      handlers.status("open");
    }
    handlers.message(message);
  };
  socket.onclose = (event) => handlers.status("closed", event.reason);
  return out;
}

async function guest(name: string): Promise<{ id: string; cookie: string }> {
  const response = await fetch(`${API}/auth/guest`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert(response.ok, await response.clone().text());
  const { id } = (await response.json()) as { id: string };
  return { id, cookie: response.headers.get("set-cookie")!.split(";")[0] };
}

async function nativeClient(name: string): Promise<NativeClient> {
  const account = await guest(name);
  const harness = Bun.spawn([harnessPath, "--tone", "550"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const write = (value: unknown) => harness.stdin.write(JSON.stringify(value) + "\n");
  const waiting: { report: ((report: Report) => void) | null } = { report: null };
  const service: NativeRoomService = new NativeRoomService({
    ensureAccount: async () => true,
    connect: (_id, handlers) => transport(account.cookie, handlers),
    send: (message) => {
      if (message.type === "roomEvent" || message.type === "voiceDown" || message.type === "voicePeople")
        write(message);
    },
  });
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of harness.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = JSON.parse(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (line.type === "voiceUp") service.voice.up(line.data);
        else if (line.type === "report") waiting.report?.(line);
      }
    }
  })();
  return {
    id: account.id,
    service,
    key: (down) => write({ type: "key", down }),
    report: () =>
      new Promise((done) => {
        waiting.report = done;
        write({ type: "report" });
      }),
    stop: () => {
      service.leave();
      write({ type: "quit" });
      harness.stdin.end();
    },
  };
}

// --------------------------------------------------------------------------------------------- the website's side

interface WebClient {
  id: string;
  context: BrowserContext;
  page: Page;
}

async function webClient(browser: Browser, name: string, frequency: number): Promise<WebClient> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript((hz: number) => {
    localStorage.setItem("bunnyhop:onboarded", "1");
    localStorage.setItem("bunnyhop:gfx-detect", "measured");
    localStorage.setItem(
      "bunnyhop:settings",
      JSON.stringify({ graphics: { menuBackground: "off", fullscreen: false }, audio: { musicMode: "off" } }),
    );
    // A synthetic microphone: a tone with a 4 Hz syllable envelope, as a real MediaStream.
    navigator.mediaDevices.getUserMedia = async () => {
      const audio = new AudioContext({ sampleRate: 48000 });
      const tone = audio.createOscillator();
      tone.frequency.value = hz;
      const gain = audio.createGain();
      gain.gain.value = 0.22;
      const syllables = audio.createOscillator();
      syllables.frequency.value = 4;
      const depth = audio.createGain();
      depth.gain.value = 0.12;
      syllables.connect(depth).connect(gain.gain);
      const out = audio.createMediaStreamDestination();
      tone.connect(gain).connect(out);
      tone.start();
      syllables.start();
      await audio.resume();
      return out.stream;
    };
  }, frequency);
  const response = await context.request.post(`${API}/auth/guest`, {
    data: { name },
    headers: { origin: WEB, "content-type": "application/json" },
  });
  assert(response.ok(), await response.text());
  const { id } = (await response.json()) as { id: string };
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[${name}]`, error.message));
  return { id, context, page };
}

async function enter(client: WebClient, codec: string): Promise<void> {
  await client.page.goto(`${WEB}/?map=${MAP}&server=${ROOM}${codec ? `&voicecodec=${codec}` : ""}`);
  await client.page.waitForFunction(
    () => document.body.classList.contains("in-game") && (window as any).__voice?.active === true,
    null,
    { timeout: 240_000, polling: 500 },
  );
  await client.page.evaluate(() => {
    const w = window as any;
    document.getElementById("overlay")?.classList.add("hidden");
    document.getElementById("resume-veil")?.remove();
    document.body.classList.remove("menu-open");
    // Headless has no pointer lock: the game has the keys as it would while playing.
    w.bunnyhop.input.locked = true;
    w.__tapped = {};
    w.__voice.tap = (slot: number, pcm: Float32Array) => {
      const t = (w.__tapped[slot] ??= { frames: 0, pcm: [] as number[] });
      t.frames++;
      if (t.pcm.length < 48000 * 3) t.pcm.push(...pcm);
    };
  });
}

/** Goertzel power at `hz` over 48 kHz samples. */
function power(samples: number[], hz: number): number {
  const k = 2 * Math.cos((2 * Math.PI * hz) / 48000);
  let s1 = 0,
    s2 = 0;
  for (const v of samples) {
    const s = v + k * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

async function webHeard(client: WebClient, slot: number): Promise<{ frames: number; pitch: number } | null> {
  const tapped = await client.page.evaluate((s: number) => (window as any).__tapped[s] ?? null, slot);
  if (!tapped) return null;
  const pcm = (tapped.pcm as number[]).slice(4800);
  const pitches = [330, 440, 550, 660, 880];
  const best = pitches.reduce((a, b) => (power(pcm, a) >= power(pcm, b) ? a : b));
  return { frames: tapped.frames, pitch: best };
}

const webRows = (client: WebClient) =>
  client.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("#voice-hud .vh-row")].map((row) => Number(row.dataset.slot)),
  );

// ------------------------------------------------------------------------------------------------------ the run

async function pass(browser: Browser, native: NativeClient, codec: string): Promise<Record<string, unknown>> {
  const web = await webClient(browser, codec ? "Web Wasm" : "Web Codecs", 440);
  await makeAccounts([web.id]);
  await enter(web, codec);
  const nativeSlot = native.service.view.you;
  const webSlot = (await web.page.evaluate(() => (window as any).__voice.host.you())) as number;
  // Native talks; the website hears it and lists it.
  const before = await native.report();
  native.key(true);
  await sleep(1500);
  const rowsWhileNativeTalks = await webRows(web);
  await web.page.screenshot({ path: join(OUT, `web-hears-native${codec ? "-wasm" : ""}.png`) });
  await sleep(1500);
  native.key(false);
  await sleep(800);
  const afterNative = await native.report();
  const webStats = await web.page.evaluate(() => ({ ...(window as any).__voice.stats }));
  const nativeSpurt = {
    sentPackets: afterNative.sentPackets - before.sentPackets,
    sentFrames: afterNative.sentFrames - before.sentFrames,
    webReceivedFrames: webStats.recvFrames,
  };
  // The website talks; native hears it.
  await web.page.keyboard.down("KeyX");
  await sleep(3000);
  await web.page.keyboard.up("KeyX");
  await sleep(800);
  const heardByWeb = await webHeard(web, nativeSlot);
  const report = await native.report();
  const heardByNative = report.heard[String(webSlot)];
  // The site's own module, served by its dev server.
  const codecPath = await web.page.evaluate(
    async (module: string) => (await import(module)).codecPath(),
    "/src/voice/codec.ts",
  );
  await web.context.close();
  const checks: [string, boolean][] = [
    ["website lists the native talker", rowsWhileNativeTalks.includes(nativeSlot)],
    ["website decoded native at 550 Hz", heardByWeb?.pitch === 550 && heardByWeb.frames >= 75],
    ["native decoded the website at 440 Hz", heardByNative?.pitch === 440 && heardByNative.frames >= 75],
    ["native played it out", report.mixedRms > 0.01],
    ["every frame native sent reached the website", nativeSpurt.webReceivedFrames >= nativeSpurt.sentFrames],
  ];
  return { codec: codecPath, nativeSlot, webSlot, nativeSpurt, heardByWeb, heardByNative, report, checks };
}

const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
const native = await nativeClient("Native Voice");
const results: Record<string, unknown>[] = [];
try {
  await makeAccounts([native.id]);
  await native.service.join(ROOM);
  await until(() => native.service.view.status === "open", "native welcome");
  results.push(await pass(browser, native, ""));
  results.push(await pass(browser, native, "wasm"));
} finally {
  native.stop();
  await browser.close();
}
writeFileSync(join(OUT, "voice-local.json"), JSON.stringify(results, null, 2) + "\n");
let ok = true;
for (const result of results)
  for (const [label, passed] of result.checks as [string, boolean][]) {
    ok &&= passed;
    console.log(`${passed ? "PASS" : "FAIL"} [${JSON.stringify(result.codec)}] ${label}`);
  }
console.log(`Report: ${join(OUT, "voice-local.json")}`);
process.exit(ok ? 0 : 1);
