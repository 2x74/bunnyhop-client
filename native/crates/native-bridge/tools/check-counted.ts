import { encodeNativeExpected } from "./native-replay-format";
import {readFileSync} from "node:fs";import {gunzipSync}from "node:zlib";
import {ReplayRecorder,decodeRaw}from "../../../apps/web/src/replay";
for(const file of Bun.argv.slice(2)){const f=JSON.parse(readFileSync(file,"utf8")),r=new ReplayRecorder(f.header.checkpointInterval);
for(let i=0;i<f.commands.length;i++){const c=f.commands[i];r.push(c.forward,c.side,c.yaw,c.pitch,c.buttons,f.looks[i]);}r.checkpoints=f.checkpoints;
const replay=r.build(f.header),expected=encodeNativeExpected(replay),actual=gunzipSync(readFileSync(f.path));
if(Buffer.compare(Buffer.from(expected),actual))throw new Error("native counted replay differs from shared recorder/encoder");
const decoded=decodeRaw(actual);if(decoded.header.version!==f.version)throw new Error("wrong counted/fallback replay version");console.log(`counted/raw rebase oracle passes ${file}, v${decoded.header.version}`);}
