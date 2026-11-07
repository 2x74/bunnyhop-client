// Loopback-only qualification: the real room service feeds the headless native controller.
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { NativeRoomService, type RoomTransport } from "../ui/room-service";
import { roomRaceTag } from "../ui/room-race";
import type { RoomHandlers } from "../../web/src/net/room";
import { WIRE_STYLES, parseServerMsg } from "../../web/src/net/protocol";
const base = new URL(Bun.argv[2] ?? "http://127.0.0.1:8793");
assert(["127.0.0.1", "localhost"].includes(base.hostname), "Use a local API");
// Bun accepts HTTP headers for a client socket; the menu's DOM constructor does not.
const LoopbackSocket = WebSocket as unknown as new (
  url: URL,
  options: { headers: Record<string, string> },
) => WebSocket;
const executable = resolve(import.meta.dir, "../build/bunnyhop-native-room-race-tests");
interface Client {
  service: NativeRoomService;
  cookie: string;
  messages: Record<string, unknown>[];
  actions: Record<string, unknown>[];
  socket: WebSocket | null;
  stop(): void;
}
async function until(ready: () => boolean, label: string, timeout = 10000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!ready()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${label}`);
    await Bun.sleep(10);
  }
}
async function client(name: string, capable = true): Promise<Client> {
  const response = await fetch(new URL("/api/auth/guest", base), {
    method: "POST",
    headers: { origin: base.origin, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  assert(response.ok, await response.clone().text());
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const process = Bun.spawn([executable, "--wire"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const result: Client = {
    cookie,
    service: null!,
    messages: [],
    actions: [],
    socket: null,
    stop() {
      result.service.leave();
      process.stdin.end();
      process.kill();
    },
  };
  void (async () => {
    const reader = process.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        result.actions.push(JSON.parse(pending.slice(0, newline)));
        pending = pending.slice(newline + 1);
      }
    }
  })();
  const connect = (handlers: RoomHandlers): RoomTransport => {
    let stopped = false,
      socket: WebSocket,
      offset = 0;
    const open = () => {
      const url = new URL("/api/servers/easy/ws", base);
      url.protocol = "ws:";
      url.search = new URLSearchParams({
        v: "1",
        style: "autohop",
        wire: String(WIRE_STYLES.length),
        ...(capable ? { roomrace: "1" } : {}),
      }).toString();
      socket = new LoopbackSocket(url, { headers: { cookie, origin: "https://bunnyhop.lol" } });
      result.socket = socket;
      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = parseServerMsg(event.data);
        if (!message) return;
        if (message.t === "welcome") {
          offset = message.now - Date.now();
          handlers.status("open");
        }
        handlers.message(message);
      };
      socket.onclose = () => {
        if (!stopped) {
          handlers.status("reconnecting");
          setTimeout(open, 200);
        }
      };
      socket.onerror = () => {};
    };
    open();
    return {
      send: (message) => socket.send(JSON.stringify(message)),
      pushSample() {},
      flushSamples() {},
      close: () => {
        stopped = true;
        socket.close(1000);
      },
      serverNow: () => Date.now() + offset,
      toLocal: (time) => time - offset,
    };
  };
  result.service = new NativeRoomService({
    ensureAccount: async () => true,
    connect: (_id, handlers) => connect(handlers),
    send: (message) => {
      result.messages.push(message as unknown as Record<string, unknown>);
      if (message.type === "roomEvent")
        process.stdin.write(JSON.stringify({ message, map: "bhop_eazy", now: Date.now() }) + "\n");
    },
  });
  try {
    await result.service.join("easy");
    await until(() => result.service.view.status === "open", `${name} welcome`);
    return result;
  } catch (error) {
    result.stop();
    throw error;
  }
}
const clients: Client[] = [];
try {
  const a = await client("Native Alice");
  clients.push(a);
  const b = await client("Native Bob");
  clients.push(b);
  const observer = await client("Native Observer", false);
  clients.push(observer);
  const command = (c: Client, text: string) => assert(c.service.command({ t: "chat", text }));
  command(a, "!race all normal main");
  await until(() => !!a.service.view.roomRace, "room race opens");
  command(observer, "!join");
  await until(
    () => observer.messages.some((m) => m.type === "chatLine" && String(m.text).includes("Update your game")),
    "legacy capability refusal",
  );
  command(b, "!join");
  await until(() => a.service.view.roomRace?.racers.length === 2, "second entrant");
  await until(() => a.service.view.roomRace?.state === "countdown", "countdown", 25000);
  await until(() => a.actions.some((action) => action.canonical && action.frozen), "native canonical reset and hold");
  assert(!observer.actions.some((action) => action.restart || action.frozen));
  await until(() => a.service.view.roomRace?.state === "live", "server GO");
  await until(() => a.actions.some((action) => action.go && action.canonical && !action.frozen), "native GO reset");
  const race = a.service.view.roomRace!;
  assert.equal(roomRaceTag(race, { map: race.map, style: race.style, track: race.track }), race.id);
  const resets = a.actions.filter((action) => action.restart).length;
  const welcomes = a.messages.filter(
    (m) => m.type === "roomEvent" && (m.event as { t: string }).t === "welcome",
  ).length;
  a.socket!.close(1001);
  await until(
    () =>
      a.messages.filter((m) => m.type === "roomEvent" && (m.event as { t: string }).t === "welcome").length > welcomes,
    "live reconnect welcome",
  );
  await until(
    () => a.actions.length >= a.messages.filter((m) => m.type === "roomEvent").length,
    "native reconnect restore",
  );
  assert.equal(a.actions.filter((action) => action.restart).length, resets);
  command(b, "!leave");
  await until(() => a.service.view.roomRace?.racers[1].dnf === "forfeit", "leave DNF");
  command(a, "!forfeit");
  await until(() => a.service.view.roomRace?.state === "over", "final standings");
  assert.equal(roomRaceTag(a.service.view.roomRace, { map: race.map, style: race.style, track: race.track }), null);
  await until(() => a.actions.some((action) => action.over && !action.frozen), "native final release");
  assert(a.messages.some((m) => m.type === "chatLine" && String(m.text).startsWith("Room race standings:")));
  console.log(
    JSON.stringify(
      {
        passed: true,
        id: race.id,
        nativeResets: resets,
        liveReconnectResets: a.actions.filter((action) => action.restart).length - resets,
        chat: a.messages
          .filter((m) => m.type === "chatLine" && /Room race|DNF/.test(String(m.text)))
          .map((m) => m.text),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      clients.map((c) => ({
        status: c.service.view.status,
        race: c.service.view.roomRace,
        chat: c.messages.filter((m) => m.type === "chatLine").map((m) => m.text),
        actions: c.actions.slice(-5),
      })),
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const c of clients) c.stop();
}
