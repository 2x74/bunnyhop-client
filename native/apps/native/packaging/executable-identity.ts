// Package identity, not code-signature attestation. Match executable_identity.hpp exactly.
// Excludes only Mach-O signature blobs and load-command padding changed by codesign.
import { createHash } from "node:crypto";
export const MACHO_MODE = "macho-code-v1";
export function executableBytes(source: Uint8Array, mode = "sha256"): Uint8Array {
  if (mode === "sha256") return source;
  if (mode !== MACHO_MODE) throw new Error("Unsupported executable hash mode");
  const input = Buffer.from(source);
  if (input.length > 256 * 1024 * 1024) throw new Error("Executable exceeds256MiB");
  const canonical = (b: Buffer): Buffer => {
    if (b.length < 32 || b.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected little-endian64-bit Mach-O");
    const n = b.readUInt32LE(16),
      size = b.readUInt32LE(20);
    if (n > 4096 || size > b.length - 32) throw new Error("Invalid Mach-O commands");
    const commands: Buffer[] = [];
    let at = 32,
      end = b.length,
      first = Infinity,
      count = 0;
    for (let i = 0; i < n; i++) {
      if (at + 8 > 32 + size) throw new Error("Truncated Mach-O command");
      const cmd = b.readUInt32LE(at),
        len = b.readUInt32LE(at + 4);
      if (len < 8 || len % 8 || len > 32 + size - at) throw new Error("Invalid Mach-O command size");
      const c = Buffer.from(b.subarray(at, at + len));
      if (cmd === 0x1d) {
        if (len !== 16 || count++) throw new Error("Invalid Mach-O signature command");
        const offset = c.readUInt32LE(8),
          length = c.readUInt32LE(12);
        if (offset < 32 + size || offset + length > b.length) throw new Error("Invalid Mach-O signature bounds");
        end = offset;
      } else {
        if (cmd === 0x19) {
          if (len < 72) throw new Error("Invalid segment command");
          const sections = c.readUInt32LE(64);
          if (72 + sections * 80 > len) throw new Error("Invalid sections");
          for (let s = 0; s < sections; s++) {
            const offset = c.readUInt32LE(72 + s * 80 + 48);
            if (offset) first = Math.min(first, offset);
          }
          if (c.subarray(8, 24).toString("ascii").replace(/\0.*$/, "") === "__LINKEDIT") {
            c.fill(0, 32, 40);
            c.fill(0, 48, 56);
          }
        }
        commands.push(c);
      }
      at += len;
    }
    if (at !== 32 + size || !Number.isFinite(first) || first < 32 + size || first > end)
      throw new Error("Invalid Mach-O header region");
    // A new signature may append zero alignment padding; normalize the unsigned case to the same16-byte boundary.
    const out = Buffer.alloc(Math.ceil(end / 16) * 16);
    b.copy(out, 0, 0, end);
    out.fill(0, 32, first);
    out.writeUInt32LE(commands.length, 16);
    out.writeUInt32LE(
      commands.reduce((n, c) => n + c.length, 0),
      20,
    );
    let pos = 32;
    for (const c of commands) {
      c.copy(out, pos);
      pos += c.length;
    }
    return out;
  };
  const marker = Buffer.from("bunnyhop-macho-code-v1\0");
  const magic = input.length >= 4 ? input.readUInt32BE(0) : 0;
  if (magic === 0xcafebabe || magic === 0xcafebabf) {
    const n = input.readUInt32BE(4),
      width = magic === 0xcafebabe ? 20 : 32;
    if (n > 16 || 8 + n * width > input.length) throw new Error("Invalid fat Mach-O");
    const parts = [];
    for (let i = 0; i < n; i++) {
      const at = 8 + i * width;
      const offset = width === 20 ? input.readUInt32BE(at + 8) : Number(input.readBigUInt64BE(at + 8)),
        size = width === 20 ? input.readUInt32BE(at + 12) : Number(input.readBigUInt64BE(at + 16));
      if (!Number.isSafeInteger(offset + size) || offset < 8 + n * width || size < 32 || offset + size > input.length)
        throw new Error("Invalid fat slice");
      parts.push({
        cpu: input.readUInt32BE(at),
        sub: input.readUInt32BE(at + 4),
        bytes: canonical(input.subarray(offset, offset + size)),
      });
    }
    parts.sort((a, b) => a.cpu - b.cpu || a.sub - b.sub);
    return Buffer.concat([
      marker,
      ...parts.flatMap((p) => {
        const header = Buffer.alloc(16);
        header.writeUInt32LE(p.cpu);
        header.writeUInt32LE(p.sub, 4);
        header.writeBigUInt64LE(BigInt(p.bytes.length), 8);
        return [header, p.bytes];
      }),
    ]);
  }
  return Buffer.concat([marker, canonical(input)]);
}
export const executableHash = (bytes: Uint8Array, mode = "sha256") =>
  createHash("sha256").update(executableBytes(bytes, mode)).digest("hex");
