// Download the unchanged public verifier for offline oracles and release identity.
// It is deliberately not versioned: upstream debug strings contain build-machine paths.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const CANONICAL_WASM_URL = "https://bunnyhop.lol/assets/bunnyhop_core-DHZPH4Tl.wasm";
export const CANONICAL_WASM_SHA256 = "b585ad5fe0568bb0b9a2ed7653f27996a6f65ee36b8f672e6f9fedcd0c355296";
export const CANONICAL_WASM_BYTES = 1_384_449;
const defaultPath = resolve(import.meta.dir, "../web/src/wasm/bunnyhop_core.wasm");
function valid(bytes: Uint8Array): boolean {
  return bytes.byteLength === CANONICAL_WASM_BYTES &&
    new Bun.CryptoHasher("sha256").update(bytes).digest("hex") === CANONICAL_WASM_SHA256;
}

export async function ensureCanonicalWasm(path = defaultPath): Promise<string> {
  const existing = await readFile(path).catch(() => null);
  if (existing && valid(existing)) return path;
  const temporary = `${path}.download-${process.pid}`;
  try {
    const response = await fetch(CANONICAL_WASM_URL, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const size = response.headers.get("content-length");
    if (size !== null && Number(size) !== CANONICAL_WASM_BYTES) throw new Error("unexpected asset size");
    const reader = response.body?.getReader();
    if (!reader) throw new Error("empty response");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CANONICAL_WASM_BYTES) { await reader.cancel(); throw new Error("oversized asset"); }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    if (!valid(bytes)) throw new Error("canonical SHA-256 verification failed");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, bytes);
    await rename(temporary, path);
    console.log(`Verified canonical WASM ${CANONICAL_WASM_SHA256}`);
    return path;
  } catch (error) {
    await rm(temporary, { force: true });
    throw new Error(`Canonical WASM is missing or invalid. Connect once and run 'bun run wasm', or place the exact public asset (SHA-256 ${CANONICAL_WASM_SHA256}) at apps/web/src/wasm/bunnyhop_core.wasm. Offline native compilation requires this cached verifier for identity and parity checks. ${String(error)}`);
  }
}

if (import.meta.main) await ensureCanonicalWasm();
