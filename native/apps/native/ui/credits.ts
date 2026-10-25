import { h } from "../../web/src/ui/dom";
import { openExternal } from "./bridge";

interface Person {
  name: string;
  handle: string;
  url: string;
  role: string;
}

const PEOPLE: readonly Person[] = [
  { name: "huddled", handle: "8tp", url: "https://github.com/8tp", role: "owner and creator of bunnyhop.lol" },
  { name: "luna", handle: "2x74", url: "https://github.com/2x74", role: "primary client producer" },
];

const LINKS: readonly { label: string; url: string }[] = [
  { label: "bunnyhop.lol", url: "https://bunnyhop.lol" },
  { label: "1998.lol", url: "https://1998.lol" },
];

/**
 * Buttons rather than anchors on purpose: the menu webview refuses to navigate
 * away from the loaded document, so an <a href> would look like a link and do
 * nothing. These hand the URL to the host, which opens the system browser.
 */
// className is h()'s dotted form ("a.b"): a space in it makes classList.add
// throw, which used to take the whole Credits screen down with it.
function link(label: string, url: string, className = "credit-link"): HTMLElement {
  return h(`button.${className}`, {
    type: "button",
    title: url,
    onclick: () => { openExternal(url); },
  }, label);
}

export function creditsPanel(): HTMLElement {
  const people = h("ul.credits-people", { "aria-label": "People" });
  for (const person of PEOPLE) {
    people.append(h("li.credit-row", null,
      h("span.credit-who", null,
        h("span.credit-name", null, person.name),
        " (", link(person.handle, person.url), ")"),
      h("span.credit-role.dim", null, person.role)));
  }
  const elsewhere = h("p.credits-links", null);
  for (const item of LINKS) elsewhere.append(link(item.label, item.url, "credit-link.credit-site"));
  return h("div.native-credits-body", null,
    people,
    elsewhere,
    h("p.dim.credits-foot", null, "Links open in your browser."));
}
