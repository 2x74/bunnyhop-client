// The pinned release branch predates BHTS. Compare its complete shared encoding
// plus v29/turn-speed's specified trailer until that encoder lands upstream.
import { encodeRaw, type Replay } from "../../../apps/web/src/replay";

export function encodeNativeExpected(
  replay: Replay,
  rates = { yawSpeed: 210, angleSpeedKey: 2 },
): Uint8Array {
  const raw = encodeRaw(replay);
  const magic = 0x53544842;
  if (
    raw.length >= 12 &&
    new DataView(raw.buffer, raw.byteOffset).getUint32(
      raw.length - 12,
      true,
    ) === magic
  ) {
    return raw;
  }
  const result = new Uint8Array(raw.length + 12);
  result.set(raw);
  const trailer = new DataView(result.buffer, raw.length);
  trailer.setUint32(0, magic, true);
  trailer.setFloat32(4, rates.yawSpeed, true);
  trailer.setFloat32(8, rates.angleSpeedKey, true);
  return result;
}
