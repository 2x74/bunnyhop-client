/** Identity fence shared by room join and asynchronous account refresh. A rename
 * keeps the connection; a different identity closes it before further room use. */
export class RoomAccountBoundary {
  private id: string | null | undefined;
  private revision = 0;
  constructor(private reset: () => void) {}
  capture(id: string | null): void {
    this.revision++;
    if (this.id !== undefined && this.id !== id) this.reset();
    this.id = id;
  }
  async refresh(read: () => Promise<string | null | undefined>): Promise<void> {
    const revision = ++this.revision;
    try {
      const id = await read();
      if (revision === this.revision && id !== undefined) this.capture(id);
    } catch {
      /* A transient API failure cannot establish a new identity. */
    }
  }
}
