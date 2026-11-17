// Updating a drawn piece of the Support page in place (ui/support-card.ts): the player cards and the look swatches are
// built by other components (ui/card.ts playerCard, ui/supporter-pickers.ts) that return a whole new element for each
// look. Swapping the old element for the new one restarts every CSS animation inside it (the card's border and effect,
// the avatar decoration, the name's shine) and makes its <img> again: the whole card blinked on every pick (v0.0.42:
// 1,200 of 1,470 elements re-created by one click). morph() instead carries the new element's attributes, text and
// children over to the one on the page, and only makes or drops the nodes that really differ, so what didn't change
// keeps running.

/** Classes scripts put on a live element after it was built (ui/card.ts tilt, ui/avatar-deco.ts fxVisibility): kept. */
const RUNTIME_CLASSES = ["is-live", "fx-off"];

/** What makes two nodes "the same node, perhaps changed": its tag, its first class (the component's own name for it) and its id. */
const keyOf = (n: Node): string => (n.nodeType === 1 ? `${(n as Element).tagName}.${(n as Element).classList[0] ?? ""}#${(n as Element).id}` : `#${n.nodeType}`);

function attrs(live: Element, fresh: Element): void {
  for (const a of [...live.attributes]) if (!fresh.hasAttribute(a.name)) live.removeAttribute(a.name);
  for (const a of [...fresh.attributes]) {
    if (a.name === "class") {
      const keep = RUNTIME_CLASSES.filter((c) => live.classList.contains(c) && !fresh.classList.contains(c));
      const next = keep.length ? `${a.value} ${keep.join(" ")}` : a.value;
      if (live.getAttribute("class") !== next) live.setAttribute("class", next);
    } else if (a.name === "style") {
      // A layer's place in its loop (--fx-t, a negative delay worked out when it is built: ui/card-fx.ts on the
      // v43/ui-cardfx branch) stays the live one's: taking the fresh value would jump every running layer forward.
      const was = live.getAttribute("style") ?? "";
      const clock = /--fx-t:[^;]*/.exec(was)?.[0];
      const next = clock ? a.value.replace(/--fx-t:[^;]*/, clock) : a.value;
      if (was !== next) live.setAttribute("style", next);
    } else if (live.getAttribute(a.name) !== a.value) live.setAttribute(a.name, a.value);
  }
}

function node(live: Node, fresh: Node): void {
  if (live.nodeType === 1) morph(live as Element, fresh as Element);
  else if (live.nodeValue !== fresh.nodeValue) live.nodeValue = fresh.nodeValue;
}

/**
 * Makes `live` (on the page) match `fresh` (just built, not attached; it is used up). Children are matched from both
 * ends by keyOf; whatever is left in the middle is dropped and the fresh middle put in its place, so a layer added at
 * the front of a card doesn't shift every later child onto the wrong node. Listeners on `live` and its kept
 * descendants stay; listeners on `fresh` nodes that were not moved in are lost, so this is for drawn things, not
 * controls. Returns `live`.
 */
export function morph<T extends Element>(live: T, fresh: Element): T {
  attrs(live, fresh);
  const a = [...live.childNodes];
  const b = [...fresh.childNodes];
  let s = 0;
  while (s < a.length && s < b.length && keyOf(a[s]) === keyOf(b[s])) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && keyOf(a[ea - 1]) === keyOf(b[eb - 1])) ea--, eb--;
  for (let i = 0; i < s; i++) node(a[i], b[i]);
  for (let i = ea, j = eb; i < a.length; i++, j++) node(a[i], b[j]);
  for (let i = s; i < ea; i++) a[i].remove();
  const before = a[ea] ?? null;
  for (let i = s; i < eb; i++) live.insertBefore(b[i], before);
  return live;
}
