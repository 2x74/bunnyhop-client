// Build-time only: GLSL the website runs through ANGLE (which renames every identifier) can still use words that a
// desktop driver rejects. NVIDIA's compiler treats C words such as `char` as reserved, so v0.9.3–v0.9.4's hop shader
// (`float ... char = ...`) failed to compile on NVIDIA as soon as a hop effect first played, and the client closed.
// Exported shaders rename these words and the export refuses to write a shader that still has one.
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Words GLSL or NVIDIA's compiler reserve that the website's shaders could use as names. */
export const RESERVED_GLSL_WORDS = [
  "char",
  "short",
  "long",
  "unsigned",
  "half",
  "fixed",
  "double",
  "string",
  "input",
  "output",
  "filter",
  "sizeof",
  "cast",
  "namespace",
  "using",
  "public",
  "static",
  "extern",
  "external",
  "goto",
  "inline",
  "noinline",
  "volatile",
  "template",
  "this",
  "class",
  "union",
  "enum",
  "typedef",
  "asm",
  "packed",
  "superp",
  "partition",
  "active",
  "common",
  "resource",
] as const;

const WORDS = new RegExp(`\\b(${RESERVED_GLSL_WORDS.join("|")})\\b`, "g");

function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Renames reserved words used as names: `char` becomes `char_`. */
export function renameReserved(source: string): string {
  return source.replace(WORDS, "$1_");
}

/** The reserved words in a shader's code, comments aside. */
export function reservedIn(source: string): string[] {
  return [...new Set(code(source).match(WORDS) ?? [])];
}

/** Throws when a shader still uses a reserved word. */
export function assertPortable(name: string, source: string): string {
  const found = reservedIn(source);
  if (found.length) throw new Error(`${name} uses ${found.join(", ")}, which NVIDIA's GLSL compiler rejects`);
  return source;
}

/** Checks every .glsl file in `directory`. */
export async function assertPortableDirectory(directory: string): Promise<void> {
  for (const name of (await readdir(directory)).filter((n) => n.endsWith(".glsl")).sort())
    assertPortable(name, await readFile(resolve(directory, name), "utf8"));
}
