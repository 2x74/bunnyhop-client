/** Bounded optional local capture for required-version evidence. No upload/storage/activation behavior. */
import { evidenceSnapshot, type SamplerEvidence } from './input-sampler';
export class LocalInputEvidence {
  private entries: SamplerEvidence[] = [];
  private bytes = 0;
  private truncated = false;
  constructor(readonly maxBytes = 8 * 1024 * 1024, readonly maxEvents = 100000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 || !Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 200000) throw new Error('Invalid local evidence budget');
  }
  /** Assign to Input.onSamplerEvidence BEFORE enabling. Overflow stops capture; the sink never throws. */
  readonly sink = (event: SamplerEvidence): void => {
    if (this.truncated) return;
    try {
      const json = JSON.stringify(event), bytes = new TextEncoder().encode(json).byteLength;
      if (this.bytes + bytes > this.maxBytes || this.entries.length >= this.maxEvents) { this.truncated = true; return; }
      this.entries.push(evidenceSnapshot(JSON.parse(json)));
      this.bytes += bytes;
    } catch { this.truncated = true; }
  };
  get status() { return Object.freeze({ bytes:this.bytes, events:this.entries.length, truncated:this.truncated }); }
  /** A required-version package cannot be made from silently rotated/truncated evidence. */
  snapshot(): readonly SamplerEvidence[] {
    if (this.truncated) throw new Error('Local input evidence truncated; start a new capture');
    return Object.freeze([...this.entries]);
  }
}
