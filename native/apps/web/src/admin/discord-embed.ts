// A close-enough rendering of a Discord webhook message (apps/api src/discord-format.ts payloads): the admin panel's
// "Post to Discord" preview and tools/discord/mock.ts (the standalone HTML mock). DOM-free: returns an HTML string in
// which every piece of payload text is escaped; only <b>, <br> and https links are generated.

export interface EmbedLike {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
  image?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

export interface PayloadLike {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds: EmbedLike[];
  /** Action rows of link buttons. */
  components?: { components: { label: string; url: string }[] }[];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The subset of Discord markdown the feed uses: backslash escapes, **bold**, [text](https://link), newlines. */
export function discordMarkdown(s: string): string {
  const held: string[] = [];
  let t = s.replace(/\\([\\*_~`|<>[\]()#])/g, (_, c: string) => `\u0000${held.push(c) - 1}\u0000`);
  t = esc(t);
  t = t.replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, (_, text: string, url: string) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  t = t.replace(/\n/g, "<br>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => esc(held[Number(i)]));
}

const hex = (n: number | undefined) => `#${(n ?? 0x1e1f22).toString(16).padStart(6, "0")}`;

function when(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export const DISCORD_MOCK_CSS = `
.dmsg { font: 15px/1.375 "gg sans", "Noto Sans", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #dbdee1; background: #313338;
  padding: 14px 16px 14px 72px; position: relative; border-radius: 8px; max-width: 560px; text-align: left; }
.dmsg + .dmsg { margin-top: 12px; }
.dmsg .av { position: absolute; left: 16px; top: 16px; width: 40px; height: 40px; border-radius: 50%; background: #1e1f22; object-fit: cover; }
.dmsg .who { display: flex; align-items: baseline; gap: 6px; }
.dmsg .who b { color: #f2f3f5; font-weight: 600; }
.dmsg .tag { background: #5865f2; color: #fff; font-size: 10px; font-weight: 600; padding: 1px 4px; border-radius: 3px; position: relative; top: -1px; }
.dmsg .ts { color: #949ba4; font-size: 12px; }
.dmsg .content { margin: 2px 0 4px; }
.dmsg .embed { margin-top: 6px; background: #2b2d31; border-left: 4px solid; border-radius: 4px; padding: 8px 16px 16px 12px; max-width: 516px; display: grid; gap: 8px; }
.dmsg .etitle { font-weight: 600; color: #00a8fc; margin-top: 8px; }
.dmsg .etitle a, .dmsg .embed a { color: #00a8fc; text-decoration: none; }
.dmsg .edesc { font-size: 14px; }
.dmsg .edesc b { color: #f2f3f5; }
.dmsg .fields { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 14px; }
.dmsg .field.wide { grid-column: 1 / -1; }
.dmsg .fname { font-weight: 600; color: #f2f3f5; margin-bottom: 2px; }
.dmsg .eimg { width: 100%; border-radius: 4px; display: block; margin-top: 8px; aspect-ratio: 1200 / 630; object-fit: cover; background: #1e1f22; }
.dmsg .foot { font-size: 12px; color: #b5bac1; }
.dmsg .btns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.dmsg .btn { background: #4e5058; color: #fff; font-size: 14px; font-weight: 500; padding: 2px 16px; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; border-radius: 3px; text-decoration: none; }
.dmsg .btn::after { content: "↗"; font-size: 12px; opacity: 0.8; }
`;

export function embedHtml(e: EmbedLike): string {
  const title = e.title ? `<div class="etitle">${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}</div>` : "";
  const desc = e.description ? `<div class="edesc">${discordMarkdown(e.description)}</div>` : "";
  const fields = e.fields?.length
    ? `<div class="fields">${e.fields.map((f) => `<div class="field${f.inline ? "" : " wide"}"><div class="fname">${esc(f.name)}</div><div>${discordMarkdown(f.value)}</div></div>`).join("")}</div>`
    : "";
  const img = e.image?.url?.startsWith("https://") || e.image?.url?.startsWith("data:") ? `<img class="eimg" alt="" src="${esc(e.image.url)}">` : "";
  const foot = e.footer?.text || e.timestamp ? `<div class="foot">${esc([e.footer?.text, when(e.timestamp)].filter(Boolean).join(" · "))}</div>` : "";
  return `<div class="embed" style="border-left-color:${hex(e.color)}">${title}${desc}${fields}${img}${foot}</div>`;
}

/** One webhook message as Discord shows it (avatar, name + BOT tag, content, embeds). */
export function messageHtml(p: PayloadLike, opts: { now?: string } = {}): string {
  const av = p.avatar_url?.startsWith("https://") || p.avatar_url?.startsWith("data:") ? `<img class="av" alt="" src="${esc(p.avatar_url)}">` : `<div class="av"></div>`;
  return (
    `<div class="dmsg">${av}<div class="who"><b>${esc(p.username ?? "Webhook")}</b><span class="tag">APP</span><span class="ts">${esc(opts.now ?? "Today")}</span></div>` +
    (p.content ? `<div class="content">${discordMarkdown(p.content)}</div>` : "") +
    p.embeds.map(embedHtml).join("") +
    (p.components ?? [])
      .map((row) => `<div class="btns">${row.components.filter((b) => b.url.startsWith("https://")).map((b) => `<a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.label)}</a>`).join("")}</div>`)
      .join("") +
    `</div>`
  );
}
