// Three server replay bodies fit within a fixed 24 MiB budget. Rejected fetches
// are never retained, so retrying an expired/temporary API failure works.
export class ReplayCache {
  private cache = new Map<string, Promise<Uint8Array>>();
  constructor(
    private fetch: (id: string) => Promise<Uint8Array>,
    private max = 3,
  ) {}
  get(id: string): Promise<Uint8Array> {
    const prior = this.cache.get(id);
    if (prior) {
      this.cache.delete(id);
      this.cache.set(id, prior);
      return prior;
    }
    const body = this.fetch(id)
      .then((bytes) => {
        if (bytes.byteLength === 0 || bytes.byteLength > 8 << 20)
          throw new Error("Replay must be between 1 byte and 8 MiB.");
        return bytes;
      })
      .catch((error) => {
        if (this.cache.get(id) === body) this.cache.delete(id);
        throw error;
      });
    this.cache.set(id, body);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return body;
  }
  clear(): void {
    this.cache.clear();
  }
}
