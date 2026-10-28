// The web input module's command bits and weapon slots, for menu code that imports them from input.ts (the HUD keys
// overlay in the settings panel). Same values as web input.ts; upstream moves them into a leaf module, input-bits.ts.
// Once that is vendored, the web modules import it directly and this adapter can go.

export const IN_ATTACK = 1 << 0;
export const IN_JUMP = 1 << 1;
export const IN_DUCK = 1 << 2;
export const IN_FORWARD = 1 << 3;
export const IN_BACK = 1 << 4;
export const IN_USE = 1 << 5;
export const IN_MOVELEFT = 1 << 9;
export const IN_MOVERIGHT = 1 << 10;
export const IN_ATTACK2 = 1 << 11;
export const IN_DROP = 1 << 12;
export const IN_RELOAD = 1 << 13;
export const IN_SLOT_SHIFT = 14;
export const IN_SLOT_MASK = 3 << IN_SLOT_SHIFT;
export const SLOT_PRIMARY = 1;
export const SLOT_PISTOL = 2;
export const SLOT_KNIFE = 3;
