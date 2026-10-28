// Build-time HTML for /credits, using the same public catalogue as the map browser.
// gen-map-index.ts already excludes retired and incomplete maps. Community `author`
// values are GameBanana submitters, not independently verified map creators.
export interface CreditMap {
  name: string;
  author?: string | null;
  url?: string | null;
  license?: string | null;
  source?: string | null;
}

const esc = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sortName = (map: CreditMap) => map.name.replace(/^(bhop_|bh_)/i, "").toLowerCase();

function sourceLink(map: CreditMap): string {
  if (!map.url) return "Not stated";
  let url: URL;
  try { url = new URL(map.url); } catch { return "Not stated"; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Not stated";
  const label = map.source === "original" ? "Original" : url.hostname === "gamebanana.com" ? "GameBanana"
    : map.source === "fastdl" ? "FastDL mirror" : map.source === "bsca" ? "BSCA mirror" : "Source";
  return `<a href="${esc(map.url)}">${label}</a>`;
}

function licenseLink(tag: string | null | undefined): string {
  if (!tag) return "Not stated";
  const cc = /^CC-(BY(?:-NC)?(?:-ND|-SA)?)-(\d\.\d)$/.exec(tag);
  const url = cc ? `https://creativecommons.org/licenses/${cc[1].toLowerCase()}/${cc[2]}/`
    : tag === "CC0-1.0" ? "https://creativecommons.org/publicdomain/zero/1.0/" : null;
  return url ? `<a href="${url}">${esc(tag)}</a>` : esc(tag);
}

/** No runtime script: every map, credit and source link is present in the HTML. */
export function renderCreditsPage(html: string, maps: readonly CreditMap[]): string {
  const groups = new Map<string, CreditMap[]>();
  for (const map of [...maps].sort((a, b) => sortName(a).localeCompare(sortName(b), "en") || a.name.localeCompare(b.name, "en"))) {
    const initial = sortName(map).charAt(0).toUpperCase();
    const letter = /^[A-Z]$/.test(initial) ? initial : "#";
    const group = groups.get(letter) ?? [];
    group.push(map);
    groups.set(letter, group);
  }
  const list = [...groups].sort(([a], [b]) => a.localeCompare(b, "en")).map(([letter, entries]) =>
    `<details class="credits-letter"><summary>${letter} <span>(${entries.length} maps)</span></summary>` +
    `<div class="legal-table-wrap"><table><caption>Map credits: ${letter}</caption>` +
    `<thead><tr><th scope="col">Map</th><th scope="col">Credit as recorded</th><th scope="col">Source</th><th scope="col">Licence as recorded</th></tr></thead><tbody>` +
    entries.map((map) => `<tr><th scope="row">${esc(map.name)}${map.source === "original" ? `<small>Original for bunnyhop.lol</small>` : ""}</th>` +
      `<td data-label="Credit">${map.author ? `${map.source === "original" ? "By" : "Uploaded by"} ${esc(map.author)}` : "Unknown"}</td>` +
      `<td data-label="Source">${sourceLink(map)}</td><td data-label="Licence">${licenseLink(map.license)}</td></tr>`).join("\n") +
    `</tbody></table></div></details>`,
  ).join("\n");
  return html.replace("<!--credits:maps-->", list).replaceAll("<!--credits:count-->", String(maps.length));
}
