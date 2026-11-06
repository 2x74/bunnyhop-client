// Source console syntax (console/): a line or a pasted config splits into commands at `;` and line breaks outside
// quotes, `//` starts a comment, and each command splits into words at spaces, a "quoted string" being one word.
// That's Source's command buffer and CCommand::Tokenize for everything a config.cfg / autoexec.cfg uses. DOM-free.

/** The commands in `text`, in order: split at `;` and newlines outside quotes, comments dropped, blanks skipped. */
export function splitCommands(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      // A line break ends a command, even inside an unclosed quote (Source does the same).
      out.push(cur);
      cur = "";
      quoted = false;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ";") {
      out.push(cur);
      cur = "";
      continue;
    } else if (!quoted && ch === "/" && text[i + 1] === "/") {
      // A comment runs to the end of the line.
      while (i + 1 < text.length && text[i + 1] !== "\n" && text[i + 1] !== "\r") i++;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim()).filter((c) => c.length > 0);
}

/** One command's words: spaces separate them, "quotes" keep spaces (and `;`) inside one word. */
export function tokenize(command: string): string[] {
  const out: string[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    while (i < n && /\s/.test(command[i])) i++;
    if (i >= n) break;
    if (command[i] === '"') {
      const end = command.indexOf('"', i + 1);
      out.push(end < 0 ? command.slice(i + 1) : command.slice(i + 1, end));
      i = end < 0 ? n : end + 1;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(command[j]) && command[j] !== '"') j++;
    out.push(command.slice(i, j));
    i = j;
  }
  return out;
}

/** Everything after the command's first word, as typed (Source's ArgS: `echo` and `say` print it as is). */
export function argString(command: string): string {
  const m = /^\s*(?:"[^"]*"?|\S+)\s*/.exec(command);
  let rest = m ? command.slice(m[0].length) : "";
  // One pair of quotes around the whole rest goes (say "hi there").
  if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"') && rest.indexOf('"', 1) === rest.length - 1) rest = rest.slice(1, -1);
  return rest;
}

/** A word quoted when it has to be for the line to read back the same (spaces, `;`, empty). */
export const quoteArg = (s: string): string => (s === "" || /[\s;"]/.test(s) ? `"${s.replace(/"/g, "")}"` : s);
