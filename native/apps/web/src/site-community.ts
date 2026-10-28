// The static /about and /changelog pages (no game code): reveal their "Join the Discord" links ([data-discord]) when
// the API has a community invite (GET /config, the DISCORD_INVITE var). No invite, no API, no JS: they stay hidden.
// /about's "Support bunnyhop.lol" link ([data-support]) opens the game's Support page (/?support). This fills the
// thank-you list ([data-supporters]) with the supporters who asked to be on it (GET /supporters); with nobody on it, it
// stays hidden.

import { cleanInvite } from "./creators";

const api = ((import.meta.env.VITE_API_URL as string | undefined) || "").replace(/\/+$/, "");
if (api) {
  fetch(`${api}/config`, { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : null))
    .then((c: { discordInvite?: unknown } | null) => {
      const url = cleanInvite(c?.discordInvite);
      if (!url) return;
      for (const el of document.querySelectorAll<HTMLElement>("[data-discord]")) {
        const a = el instanceof HTMLAnchorElement ? el : el.querySelector("a");
        if (a) a.href = url;
        el.hidden = false;
      }
    })
    .catch(() => undefined);
  const thanks = document.querySelector<HTMLElement>("[data-supporters]");
  if (thanks)
    fetch(`${api}/supporters`, { credentials: "omit" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { names?: unknown } | null) => {
        const names = Array.isArray(s?.names) ? s.names.filter((n): n is string => typeof n === "string" && !!n.trim()) : [];
        if (!names.length) return;
        const p = thanks.querySelector(".thanks-names");
        if (p) p.textContent = names.join(", ");
        thanks.hidden = false;
      })
      .catch(() => undefined);
}
