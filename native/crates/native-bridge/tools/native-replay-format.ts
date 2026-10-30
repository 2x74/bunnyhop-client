// Native recordings always include the website's optional turn-speed trailer.
import { encodeRaw, type Replay } from "../../../apps/web/src/replay";

export function encodeNativeExpected(
  replay: Replay,
  rates = { yawSpeed: 210, angleSpeedKey: 2 },
): Uint8Array {
  return encodeRaw({ ...replay, header: { ...replay.header, turnSpeed: replay.header.turnSpeed ?? rates } });
}
