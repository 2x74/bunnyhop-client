// "Classic CS:S sounds": swaps footsteps, landings, water and the knife (carrot) for the original CS:S sounds when the
// hosted CS:S content has them (manifest optional.sounds, extracted by tools/content/extract.ts). Off by default;
// fetched only when switched on; ids without a CS:S file keep our own sound.

import { fetchBytes } from "../content/fetch";
import { contentKey } from "../content/manifest";
import { onSoundContent, soundContent } from "../content/sounds";
import { CLASSIC_SOUNDS } from "./classic-map";
import { decodeAudio, type AudioEngine } from "./engine";

const cache = new Map<string, AudioBuffer | null>();

async function fetchSound(path: string): Promise<AudioBuffer | null> {
  if (cache.has(path)) return cache.get(path)!;
  const c = soundContent();
  const f = c?.group.files[path];
  let buf: AudioBuffer | null = null;
  if (c && f) {
    try {
      const bytes = await fetchBytes(`${c.base}/${contentKey(f.sha256)}`, { cacheSha256: f.sha256, expectedSize: f.size });
      buf = await decodeAudio(bytes.slice().buffer as ArrayBuffer);
    } catch {
      /* missing / undecodable (e.g. an ADPCM wav in a browser without that decoder): keep ours */
    }
  }
  cache.set(path, buf);
  return buf;
}

export class ClassicSounds {
  private wanted = false;
  private applied = false;
  private seq = 0;
  /** True while the CS:S set is active (movement trackers switch to CS:S behaviour). */
  onChange: ((active: boolean) => void) | null = null;

  constructor(private e: AudioEngine) {
    onSoundContent(() => this.wanted && void this.apply());
  }

  get active(): boolean {
    return this.applied;
  }

  get available(): boolean {
    return !!soundContent();
  }

  set(on: boolean): void {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) void this.apply();
    else this.clear();
  }

  private clear(): void {
    this.seq++;
    this.e.clearOverrides();
    if (this.applied) {
      this.applied = false;
      this.onChange?.(false);
    }
  }

  private async apply(): Promise<void> {
    if (!soundContent()) return;
    const my = ++this.seq;
    const got = await Promise.all(Object.entries(CLASSIC_SOUNDS).map(async ([id, paths]) => [id, (await Promise.all(paths.map(fetchSound))).filter((b): b is AudioBuffer => !!b)] as const));
    if (my !== this.seq || !this.wanted) return;
    let any = false;
    for (const [id, bufs] of got) {
      this.e.setOverride(id, bufs.length ? bufs : null);
      any ||= bufs.length > 0;
    }
    if (any !== this.applied) {
      this.applied = any;
      this.onChange?.(any);
    }
  }
}
