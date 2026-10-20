// "Classic CS:S sounds": which original CS:S sounds replace which of ours. Pure data, shared by the client
// (audio/classic.ts) and the extractor (tools/content/extract.ts puts exactly these files in every manifest's
// `optional.sounds`). Paths are game paths in the CS:S / HL2 sound VPKs. Valve content: hosted like the textures,
// never committed.

const n = (base: string, count: number, from = 1) => Array.from({ length: count }, (_, i) => `sound/${base}${i + from}.wav`);

export const CLASSIC_SOUNDS: Record<string, string[]> = {
  step_concrete: n("player/footsteps/concrete", 4),
  step_metal: n("player/footsteps/metal", 4),
  step_wood: n("player/footsteps/wood", 4),
  step_grass: [...n("player/footsteps/grass", 4), ...n("player/footsteps/dirt", 4)],
  step_tile: n("player/footsteps/tile", 4),
  // Ankle-deep water: CS:S "slosh"; deeper: "wade".
  step_water: n("player/footsteps/slosh", 4),
  swim: n("player/footsteps/wade", 4),
  water_enter: n("ambient/water/water_splash", 3),
  water_exit: n("player/footsteps/wade", 2, 5),
  carrot_swing: n("weapons/knife/knife_slash", 2),
  carrot_stab: ["sound/weapons/knife/knife_stab.wav"],
  carrot_draw: ["sound/weapons/knife/knife_deploy1.wav"],
};

/** Every game path above (the extractor's list). */
export const CLASSIC_SOUND_PATHS: string[] = [...new Set(Object.values(CLASSIC_SOUNDS).flat())];

/** VPKs that hold them besides the material VPKs (ambient/water lives in the HL2 sound VPK). */
export const CLASSIC_SOUND_VPKS = ["cstrike/cstrike_pak_dir.vpk", "hl2/hl2_sound_misc_dir.vpk"];
