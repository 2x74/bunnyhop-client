// The website's voice client (apps/web/src/voice/client.ts) in the native menu. Native voice runs in the game
// (voice_chat.hpp); the menu's side is voice-relay.ts, voice-people.ts and voice-section.ts. Shared UI that asks the
// web client (talking marks, the scoreboard's voice menu) sees no web voice, so only the native controls show.
export const voice = {
  active: false,
  isTalking: (_slot: number): boolean => false,
  ownsKey: (_code: string): boolean => false,
  canRoomMute: (): boolean => false,
};
