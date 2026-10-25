// Optional qualification against the unmodified private server helper:
// bun tools/check-native-turn-admission.ts <input-analysis.ts> <native-input-turn-oracle executable>
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { ReplayRecorder, encodeRaw, decodeRaw } from "../../../apps/web/src/replay";
const [server, executable] = Bun.argv.slice(2);
assert.ok(server && executable, "pass the private input-analysis.ts and the compiled C++ oracle");
const scratch = mkdtempSync(join(tmpdir(), "bh-turn-admission-"));
try {
  // Export the exact helper in a scratch copy; do not edit or relax server policy.
  const source = readFileSync(server,"utf8").replace(/from "(\.\.?\/[^\"]+)"/g,
    (_, p) => `from ${JSON.stringify(resolve(dirname(server),p))}`);
  const module = join(scratch,"analysis.ts");
  writeFileSync(module,source+"\nexport { countedTurns };\n");
  const { countedTurns } = await import(pathToFileURL(module).href);
  const output = Bun.spawnSync([executable]);
  assert.equal(output.exitCode,0);
  const cases = JSON.parse(output.stdout.toString());
  for(const c of cases) {
    const r = new ReplayRecorder(100);
    for(const t of c.ticks)r.push(0,0,t.yaw,0,t.buttons,t.look);
    const replay = decodeRaw(encodeRaw(r.build({map:"fixture",mapSha256:"00".repeat(32),
      settings:{tickInterval:Math.fround(.01),airAccelerate:1000,accelerate:5,friction:4,stopSpeed:75,gravity:800,maxSpeed:260,autohop:true,physics:16},
      style:c.style,timerRules:2,prespeedCap:null,track:0,zones:[],spawn:null,startTick:0,endTick:8,
      clientBuild:"native/admission-oracle",player:"test",recordedAt:0})));
    const actual = countedTurns(replay,{events:c.ticks.map((t:any)=>t.event)},c.style);
    const expected = c.name==="custom"||c.name==="scroll-practice" ? [0,1,2,3,4,5,6,7] : c.name==="raw" ? [2] : [];
    assert.deepEqual([...actual.invalid],expected,c.name);
    assert.equal(c.localOnly,c.name==="custom"||c.name==="scroll-practice");
    if(c.name==="scroll")assert.ok(replay.buttons.every(b=>!(b&384)));
    if(c.name==="canonical") {
      // A decoder roundtrip alone cannot catch a wrong-rate turn marked canonical.
      replay.counted!.rebases[3].base+=.1;
      assert.ok(countedTurns(replay,{events:[]},c.style).invalid.has(3));
    }
    console.log(`${c.name}: server invalid ticks [${expected}], localOnly=${c.localOnly}`);
  }
} finally { rmSync(scratch,{recursive:true,force:true}); }
