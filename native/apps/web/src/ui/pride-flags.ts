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

const RAINBOW = ["#e40303", "#ff8c00", "#ffed00", "#008026", "#004dff", "#750787"];

const ART: Readonly<Record<string, string>> = {
  "PRIDE-RAINBOW": stripes(RAINBOW),
  "PRIDE-TRANS": stripes(["#5bcefa", "#f5a9b8", "#ffffff", "#f5a9b8", "#5bcefa"]),
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
