import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PersonalBestCapture, RunVault } from '../run-vault.mjs';

test('run vault keeps bounded summaries and PB screenshots without preserving unknown data', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-vault-'));
  let tick = 0;
  let random = 0;
  const vault = new RunVault(root, {
    maxRuns: 2,
    maxScreenshots: 1,
    now: () => new Date(Date.UTC(2026, 7, 27, 12, 0, tick++)),
    randomBytes: () => Buffer.alloc(16, ++random),
  });
  const first = vault.archive({
    mapId: 'gridshot', mapName: 'Gridshot', timeMs: 100, personalBest: true,
    accuracy: 0.8, hits: 8, shots: 10, token: 'do-not-store',
  }, { client: 'bunnyhop-client/0.2.0' });
  const second = vault.archive({ mapId: '1w6ts', timeMs: 200, personalBest: true });
  vault.attachScreenshot(first.id, Buffer.from('first-png'));
  vault.attachScreenshot(second.id, Buffer.from('second-png'));
  assert.equal(vault.screenshot(first.id), null, 'old screenshots are evicted independently');
  assert.equal(vault.screenshot(second.id).toString(), 'second-png');

  const third = vault.archive({ mapId: 'smoothbot', timeMs: 300 });
  const runs = vault.list();
  assert.deepEqual(runs.map((run) => run.timeMs), [300, 200]);
  assert.equal(runs[1].hasScreenshot, true);
  assert.equal('token' in runs[1], false);
  assert.equal(existsSync(vault.summaryPath(first.id)), false, 'old run summaries are evicted');
  assert.equal(readdirSync(path.join(root, 'runs')).length, 2);
  assert.equal(vault.screenshot('../client-settings'), null);
  assert.ok(third.id);
});

test('run vault rejects oversize captures and evicts old images at the total byte cap', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-vault-bytes-'));
  let random = 10;
  const vault = new RunVault(root, {
    maxScreenshots: 10,
    maxScreenshotBytes: 6,
    maxScreenshotTotalBytes: 9,
    randomBytes: () => Buffer.alloc(16, ++random),
  });
  const first = vault.archive({ mapId: 'gridshot', personalBest: true });
  const second = vault.archive({ mapId: '1w6ts', personalBest: true });
  const third = vault.archive({ mapId: 'smoothbot', personalBest: true });
  assert.throws(() => vault.attachScreenshot(first.id, Buffer.alloc(7)), /invalid vault screenshot/);
  vault.attachScreenshot(first.id, Buffer.alloc(5, 1));
  vault.attachScreenshot(second.id, Buffer.alloc(4, 2));
  assert.ok(vault.screenshot(first.id));
  vault.attachScreenshot(third.id, Buffer.alloc(5, 3));
  assert.equal(vault.screenshot(first.id), null, 'the oldest image is removed before the total cap is exceeded');
  assert.ok(vault.screenshot(second.id));
  assert.ok(vault.screenshot(third.id));
});

test('PB capture waits for the result, cancels on state change, and saves only PBs', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-capture-'));
  const vault = new RunVault(root);
  const normal = vault.archive({ mapId: 'gridshot', timeMs: 90 });
  const pb = vault.archive({ mapId: 'gridshot', timeMs: 100, personalBest: true });
  const timers = [];
  const saved = [];
  const capture = new PersonalBestCapture({
    delayMs: 2500,
    capture: async () => Buffer.from('result-screen'),
    save: (id, bytes) => saved.push({ id, bytes: bytes.toString() }),
    schedule: (callback, delay) => {
      timers.push({ callback, delay, canceled: false });
      return timers.length - 1;
    },
    cancel: (id) => { timers[id].canceled = true; },
  });
  assert.equal(capture.schedule(normal, { enabled: true }), false);
  assert.equal(capture.schedule(pb, { enabled: false }), false);
  assert.equal(capture.schedule(pb, { enabled: true }), true);
  assert.equal(capture.pendingId, pb.id);
  capture.cancel();
  assert.equal(timers[0].canceled, true);
  assert.deepEqual(saved, []);

  capture.schedule(pb, { enabled: true });
  assert.equal(timers[1].delay, 2_500);
  await timers[1].callback();
  assert.deepEqual(saved, [{ id: pb.id, bytes: 'result-screen' }]);
  assert.equal(capture.pendingId, null);
});

test('a settled plate is captured at once, and an optional legacy timer is dropped', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-settle-'));
  const vault = new RunVault(root);
  const pb = vault.archive({ mapId: 'gridshot', timeMs: 100, personalBest: true });
  const timers = [];
  const saved = [];
  const capture = new PersonalBestCapture({
    delayMs: 2500,
    capture: async () => Buffer.from('settled-plate'),
    save: (id, bytes) => saved.push({ id, bytes: bytes.toString() }),
    schedule: (callback, delay) => { timers.push({ callback, delay, canceled: false }); return timers.length - 1; },
    cancel: (id) => { timers[id].canceled = true; },
  });
  assert.equal(capture.settle(), false, 'nothing pending, nothing to settle');
  capture.schedule(pb, { enabled: true });
  assert.equal(capture.settle(), true);
  assert.equal(timers[0].canceled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(saved, [{ id: pb.id, bytes: 'settled-plate' }]);
  assert.equal(capture.settle(), false, 'a second signal does not capture twice');
});

test('stored runs keep mode and verification, and unknown modes fall back to solo', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bunnyhop-mode-'));
  const vault = new RunVault(root);
  vault.archive({ mapId: 'c:abcdefghij', timeMs: 1, mode: 'multiplayer', verified: true });
  vault.archive({ mapId: 'gridshot', timeMs: 2, mode: 'forged' });
  const runs = vault.list();
  const duel = runs.find((run) => run.mapId === 'c:abcdefghij');
  const forged = runs.find((run) => run.mapId === 'gridshot');
  assert.deepEqual([duel.mode, duel.verified], ['multiplayer', true]);
  assert.deepEqual([forged.mode, forged.verified], ['solo', false]);
});

test('default PB capture has no fallback that can photograph a later run', async () => {
 let calls=0;
 const capture=new PersonalBestCapture({capture:async()=>Buffer.from('png'),save:()=>{calls++;},schedule:()=>{throw new Error('unexpected fallback timer');}});
 const id='00000001-11111111111111111111111111111111';
 assert.equal(capture.schedule({id,personalBest:true},{enabled:true}),true);
 assert.equal(calls,0);
 assert.equal(capture.settle(),true);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls,1);
});
