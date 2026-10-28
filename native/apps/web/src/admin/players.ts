// Players: search, the player page, names (flagged names, blocked terms, reserved names) and network bans. The player
// page has everything about one player on one page: their flags and how each ended, their feedback, account and
// marks (each change saves at once with a 10 s Undo), bans, other accounts, devices and networks ("Ban all linked
// accounts"), chat, runs, names and moderation history.

import { act, ago, api, ask, badge, dollarsToCents, specialIcon, emptyLine, glyph, h, help, idCell, leaveRow, may, mayShadow, me, money, n, playerLink, reroute, rowOf, setKeys, stepRows, table, timeCell, toast, undoCall, when, type View, fill } from "./core";
import { SPECIAL_BADGES, CREATOR_KINDS, CREATOR_SVG, VERIFIED_SVG } from "../creators";
import { outranks } from "../moderation/staff";
import { activeBan, altRows, flagRows, roleOf, stateWords, nameWithShield, type PlayerDetail, type PlayerNetwork } from "./context";
import { banDialog, KIND_LABEL, kickDialog, messageDialog, muteDialog, networkBanDialog, shadowDialog, warnDialog, type NetworkBan } from "./dialogs";
import { notesBlock } from "./notes";
import { figEl } from "./pulse";
import { modTable, staffButtons } from "./staff";
import { chatRow } from "./live";
import { mapLine } from "./art";
import { clientTag, fmtTime } from "./core";

interface PlayerRow {
  id: string;
  name: string;
  provider: string;
  created_at: number;
  merged_into: string | null;
  last_seen: number | null;
  banned: number;
  admin: number;
  moderator?: number;
  verified?: number;
  creator?: string | null;
  shadowed?: number;
}

export const playersView: View = async (root, params) => {
  const q = h("input", { type: "search", placeholder: "name or player id", value: params.get("q") ?? "", style: "min-width:20rem" });
  const out = h("div");
  const load = async () => {
    const r = await api<{ players: PlayerRow[] }>(`/admin/players?q=${encodeURIComponent(q.value.trim())}`);
    fill(out, 
      table(
        ["Name", "Account", "Joined", "Last seen", ""],
        r.players.map((p) =>
          h(
            "tr",
            { class: "go", "data-href": `#/player/${encodeURIComponent(p.id)}` },
            h("td", null, playerLink(p.id, p.name), " ", idCell(p.id)),
            h("td", null, p.provider === "guest" ? "guest" : "signed in", p.merged_into ? badge("merged", "warn") : null),
            timeCell(p.created_at),
            timeCell(p.last_seen),
            h("td", null, p.banned ? badge("banned", "bad") : null, p.shadowed ? badge("shadowed", "warn") : null, p.admin ? badge("admin", "acc") : p.moderator ? badge("moderator", "acc") : null, p.verified ? badge("verified", "info") : null, p.creator ? badge(`${p.creator} creator`, "acc") : null),
          ),
        ),
        "No players match.",
      ),
    );
  };
  fill(root, 
    h(
      "form",
      {
        class: "filters",
        onsubmit: (e: Event) => {
          e.preventDefault();
          history.replaceState(null, "", `#/players?q=${encodeURIComponent(q.value.trim())}`);
          void load();
        },
      },
      h("label", null, "Find", q),
      h("button", { type: "submit", class: "primary" }, "Search"),
      h("span", { class: "faint" }, "An exact id, or part of a name. Newest first."),
    ),
    out,
  );
  await load();
  q.focus();
  const rows = () => [...out.querySelectorAll<HTMLElement>("tr.go")];
  setKeys({ j: () => void stepRows(rows(), 1), k: () => void stepRows(rows(), -1), Enter: () => (location.hash = out.querySelector<HTMLElement>("tr.cur")?.dataset.href ?? location.hash) });
};

