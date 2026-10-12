import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { ContentCache } from '../content-cache.mjs';
const hash = b => createHash('sha256').update(b).digest('hex');

test('cache persists across instances, separates versions, and rejects corrupt files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bunnyhop-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cache = new ContentCache(root);
  const first = Buffer.from('first map'), second = Buffer.from('updated map');
  assert.equal(await cache.get(hash(first)), null);
  assert.equal(await cache.put(hash(first), first), true);
  assert.equal(await cache.put(hash(second), second), true);
  const restarted = new ContentCache(root);
  assert.deepEqual(await restarted.get(hash(first)), first);
  assert.deepEqual(await restarted.get(hash(second)), second);
  await writeFile(cache.file(hash(first)), 'corrupted');
  assert.equal(await restarted.get(hash(first)), null);
  assert.equal(await restarted.put(hash(first), second), false);
  assert.equal(await restarted.get(hash(first)), null);
});

test('invalid keys and unavailable storage are nonfatal misses', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'bunnyhop-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('map');
  const cache = new ContentCache(path.join(root, 'blocked'));
  await writeFile(cache.root, 'not a directory');
  assert.equal(await cache.put(hash(bytes), bytes), false);
  assert.equal(await cache.get(hash(bytes)), null);
  for (const key of ['../escape', null, {}, 'a'.repeat(65)]) {
    assert.equal(await cache.get(key), null);
    assert.equal(await cache.put(key, bytes), false);
  }
  assert.equal(await cache.put(hash(bytes), 'not bytes'), false);
});

test('sandbox bridge forwards cache bytes and Discord artwork through narrow channels', async () => {
  const calls = [];
  let bridge;
  vm.runInNewContext(readFileSync(new URL('../game-preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(null); }, send: (...args) => calls.push(args) } }),
  });
  const bytes = new Uint8Array([1,2,3]);
  await bridge.getCachedContent(hash(bytes));
  await bridge.cacheContent(hash(bytes), bytes);
  bridge.setPresence({ kind: 'playing', mapImage: '/thumbs/map.webp' });
  assert.equal(calls[0][0], 'client:cache-get');
  assert.equal(calls[1][0], 'client:cache-put');
  assert.equal(calls[1][2], bytes);
  assert.equal(calls[2][1].mapImage, '/thumbs/map.webp');
});
