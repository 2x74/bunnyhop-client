import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { Duplex } from 'node:stream';

import {
  DiscordFrameDecoder,
  DiscordPresence,
  DiscordRpcClient,
  buildPresenceActivity,
  discordSocketCandidates,
  encodeDiscordFrame,
} from '../discord-rpc.mjs';
import { EventEmitter } from 'node:events';

class MockDiscordSocket extends Duplex {
  constructor() {
    super();
    this.writes = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.writes.push(Buffer.from(chunk));
    callback();
  }
}

test('Discord frames decode across arbitrary chunks', () => {
  const encoded = encodeDiscordFrame(1, { evt: 'READY', data: { user: 'test' } });
  const decoder = new DiscordFrameDecoder();
  assert.deepEqual(decoder.push(encoded.subarray(0, 5)), []);
  const [frame] = decoder.push(encoded.subarray(5));
  assert.equal(frame.op, 1);
  assert.equal(frame.payload.evt, 'READY');
});

test('Bunnyhop presence uses fixed sentences and respects map privacy', () => {
  const raw = { kind: 'playing', mode: 'multiplayer', mapName: 'Castle\u0000', mapId: 'private-room', style: 'Auto', startedAt: 1700000000, url: 'file:///secret', secrets: { join: 'secret' }, roomId: 'secret' };
  const named = buildPresenceActivity(raw, { discordShowMap: true });
  assert.equal(named.details, 'Hopping on Castle');
  assert.equal(named.state, 'Multiplayer · Auto');
  assert.deepEqual(named.timestamps, { start: 1700000000 });
  assert.deepEqual(named.buttons, [{ label: 'Play Bunnyhop', url: 'https://bunnyhop.lol' }]);
  assert.equal(JSON.stringify(named).includes('secret'), false);
  assert.equal(JSON.stringify(named).includes('private-room'), false);
  assert.equal(buildPresenceActivity(raw, { discordShowMap: false }).details, 'Bunnyhopping');
  const privateActivity = buildPresenceActivity(raw, { discordShowMap: true, privacyMode: true });
  assert.equal(privateActivity.details, 'Bunnyhopping');
  assert.equal(privateActivity.state, 'Multiplayer');
  for (const [kind, details] of Object.entries({ menu: 'In the menu', paused: 'Paused on Castle', results: 'Finished Castle', replay: 'Watching Castle' })) {
    assert.equal(buildPresenceActivity({ ...raw, kind }, { discordShowMap: true }).details, details);
  }
  assert.equal(buildPresenceActivity({ kind: 'forged', mode: 'forged' }).state, 'Bunnyhop');
});

test('Discord socket candidates stay on local IPC paths', () => {
  const windows = discordSocketCandidates({ platform: 'win32' });
  assert.equal(windows.length, 10);
  assert.match(windows[0], /discord-ipc-0$/);
  const linux = discordSocketCandidates({ platform: 'linux', env: { XDG_RUNTIME_DIR: '/run/user/1000' }, uid: 1000 });
  assert.ok(linux.every((candidate) => candidate.includes('discord-ipc-')));
  assert.ok(linux.includes('/run/user/1000/discord-ipc-0'));
});

test('Discord client sends only handshake and presence commands after READY', async () => {
  const socket = new MockDiscordSocket();
  const client = new DiscordRpcClient('123456789012345678', {
    candidates: ['local-test-socket'],
    connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  });
  client.on('error', () => {});
  await client.start();

  const handshake = new DiscordFrameDecoder().push(socket.writes[0])[0];
  assert.equal(handshake.op, 0);
  assert.deepEqual(handshake.payload, { v: 1, client_id: '123456789012345678' });

  client.setActivity(buildPresenceActivity({ kind: 'playing', mapName: 'Castle' }, {
    discordShowMap: true,
    privacyMode: false,
  }));
  assert.equal(socket.writes.length, 1);

  socket.push(encodeDiscordFrame(1, { evt: 'READY' }));
  await new Promise((resolve) => setImmediate(resolve));
  const activity = new DiscordFrameDecoder().push(socket.writes[1])[0];
  assert.equal(activity.payload.cmd, 'SET_ACTIVITY');
  assert.equal(activity.payload.args.activity.details, 'Hopping on Castle');
  assert.deepEqual(activity.payload.args.activity.buttons, [
    { label: 'Play Bunnyhop', url: 'https://bunnyhop.lol' },
  ]);
  assert.equal('secrets' in activity.payload.args, false);
  client.stop();
});

