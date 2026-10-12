import crypto from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { sanitizeRunSummary } from './security.mjs';

export const MAX_RUN_SUMMARIES = 5_000;
export const MAX_SCREENSHOTS = 500;
export const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
export const MAX_SCREENSHOT_TOTAL_BYTES = 1024 * 1024 * 1024;
export const MAX_SUMMARY_BYTES = 64 * 1024;

const RUN_ID = /^[a-z0-9]{8,16}-[a-f0-9]{32}$/;

function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 });
  renameSync(temporary, file);
}

function removeIfPresent(file) {
  try { unlinkSync(file); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function newestByAge(root, files) {
  const ages = new Map(files.map((name) => {
    const id = name.replace(/\.(?:json|png)$/, '');
    if (RUN_ID.test(id)) return [name, Number.parseInt(id.split('-')[0], 36)];
    try { return [name, statSync(path.join(root, name)).mtimeMs]; } catch { return [name, 0]; }
  }));
  return [...files].sort((a, b) => ages.get(b) - ages.get(a) || b.localeCompare(a));
}

function storedSummary(raw, { hasScreenshot = false } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = RUN_ID.test(String(raw.id || '')) ? raw.id : null;
  const summary = sanitizeRunSummary(raw, {
    client: raw.client,
    now: Number.isFinite(Date.parse(raw.savedAt)) ? new Date(raw.savedAt) : new Date(0),
  });
  return {
    ...summary,
    id,
    hasScreenshot: id !== null && hasScreenshot,
  };
}

export class RunVault {
  constructor(root, {
    maxRuns = MAX_RUN_SUMMARIES,
    maxScreenshots = MAX_SCREENSHOTS,
    maxScreenshotBytes = MAX_SCREENSHOT_BYTES,
    maxScreenshotTotalBytes = MAX_SCREENSHOT_TOTAL_BYTES,
    now = () => new Date(),
    randomBytes = crypto.randomBytes,
  } = {}) {
    this.root = root;
    this.runRoot = path.join(root, 'runs');
    this.captureRoot = path.join(root, 'captures', 'results');
    this.maxRuns = maxRuns;
    this.maxScreenshots = maxScreenshots;
    this.maxScreenshotBytes = maxScreenshotBytes;
    this.maxScreenshotTotalBytes = maxScreenshotTotalBytes;
    this.now = now;
    this.randomBytes = randomBytes;
  }

  ensure() {
    mkdirSync(this.runRoot, { recursive: true });
    mkdirSync(this.captureRoot, { recursive: true });
  }

  archive(raw, { client = '' } = {}) {
    this.ensure();
    const now = this.now();
    const id = `${now.getTime().toString(36).padStart(8, '0')}-${this.randomBytes(16).toString('hex')}`;
    const summary = {
      ...sanitizeRunSummary(raw, { client, now }),
      id,
      hasScreenshot: false,
    };
    atomicWrite(this.summaryPath(id), `${JSON.stringify(summary, null, 2)}\n`);
    this.pruneRuns();
    return summary;
  }

  attachScreenshot(id, png) {
    if (!this.validId(id) || !Buffer.isBuffer(png) || png.length === 0
      || png.length > this.maxScreenshotBytes || png.length > this.maxScreenshotTotalBytes) {
      throw new Error('invalid vault screenshot');
    }
    const summaryFile = this.summaryPath(id);
    if (!existsSync(summaryFile)) throw new Error('vault run was not found');
    this.ensure();
    atomicWrite(this.capturePath(id), png);
    const raw = JSON.parse(readFileSync(summaryFile, 'utf8'));
    const summary = storedSummary(raw, { hasScreenshot: true });
    if (!summary) throw new Error('vault run is invalid');
    atomicWrite(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    this.pruneScreenshots();
    return summary;
  }

  list({ limit = 250 } = {}) {
    this.ensure();
    const bounded = Math.min(500, Math.max(1, Math.floor(Number(limit) || 250)));
    const files = readdirSync(this.runRoot).filter((name) => name.endsWith('.json'));
    const result = [];
    for (const file of files) {
      try {
        const id = file.slice(0, -5);
        const summaryFile = path.join(this.runRoot, file);
        if (statSync(summaryFile).size > MAX_SUMMARY_BYTES) continue;
        const summary = storedSummary(JSON.parse(readFileSync(summaryFile, 'utf8')), {
          hasScreenshot: this.validId(id) && existsSync(this.capturePath(id)),
        });
        if (summary) result.push(summary);
      } catch {
        // A hand-edited or interrupted file cannot break the rest of the vault.
      }
    }
    result.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
    return result.slice(0, bounded);
  }

  screenshot(id) {
    if (!this.validId(id)) return null;
    if (!existsSync(this.summaryPath(id))) return null;
    const file = this.capturePath(id);
    if (!existsSync(file)) return null;
    const size = statSync(file).size;
    if (size <= 0 || size > this.maxScreenshotBytes || size > this.maxScreenshotTotalBytes) return null;
    return readFileSync(file);
  }

  pruneRuns() {
    const files = newestByAge(this.runRoot, readdirSync(this.runRoot).filter((name) => name.endsWith('.json')));
    for (const file of files.slice(this.maxRuns)) {
      const id = file.slice(0, -5);
      removeIfPresent(path.join(this.runRoot, file));
      if (this.validId(id)) removeIfPresent(this.capturePath(id));
    }
  }

  pruneScreenshots() {
    const files = newestByAge(this.captureRoot, readdirSync(this.captureRoot).filter((name) => name.endsWith('.png')));
    let kept = 0;
    let keptBytes = 0;
    for (const file of files) {
      const target = path.join(this.captureRoot, file);
      let size = 0;
      try { size = statSync(target).size; } catch {}
      const withinBounds = size > 0
        && size <= this.maxScreenshotBytes
        && kept < this.maxScreenshots
        && keptBytes + size <= this.maxScreenshotTotalBytes;
      if (!withinBounds) {
        removeIfPresent(target);
        continue;
      }
      kept += 1;
      keptBytes += size;
    }
  }

  validId(id) { return RUN_ID.test(String(id || '')); }
  summaryPath(id) { return path.join(this.runRoot, `${id}.json`); }
  capturePath(id) { return path.join(this.captureRoot, `${id}.png`); }
}

export class PersonalBestCapture {
  constructor({
    capture,
    save,
    onSaved = () => {},
    onError = () => {},
    schedule = setTimeout,
    cancel = clearTimeout,
    // The game explicitly settles a result with its returned archive ID.
    delayMs = null,
  }) {
    this.capture = capture;
    this.save = save;
    this.onSaved = onSaved;
    this.onError = onError;
    this.scheduleTimer = schedule;
    this.cancelTimer = cancel;
    this.delayMs = delayMs;
    this.pending = null;
  }

  schedule(summary, { enabled = false } = {}) {
    this.cancel();
    if (!enabled || summary?.personalBest !== true || !RUN_ID.test(String(summary?.id || ''))) return false;
    const pending = { id: summary.id, timer: null, run: null };
    pending.run = async () => {
      try {
        const bytes = await this.capture(pending.id);
        if (this.pending !== pending) return;
        this.pending = null;
        if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
        this.save(pending.id, bytes);
        this.onSaved(pending.id);
      } catch (error) {
        if (this.pending === pending) this.pending = null;
        this.onError(error);
      }
    };
    if (this.delayMs !== null) pending.timer = this.scheduleTimer(() => {
      pending.timer = null;
      return pending.run();
    }, this.delayMs);
    this.pending = pending;
    return true;
  }

  /** The page says the plate is finished: capture now instead of waiting. */
  settle() {
    const pending = this.pending;
    if (!pending) return false;
    if (pending.timer !== null) this.cancelTimer(pending.timer);
    pending.timer = null;
    pending.run();
    return true;
  }

  cancel() {
    if (this.pending && this.pending.timer !== null) this.cancelTimer(this.pending.timer);
    this.pending = null;
  }

  get pendingId() { return this.pending?.id ?? null; }
}
