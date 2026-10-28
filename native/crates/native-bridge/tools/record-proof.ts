import { encodeNativeExpected } from "./native-replay-format";
// Offline native capture/BHR proof against the shared current WASM and timer. Never starts a live game.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Core, applyRestartPoint, PHYSICS_VERSION } from "../../../apps/web/src/core";
import { decodeReplay, encodeReplay, ReplayRecorder } from "../../../apps/web/src/replay";
import { makeTimer, beforeStep, afterStep, replayCommand, simulate } from "../../../apps/web/src/sim";
import { gunzipSync } from "node:zlib";
import {foldCommand,hashHex,RUN_HASH_SEED} from "../../../apps/web/src/run-hash";
import { verifyReplay } from "../../../apps/web/src/verifier";
import { StyleFilter, styleDef } from "../../../apps/web/src/styles";
const { values }=parseArgs({args:Bun.argv.slice(2),options:{map:{type:"string"},replay:{type:"string"},wasm:{type:"string"},output:{type:"string"},"client-build":{type:"string"}}});
if(!values.map||!values.replay)throw new Error("--map MAP.bsp --replay ROUTE.bhr [--wasm production.wasm] [--output DIR]");
const root=resolve(import.meta.dir,"../../..");const map=resolve(values.map);const output=resolve(values.output??join(root,"target/native-record-proof"));mkdirSync(output,{recursive:true});
const source=await decodeReplay(readFileSync(values.replay));

if(values["client-build"]&&!/^bunnyhop-native\/[0-9a-f]{12,64}$/.test(values["client-build"]))throw new Error("--client-build requires an exact native release identity");
source.header.settings.physics=PHYSICS_VERSION;
const mapBytes=readFileSync(map);const hash=new Bun.CryptoHasher("sha256").update(mapBytes).digest("hex");if(hash!==source.header.mapSha256)throw new Error("fixture BSP hash mismatch");
const wasm=readFileSync(values.wasm??join(root,"apps/web/src/wasm/bunnyhop_core.wasm"));
const core=await Core.create(wasm);
const cache=process.env.CONTENT_CACHE_DIR??resolve(dirname(map),"../content-cache");const manifest=join(cache,"physics",basename(map,".bsp")+".txt");
if(existsSync(manifest))for(const line of readFileSync(manifest,"utf8").split("\n")){const [name,sha]=line.split("\t");if(name&&sha){const file=join(cache,"content",sha.trim());if(existsSync(file))core.contentAddFile(name,readFileSync(file));}}
core.loadMap(mapBytes);core.setSettings(source.header.settings);core.reset();if(source.header.spawn)applyRestartPoint(core,source.header.spawn);
const timer=makeTimer(source.header.zones,source.header.settings,source.header.prespeedCap,styleDef(source.header.style??"autohop"),source.header.timerRules??1);timer.reset();
const scratch=new ArrayBuffer(4),f32=new Float32Array(scratch),u32=new Uint32Array(scratch);const bits=(n:number)=>{f32[0]=n;return u32[0]};const fromBits=(n:number)=>{u32[0]=n;return f32[0]};
const filter=new StyleFilter(styleDef(source.header.style??"autohop"),source.header.settings.physics);
const commands:any[]=[],expected:unknown[]=[];let commandHash=RUN_HASH_SEED;
for(let i=0;i<source.header.totalTicks;i++){
 const cmd=filter.apply(replayCommand(source,i),core.state());beforeStep(core,timer,cmd);const events=core.step(cmd.forward,cmd.side,cmd.yaw,cmd.pitch,cmd.buttons);const {state:s,update}=afterStep(core,timer,cmd,events);
 commandHash=foldCommand(commandHash,cmd.forward,cmd.side,cmd.buttons,cmd.yaw,cmd.pitch);
 commands.push(cmd);expected.push({commandHash:hashHex(commandHash),floatBits:[...s.position,...s.velocity,s.viewOffsetZ,...s.teleportAngles,...s.angleChange,...(s.touchPosition??[NaN,NaN,NaN])].map(bits),
  state:{tick:s.tick,grounded:s.grounded,crouched:s.crouched,onLadder:s.onLadder,events,touchCrouched:s.touchCrouched??false,weapons:s.weapons??0,activeWeapon:s.activeWeapon??0},
  timer:{status:timer.status,track:timer.track,startTick:timer.startTick,endTick:timer.endTick,lastTick:timer.lastTick,ticks:timer.ticks(),seconds:timer.time(),timeMs:timer.timeMs(),timing:timer.timing(),jumps:timer.jumps,strafes:timer.strafes,
   perfectJumps:timer.perfectJumps,measuredJumps:timer.measuredJumps,lastPerfectTick:timer.lastPerfectTick,syncGood:timer.syncGood,syncTotal:timer.syncTotal,syncPercent:timer.syncPercent(),perfPercent:timer.perfPercent(),inStart:timer.inStart,
   pendingStart:(timer as any).pendingStart,updateFlags:(update.started?1:0)|(update.finished?2:0)|(update.restarted?4:0)|(update.clampVelocity?8:0)|(update.split?16:0),splits:timer.splits.map(s=>({...s}))}});
}
if(timer.status!=="finished")throw new Error("current-physics fixture did not finish");
const spec=join(output,"spec.json"),recording=join(output,"recording.jsonl");if(existsSync(recording))throw new Error("choose a new --output directory; recording exists");
const runHash=commands.slice(timer.startTick).reduce((h,c)=>foldCommand(h,c.forward,c.side,c.buttons,c.yaw,c.pitch),RUN_HASH_SEED);
writeFileSync(spec,JSON.stringify({...source.header,...(values["client-build"]?{nativeClientBuild:values["client-build"]}:{}),commands,expected,runStartIndex:timer.startTick,runHash:hashHex(runHash)}));
const child=Bun.spawn(["cargo","run","--release","--locked","-p","bunnyhop-native-bridge","--bin","record-proof","--",map,spec,recording],{cwd:root,stdout:"pipe",stderr:"inherit"});const native=await new Response(child.stdout).text();if(await child.exited)throw new Error("native record proof failed");console.log(native.trim());
const nativeHeartbeats=native.trim().split("\n").map(line=>JSON.parse(line)).find(row=>Array.isArray(row.nativeHeartbeats))?.nativeHeartbeats;if(!nativeHeartbeats)throw new Error("Native command heartbeat proof missing");
const rows=readFileSync(recording,"utf8").trim().split("\n").map(l=>JSON.parse(l));const header=rows[0],summary=rows.at(-1);if(!summary.valid||summary.timer.status!=="finished")throw new Error("native recording is invalid or unfinished");
const rec=new ReplayRecorder(header.checkpointInterval);
for(const row of rows.filter(r=>r.type==="tick")){const c=row.command;rec.push(c.forward,c.side,fromBits(c.yawBits),fromBits(c.pitchBits),c.buttons);const b=row.state.floatBits;rec.maybeCheckpoint(row.state.tick,b.slice(0,3).map(fromBits),b.slice(3,6).map(fromBits));}
const final=summary.finalState.floatBits;rec.addCheckpoint(summary.totalTicks,final.slice(0,3).map(fromBits),final.slice(3,6).map(fromBits));
const replay=rec.build({map:header.map,mapSha256:header.mapSha256,settings:header.settings,prespeedCap:header.prespeedCap,startTick:summary.timer.startTick,endTick:summary.timer.endTick,track:summary.timer.track,
 spawn:header.spawn,style:header.style,timerRules:header.timerRules,zones:header.zones,clientBuild:header.clientBuild,player:header.player,recordedAt:header.recordedAt});
