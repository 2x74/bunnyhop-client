// The pride flags (countries.ts PRIDE_FLAGS): flat 4:3 drawings at the country flags' size, as `.fi-pride-*` classes
// like flag-icons' own, so every place that draws a profile flag (ui/country-flag.ts) shows them the same way.

const W = 640;
const H = 480;

/** Even horizontal stripes, top to bottom (`weights`: relative heights, default all 1). */
function stripes(colors: readonly string[], weights: readonly number[] = colors.map(() => 1)): string {
  const total = weights.reduce((a, b) => a + b, 0);
  let y = 0;
  return colors
    .map((c, i) => {
      const h = (weights[i] / total) * H;
      const r = `<rect y="${+y.toFixed(2)}" width="${W}" height="${+(h + 0.5).toFixed(2)}" fill="${c}"/>`;
      y += h;
      return r;
    })
    .join("");
}

/** Chevrons from the hoist, innermost colour first; `step`: each band's width, `tip`: how far the innermost one reaches. */
function chevrons(colors: readonly string[], step: number, tip: number): string {
  return colors
    .map((c, i) => ({ c, a: i * step }))
    .reverse()
    .map(({ c, a }) => `<path d="M0 0H${a}L${a + tip} ${H / 2}L${a} ${H}H0Z" fill="${c}"/>`)
    .join("");
}

const RAINBOW = ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"];
const PROGRESS = ["#ffffff", "#f5a9b8", "#5bcefa", "#613915", "#000000"];
const INTERSEX_YELLOW = "#ffd800";
const INTERSEX_PURPLE = "#7902aa";

const ART: Readonly<Record<string, string>> = {
  "PRIDE-RAINBOW": stripes(RAINBOW),
  "PRIDE-PROGRESS": stripes(RAINBOW) + chevrons(PROGRESS, 40, 150),
  "PRIDE-INTERSEX-PROGRESS":
    stripes(RAINBOW) +
    chevrons([INTERSEX_YELLOW, ...PROGRESS], 34, 150) +
    `<circle cx="58" cy="${H / 2}" r="27" fill="none" stroke="${INTERSEX_PURPLE}" stroke-width="10"/>`,
  "PRIDE-TRANS": stripes(["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"]),
  "PRIDE-BI": stripes(["#d60270", "#9b4f96", "#0038a8"], [2, 1, 2]),
  "PRIDE-PAN": stripes(["#ff218c", "#ffd800", "#21b1ff"]),
  "PRIDE-LESBIAN": stripes(["#d52d00", "#ff9a56", "#ffffff", "#d362a4", "#a30262"]),
  "PRIDE-GAY": stripes(["#078d70", "#26ceaa", "#98e8c1", "#ffffff", "#7bade2", "#5049cc", "#3d1a78"]),
  "PRIDE-NONBINARY": stripes(["#fcf434", "#ffffff", "#9c59d1", "#2c2c2c"]),
  "PRIDE-ACE": stripes(["#000000", "#a3a3a3", "#ffffff", "#800080"]),
  "PRIDE-ARO": stripes(["#3da542", "#a7d379", "#ffffff", "#a9a9a9", "#000000"]),
  "PRIDE-AROACE": stripes(["#e28c00", "#eccd00", "#ffffff", "#62aedc", "#203856"]),
  "PRIDE-DEMI": stripes(["#ffffff", "#6e0070", "#d2d2d2"], [7, 2, 7]) + chevrons(["#000000"], 0, 210),
  "PRIDE-GENDERFLUID": stripes(["#ff76a4", "#ffffff", "#c011d7", "#000000", "#2f3cbe"]),
  "PRIDE-GENDERQUEER": stripes(["#b57edc", "#ffffff", "#4a8123"]),
  "PRIDE-AGENDER": stripes(["#000000", "#bcc4c7", "#ffffff", "#b7f684", "#ffffff", "#bcc4c7", "#000000"]),
  "PRIDE-BIGENDER": stripes(["#c479a2", "#eda5cd", "#d6c7e8", "#ffffff", "#d6c7e8", "#9ac7e8", "#6d82d1"]),
  "PRIDE-DEMIBOY": stripes(["#7f7f7f", "#c4c4c4", "#9dd7ea", "#ffffff", "#9dd7ea", "#c4c4c4", "#7f7f7f"]),
  "PRIDE-DEMIGIRL": stripes(["#7f7f7f", "#c4c4c4", "#fdadc8", "#ffffff", "#fdadc8", "#c4c4c4", "#7f7f7f"]),
  "PRIDE-INTERSEX": `<rect width="${W}" height="${H}" fill="${INTERSEX_YELLOW}"/><circle cx="${W / 2}" cy="${H / 2}" r="112" fill="none" stroke="${INTERSEX_PURPLE}" stroke-width="40"/>`,
  "PRIDE-POLY": stripes(["#f714ba", "#01d66a", "#1594f6"]),
  "PRIDE-OMNI": stripes(["#fe9ace", "#ff53bf", "#200044", "#6760fe", "#8ea6ff"]),
};

/** The flag as an SVG document (tests, previews). */
export function prideFlagSvg(code: string): string | null {
  const art = ART[code];
  return art ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${art}</svg>` : null;
}

/** Every pride flag's `.fi-<code>` rule, as flag-icons draws the countries (background-image, contain). */
export function prideFlagCss(): string {
  return Object.keys(ART)
    .map((code) => `.fi-${code.toLowerCase()}{background-image:url("data:image/svg+xml,${encodeURIComponent(prideFlagSvg(code)!)}")}`)
    .join("\n");
}

export const PRIDE_ART_CODES: readonly string[] = Object.keys(ART);