/** Player page card: devices, fingerprints, networks, accounts linked through them, bans on them. */
function networkCard(userId: string, net: PlayerNetwork): HTMLElement {
  const canBan = may("players.network");
  const banBtn = (kind: NetworkBan["kind"], value: string) => (canBan ? h("button", { class: "small ghost danger-text", onclick: async () => (await networkBanDialog(kind, value, userId)) && reroute() }, `Ban ${KIND_LABEL[kind]}…`) : null);
  const banned = (kind: NetworkBan["kind"], value: string) => net.bans.filter((b) => b.kind === kind && b.value === value).map((b) => badge(b.action === "block" ? "blocked" : "shadow ban", b.action === "block" ? "bad" : "warn"));
  const hash = (s: string) => h("span", { class: "mono", title: s }, s.length > 14 ? `${s.slice(0, 12)}…` : s);
  const bannable = net.linked.filter((a) => !a.banned);
  const banAll = async () => {
    const v = await ask({
      title: `Ban all ${bannable.length} linked accounts?`,
      lead: h("ul", { class: "plain-list" }, bannable.map((a) => h("li", null, a.name, h("span", { class: "faint" }, ` same ${KIND_LABEL[a.via]}`)))),
      text: "Each gets the same server-wide ban, one at a time. Staff of your rank or higher are skipped.",
      fields: [
        { name: "duration", label: "How long", kind: "seg", options: may("player.ban.perm") ? [["1440", "1d"], ["10080", "7d"], ["43200", "30d"], ["perm", "Permanent"]] : [["1440", "1d"], ["10080", "7d"]], value: "10080" },
        { name: "reason", label: "Reason (they see it)", kind: "text", required: true, value: "Ban evasion" },
      ],
      confirm: "Ban all",
      danger: true,
    });
    if (!v) return;
    let done = 0;
    const failed: string[] = [];
    for (const a of bannable) {
      try {
        await api(`/admin/players/${encodeURIComponent(a.id)}`, { action: "ban", minutes: v.duration === "perm" ? null : Number(v.duration), reason: v.reason });
        done++;
      } catch (e) {
        failed.push(`${a.name}: ${(e as Error).message}`);
      }
    }
    toast(`Banned ${done} of ${bannable.length}${failed.length ? `. ${failed[0]}` : ""}`, !!failed.length);
    reroute();
  };
  return h(
    "section",
    { class: "card" },
    h("h2", null, "Devices and networks", bannable.length && may("player.ban.temp") ? h("button", { class: "small danger", onclick: () => void banAll() }, `Ban all ${bannable.length} linked accounts…`) : null),
    h("h3", null, "Other accounts on the same device, fingerprint or network (30 days)"),
    table(["Name", "Linked by", ""], net.linked.map((a) => h("tr", null, h("td", null, playerLink(a.id, a.name)), h("td", null, KIND_LABEL[a.via]), h("td", null, a.banned ? badge("banned", "bad") : null, a.shadowed ? badge("shadowed", "warn") : null))), "None."),
    h(
      "div",
      { class: "cols" },
      h("div", null, h("h3", null, "Devices"), table(["Device", "Fingerprint", "Last seen", ""], net.devices.map((d) => h("tr", null, h("td", null, hash(d.device_id), banned("device", d.device_id)), h("td", null, d.fp_hash ? [hash(d.fp_hash), banned("fp", d.fp_hash)] : "—"), timeCell(d.last_seen), h("td", { class: "acts" }, banBtn("device", d.device_id), d.fp_hash ? banBtn("fp", d.fp_hash) : null))), "No device id seen (an older client).")),
      h("div", null, h("h3", null, "Networks"), table(["Network", "First seen", "Last seen", ""], net.nets.map((x) => h("tr", null, h("td", null, hash(x.net_hash), banned("net", x.net_hash)), timeCell(x.first_seen), timeCell(x.last_seen), h("td", { class: "acts" }, banBtn("net", x.net_hash)))), "None recorded.")),
    ),
  );
}

