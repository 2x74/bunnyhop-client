import { zoneWarningToast } from "../../web/src/zone-warning";

const TOAST_MS = 8000;

// Says a map's "zones unconfirmed" label (maps/index.json `zoneWarning`) once when it loads, as the website does. The
// map panel shows the same label through the website's map browser.
export class MapZoneWarning {
  private map: string | null = null;

  constructor(
    private readonly labelOf: (map: string) => Promise<string | undefined>,
    private readonly toast: (text: string, ms: number) => void,
  ) {}

  mapChanged(map: string | null): void {
    if (map === this.map) return;
    this.map = map;
    if (map) void this.say(map);
  }

  private async say(map: string): Promise<void> {
    const label = await this.labelOf(map).catch(() => undefined);
    if (label && this.map === map) this.toast(zoneWarningToast(label), TOAST_MS);
  }
}
