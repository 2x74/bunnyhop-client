// The loaded map's BSP for the rest of the page's life.
//
// While the map loads, the bytes are in memory for the readers that parse it then (the main core, the world build, the
// water / ladder volumes, the map's sounds, the zones). main.ts then releases them: only a Blob is kept, which the browser
// holds outside the page's JS heap (Chrome keeps large blobs in its browser process and writes them to disk under memory
// pressure). The readers that come later (the map's worker core, the replay viewer, head to head, the tutorial's demos)
// stream it from the Blob straight into their core's memory, so no full copy of the map stays on the JS heap.

export class MapFile {
  private mem: Uint8Array | null;
  private readonly file: Blob;
  readonly size: number;

  constructor(bytes: Uint8Array) {
    this.mem = bytes;
    this.size = bytes.length;
    // Made now, before the core loads: it copies the file once more for a moment, best while memory is low.
    this.file = new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  /** The bytes, until release(). For the readers during the map load. */
  get bytes(): Uint8Array {
    if (!this.mem) throw new Error("the map's bytes were released after its load");
    return this.mem;
  }

  /**
   * Drops the in-memory copy; the Blob stays. The bytes' buffer (when they span all of it) is detached, which frees it
   * at once instead of at the next full GC, seconds later, while the map's worker core loads. Nothing reads the bytes
   * after the map's load.
   */
  release(): void {
    const mem = this.mem;
    if (!mem) return;
    this.mem = null;
    if (mem.byteOffset === 0 && mem.byteLength === mem.buffer.byteLength) detach(mem.buffer as ArrayBuffer);
  }

  /** The file as a Blob (a worker gets it by reference and reads it there). */
  blob(): Blob {
    return this.file;
  }

  /**
   * The file's bytes as a stream for Core.loadMapPhysicsStream, read from the Blob in 4 MB slices. Each slice is freed
   * (detached) when the next is asked for, so it has been copied into the core by then: the read leaves no map-sized
   * garbage behind on the reading thread's heap.
   */
  stream(): ReadableStream<Uint8Array> {
    return blobSlices(this.blob());
  }
}

const SLICE = 4 << 20;

export function blobSlices(blob: Blob, size = SLICE): ReadableStream<Uint8Array> {
  let at = 0;
  let last: ArrayBuffer | null = null;
  return new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        detach(last);
        last = null;
        if (at >= blob.size) return c.close();
        last = await blob.slice(at, (at += size)).arrayBuffer();
        c.enqueue(new Uint8Array(last));
      },
      cancel: () => detach(last),
    },
    // Pulled only when the reader asks: the slice before has been used.
    { highWaterMark: 0 },
  );
}

/** Frees a buffer now, not at the next GC (where the runtime can: ArrayBuffer.prototype.transfer). */
export function detach(buf: ArrayBuffer | null): void {
  (buf as (ArrayBuffer & { transfer?: (n: number) => ArrayBuffer }) | null)?.transfer?.(0);
}