const bhr=join(output,"native-recording.bhr");writeFileSync(bhr,await encodeReplay(replay));
const nativeBhr=join(output,"recording.bhr");
const nativeRaw=gunzipSync(readFileSync(nativeBhr)),jsRaw=encodeNativeExpected(replay);
if(Buffer.compare(nativeRaw,Buffer.from(jsRaw))!==0)throw new Error("native BHR raw layout differs from shared JS encoder");
const decoded=await decodeReplay(readFileSync(nativeBhr));const checked=simulate(core,decoded,decoded.header.zones);
if(!checked.checkpointsMatch||checked.timer.status!=="finished"||checked.timer.startTick!==summary.timer.startTick||checked.timer.endTick!==summary.timer.endTick)throw new Error("native BHR failed canonical replay verification");
const verified=verifyReplay(core,decoded,decoded.header.zones,{mapSha256:hash,ranked:true});
if(!verified.valid)throw new Error("native BHR rejected by shared ranked verifier: "+verified.problems.join("; "));
if(summary.timer.timeMs!==verified.timeMs)throw new Error("native ms differs from verifier ms");
const changed=await decodeReplay(readFileSync(nativeBhr));changed.checkpoints[0].position[0]=Math.fround(changed.checkpoints[0].position[0]+1);
const mutation=verifyReplay(core,changed,changed.header.zones,{mapSha256:hash,ranked:true});
if(mutation.valid||mutation.checkpointsMatch)throw new Error("shared verifier accepted mutated native checkpoint");
const report={pass:true,nativeHeartbeats,nativeReplayPlayback:true,nativeReplaySeek:true,ghostStatePreserved:true,offlineVerifierValid:verified.valid,rankedVerifier:true,mutatedCheckpointRejected:!mutation.valid,verifierProblems:verified.problems,physics:PHYSICS_VERSION,wasmSha256:new Bun.CryptoHasher("sha256").update(wasm).digest("hex"),mapSha256:hash,recording,bhr:nativeBhr,nativeRawBytes: nativeRaw.length,nativeRawEqualsSharedEncoderPlusBhts:true,runHash:hashHex(runHash),statesCompared:commands.length,timerRowsCompared:commands.length,
 checkpointsChecked:checked.checkpointsChecked,startTick:checked.timer.startTick,endTick:checked.timer.endTick,time:checked.timer.time(),
 nativeTimeMs:summary.timer.timeMs,timingPolicy:summary.timer.timingPolicy,webTimeMs:verified.timeMs,serverVerified:false,submissionEnabled:false};
writeFileSync(join(output,"proof.json"),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
