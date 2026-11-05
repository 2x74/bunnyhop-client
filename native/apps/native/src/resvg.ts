// Build-time only: resvg's WASM, started once. It can start only once per process, and Bun runs every test file in one
// process, so the exporters and their tests share this start.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type ResvgModule = typeof import("@resvg/resvg-wasm");

let started: Promise<ResvgModule["Resvg"]> | null = null;

async function start(): Promise<ResvgModule["Resvg"]> {
  const path = Bun.resolveSync("@resvg/resvg-wasm", import.meta.dir);
  const resvg: ResvgModule = await import(path);
  await resvg.initWasm(await readFile(join(dirname(path), "index_bg.wasm")));
  return resvg.Resvg;
}

export function startResvg(): Promise<ResvgModule["Resvg"]> {
  started ??= start();
  return started;
}
