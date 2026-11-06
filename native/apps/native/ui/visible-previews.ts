// Tile canvases are inserted by loadout-view before they are observed. IntersectionObserver accounts for the
// scrolling grid's clip as well as the viewport, so hidden tabs and offscreen rows never reach the host.
type Start = (done: () => void) => () => void;
interface Tile {
  element: Element;
  start: Start;
  visible: boolean;
  finished: boolean;
  cancel: (() => void) | null;
}
export class VisiblePreviews {
  private tiles = new Map<string, Tile>();
  private observer: IntersectionObserver;
  constructor() {
    this.observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const tile = [...this.tiles.values()].find((tile) => tile.element === entry.target);
        if (!tile) continue;
        tile.visible = entry.isIntersecting;
        if (!tile.visible && tile.cancel) {
          tile.cancel();
          tile.cancel = null;
        }
      }
      this.pump();
    });
  }
  watch(key: string, element: Element, start: Start): void {
    if (this.tiles.has(key)) return;
    this.tiles.set(key, { element, start, visible: false, finished: false, cancel: null });
    this.observer.observe(element);
  }
  private pump(): void {
    let active = [...this.tiles.values()].filter((tile) => tile.cancel).length;
    for (const tile of this.tiles.values()) {
      if (active >= 2) break;
      if (!tile.visible || tile.finished || tile.cancel) continue;
      // Install the sentinel first: a transport failure may complete synchronously.
      tile.cancel = () => {};
      const cancel = tile.start(() => {
        tile.finished = true;
        tile.cancel = null;
        this.pump();
      });
      if (!tile.finished) {
        tile.cancel = cancel;
        active++;
      }
    }
  }
  keep(keep: (key: string) => boolean): void {
    for (const [key, tile] of this.tiles) {
      if (keep(key)) continue;
      tile.cancel?.();
      this.observer.unobserve(tile.element);
      this.tiles.delete(key);
    }
    this.pump();
  }
  dispose(): void {
    this.keep(() => false);
    this.observer.disconnect();
  }
}
