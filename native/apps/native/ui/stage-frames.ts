// The host's Loadout stage pictures, by request, as PNG data URLs (about 100 KB each): hovering back over an item
// shows its picture at once instead of rendering, reading back and encoding it again.
export class StageFrames {
  private frames = new Map<string, string>();
  constructor(private readonly kept = 32) {}
  keep(key: string, png: string): void {
    this.frames.delete(key);
    this.frames.set(key, png);
    if (this.frames.size > this.kept) this.frames.delete(this.frames.keys().next().value!);
  }
  /** The picture for `key`, which then counts as the most recently used. */
  get(key: string): string | undefined {
    const png = this.frames.get(key);
    if (png) this.keep(key, png);
    return png;
  }
}
