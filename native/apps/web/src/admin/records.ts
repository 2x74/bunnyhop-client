// Admin panel → Records: current world records (newest first, filter by map / tier / style / track / posted) with
// "Post to Discord" (preview of the exact embed, confirm, posted state), any run by id, and the optional automatic
// feed's settings. API: apps/api src/discord-wr.ts (/admin/discord/*). Plain DOM like main.ts, whose helpers are
// passed in; user text only ever goes through textContent or discord-embed.ts (which escapes everything).

import { DISCORD_MOCK_CSS, messageHtml, type PayloadLike } from "./discord-embed";
import { mapLine } from "./art";
import { help } from "./core";
import { TIERS, tierLabel } from "../tiers";

type Child = Node | string | number | null | undefined | false | Child[];
type View = (root: HTMLElement, params: URLSearchParams, rest: string[]) => Promise<void | (() => void)>;

export interface RecordsDeps {
  h: <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, unknown> | null, ...children: Child[]) => HTMLElementTagNameMap[K];
  api: <T>(path: string, body?: unknown) => Promise<T>;
  act: <T = Record<string, unknown>>(path: string, body: unknown, done?: string) => Promise<T | null>;
  toast: (text: string, bad?: boolean) => void;
  badge: (text: string, kind?: string) => HTMLElement;
  playerLink: (id: string, name: string | null) => HTMLElement;
  timeCell: (ms: number | null | undefined) => HTMLTableCellElement;
  fmtTime: (sec: number | null | undefined) => string;
}

interface Posted {
  status: string;
  mode: string | null;
  at: number | null;
  by: string | null;
}

interface RecordRow {
  runId: string;
  map: string;
  tier: number | null;
  style: string;
  track: number;
  time: number;
  finishers: number;
  player: { id: string; name: string };
  achievedAt: number;
  posted: Posted | null;
}

interface Settings {
  auto: boolean;
  records: boolean;
  minFinishers: number;
  minTier: number;
  minImprovePct: number;
  minImproveSec: number;
  classicOnly: boolean;
  bonuses: boolean;
  cooldownMin: number;
  coalesceSec: number;
}

interface Preview {
  payload: PayloadLike;
  posted: { status: string; mode: string; at: number; by: string | null } | null;
  warnings: string[];
  auto: { ok: boolean; reason: string };
  configured: boolean;
}

const STYLES: [string, string][] = [
  ["", "Any style"],
  ["autohop", "Normal"],
  ["legit", "EZ Scroll"],
  ["scroll", "Legit Scroll"],
  ["wonly", "W-Only"],
  ["sideways", "Sideways"],
  ["hsw", "Half-Sideways"],
  ["autostrafe", "Auto-strafe"],
];

let cssAdded = false;
function addCss(): void {
  if (cssAdded) return;
  cssAdded = true;
  const s = document.createElement("style");
  s.textContent = `${DISCORD_MOCK_CSS}\n.dpreview { background: #313338; border-radius: 8px; padding: 4px; max-height: 60vh; overflow: auto; margin: 0.5rem 0; }\n.dpreview .dmsg { max-width: none; }\ndialog.dwide { max-width: 640px; width: 92vw; }`;
  document.head.appendChild(s);
}

