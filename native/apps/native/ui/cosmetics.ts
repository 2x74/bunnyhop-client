import { installGlowSettings } from "./glow-settings";
import { accountGeneration } from "../../web/src/ui/account-state";
import { navigate } from "../../web/src/ui/nav";
import { api, type CosmeticChoice } from "../../web/src/api";
import { COSMETICS, DEFAULT_COSMETICS, isUnlocked, type CosmeticSlot } from "../../web/src/progression";
import {
  getOutfit,
  getLoadout,
  getGhostCosmetics,
  getPlayerGlow,
  onPlayerGlow,
  setOutfit,
  setLoadout,
  setGhostCosmetics,
  onOutfit,
  onLoadout,
  onGhostCosmetics,
} from "../../web/src/player/cosmetics";
import { loadoutFor, packLoadout } from "../../web/src/loadout";
import { h } from "../../web/src/ui/dom";
import { send } from "./bridge";
export interface CosmeticApi {
  myCosmetics(): Promise<{ choice: CosmeticChoice; unlocked: string[] }>;
  saveCosmetics(patch: Partial<CosmeticChoice>): Promise<CosmeticChoice>;
}
export class NativeCosmetics {
  choice: CosmeticChoice = {
    ...DEFAULT_COSMETICS,
    ...getLoadout(),
    outfit: getOutfit(),
    ghost: getGhostCosmetics().ghostId,
    trail: getGhostCosmetics().trailId,
  };
  unlocked = new Set(COSMETICS.filter((c) => isUnlocked(c, 1, [])).map((c) => c.id));
  online = false;
  status = "";
  private syncing = false;
  private epoch = 0;
  private listeners = new Set<() => void>();
  private saving: Promise<void> = Promise.resolve();
  constructor(private service: CosmeticApi = api) {}
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  private changed(): void {
    for (const fn of this.listeners) fn();
  }
  private sync(): void {
    this.syncing = true;
    try {
      setOutfit(this.choice.outfit);
      setLoadout(loadoutFor(this.choice, getLoadout().crown ?? null));
      setGhostCosmetics(this.choice.ghost, this.choice.trail);
    } finally {
      this.syncing = false;
    }
  }
  observeLocal(): void {
    if (this.syncing) return;
    this.epoch++;
    this.choice = {
      ...this.choice,
      ...getLoadout(),
      outfit: getOutfit(),
      ghost: getGhostCosmetics().ghostId,
      trail: getGhostCosmetics().trailId,
    };
    this.changed();
  }
  async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const result = await this.service.myCosmetics();
      if (epoch !== this.epoch) return;
      this.choice = { ...DEFAULT_COSMETICS, ...result.choice };
      this.unlocked = new Set(result.unlocked);
      this.online = true;
      this.status = "";
      this.sync();
    } catch {
      if (epoch !== this.epoch) return;
      this.online = false;
      this.unlocked = new Set(COSMETICS.filter((c) => isUnlocked(c, 1, [])).map((c) => c.id));
      this.status = "Offline: free cosmetics are saved on this device.";
    }
    this.changed();
  }
  equip(slot: CosmeticSlot, id: string | null): Promise<void> {
    const item = COSMETICS.find((item) => item.id === id);
    if (id && (!item || item.slot !== slot || !this.unlocked.has(id))) return Promise.resolve();
    if (!id && slot !== "hat" && slot !== "title") return Promise.resolve();
    const epoch = this.epoch;
    this.saving = this.saving.then(async () => {
      if (epoch !== this.epoch) return;
      this.status = "Saving…";
      this.changed();
      try {
        if (this.online) {
          const choice = await this.service.saveCosmetics({ [slot]: id });
          if (epoch !== this.epoch) return;
          this.choice = { ...DEFAULT_COSMETICS, ...choice };
          this.status = "Saved to your account.";
        } else {
          this.choice = { ...this.choice, [slot]: id };
          this.status = "Saved on this device.";
        }
        this.sync();
      } catch (error) {
        if (epoch !== this.epoch) return;
        this.status = error instanceof Error ? error.message : "Couldn't save cosmetics.";
      }
      this.changed();
    });
    return this.saving;
  }
}
export const cosmetics = new NativeCosmetics();
export function initCosmetics(): void {
  installGlowSettings();
  const notify = () => {
    cosmetics.observeLocal();
    send({
      type: "cosmetics",
      outfit: getOutfit(),
      packedLoadout: packLoadout(getLoadout()),
      ghostId: getGhostCosmetics().ghostId,
      trailId: getGhostCosmetics().trailId,
      playerGlow: getPlayerGlow(),
    });
  };
  onOutfit(notify);
  onLoadout(notify);
  onGhostCosmetics(notify);
  onPlayerGlow(() =>
    send({
      type: "cosmetics",
      outfit: getOutfit(),
      packedLoadout: packLoadout(getLoadout()),
      ghostId: getGhostCosmetics().ghostId,
      trailId: getGhostCosmetics().trailId,
      playerGlow: getPlayerGlow(),
    }),
  );
  notify();
  addEventListener("bunnyhop:account", () => {
    void cosmetics.refresh();
  });
  void cosmetics.refresh();
}
// The standalone Loadout shortcut uses the same full web screen as the own
// profile tab; inventory/save guards above remain available to existing callers.
export function cosmeticsPanel(
  play: (map: string, style?: string) => void = (map) => navigate({ screen: "maps", focus: map }),
  slot: string | null = null,
  tabsHost: HTMLElement | null = null,
): HTMLElement {
  const root = h("div.native-cosmetics", null, h("p.dim", null, "Loading loadout…"));
  let request = 0;
  let attached = false;
  queueMicrotask(() => {
    attached = root.isConnected;
  });
  const load = (): void => {
    const current = ++request;
    const epoch = accountGeneration();
    void Promise.all([import("./profile-panel"), api.me().catch(() => null)]).then(([module, user]) => {
      if (current !== request || epoch !== accountGeneration() || (attached && !root.isConnected)) return;
      tabsHost?.replaceChildren();
      root.replaceChildren(module.profilePanel(user?.id ?? "", play, undefined, { tab: "loadout", slot, tabsHost }));
    });
  };
  const account = (): void => {
    if (root.isConnected) attached = true;
    else if (attached) {
      window.removeEventListener("bunnyhop:account", account);
      return;
    }
    load();
  };
  window.addEventListener("bunnyhop:account", account);
  load();
  return root;
}
