// Ephemeral offline signing fixtures. No key here is ever trusted by a release.
import {generateKeyPairSync,sign} from "node:crypto";
const {publicKey,privateKey}=generateKeyPairSync("ed25519");
const now=1793016000;
const trust={schema:1,keys:[{id:"test-only",publicKey:publicKey.export({type:"spki",format:"pem"}).toString()}],downloadOrigins:["https://download.example.test"]};
const artifact={platform:"darwin/arm64",filename:"bunnyhop-0.4.0.tar.gz",url:"https://download.example.test/bunnyhop-0.4.0.tar.gz",bytes:100,sha256:"a".repeat(64),build:"bunnyhop-native/"+"b".repeat(24)};
const base={schema:1,version:"0.4.0",createdAt:new Date((now-60)*1000).toISOString(),expiresAt:new Date((now+86400)*1000).toISOString(),artifacts:[artifact]};
function envelope(m:unknown){const bytes=Buffer.from(JSON.stringify(m));return {keyId:"test-only",payload:bytes.toString("base64"),signature:sign(null,bytes,privateKey).toString("base64")};}
const cases:{name:string;envelope:unknown;valid:boolean}[]=[{name:"valid",envelope:envelope(base),valid:true}];
const bad=(name:string,mutate:(m:typeof base)=>void)=>{const m=structuredClone(base);mutate(m);cases.push({name,envelope:envelope(m),valid:false});};
bad("expired",m=>m.expiresAt=new Date((now-1)*1000).toISOString());bad("future",m=>m.createdAt=new Date((now+301)*1000).toISOString());bad("long validity",m=>m.expiresAt=new Date((now+32*86400)*1000).toISOString());bad("bad day",m=>m.createdAt="2026-02-30T00:00:00Z");bad("duplicate platform",m=>m.artifacts.push({...artifact}));bad("unsafe filename",m=>m.artifacts[0].filename="../escape.zip");bad("wrong origin",m=>m.artifacts[0].url="https://download.example.test.evil.test/a.zip");bad("url credentials",m=>m.artifacts[0].url="https://evil@download.example.test/a.zip");bad("too large",m=>m.artifacts[0].bytes=512*1024*1024+1);bad("fraction",m=>m.artifacts[0].bytes=1.5);bad("hash",m=>m.artifacts[0].sha256="a".repeat(63));bad("build",m=>m.artifacts[0].build="local");
const tampered=envelope(base);tampered.payload=Buffer.from(JSON.stringify({...base,version:"9.0.0"})).toString("base64");cases.push({name:"tampered",envelope:tampered,valid:false});
const unknown=envelope(base);unknown.keyId="other";cases.push({name:"untrusted key",envelope:unknown,valid:false});
await Bun.write(Bun.argv[2],JSON.stringify({now,trust,cases}));
