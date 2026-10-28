// /custom-css (custom-css.html): copy buttons and light colouring on the code blocks, the before / after slider, and
// the contents rail following the scroll. No game code; without it the page is plain and complete.

// --- code: colour (comments, at-rules, selectors, properties, strings, values) and a Copy button

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, s: string) => `<span class="${cls}">${esc(s)}</span>`;

/** Colours one CSS block. Inside { }: `property:` and its value; outside: selectors and at-rules. */
function colour(css: string): string {
  let out = "";
  let depth = 0;
  let i = 0;
  let inValue = false;
  while (i < css.length) {
    const rest = css.slice(i);
    const comment = /^\/\*[\s\S]*?\*\//.exec(rest);
    const str = /^"(?:[^"\\]|\\.)*"|^'(?:[^'\\]|\\.)*'/.exec(rest);
    if (comment) (out += span("tk-c", comment[0])), (i += comment[0].length);
    else if (str) (out += span("tk-s", str[0])), (i += str[0].length);
    else if (rest[0] === "{") (out += "{"), depth++, (inValue = false), i++;
    else if (rest[0] === "}") (out += "}"), (depth = Math.max(0, depth - 1)), (inValue = false), i++;
    else if (rest[0] === ";") (out += ";"), (inValue = false), i++;
    else if (rest[0] === "@") {
      const m = /^@[\w-]+/.exec(rest)!;
      (out += span("tk-at", m[0])), (i += m[0].length);
    } else if (depth > 0 && !inValue) {
      const m = /^(\s*)(--?[\w-]+|[a-z-]+)(\s*:)/i.exec(rest);
      if (m && !/^[\s\S]*?\{/.test(rest.split(/[;}]/)[0])) {
        out += esc(m[1]) + span("tk-p", m[2]) + esc(m[3]);
        i += m[0].length;
        inValue = true;
      } else {
        // A nested rule's selector (or anything else) up to the next { ; }.
        const m2 = /^[^{};"'/]+/.exec(rest);
        const t = m2 ? m2[0] : rest[0];
        out += /\{/.test(css.slice(i + t.length, i + t.length + 1)) ? span("tk-sel", t) : esc(t);
        i += t.length;
      }
    } else if (depth > 0) {
      const m = /^[^{};"'/]+|^\//.exec(rest)!;
      (out += span("tk-v", m[0])), (i += m[0].length);
    } else {
      const m = /^[^{};"'@/]+|^\//.exec(rest)!;
      (out += span("tk-sel", m[0])), (i += m[0].length);
    }
  }
  return out;
}

for (const code of document.querySelectorAll<HTMLElement>("pre > code")) {
  const text = code.textContent ?? "";
  if (code.classList.contains("language-css")) code.innerHTML = colour(text);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "copy";
  btn.textContent = "Copy";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = "Copied";
    } catch {
      getSelection()?.selectAllChildren(code);
      btn.textContent = "Ctrl+C";
    }
    btn.classList.add("done");
    setTimeout(() => ((btn.textContent = "Copy"), btn.classList.remove("done")), 1600);
  });
  code.parentElement!.append(btn);
}

// --- before / after

for (const fig of document.querySelectorAll<HTMLElement>("[data-compare]")) {
  const range = fig.querySelector<HTMLInputElement>(".compare-range")!;
  range.hidden = false;
  fig.classList.add("ready");
  const set = () => fig.style.setProperty("--pos", `${range.value}%`);
  range.addEventListener("input", set);
  set();
}

// --- contents rail: the section on screen

const links = [...document.querySelectorAll<HTMLAnchorElement>(".toc a")];
const targets = links.map((a) => document.getElementById(a.hash.slice(1)));
let current: HTMLAnchorElement | null = null;
const follow = () => {
  // The last section whose heading has passed the top third of the screen.
  let at = 0;
  targets.forEach((t, k) => t && t.getBoundingClientRect().top < innerHeight * 0.33 && (at = k));
  if (links[at] === current) return;
  current?.classList.remove("on");
  (current = links[at])?.classList.add("on");
};
addEventListener("scroll", follow, { passive: true });
follow();
