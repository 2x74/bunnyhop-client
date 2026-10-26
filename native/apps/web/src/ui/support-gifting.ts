// The Support page's Gifting tab (ui/support.ts): your gift credits and the button to send them on the left, the
// Gifter badge on the right. The badge preview uses the in-game name renderer; trying a tier never equips or saves it.

import { GIFTER_TIERS } from "../creators";
import { h } from "./dom";
import { giftWalletPanel } from "./gifting";
import { nameMarks } from "./marks";

/** Prism colour sets to try (Edit card → Badges has the full picker). */
const PRISM_SETS: [string, string, string][] = [
  ["#b98cff", "#7fcfff", "#ffb9db"],
  ["#ff745e", "#f2b628", "#ec72bd"],
  ["#51d9a4", "#7fcfff", "#7592ff"],
];

export function supportGifting(o: { name: () => string; again: HTMLElement }): HTMLElement {
  let selected = 0;
  let colors = PRISM_SETS[0];
  const sample = h("div.sp-gift-sample", { "aria-live": "polite" });
  const tiers = h("div.sp-gift-tiers", { role: "radiogroup", "aria-label": "Gifter tier" });
  const prism = h("div.sp-gift-prism", { role: "radiogroup", "aria-label": "Prism colours" });
  const drawSample = () => {
    const tier = GIFTER_TIERS[selected];
    sample.replaceChildren(h("span", null, o.name()), nameMarks({ giftsSent: tier.goal, nameBadges: [tier.id], gifterColors: [...colors], gifterAnimated: true })!);
  };
  const draw = () => {
    tiers.replaceChildren(
      ...GIFTER_TIERS.map((tier, i) =>
        h(
          `button.sp-gift-tier${i === selected ? ".on" : ""}`,
          { type: "button", role: "radio", "aria-checked": String(i === selected), onclick: () => ((selected = i), draw()) },
          nameMarks({ giftsSent: tier.goal, nameBadges: [tier.id] }),
          h("b", null, tier.name.replace(" Gifter", "")),
          h("span", null, tier.goal === 1 ? "1 gift" : `${tier.goal} gifts`),
        ),
      ),
    );
    prism.hidden = selected !== GIFTER_TIERS.length - 1;
    prism.replaceChildren(
      ...PRISM_SETS.map((set) =>
        h(
          `button.sp-gift-set${set === colors ? ".on" : ""}`,
          { type: "button", role: "radio", "aria-checked": String(set === colors), "aria-label": "Prism colours", onclick: () => ((colors = set), draw()) },
          ...set.map((c) => h("span", { style: `background:${c}` })),
        ),
      ),
    );
    drawSample();
  };
  draw();

  const root = h(
    "div.sp-gifting-page",
    { role: "tabpanel", "aria-labelledby": "sp-tab-gifting" },
    h(
      "section.sp-gift-info",
      null,
      h("p.sp-lead", null, "Give another player permanent Supporter."),
      h("p", null, "Your first $5 makes you a supporter. Every full $5 after that is a gift credit, past donations included."),
      giftWalletPanel(),
      h("p", null, "You can also gift from a player's profile, from the pause menu on a server, or with !gift in chat. Guests and offline players can receive gifts."),
      o.again,
    ),
    h(
      "section.sp-gift-badge",
      null,
      h("h3.sp-h", null, "Gifter badge"),
      h("p", null, "Sits beside your name and levels up with the gifts you send."),
      sample,
      tiers,
      prism,
      h("p.sp-gift-note", null, "Wear it from Edit card → Badges."),
    ),
  );
  // The account name may resolve after the screen is built.
  root.addEventListener("support-preview-refresh", drawSample);
  return root;
}
