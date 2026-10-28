// Native recorder proof against the pinned WASM and the shared ranked verifier.
import { resolve } from "node:path";

const proof = resolve(import.meta.dir, "../../../crates/native-bridge/tools/record-proof.ts");
const child = Bun.spawn([process.execPath, proof, ...Bun.argv.slice(2)], {
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await child.exited);