export const playerView: View = async (root, _params, [id]) => {
  const d = await api<PlayerDetail>(`/admin/players/${encodeURIComponent(id)}`);
  const u = d.user;
  const path = `/admin/players/${encodeURIComponent(u.id)}`;
  const ban = activeBan(d);
  const role = roleOf(d);
  const canAct = outranks(me?.role, role);
  const online = d.rooms.filter((r) => r.online);
  const target = { id: u.id, name: u.name };
  const post = async (body: Record<string, unknown>, done?: string, undo?: Record<string, unknown>) => {
    if (await act(path, body, done, undo ? { run: async () => (await undoCall(path, undo)) && reroute() } : undefined)) reroute();
  };
  const after = (p: Promise<boolean>) => void p.then((ok) => ok && reroute());
  // The toolbar in three groups: talk, name, moderate; then the role buttons. Only on players the viewer outranks.
  const actions = h(
    "div",
    { class: "toolbar" },
    h(
      "div",
      { class: "group" },
      may("player.message") ? h("button", { onclick: () => void messageDialog(u.id, u.name) }, glyph("message"), "Message…") : null,
      canAct && may("player.warn") && !u.merged_into ? h("button", { onclick: () => after(warnDialog(target, { canRename: may("names.rename"), actions: d.actions })) }, glyph("warn"), "Warn…") : null,
      h("a", { class: "btn ghost", href: `/u/${encodeURIComponent(u.id)}`, target: "_blank", rel: "noopener" }, "Public profile", glyph("ext")),
    ),
    canAct &&
      h(
        "div",
        { class: "group" },
        h("button", {
          onclick: async () => {
            const v = await ask({ title: `Rename ${u.name}`, fields: [{ name: "name", label: "New name", kind: "text", value: u.name, required: true }, { name: "reason", label: "Reason", kind: "text" }], confirm: "Rename" });
            if (v) await post({ action: "rename", name: v.name, reason: v.reason || null }, "Renamed");
          },
        }, glyph("rename"), "Rename…"),
        h("button", {
          onclick: async () => {
            const v = await ask({ title: `Give ${u.name} a default name?`, text: "They get a fresh guest name, which they can change for free.", fields: [{ name: "reason", label: "Reason", kind: "text" }, { name: "reserve", label: "Also ban the old name", kind: "check" }], confirm: "Rename", danger: true });
            if (v) await post({ action: "rename", reason: v.reason || null, reserve: !!v.reserve }, "Renamed");
          },
        }, "Default name"),
        h("button", {
          onclick: async () => {
            const v = await ask({ title: `Ban the name "${u.name}"?`, text: "The name and its lookalikes are out of circulation, and this player gets a default name.", fields: [{ name: "reason", label: "Reason", kind: "text" }], confirm: "Ban name", danger: true });
            if (v) await post({ action: "ban-name", reason: v.reason || null }, "Name banned");
          },
        }, "Ban name"),
      ),
    canAct &&
      h(
        "div",
        { class: "group" },
        h("button", { onclick: () => after(muteDialog(target, { actions: d.actions })) }, glyph("mute"), "Mute…"),
        d.rooms.some((r) => r.muted !== null) ? h("button", { onclick: async () => (await ask({ title: `Unmute ${u.name} everywhere?`, confirm: "Unmute" })) && (await post({ action: "unmute" }, "Unmuted")) }, "Unmute") : null,
        online.length ? h("button", { class: "danger", onclick: () => after(kickDialog(target)) }, glyph("kick"), `Kick from ${online.map((r) => r.id).join(", ")}`) : null,
        ban ? h("button", { class: "danger", onclick: async () => (await ask({ title: `Unban ${u.name}?`, confirm: "Unban" })) && (await post({ action: "unban" }, "Unbanned")) }, "Unban") : h("button", { class: "danger", onclick: () => after(banDialog(target, { actions: d.actions })) }, glyph("ban"), "Ban…"),
        mayShadow(!!u.shadow_at, u.shadow_source) ? h("button", { class: u.shadow_at ? "" : "danger", onclick: () => after(shadowDialog({ ...target, shadow_at: u.shadow_at })) }, u.shadow_at ? "Lift shadowban" : "Shadowban…") : null,
      ),
    h("div", { class: "group" }, ...staffButtons(u.id, u.name, role, d.configAdmin, (b, done) => post(b, done))),
  );

  // Badges: a shelf of the real marks, lit when they have it. A press gives or takes it at once, with Undo for 10 s.
  let special: string[] = (() => {
    try {
      const a = JSON.parse(u.special_badges ?? "[]");
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  })();
  const locked = !!u.merged_into;
  const art = (svg: string) => {
    const el = h("span", { class: "bt-art", "aria-hidden": "true" });
    el.innerHTML = `<svg viewBox="0 0 24 24">${svg}</svg>`;
    return el;
  };
  const tile = (o: { id: string; name: string; svg: string; on: boolean; gold?: boolean; toggle: () => void }) =>
    h(
      "button",
      { type: "button", class: `badge-tile${o.on ? " on" : ""}${o.gold ? " gold" : ""}`, "aria-pressed": String(o.on), disabled: locked, title: o.on ? `Take ${o.name} away` : `Give ${o.name}`, onclick: o.toggle },
      art(o.svg),
      h("span", { class: "bt-name" }, o.name.replace(/^Top (.+) creator$/, "Top $1")),
      h("span", { class: "bt-state" }, o.on ? "Has it" : "Give"),
    );
  const shelf = h(
    "div",
    { class: "badge-shelf" },
    tile({ id: "verified", name: "Verified", svg: VERIFIED_SVG, on: !!u.verified, toggle: () => void post({ verified: !u.verified }, u.verified ? "Verified removed" : "Verified given", { verified: !!u.verified }) }),
    // (Earned marks, the gauntlet ones, aren't staff's to give or take. Mapper is given by hand here too, as well as by
    // linking an author name in Boards → Mappers; unlinking takes it back.)
    ...Object.entries(SPECIAL_BADGES).filter(([, def]) => !def.earned).map(([sid, def]) =>
      tile({
        id: sid,
        name: def.name,
        svg: def.svg,
        gold: def.gold,
        on: special.includes(sid),
        toggle: () => {
          const before = special;
          const on = !special.includes(sid);
          special = on ? [...special, sid] : special.filter((x) => x !== sid);
          void post({ special }, on ? `${def.name} given` : `${def.name} taken away`, { special: before });
        },
      }),
    ),
  );
  const creatorSeg = h(
    "div",
    { class: "seg creator-seg", role: "radiogroup", "aria-label": "Creator tag" },
    [["", "None", null] as const, ...CREATOR_KINDS.map((k) => [k, ({ youtube: "YouTube", twitch: "Twitch", tiktok: "TikTok", x: "X" } as const)[k], CREATOR_SVG[k]] as const)].map(([v, label, svg]) =>
      h(
        "button",
        { type: "button", role: "radio", "aria-checked": String((u.creator ?? "") === v), disabled: locked, onclick: () => (u.creator ?? "") !== v && void post({ creator: v || null }, v ? `${label} creator tag set` : "Creator tag removed", { creator: u.creator ?? null }) },
        svg ? art(svg) : null,
        label,
      ),
    ),
  );
  const links = Object.entries(d.links?.links ?? {});
  const linkHost: Record<string, (x: string) => string> = {
    youtube: (x) => (/^UC[\w-]{22}$/.test(x) ? `https://www.youtube.com/channel/${x}` : `https://www.youtube.com/@${x}`),
    twitch: (x) => `https://www.twitch.tv/${x}`,
    x: (x) => `https://x.com/${x}`,
    tiktok: (x) => `https://www.tiktok.com/@${x}`,
  };
  const avatarSection = () => {
    const blocked = u.discord_avatar_blocked === 1;
    const pic = u.discord_avatar_url ?? null;
    if (!pic && !blocked && !d.identities.some((i) => i.provider === "discord")) return [];
    const can = canAct && may("player.avatar");
    return [
      h("h3", null, "Discord avatar ", blocked ? badge("blocked", "bad") : u.use_discord_avatar === 1 && pic ? badge("shown", "ok") : pic ? badge("not shown") : null),
      h(
        "div",
        { class: "actions" },
        pic ? h("img", { src: pic, alt: `${u.name}'s Discord avatar`, width: 40, height: 40, loading: "lazy", referrerpolicy: "no-referrer", style: "border-radius:50%;object-fit:cover" }) : h("span", { class: "faint" }, "No picture: their bunny shows."),
        can && blocked ? h("button", { onclick: async () => (await ask({ title: `Allow ${u.name}'s Discord avatar again?`, text: "It stays off until they turn it back on.", confirm: "Allow again" })) && (await post({ action: "avatar-unblock" }, "Allowed again", { action: "avatar-block" })) }, "Allow again") : null,
        can && !blocked && pic
          ? h("button", {
              class: "danger",
              onclick: async () => {
                const v = await ask({ title: `Remove ${u.name}'s Discord avatar?`, text: "Their bunny avatar shows instead, and they can't turn it back on until staff allow it.", fields: [{ name: "reason", label: "Reason", kind: "text" }], confirm: "Remove and block", danger: true });
                if (v) await post({ action: "avatar-block", reason: v.reason || null }, "Avatar removed", { action: "avatar-unblock" });
              },
            }, "Remove and block…")
          : null,
      ),
    ];
  };
  // Their bunny avatar (src/bunny-avatar.ts): a saved one is the client's render, so staff can put it back to the default.
  const bunnySection = () => {
    const pic = u.bunny_avatar_url ?? null;
    if (!pic) return [];
    const can = canAct && may("player.avatar") && u.bunny_custom === 1;
    return [
      h("h3", null, "Bunny avatar ", u.bunny_custom === 1 ? badge("saved") : badge("default")),
      h(
        "div",
        { class: "actions" },
        h("img", { src: pic, alt: `${u.name}'s bunny avatar`, width: 40, height: 40, loading: "lazy", style: "border-radius:50%;object-fit:cover" }),
        can
          ? h("button", {
              class: "danger",
              onclick: async () => {
                const v = await ask({ title: `Reset ${u.name}'s bunny avatar?`, text: "They get the default for their colourway back, and can save a new one.", fields: [{ name: "reason", label: "Reason", kind: "text" }], confirm: "Reset", danger: true });
                if (v) await post({ action: "bunny-reset", reason: v.reason || null }, "Avatar reset");
              },
            }, "Reset to default…")
          : null,
      ),
    ];
  };
  const boosterSection = () => {
    const b = d.booster;
    if (!b) return [];
    return [h("h3", null, "Server Booster ", b.shown ? badge("shown", "ok") : b.boosting && b.hidden ? badge("hidden by them") : null), h("p", { class: "faint" }, `${b.boosting ? `Boosting since ${when(b.since!)}` : b.member ? "In the server, not boosting" : "Not in the server"}. Checked ${ago(b.checkedAt)}.`)];
  };
  const wingsSection = () => {
    const w = d.wings;
    if (!w) return [];
    return [
      h("h3", null, "Wings ", w.earned ? badge("earned", "ok") : badge("not earned")),
      h(
        "div",
        { class: "actions" },
        h("span", { class: "faint" }, w.earned ? `Since ${when(w.at!)}${w.runId ? `, run ${w.runId}` : ", granted"}.` : "The secret achievement."),
        h("button", { class: w.earned ? "danger" : "", onclick: async () => (await ask({ title: w.earned ? `Take ${u.name}'s wings away?` : `Give ${u.name} the wings?`, confirm: w.earned ? "Take away" : "Give", danger: w.earned })) && (await post({ action: w.earned ? "revoke-wings" : "grant-wings" }, w.earned ? "Wings taken away" : "Wings given", { action: w.earned ? "grant-wings" : "revoke-wings" })) }, w.earned ? "Take away" : "Give"),
      ),
    ];
  };
  const supporterSection = () => {
    const s = d.supporter;
    if (s === undefined) return [];
    const can = may("player.supporter") && !u.merged_into;
    return [
      h("h3", null, "Supporter ", s ? badge("supporter", "ok") : null),
      s ? h("p", { class: "faint" }, `Since ${when(s.since)}, ${s.source === "admin" ? "given by staff" : s.source === "stripe" ? "paid" : (s.source ?? "unknown")}. Total ${money(s.cents ?? 0)}.${s.badgeShown ? "" : " Badge hidden by them."}${s.shown === false ? " Hidden from Top supporters." : ""}`) : null,
      h(
        "div",
        { class: "actions" },
        can && !s
          ? h("button", {
              onclick: async () => {
                const v = await ask({ title: `Make ${u.name} a supporter?`, text: "They get the supporter sets, the badge, a name colour and the reserved slot until it's revoked.", fields: [{ name: "amount", label: "Amount in dollars (0 for a gift)", kind: "number", value: "0" }, { name: "reason", label: "Reason", kind: "text" }], confirm: "Make supporter" });
                const cents = v ? dollarsToCents(v.amount) : null;
                if (v && cents === null) return toast("Amount: dollars, like 5 or 12.50", true);
                if (v) await post({ action: "supporter-grant", reason: v.reason || null, amountCents: cents }, "Supporter given", { action: "supporter-revoke", reason: "undo" });
              },
            }, "Make supporter…")
          : null,
        can && s
          ? h("button", {
              onclick: async () => {
                const v = await ask({ title: `${u.name}'s total`, text: `Now ${money(s.cents ?? 0)}.`, fields: [{ name: "mode", label: "Change", kind: "seg", options: [["add", "Add to it"], ["set", "Set it"]], value: "add" }, { name: "amount", label: "Dollars", kind: "number", required: true }, { name: "reason", label: "Reason", kind: "text" }], confirm: "Save" });
                const cents = v ? dollarsToCents(v.amount) : null;
                if (v && cents === null) return toast("Amount: dollars, like 5 or 12.50", true);
                if (v) await post({ action: "supporter-amount", amountCents: cents, mode: v.mode, reason: v.reason || null }, "Total saved", { action: "supporter-amount", amountCents: s.cents ?? 0, mode: "set", reason: "undo" });
              },
            }, "Change total…")
          : null,
        can && s
          ? h("button", {
              class: "danger",
              onclick: async () => {
                const v = await ask({ title: `Revoke ${u.name}'s supporter?`, text: "For refunds and chargebacks. The sets, badge, name colour and slot go.", fields: [{ name: "reason", label: "Reason", kind: "text" }], confirm: "Revoke", danger: true });
                if (v) await post({ action: "supporter-revoke", reason: v.reason || null }, "Supporter revoked", { action: "supporter-grant", reason: "undo", amountCents: 0 });
              },
            }, "Revoke…")
          : null,
      ),
    ];
  };
  const marks = h(
    "section",
    { class: "card marks" },
    h("h2", null, "Badges and links"),
    may("player.marks") ? [shelf, h("h3", null, "Creator tag"), creatorSeg] : h("p", { class: "faint" }, [u.verified ? "Verified" : null, ...special.map((x) => SPECIAL_BADGES[x]?.name)].filter(Boolean).join(", ") || "No badges."),
    boosterSection(),
    supporterSection(),
    h("h3", null, "Profile links ", d.links ? badge(d.links.show ? "on their profile" : "hidden", d.links.show ? "ok" : "") : null),
    links.length
      ? h(
          "div",
          { class: "actions" },
          ...links.map(([pl, x]) => h("a", { class: "btn ghost", href: linkHost[pl]?.(encodeURIComponent(x)) ?? "#", target: "_blank", rel: "nofollow noopener noreferrer" }, `${pl}: ${x}`, glyph("ext"))),
          canAct && h("button", { class: "danger", onclick: async () => (await ask({ title: `Clear ${u.name}'s profile links?`, text: "They can add new ones, which pass the filters again.", fields: [{ name: "reason", label: "Reason", kind: "text" }], confirm: "Clear links", danger: true })) && (await post({ action: "clear-links" }, "Links cleared")) }, "Clear links"),
        )
      : emptyLine("No links."),
    avatarSection(),
    bunnySection(),
    wingsSection(),
  );
  const verifiedRuns = d.runStats.find((x) => x.status === "verified")?.n ?? 0;
  const totalRuns = d.runStats.reduce((a, x) => a + x.n, 0);
  const flags = d.flags ?? [];
  const openFlags = flags.filter((f) => !f.review).length;
  const facts = h(
    "div",
    { class: "figs figs-small player-facts" },
    [
      { key: "pts", label: "points", value: d.points ? Math.round(d.points.points) : 0, foot: d.points ? `${n(d.points.top10s)} top 10s` : "unranked" },
      { key: "rec", label: "records", value: d.points?.records ?? 0, foot: `${n(d.points?.wrs ?? 0)} world records` },
      { key: "runs", label: "verified runs", value: verifiedRuns, foot: `${n(totalRuns)} submitted`, to: may("runs.read") ? `#/runs?user=${encodeURIComponent(u.id)}` : undefined },
      { key: "flags", label: "open flags", value: openFlags, foot: `${n(flags.length)} flagged in all`, to: flags.length ? `#/suspicious?case=${encodeURIComponent(u.id)}` : undefined, tone: openFlags ? "hot" : "" },
    ].map((x) => figEl(x as Parameters<typeof figEl>[0], "small").el),
    h("div", { class: "fig small" }, h("span", { class: "fig-top" }, h("span", { class: "fig-v fig-text" }, d.sessions.last_seen ? ago(d.sessions.last_seen) : "never"), h("span", { class: "fig-l" }, "last seen")), h("span", { class: "fig-f" }, `${d.sessions.sessions} live session${d.sessions.sessions === 1 ? "" : "s"}`)),
  );
  fill(root, 
    h(
      "div",
      { class: "head player-head" },
      h("a", { href: "#/players", class: "back-link" }, glyph("back"), "Players"),
      u.avatar_url ? h("img", { class: "av av-lg", src: u.avatar_url, alt: "", width: 52, height: 52, referrerpolicy: "no-referrer" }) : h("span", { class: "av av-lg", "aria-hidden": "true" }, (u.name[0] ?? "?").toUpperCase()),
      h("div", { class: "ph-id" }, h("h1", null, ...nameWithShield(d), u.verified ? h("span", { class: "verified-mark", title: "Verified" }, glyph("verified")) : null), h("div", { class: "ph-state" }, stateWords(d), d.supporter ? badge("supporter", "acc") : null, d.booster?.shown ? badge("booster", "acc") : null, u.creator ? badge(`${u.creator} creator`, "acc") : null)),
    ),
    facts,
    actions,
    may("player.notes") ? h("section", { class: "card notes-card" }, h("h2", null, "Notes", d.notes?.length ? h("small", null, String(d.notes.length)) : null, help("What staff already know about this player, so nobody reviews the same thing twice. The pinned note shows on their board cards, cases and tickets. Players never see notes.")), notesBlock(u.id, d.notes ?? [])) : null,
    flags.length || d.tickets?.length || d.reports?.length
      ? h(
          "div",
          { class: "cols" },
          h("section", { class: "card" }, h("h2", null, "Anticheat flags", flags.length ? h("small", null, String(flags.length)) : null, flags.length ? h("a", { class: "go-link", href: `#/suspicious?case=${encodeURIComponent(u.id)}` }, "Open the case", glyph("arrow")) : null), flags.length ? h("div", { class: "ctx-rows" }, flagRows(flags, 12)) : emptyLine("No flags.")),
          h(
            "section",
            { class: "card" },
            h("h2", null, "Feedback", d.tickets?.length ? h("small", null, String(d.tickets.length)) : null),
            d.tickets?.length ? h("div", { class: "ctx-rows" }, d.tickets.map((t) => h("a", { class: "ctx-row", href: `#/feedback/${encodeURIComponent(t.id)}` }, badge(t.status, t.status === "new" ? "warn" : ""), h("span", { class: "ctx-msg" }, t.message), h("span", { class: "faint ctx-when" }, ago(t.created_at))))) : emptyLine("None sent."),
            d.reports?.length
              ? [
                  h("h3", null, "Reported by players", h("a", { class: "go-link", href: `#/feedback?about=${encodeURIComponent(u.id)}` }, "All", glyph("arrow"))),
                  h("div", { class: "ctx-rows" }, d.reports.map((t) => h("a", { class: "ctx-row", href: `#/feedback/${encodeURIComponent(t.id)}` }, badge(t.status, t.status === "new" ? "warn" : ""), h("span", { class: "ctx-msg" }, `${t.user_name ?? "someone"}: ${t.message.replace(/^Reported: .* for /, "").replace(/\s*\n+\s*/g, " · ")}`), h("span", { class: "faint ctx-when" }, ago(t.created_at))))),
                ]
              : null,
          ),
        )
      : null,
    h(
      "div",
      { class: "cols" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Account"),
        h(
          "dl",
          { class: "kv" },
          h("dt", null, "Player id"), h("dd", null, idCell(u.id)),
          h("dt", null, "Joined"), h("dd", null, `${when(u.created_at)}, ${ago(u.created_at)}`),
          h("dt", null, "Last seen"), h("dd", null, when(d.sessions.last_seen)),
          h("dt", null, "Sign-in"), h("dd", null, d.identities.length ? d.identities.map((i) => `${i.provider}${i.username ? ` (${i.username})` : ""}`).join(", ") : "guest only"),
          u.merged_into ? [h("dt", null, "Merged into"), h("dd", null, playerLink(u.merged_into, u.merged_into))] : null,
          u.shadow_at ? [h("dt", null, "Shadowban"), h("dd", null, `${when(u.shadow_at)}, ${(u.shadow_source ?? "admin").replace(/^auto:/, "rule ")}${u.shadow_reason ? `. ${u.shadow_reason}` : ""}`)] : null,
          u.ip_hash !== undefined ? [h("dt", null, "IP hash"), h("dd", { class: "mono" }, u.ip_hash ?? "—")] : null,
          h("dt", null, "Runs"), h("dd", null, d.runStats.length ? d.runStats.map((x) => `${n(x.n)} ${x.status}`).join(", ") : "none"),
        ),
      ),
      marks,
    ),
    h(
      "div",
      { class: "cols" },
      h("section", { class: "card" }, h("h2", null, "Bans", d.bans.length ? h("small", null, String(d.bans.length)) : null), table(["Where", "Until", "Reason", "When"], d.bans.map((b) => h("tr", null, h("td", null, b.room_id === "*" ? "everywhere" : b.room_id), h("td", null, b.until ? when(b.until) : "for good", b.until && b.until < Date.now() ? badge("over") : null), h("td", null, b.reason ?? ""), timeCell(b.created_at))), "No bans.")),
      h("section", { class: "card" }, h("h2", null, "Other accounts"), (() => {
        const rows = altRows(d);
        return rows.length ? h("div", { class: "ctx-rows" }, rows) : emptyLine("None seen.");
      })()),
    ),
    ...(d.network ? [networkCard(u.id, d.network)] : []),
    h("section", { class: "card" }, h("h2", null, "Chat", h("a", { href: `#/chat?user=${encodeURIComponent(u.id)}`, class: "go-link" }, "All of it", glyph("arrow"))), table(["When", "Room", "Message", "", ""], d.chat.map((m) => chatRow(m, false)), "No chat.")),
    h(
      "div",
      { class: "cols" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Runs", may("runs.read") ? h("a", { href: `#/runs?user=${encodeURIComponent(u.id)}`, class: "go-link" }, "All runs", glyph("arrow")) : null),
        table(["When", "Map", "Style", ["Time", "num"], "", "Client"], d.runs.map((r) => h("tr", null, timeCell(r.created_at), h("td", null, mapLine(r.map, { track: r.track })), h("td", null, r.style), h("td", { class: "num" }, h("span", { class: "t-run" }, fmtTime(r.time))), h("td", null, badge(r.status, r.status === "verified" ? "ok" : r.status === "rejected" || r.status === "error" ? "bad" : ""), r.pb ? badge("PB", "acc") : null, r.reason ? h("div", { class: "faint" }, r.reason) : null), h("td", null, clientTag(r.client)))), "No runs."),
      ),
      h("section", { class: "card" }, h("h2", null, "Names"), table(["When", "From", "To", "By", "Reason"], d.names.map((x) => h("tr", null, timeCell(x.created_at), h("td", null, x.old_name ?? "—"), h("td", null, x.new_name), h("td", null, x.source === "player" ? "them" : x.source), h("td", null, x.reason ?? ""))), "No changes.")),
    ),
    h("section", { class: "card" }, h("h2", null, "Moderation"), modTable(d.actions, false)),
  );
};

// --- Names

export const namesView: View = async (root) => {
  const [flagged, terms, reserved] = await Promise.all([
    api<{ players: { id: string; name: string; problem: string }[] }>("/admin/names?flagged=1"),
    api<{ terms: { term: string; whole: number; created_by: string | null; created_at: number }[] }>("/admin/names?terms=1"),
    api<{ names: { name: string; name_key: string; reason: string | null; created_by: string | null; created_at: number }[] }>("/admin/names?reserved=1"),
  ]);
  const term = h("input", { type: "text", placeholder: "3+ letters", required: true });
  const whole = h("input", { type: "checkbox" });
  const resName = h("input", { type: "text", placeholder: "the name", required: true });
  const resReason = h("input", { type: "text", placeholder: "why" });
  const renameAll = async () => {
    if (!(await ask({ title: `Give all ${flagged.players.length} flagged players a default name?`, text: "One at a time. Each is logged.", confirm: "Rename all", danger: true }))) return;
    let ok = 0;
    for (const p of flagged.players) if (await api("/admin/names", { action: "rename", user: p.id, reason: "flagged name" }).then(() => true, () => false)) ok++;
    toast(`Renamed ${ok} of ${flagged.players.length}`);
    reroute();
  };
  fill(root, 
    h(
      "section",
      { class: "card" },
      h("h2", null, "Flagged names", h("small", null, String(flagged.players.length)), help("Live names that today's rules (the built-in lists and the blocked terms below) would refuse."), flagged.players.length > 1 && may("names.rename") ? h("button", { class: "small", onclick: () => void renameAll() }, "Rename all…") : null),
      table(
        ["Name", "Why", ""],
        flagged.players.map((p) =>
          h(
            "tr",
            null,
            h("td", null, playerLink(p.id, p.name)),
            h("td", null, badge(p.problem === "blocked" ? "a blocked word" : p.problem === "reserved" ? "reserved" : p.problem, "bad")),
            h(
              "td",
              { class: "acts" },
              h("button", { class: "small", onclick: async (e: Event) => { const row = rowOf(e); if (await ask({ title: `Give ${p.name} a default name?`, confirm: "Rename", danger: true })) await leaveRow(row, act("/admin/names", { action: "rename", user: p.id, reason: "flagged name" }, "Renamed")); } }, glyph("rename"), "Default name"),
              h("button", { class: "small danger", onclick: async (e: Event) => { const row = rowOf(e); if (await ask({ title: `Ban the name ${p.name}?`, text: "Its holder gets a default name.", confirm: "Ban name", danger: true })) await leaveRow(row, act("/admin/names", { action: "ban-name", name: p.name, rename: true, reason: "flagged name" }, "Name banned", { run: () => undoCall("/admin/names", { action: "unban-name", name: p.name }, "Name allowed again") })); } }, glyph("ban"), "Ban name"),
            ),
          ),
        ),
        "No flagged names.",
      ),
    ),
    h(
      "div",
      { class: "cols" },
      h(
        "section",
        { class: "card" },
        h("h2", null, "Blocked terms", h("small", null, String(terms.terms.length))),
        h(
          "form",
          {
            class: "filters",
            onsubmit: async (e: Event) => {
              e.preventDefault();
              const t = term.value;
              const r = await act<{ matches?: unknown[]; suggested?: boolean }>("/admin/names", { action: "block-term", term: t, whole: whole.checked }, may("names.terms") ? "Term blocked" : "Sent to the admins", may("names.terms") ? { run: () => undoCall("/admin/names", { action: "unblock-term", term: t }, "Unblocked") } : undefined);
              if (r) {
                if (r.matches?.length) toast(`${r.matches.length} names now match it. They're under Flagged names.`);
                reroute();
              }
            },
          },
          h("label", null, "Term", term),
          h("label", { class: "check" }, whole, "whole word only"),
          h("button", { type: "submit", class: "primary" }, may("names.terms") ? "Block" : "Suggest"),
        ),
        table(
          ["Term", "Matches", "Added", ""],
          terms.terms.map((t) => h("tr", null, h("td", { class: "mono" }, t.term), h("td", null, t.whole ? "whole word" : "anywhere"), timeCell(t.created_at), h("td", { class: "acts" }, may("names.terms") && h("button", { class: "small ghost", onclick: async (e: Event) => { const row = rowOf(e); if (await ask({ title: `Unblock "${t.term}"?`, confirm: "Unblock" })) await leaveRow(row, act("/admin/names", { action: "unblock-term", term: t.term }, "Unblocked", { run: async () => (await undoCall("/admin/names", { action: "block-term", term: t.term, whole: !!t.whole }, "Blocked again")) && reroute() })); } }, glyph("close"), "Remove")))),
          "None added here. The built-in lists still apply.",
        ),
      ),
      h(
        "section",
        { class: "card" },
        h("h2", null, "Reserved names", h("small", null, String(reserved.names.length))),
        h(
          "form",
          {
            class: "filters",
            onsubmit: async (e: Event) => {
              e.preventDefault();
              const nm = resName.value;
              if (await ask({ title: `Ban the name "${nm}"?`, text: "Its lookalikes too. Its holder gets a default name.", confirm: "Ban name", danger: true }))
                if (await act("/admin/names", { action: "ban-name", name: nm, rename: true, reason: resReason.value || null }, "Name banned", { run: () => undoCall("/admin/names", { action: "unban-name", name: nm }, "Allowed again") })) reroute();
            },
          },
          h("label", null, "Name", resName),
          h("label", null, "Why", resReason),
          h("button", { type: "submit", class: "primary" }, "Ban name"),
        ),
        table(
          ["Name", "Why", "Added", ""],
          reserved.names.map((r) => h("tr", null, h("td", null, r.name), h("td", null, r.reason ?? ""), timeCell(r.created_at), h("td", { class: "acts" }, may("names.unban") && h("button", { class: "small ghost", onclick: async (e: Event) => { const row = rowOf(e); if (await ask({ title: `Allow "${r.name}" again?`, confirm: "Allow" })) await leaveRow(row, act("/admin/names", { action: "unban-name", name: r.name }, "Allowed again")); } }, glyph("close"), "Remove")))),
          "No reserved names.",
        ),
      ),
    ),
  );
};

// --- Network bans

export const networkView: View = async (root, params) => {
  const all = params.get("all") === "1";
  const r = await api<{ bans: NetworkBan[] }>(`/admin/network${all ? "?all=1" : ""}`);
  const now = Date.now();
  const kindSel = h("select", null, h("option", { value: "device" }, "Device id"), h("option", { value: "fp" }, "Fingerprint"), h("option", { value: "net" }, "Network hash"));
  const value = h("input", { type: "search", placeholder: "from a player's page", style: "min-width:22rem" });
  fill(root, 
    h(
      "form",
      {
        class: "filters",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (value.value.trim() && (await networkBanDialog(kindSel.value as NetworkBan["kind"], value.value.trim(), null))) reroute();
        },
      },
      h("label", null, "Kind", kindSel),
      h("label", null, "Value", value),
      h("button", { type: "submit", class: "primary" }, "Ban…"),
      h("a", { class: "btn ghost", href: all ? "#/network" : "#/network?all=1" }, all ? "Active only" : "With expired ones"),
      help("Block refuses guest creation, sign-in and runs from there, with a generic error. Shadow shadowbans the accounts seen there. A device shared with a banned or shadowed account shadows too, without a row here. Player bans add shadow bans on their networks."),
    ),
    table(
      ["Kind", "Value", "Does", "From", "Reason", ["Accounts", "num"], "Added", "Ends", ""],
      r.bans.map((b) =>
        h(
          "tr",
          null,
          h("td", null, KIND_LABEL[b.kind]),
          h("td", null, h("span", { class: "mono", title: b.value }, b.value.length > 14 ? `${b.value.slice(0, 12)}…` : b.value)),
          h("td", null, badge(b.action === "block" ? "block" : "shadow", b.action === "block" ? "bad" : "warn"), b.expires_at && b.expires_at < now ? badge("over") : null),
          h("td", null, b.source_user ? playerLink(b.source_user, b.source_name ?? b.source_user) : h("span", { class: "faint" }, "by hand")),
          h("td", { class: "msg" }, b.reason ?? ""),
          h("td", { class: "num" }, b.accounts ?? 0),
          timeCell(b.created_at),
          b.expires_at ? timeCell(b.expires_at) : h("td", null, "never"),
          h(
            "td",
            { class: "acts" },
            h("button", {
              class: "small ghost",
              onclick: async (e: Event) => {
                const row = rowOf(e);
                if (!(await ask({ title: `Remove this ${KIND_LABEL[b.kind]} ban?`, confirm: "Remove" }))) return;
                // Undo: the same ban again, for what was left of it.
                const days = b.expires_at ? Math.max(1, Math.ceil((b.expires_at - Date.now()) / 86_400_000)) : null;
                const again = { action: "add", kind: b.kind, value: b.value, mode: b.action, reason: b.reason ?? "restored", days, user: b.source_user };
                await leaveRow(row, act("/admin/network", { action: "remove", id: b.id }, "Removed", { run: async () => (await undoCall("/admin/network", again, "Ban back")) && reroute() }));
              },
            }, "Remove"),
          ),
        ),
      ),
      "No network bans.",
    ),
  );
};