test('stopping Discord during socket connect sends no orphan handshake', async () => {
  const socket = new MockDiscordSocket();
  const client = new DiscordRpcClient('123456789012345678', {
    candidates: ['pending-test-socket'],
    connect: () => socket,
  });
  client.on('error', () => {});
  const starting = client.start();
  client.stop();
  socket.emit('connect');
  await assert.rejects(starting, /stopped/);
  assert.equal(socket.destroyed, true);
  assert.equal(socket.writes.length, 0);
  assert.equal(client.socket, null);
});

test('stopping an established Discord session absorbs a late local socket reset', async () => {
  const socket = new MockDiscordSocket();
  const client = new DiscordRpcClient('123456789012345678', {
    candidates: ['established-test-socket'],
    connect: () => {
      queueMicrotask(() => socket.emit('connect'));
      return socket;
    },
  });
  client.on('error', () => {});
  await client.start();
  client.removeAllListeners();
  client.stop();
  assert.equal(socket.destroyed, true);
  assert.doesNotThrow(() => socket.emit('error', new Error('late reset')));
  assert.equal(client.socket, null);
});

test('Discord presence reconnects when Discord starts late or restarts', async () => {
  const scheduled = [];
  const clients = [];
  class FakeClient extends EventEmitter {
    constructor(fail) {
      super();
      this.fail = fail;
      this.activities = [];
      this.stopped = false;
    }
    async start() { if (this.fail) throw new Error('Discord desktop was not found'); }
    setActivity(value) { this.activities.push(value); }
    stop() { this.stopped = true; }
  }
  let attempt = 0;
  const presence = new DiscordPresence('123456789012345678', {
    createClient: () => {
      const client = new FakeClient(attempt++ === 0);
      clients.push(client);
      return client;
    },
    retryDelays: [2_000, 5_000],
    schedule: (callback, delay) => {
      scheduled.push({ callback, delay, canceled: false });
      return scheduled.length - 1;
    },
    cancel: (id) => { scheduled[id].canceled = true; },
  });
  const statuses = [];
  presence.on('status', (status) => statuses.push(status));
  presence.on('error', () => {});
  presence.setActivity({ details: 'Hopping on Castle' });
  await presence.start();
  assert.equal(statuses.at(-1).state, 'reconnecting');
  assert.equal(scheduled[0].delay, 2_000);

  scheduled[0].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(clients[1].activities, [{ details: 'Hopping on Castle' }]);
  clients[1].emit('status', { state: 'ready' });
  clients[1].emit('status', { state: 'disconnected' });
  assert.equal(statuses.at(-1).state, 'reconnecting');
  assert.equal(scheduled[1].delay, 2_000, 'a ready connection resets the backoff');
  presence.stop();
  assert.equal(scheduled[1].canceled, true);
});