export function recordsView(d: RecordsDeps): View {
  const { h, api, act, toast, badge, playerLink, timeCell, fmtTime } = d;

  const postedBadge = (p: Posted | null) =>
    !p
      ? null
      : p.status === "posted"
        ? badge(p.mode === "auto" ? "Posted (auto)" : "Posted", "ok")
        : p.status === "queued"
          ? badge("Queued", "info")
          : p.status === "failed"
            ? badge("Post failed", "bad")
            : badge(p.status);

  /** Preview + confirm. Resolves true when posted. */
  async function postDialog(runId: string): Promise<boolean> {
    addCss();
    let pv: Preview;
    try {
      pv = await api<Preview>(`/admin/discord/preview/${encodeURIComponent(runId)}`);
    } catch (e) {
      toast(String((e as Error).message ?? e), true);
      return false;
    }
    const dlg = document.getElementById("dlg") as HTMLDialogElement;
    dlg.classList.add("dwide");
    const preview = h("div", { class: "dpreview" });
    preview.innerHTML = messageHtml(pv.payload); // escaped by discord-embed.ts
    const force = h("input", { type: "checkbox" });
    const already = pv.posted?.status === "posted";
    const ok = h("button", { type: "submit", class: "primary", disabled: !pv.configured }, already ? "Post again" : "Post to Discord");
    const cancel = h("button", { type: "button" }, "Cancel");
    const form = h(
      "form",
      { method: "dialog" },
      h("h2", null, "Post to Discord"),
      pv.configured ? null : h("p", { class: "err" }, "DISCORD_WR_WEBHOOK is not set, so posting is disabled. Set the secret (wrangler secret put DISCORD_WR_WEBHOOK) to enable it."),
      pv.warnings.length ? h("ul", null, pv.warnings.map((w) => h("li", { class: "muted" }, w))) : null,
      preview,
      h("p", { class: "faint" }, `Automatic feed filters: ${pv.auto.ok ? "this run would pass" : pv.auto.reason}. Manual posts ignore them.`),
      already ? h("label", { class: "field check" }, force, `Already posted ${pv.posted?.by ? `by ${pv.posted.by}` : ""}: post it again anyway`) : null,
      h("div", { class: "actions" }, cancel, ok),
    );
    dlg.replaceChildren(form);
    return new Promise((resolve) => {
      let done = false;
      cancel.onclick = () => dlg.close();
      form.onsubmit = async (e) => {
        e.preventDefault();
        if (already && !force.checked) return toast("Tick the box to post it again", true);
        ok.disabled = true;
        const r = await act("/admin/discord/post", { runId, force: already && force.checked });
        ok.disabled = false;
        if (r) {
          done = true;
          dlg.close();
        }
      };
      dlg.addEventListener(
        "close",
        () => {
          dlg.classList.remove("dwide");
          resolve(done);
        },
        { once: true },
      );
      dlg.showModal();
    });
  }

  function settingsCard(s: Settings, configured: { wr: boolean; records: boolean }, queued: number): HTMLElement {
    const check = (k: keyof Settings, label: string) => {
      const i = h("input", { type: "checkbox", checked: !!s[k], "data-k": k });
      return h("label", { class: "field check" }, i, label);
    };
    const numIn = (k: keyof Settings, label: string, step = "1") => h("label", null, label, h("input", { type: "number", min: "0", step, value: String(s[k]), "data-k": k }));
    const form = h(
      "form",
      {
        class: "filters",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const next: Record<string, unknown> = {};
          for (const el of form.querySelectorAll<HTMLInputElement>("input[data-k]")) next[el.dataset.k!] = el.type === "checkbox" ? el.checked : Number(el.value);
          await act("/admin/discord/settings", { settings: next });
        },
      },
      check("auto", "Post new WRs"),
      check("records", "Post top 10s and server records"),
      numIn("minFinishers", "Min finishers"),
      numIn("minTier", "Min tier (0 = any)"),
      numIn("minImprovePct", "Min improvement %", "0.01"),
      numIn("minImproveSec", "or min improvement s", "0.001"),
      check("classicOnly", "Classic styles only (no Auto-strafe)"),
      check("bonuses", "Include bonuses"),
      numIn("cooldownMin", "Map cooldown (min)"),
      numIn("coalesceSec", "Batch window (s)"),
      h("button", { type: "submit", class: "primary" }, "Save"),
    );
    return h(
      "section",
      { class: "card" },
      h("h2", null, "Posting by itself", help("Off by default: post WRs by hand above. When on, new verified WRs that pass every filter are batched and posted after the window.")),
      h(
        "p",
        { class: "states" },
        configured.wr ? badge("WR webhook set", "ok") : badge("DISCORD_WR_WEBHOOK isn't set, so posting is off", "bad"),
        configured.records ? badge("records webhook set", "ok") : badge("no records webhook"),
        queued ? badge(`${queued} queued`, "info") : null,
      ),
      form,
    );
  }

  return async (root, params) => {
    const f = {
      map: h("input", { type: "search", placeholder: "map contains", value: params.get("map") ?? "" }),
      tier: h("select", null, [["", "Any tier"], ...TIERS.map((t) => [String(t), tierLabel(t)])].map(([v, l]) => h("option", { value: v, selected: (params.get("tier") ?? "") === v }, l))),
      style: h("select", null, STYLES.map(([v, l]) => h("option", { value: v, selected: (params.get("style") ?? "") === v }, l))),
      track: h("select", null, [["", "Main + bonus"], ["main", "Main"], ["bonus", "Bonus"]].map(([v, l]) => h("option", { value: v, selected: (params.get("track") ?? "") === v }, l))),
      posted: h("select", null, [["", "All current WRs"], ["0", "Not posted yet"], ["1", "Posted to Discord"]].map(([v, l]) => h("option", { value: v, selected: (params.get("posted") ?? "") === v }, l))),
    };
    const runIn = h("input", { type: "search", placeholder: "run id", class: "mono" });
    const body = h("tbody");
    const moreBtn = h("button", { type: "button" }, "Load older");
    const count = h("span", { class: "sub" });
    let next: string | null = null;
    let shown = 0;
    const query = (before: string | null) => {
      const q = new URLSearchParams();
      for (const k of ["map", "tier", "style", "track", "posted"] as const) if (f[k].value.trim()) q.set(k, f[k].value.trim());
      if (before) q.set("before", before);
      q.set("limit", "100");
      return q;
    };
    const row = (r: RecordRow): HTMLTableRowElement => {
      const status = h("td", null, postedBadge(r.posted));
      const btn = h(
        "button",
        {
          type: "button",
          class: "small ghost",
          onclick: async () => {
            if (await postDialog(r.runId)) {
              status.replaceChildren(badge("Posted", "ok"));
              btn.textContent = "Post again";
            }
          },
        },
        r.posted?.status === "posted" ? "Post again" : "Post to Discord",
      );
      return h(
        "tr",
        null,
        h("td", null, mapLine(r.map, { tier: r.tier, track: r.track })),
        h("td", null, STYLES.find(([v]) => v === r.style)?.[1] ?? r.style),
        h("td", { class: "num" }, h("span", { class: "t-run" }, fmtTime(r.time))),
        h("td", null, playerLink(r.player.id, r.player.name)),
        h("td", { class: "num" }, r.finishers),
        timeCell(r.achievedAt),
        status,
        h("td", { class: "acts" }, h("span", { class: "hover-acts" }, btn, h("a", { class: "btn small ghost", href: `/replay/${encodeURIComponent(r.runId)}`, target: "_blank", rel: "noopener" }, "Watch"))),
      );
    };
    const load = async (reset: boolean) => {
      const r = await api<{ records: RecordRow[]; next: string | null }>(`/admin/discord/records?${query(reset ? null : next)}`);
      if (reset) body.replaceChildren(), (shown = 0);
      shown += r.records.length;
      for (const x of r.records) body.appendChild(row(x));
      if (reset && !r.records.length) body.appendChild(h("tr", null, h("td", { colspan: "8", class: "empty" }, "No records match.")));
      next = r.next;
      moreBtn.hidden = !next;
      count.textContent = `${shown} records`;
    };
    moreBtn.onclick = () => void load(false);
    const st = await api<{ configured: { wr: boolean; records: boolean }; settings: Settings; queued: number }>("/admin/discord/settings");
    root.replaceChildren(
      h("div", { class: "view-bar" }, count, h("span", { class: "faint" }, "World records, newest first.")),
      h(
        "form",
        {
          class: "filters",
          onsubmit: (e: Event) => {
            e.preventDefault();
            history.replaceState(null, "", `#/records?${query(null)}`);
            void load(true);
          },
        },
        h("label", null, "Map", f.map),
        h("label", null, "Tier", f.tier),
        h("label", null, "Style", f.style),
        h("label", null, "Track", f.track),
        h("label", null, "Discord", f.posted),
        h("button", { type: "submit", class: "primary" }, "Filter"),
      ),
      h(
        "form",
        {
          class: "filters",
          onsubmit: (e: Event) => {
            e.preventDefault();
            const id = runIn.value.trim();
            if (id) void postDialog(id).then((posted) => (posted ? load(true) : undefined));
          },
        },
        h("label", null, "Any verified run", runIn),
        h("button", { type: "submit" }, "Preview / post"),
      ),
      h(
        "div",
        { class: "tablewrap" },
        h("table", null, h("thead", null, h("tr", null, ["Map", "Style", "Time", "Player", "Finishers", "Set", "Discord", ""].map((t) => h("th", { class: t === "Time" || t === "Finishers" ? "num" : undefined }, t)))), body),
      ),
      h("div", { class: "more" }, moreBtn),
      settingsCard(st.settings, st.configured, st.queued),
    );
    await load(true);
  };
}
