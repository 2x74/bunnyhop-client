// What the game does with its platform once the menu is up (main.ts initPlatform): settings kept with the account
// (both builds, opt-in on the site), and in the Wavedash build: telling Wavedash the game is ready, copying verified
// totals to Wavedash's stats / boards, and handling links that would take the frame to another site.

import { me, onMyProfile, openAccount } from "../ui/account-state";
import { toast } from "../notify";
import { WAVEDASH } from "./env";
import { LEAVE_EVENT } from "./navigation";
import { syncSettings } from "./settings-sync";
import { showDesktopNotice } from "./touch";
import { syncWavedashCareer, wavedashCopy, wavedashReady } from "./wavedash";

const ACCOUNT_EVENT = "bunnyhop:account";

export function initPlatform(): void {
  const resync = () => void me().then((u) => syncSettings(u));
  resync();
  window.addEventListener(ACCOUNT_EVENT, resync);
  if (!WAVEDASH) return;

  wavedashReady();
  showDesktopNotice();
  onMyProfile((p) => {
    if (!p.mine) return;
    void syncWavedashCareer({
      maps: p.stats.maps,
      wrs: p.stats.wrs,
      top10s: p.stats.top10s,
      pbs: p.stats.pbs,
      bonuses: p.stats.bonuses,
      jumps: p.stats.jumps,
      level: p.level.level,
      points: p.rank.points,
      runs: p.stats.runs,
      clearsByTier: p.stats.clearsByTier,
    });
  });

  // Wavedash's frame may not open tabs: links to other sites (Discord invite, GitHub...) are copied for the player.
  document.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a || e.defaultPrevented || a.origin === location.origin || !/^https?:$/.test(a.protocol)) return;
    e.preventDefault();
    leave(a.href);
  });
  window.addEventListener(LEAVE_EVENT, (e) => leave((e as CustomEvent<string>).detail));
}

function leave(url: string): void {
  // Discord's sign-in can't run in Wavedash's frame: the account panel has the way that does (email).
  if (/\/auth\/discord\/login\b/.test(url)) return openAccount("save");
  const w = window.open(url, "_blank", "noopener");
  if (!w) void wavedashCopy(url).then((ok) => toast(ok ? "Link copied: open it in your browser." : `Open ${new URL(url).host} in your browser.`));
}
