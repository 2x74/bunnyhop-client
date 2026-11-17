// The knife's own grip, guard and pommel under each living hilt (v0.0.43; hilts/live/index.ts): ordinary hilt skins in
// the existing material kinds (hilts/glsl.ts HILT_KIND_CODE), spread into loadout.ts HILT_SKIN. Data only (the API and
// the native exporter read loadout.ts), so no rendering code is imported here.

import type { HiltSkin } from "../../../loadout";

type Kind = HiltSkin["grip"]["kind"];
const HL = (kind: Kind, color: number, alt = color) => ({ kind, color, alt });

export const LIVE_HILT_SKINS: Record<string, HiltSkin> = {
  // Watcher: dark violet leather, dark plum polished fittings.
  "hilt-watcher": { grip: HL("leather", 0x3a1a34, 0x14080f), guard: HL("polished", 0x4a2a46, 0x2a1024), pommel: HL("polished", 0x4a2a46, 0x2a1024) },
  // Frostrune: braided dark leather, worn iron.
  "hilt-frostrune": { grip: HL("cord", 0x4a3424, 0x1c130c), guard: HL("satin", 0x5a5e66, 0x3c4046), pommel: HL("satin", 0x5a5e66, 0x3c4046) },
  // Escapement: walnut, polished brass.
  "hilt-clockwork": { grip: HL("wood", 0x5a3a22, 0x2e1c10), guard: HL("polished", 0xd9a54a, 0xb8862f), pommel: HL("polished", 0xd9a54a, 0xb8862f) },
  // Forge: charcoal leather, blackened steel.
  "hilt-ember": { grip: HL("leather", 0x24201e, 0x0e0c0b), guard: HL("satin", 0x2e2a28, 0x1c1a19), pommel: HL("satin", 0x2e2a28, 0x1c1a19) },
  // Deepwater: navy leather, dark teal, a pearly pommel.
  "hilt-deep": { grip: HL("leather", 0x16303e, 0x08141a), guard: HL("polished", 0x1c4a58, 0x123440), pommel: HL("enamel", 0x9fd8d0, 0x6fb8b0) },
  // Stormfork: slate rubber with a violet groove, dark iron.
  "hilt-storm": { grip: HL("rubber", 0x3a3f4a, 0x6a52c8), guard: HL("satin", 0x34373e, 0x24262b), pommel: HL("satin", 0x34373e, 0x24262b) },
  // Bloom: green cord, leaf-green and seed-brown.
  "hilt-bloom": { grip: HL("cord", 0x3f8f3a, 0x24521f), guard: HL("enamel", 0x4fb043, 0x3f8f3a), pommel: HL("enamel", 0x7a5a2a, 0x5a401c) },
};