async function eventually(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Discord IPC');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('local Discord IPC server receives handshake, fragmented READY, ping, rate-limited updates and clear', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bh-rpc-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(directory)}-discord-ipc-0`
    : path.join(directory, 'discord-ipc-0');
  const received = [];
  let peer;
  const server = net.createServer((socket) => {
    peer = socket;
    const decoder = new DiscordFrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decoder.push(chunk)) {
        received.push(frame);
        if (frame.op === 0) {
          const ready = encodeDiscordFrame(1, { evt: 'READY' });
          socket.write(ready.subarray(0, 5));
          socket.write(ready.subarray(5));
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
  });
  const client = new DiscordRpcClient('123456789012345678', { candidates: [endpoint], rateLimitMs: 80 });
  client.on('error', () => {});
  t.after(async () => {
    client.stop(); peer?.destroy();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  client.setActivity({ details: 'First' });
  await client.start();
  await eventually(() => received.length === 2);
  assert.deepEqual(received[0].payload, { v: 1, client_id: '123456789012345678' });
  assert.equal(received[1].payload.args.activity.details, 'First');
  peer.write(encodeDiscordFrame(3, { probe: 'ping' }));
  await eventually(() => received.some((frame) => frame.op === 4));
  assert.deepEqual(received.find((frame) => frame.op === 4).payload, { probe: 'ping' });
  client.setActivity({ details: 'Intermediate' });
  client.setActivity({ details: 'Latest' });
  await eventually(() => received.some((frame) => frame.payload.args?.activity?.details === 'Latest'));
  assert.equal(received.some((frame) => frame.payload.args?.activity?.details === 'Intermediate'), false);
  client.setActivity({ details: 'Canceled' });
  client.stop();
  await eventually(() => received.some((frame) => frame.payload.args?.activity === null));
  assert.equal(received.some((frame) => frame.payload.args?.activity?.details === 'Canceled'), false);
});

test('local IPC recovers after Discord starts late and restarts', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bh-retry-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(directory)}-discord-ipc-0`
    : path.join(directory, 'discord-ipc-0');
  const peers = new Set();
  const activities = [];
  let server;
  const presence = new DiscordPresence('123456789012345678', {
    createClient: () => new DiscordRpcClient('123456789012345678', { candidates: [endpoint] }),
    retryDelays: [250],
  });
  presence.on('error', () => {});
  t.after(async () => {
    presence.stop();
    for (const peer of peers) peer.destroy();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  presence.setActivity({ details: 'Persistent' });
  await presence.start();
  assert.equal(presence.client, null);
  const launch = async () => {
    server = net.createServer((socket) => {
      peers.add(socket);
      socket.on('close', () => peers.delete(socket));
      const decoder = new DiscordFrameDecoder();
      socket.on('data', (chunk) => {
        for (const frame of decoder.push(chunk)) {
          if (frame.op === 0) socket.write(encodeDiscordFrame(1, { evt: 'READY' }));
          if (frame.payload.args?.activity) activities.push(frame.payload.args.activity);
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, () => { server.removeListener('error', reject); resolve(); });
    });
  };
  await launch();
  await eventually(() => activities.length === 1);
  for (const peer of peers) peer.destroy();
  await new Promise((resolve) => server.close(resolve));
  await launch();
  await eventually(() => activities.length === 2);
  assert.deepEqual(activities, [{ details: 'Persistent' }, { details: 'Persistent' }]);
});


test('Discord decoder rejects oversized and malformed local frames', () => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(1, 0);
  header.writeUInt32LE(65537, 4);
  assert.throws(() => new DiscordFrameDecoder().push(header), /limit/);
  const malformed = Buffer.from('{bad');
  header.writeUInt32LE(malformed.length, 4);
  assert.throws(() => new DiscordFrameDecoder().push(Buffer.concat([header, malformed])), SyntaxError);
  assert.throws(() => encodeDiscordFrame(1, { data: 'x'.repeat(65537) }), /too large/);
});


test('presence defaults unsupported input shapes and bounds timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const raw of [null, [], 'playing', 42, true]) {
    const activity = buildPresenceActivity(raw, null);
    assert.equal(activity.details, 'In the menu');
    assert.equal(activity.state, 'Bunnyhop');
  }
  const array = [];
  array.kind = 'playing'; array.mapName = 'Hidden';
  assert.equal(buildPresenceActivity(array, { discordShowMap: true }).details, 'In the menu');
  for (const startedAt of [Infinity, -Infinity, NaN, 1e20, now + 3600, 1, '1700000000', {}, null]) {
    const timestamp = buildPresenceActivity({ startedAt }).timestamps.start;
    assert.ok(timestamp >= now && timestamp <= now + 1);
  }
  assert.equal(buildPresenceActivity({ startedAt: 1700000000.75 }).timestamps.start, 1700000000);
  assert.equal(buildPresenceActivity({ kind: 'playing', mapName: { roomId: 'secret' }, style: ['secret'] }, { discordShowMap: true }).details, 'Bunnyhopping');
  assert.equal(buildPresenceActivity({ kind: 'playing', style: ['secret'] }).state, 'Solo');
});
