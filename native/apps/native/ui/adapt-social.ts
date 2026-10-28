// The web shell reloads after switching accounts. Native gameplay stays alive,
// so reset the reused social module's account-scoped socket/data in this bundle.
// Checked anchors make an upstream change fail the menu build instead of
// silently dropping the native account boundary. Original web files stay intact.
export function adaptSocialSource(input: string): string {
  const replace = (from: string, to: string) => {
    if (input.split(from).length !== 2) throw new Error(`Native social adapter anchor changed: ${from.slice(0, 70)}`);
    input = input.replace(from, to);
  };
  replace(
    "loading = (async () => {\n    try {",
    "loading = (async () => {\n    const nativeEpoch = nativeAccountEpoch;\n    try {",
  );
  replace(
    "const u = await api.me();",
    "const u = await api.me();\n      if (nativeEpoch !== nativeAccountEpoch) return;",
  );
  replace(
    "const next = await api.friends();",
    "const next = await api.friends();\n      if (nativeEpoch !== nativeAccountEpoch) return;",
  );
  replace(
    "} catch (e) {\n      // Keep the last list;",
    "} catch (e) {\n      if (nativeEpoch !== nativeAccountEpoch) return;\n      // Keep the last list;",
  );
  replace(
    "export function setFollow(id: string, on: boolean, o: FollowOpts = {}): Promise<FollowResult> {",
    "export function setFollow(id: string, on: boolean, o: FollowOpts = {}): Promise<FollowResult> {\n  const nativeEpoch = nativeAccountEpoch;",
  );
  replace(
    "const r = await api.follow(id, on);",
    'const r = await api.follow(id, on);\n      if (nativeEpoch !== nativeAccountEpoch) return {ok:false,error:"Account changed"};',
  );
  replace(
    "} catch (e) {\n      pending.delete(id);",
    '} catch (e) {\n      if (nativeEpoch !== nativeAccountEpoch) return {ok:false,error:"Account changed"};\n      pending.delete(id);',
  );
  replace(
    "const r = await api.setAppearOffline(on);",
    "const nativeEpoch = nativeAccountEpoch;\n  const r = await api.setAppearOffline(on);\n  if (nativeEpoch !== nativeAccountEpoch) return;",
  );
  replace("let ping = 0;", "let ping = 0;\n  nativeSocialStop=()=>clearInterval(ping);");
  replace(
    "function noteToast(n: Note): void {",
    'function noteToast(n: Note): void {\n  postLocalLine(`${n.actor.name}: ${n.kind === "invite" ? "invited you to play (open Friends to join)" : n.kind === "ask" ? "asked to join your lobby" : n.kind === "follow" ? "followed you" : "new notification (open Friends)"}`);',
  );
  return (
    input +
    `\nlet nativeAccountEpoch = 0;
let nativeSocialStop=()=>{};
window.addEventListener("bunnyhop:account",()=>{
 nativeAccountEpoch++;
 nativeSocialStop();
 const previous=ws;ws=null;
 if(previous){previous.onmessage=null;previous.onclose=null;previous.onopen=null;previous.close();}
 view=null;myId=null;known.clear();pending.clear();lastFrom=null;loadState="loading";
 setOpenConversation(null);changed();void refreshFriends();
});\n`
  );
}
