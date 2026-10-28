import { api } from "./api";
import { mouseFromPrefs } from "./mouse-settings";
import { prefs } from "./ui/settings";

/** Publish the active device's actual sensitivity, plus DPI only once explicitly entered. */
export function initMouseProfileSync(): void {
  if (!api.available()) return;
  let timer = 0;
  let busy = false;
  let sent = "";
  let seen = "";
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(() => void sync(), 1000); };
  const sync = async () => {
    if (busy) return schedule();
    busy = true;
    try {
      const user = await api.me();
      if (!user || api.meStale()) return;
      const mouse = mouseFromPrefs(prefs.get());
      const key = `${user.id}:${JSON.stringify(mouse)}`;
      if (key === sent) return;
      await api.setMouseSettings(mouse);
      sent = key;
    } catch { /* Keep playing offline; retry on the next change / connection. */ }
    finally { busy = false; }
  };
  prefs.watch(p => {
    const key = JSON.stringify(mouseFromPrefs(p));
    if (key !== seen) { seen = key; schedule(); }
  });
  window.addEventListener("online", schedule);
  window.addEventListener("bunnyhop:account", () => { sent = ""; schedule(); });
  schedule();
}
