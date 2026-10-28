// The /changelog page's content (apps/web/changelog.html), rendered to static HTML from version.ts at build time (and by
// the dev server) by the changelogPage() plugin in vite.config.ts: crawlable, no script. Pure string building, no DOM.

import { CHANGELOG, KIND_LABEL, STAGE, VERSION, prettyDate, type ChangelogEntry } from "../version";

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** Replaces <!--changelog:list-->, <!--changelog:version--> and <!--changelog:jsonld--> in changelog.html. */
export function renderChangelogPage(html: string, entries: readonly ChangelogEntry[] = CHANGELOG): string {
  const list = entries.map(
    (e) =>
      `<article class="cl-entry" id="v${esc(e.version)}">` +
      `<div class="cl-meta"><h2><a href="#v${esc(e.version)}">v${esc(e.version)}</a></h2>` +
      `<span class="cl-kind ${e.kind}">${KIND_LABEL[e.kind]}</span>` +
      `<time datetime="${esc(e.date)}">${esc(prettyDate(e.date, "en-GB"))}</time></div>` +
      `<h3>${esc(e.title)}</h3>` +
      `<ul>${e.notes.map((n) => `<li>${esc(n)}</li>`).join("")}` +
      (e.links ?? []).map((link) => `<li><a href="${esc(link.url)}" target="_blank" rel="noopener noreferrer">${esc(link.label)}</a></li>`).join("") + `</ul>` +
      `</article>`,
  ).join("\n      ");
  const ld = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "bunnyhop.lol", item: "https://bunnyhop.lol/" },
      { "@type": "ListItem", position: 2, name: "Changelog", item: "https://bunnyhop.lol/changelog" },
    ],
  }).replace(/</g, "\\u003c");
  return html
    .replace("<!--changelog:list-->", list)
    .replaceAll("<!--changelog:version-->", esc(`v${VERSION} ${STAGE}`))
    .replace("<!--changelog:jsonld-->", `<script type="application/ld+json">${ld}</script>`);
}
