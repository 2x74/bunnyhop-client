import { encodeNativeExpected } from "./native-replay-format";
// Native encoder's output is decoded/re-encoded by the existing shared JS implementation.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { decodeRaw } from "../../../apps/web/src/replay";
for (const path of Bun.argv.slice(2)) {
 const raw=gunzipSync(readFileSync(path)),decoded=decodeRaw(raw),again=encodeNativeExpected(decoded);
 if(Buffer.compare(raw,Buffer.from(again))!==0)throw new Error(`native BHR differs from shared encoder: ${path}`);
 console.log(`${path}: shared encoder identical, v${decoded.header.version}, ${decoded.header.totalTicks} commands`);
}
