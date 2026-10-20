import { describe, expect, test } from "bun:test";
import { NativeRunService, nativeBuildAllowed, replayBytes, type RunApi, type RunServiceStatus, type VersionPolicy } from "./run-service";

const identity={map:"bhop_eazy",track:0,style:"autohop" as const,build:"bunnyhop-native/123456789abc",wasm:"bunnyhop-web/abcdef012345"};
const allowed: VersionPolicy={wasm:identity.wasm,native:[{build:identity.build,wasm:identity.wasm,until:Date.now()+60_000}]};
const beat=(generation:number,tick:number,paused=false)=>({type:"beat",generation,...identity,tick,hash:"1234abcd",paused});
const finish=(generation:number)=>({type:"finish",generation,...identity,replayBase64:btoa("bhr-mock-transport-bytes")});
function deferred<T>() {let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
function fixture(policy:()=>Promise<VersionPolicy>=async()=>allowed) {
  const statuses:RunServiceStatus[]=[],bodies:Parameters<RunApi["runBeat"]>[0][]=[],uploads:{bytes:Uint8Array;beats:string[]}[]=[];
  const requests:ReturnType<typeof deferred<{sid:string;token:string}>>[]=[];
  const api:RunApi={
    runBeat:body=>{bodies.push(body);const request=deferred<{sid:string;token:string}>();requests.push(request);return request.promise;},
    submitRun:async(bytes,options)=>{uploads.push({bytes,beats:options.beats});return{id:"verified-run",status:"verified",rank:1};},
    submission:async()=>({id:"verified-run",status:"verified"}),
  };
  const service=new NativeRunService({api,version:policy,origin:()=>"https://bunnyhop.lol",send:status=>statuses.push(status)});
  return{service,api,statuses,bodies,uploads,requests};
}
async function reset(service:NativeRunService,generation=1) {await service.receive({type:"reset",generation});}

describe("native run service, mocked network only",()=>{
  test("tokens follow send slots when replies arrive out of order",async()=>{
    const f=fixture();await reset(f.service);
    const first=f.service.receive(beat(1,0));f.requests[0].resolve({sid:"session",token:"t0"});await first;
    const a=f.service.receive(beat(1,400)),b=f.service.receive(beat(1,800));
    f.requests[2].resolve({sid:"session",token:"t2"});await b;
    f.requests[1].resolve({sid:"session",token:"t1"});await a;
    await f.service.receive(finish(1));
    expect(f.uploads[0].beats).toEqual(["t0","t1","t2"]);
    expect(f.bodies.slice(1).every(body=>body.sid==="session")).toBe(true);
    expect(f.statuses.at(-1)?.status).toBe("verified");
  });
  test("initial handshake shares a session with a beat queued before its reply",async()=>{
    const f=fixture();await reset(f.service);
    const a=f.service.receive(beat(1,0)),b=f.service.receive(beat(1,400));
    expect(f.requests).toHaveLength(1);
    f.requests[0].resolve({sid:"s",token:"a"});await a;await Promise.resolve();
    expect(f.bodies[1].sid).toBe("s");f.requests[1].resolve({sid:"s",token:"b"});await b;
  });
  test("late replies after a reset cannot change a new generation",async()=>{
    const f=fixture();await reset(f.service);
    const stale=f.service.receive(beat(1,0));await reset(f.service,2);
    const current=f.service.receive(beat(2,0));
    f.requests[0].resolve({sid:"old",token:"old-token"});await stale;
    f.requests[1].resolve({sid:"new",token:"new-token"});await current;
    await f.service.receive(finish(2));
    expect(f.uploads[0].beats).toEqual(["new-token"]);
    expect(f.statuses.filter(status=>status.status==="beat").map(status=>status.generation)).toEqual([2]);
  });
  test("failed beats leave gaps and carry their pause into the next beat",async()=>{
    const f=fixture();await reset(f.service);
    const a=f.service.receive(beat(1,0));f.requests[0].resolve({sid:"s",token:"a"});await a;
    const b=f.service.receive(beat(1,400,true));f.requests[1].reject(new Error("offline"));await b;
    const c=f.service.receive(beat(1,800));expect(f.bodies[2].paused).toBe(true);
    f.requests[2].resolve({sid:"s",token:"c"});await c;await f.service.receive(finish(1));
    expect(f.uploads[0].beats).toEqual(["a","c"]);
    expect(f.statuses.find(status=>status.status==="uploading")?.gaps).toBe(1);
  });
  test.each([
    {wasm:identity.wasm,native:[]},
    {wasm:identity.wasm,native:[{...identity,build:"bunnyhop-native/ffffffffffff",until:Date.now()+10000}]},
    {wasm:identity.wasm,native:[{...identity,until:0}]},
    {wasm:"bunnyhop-web/ffffffffffff",native:[{...identity,until:Date.now()+10000}]},
  ])("preflight rejects unmatched, expired or incompatible release without upload (%j)",async policy=>{
    const f=fixture(async()=>policy);await reset(f.service);await f.service.receive(finish(1));
    expect(f.uploads).toHaveLength(0);expect(f.statuses.at(-1)?.status).toBe("kept");
    expect(f.statuses.at(-1)?.local).toBe(true);
  });
  test("offline preflight keeps the native archive and never submits",async()=>{
    const f=fixture(async()=>{throw new Error("offline");});await reset(f.service);await f.service.receive(finish(1));
    expect(f.uploads).toHaveLength(0);expect(f.statuses.at(-1)?.status).toBe("kept");
  });
  test("reset during preflight prevents a stale upload",async()=>{
    const policy=deferred<VersionPolicy>(),f=fixture(()=>policy.promise);await reset(f.service);
    const pending=f.service.receive(finish(1));await reset(f.service,2);policy.resolve(allowed);await pending;
    expect(f.uploads).toHaveLength(0);expect(f.statuses.at(-1)?.generation).toBe(2);
  });
  test("known exact release uploads original bytes and server rejection stays rejected",async()=>{
    const f=fixture();f.api.submitRun=async(bytes,options)=>{f.uploads.push({bytes,beats:options.beats});return{id:"",status:"rejected",code:"unranked_map",reason:"Unranked map"};};
    await reset(f.service);await f.service.receive(finish(1));
    expect(new TextDecoder().decode(f.uploads[0].bytes)).toBe("bhr-mock-transport-bytes");
    expect(f.statuses.at(-1)?.status).toBe("rejected");
  });
  test("polling deadline yields pending even when the server never answers",async()=>{
    const statuses:RunServiceStatus[]=[];
    const service=new NativeRunService({api:{runBeat:async()=>({sid:"s",token:"t"}),submitRun:async()=>({id:"q",status:"queued"}),submission:()=>new Promise(()=>{})},version:async()=>allowed,origin:()=>"https://bunnyhop.lol",send:value=>statuses.push(value),pollLimitMs:10,pollDelayMs:0});
    await reset(service);await service.receive(finish(1));expect(statuses.at(-1)?.status).toBe("pending");
  });
  test("queued submission polls until the actual server verdict",async()=>{
    const statuses:RunServiceStatus[]=[];let polls=0;
    const service=new NativeRunService({api:{runBeat:async()=>({sid:"s",token:"t"}),submitRun:async()=>({id:"q",status:"queued"}),submission:async()=>({id:"q",status:++polls===1?"verifying":"verified"})},version:async()=>allowed,origin:()=>"https://bunnyhop.lol",send:value=>statuses.push(value),sleep:async()=>{},pollDelayMs:0});
    await reset(service);await service.receive(finish(1));expect(polls).toBe(2);expect(statuses.at(-1)?.status).toBe("verified");
  });
  test("upload network failure keeps the native archive",async()=>{
    const f=fixture();f.api.submitRun=async()=>{throw new Error("offline");};
    await reset(f.service);await f.service.receive(finish(1));expect(f.statuses.at(-1)?.status).toBe("kept");expect(f.statuses.at(-1)?.local).toBe(true);
  });
  test("development origin never calls version or upload",async()=>{
    let calls=0;const statuses:RunServiceStatus[]=[];
    const service=new NativeRunService({api:{runBeat:async()=>({sid:"s",token:"t"}),submitRun:async()=>{calls++;return{id:"q",status:"verified"};},submission:async()=>({id:"q",status:"verified"})},version:async()=>{calls++;return allowed;},origin:()=>"http://localhost:5174",send:value=>statuses.push(value)});
    await reset(service);await service.receive(finish(1));expect(calls).toBe(0);expect(statuses.at(-1)?.status).toBe("kept");
  });
  test("local or missing release identity explains local retention and sends no beats",async()=>{
    for(const identity of [{build:"bunnyhop-native/local",wasm:""},{build:"unknown",wasm:"bunnyhop-web/abcdef012345"}]) {
      let preflights=0;const f=fixture(async()=>{preflights++;return allowed;});await reset(f.service);
      await f.service.receive({...beat(1,0),...identity});expect(f.bodies).toHaveLength(0);
      await f.service.receive({...finish(1),...identity});
      expect(preflights).toBe(0);expect(f.uploads).toHaveLength(0);expect(f.statuses.at(-1)?.status).toBe("kept");
      expect(f.statuses.at(-1)?.message).toContain("manifest is missing or stale");
    }
  });
  test("ambiguous native allowlist and malformed bytes fail closed",()=>{
    const entry={build:identity.build,wasm:identity.wasm,until:Date.now()+10000};
    expect(nativeBuildAllowed({wasm:identity.wasm,native:[entry,entry]},identity,Date.now())).toBe(false);
    expect(()=>replayBytes("invalid*base64")).toThrow();
  });
  test("valid replay at the eight MiB upload boundary decodes",()=>{
    const encoded=Buffer.alloc(8<<20,120).toString("base64");
    const bytes=replayBytes(encoded);expect(bytes.length).toBe(8<<20);expect(bytes[bytes.length-1]).toBe(120);
    expect(()=>replayBytes(Buffer.alloc((8<<20)+1).toString("base64"))).toThrow();
  });
});

test("all eight canonical styles retain their heartbeat identity and submit through the same exact release gate",async()=>{
 for(const style of ["autohop","legit","wonly","sideways","hsw","autostrafe","scroll","lowgrav"]){const f=fixture();await reset(f.service);const pending=f.service.receive({...beat(1,0),style});expect(f.bodies[0].style).toBe(style);f.requests[0].resolve({sid:"s",token:style});await pending;await f.service.receive({...finish(1),style});expect(f.uploads[0].beats).toEqual([style]);}
 const f=fixture();await reset(f.service);await f.service.receive({...beat(1,0),style:"unknown"});expect(f.bodies).toHaveLength(0);
});
test("room and race submission context is frozen before asynchronous release preflight",async()=>{
 const policy=deferred<VersionPolicy>();let context={room:"room-at-finish",race:"race-at-finish"};let submitted:unknown=null;
 const service=new NativeRunService({api:{runBeat:async()=>({sid:"s",token:"t"}),submitRun:async(_bytes,options)=>{submitted=options;return{id:"v",status:"verified"};},submission:async()=>({id:"v",status:"verified"})},version:()=>policy.promise,context:()=>context,origin:()=>"https://bunnyhop.lol",send:()=>{}});
 await reset(service);const upload=service.receive(finish(1));context={room:"different-room",race:"different-race"};policy.resolve(allowed);await upload;expect(submitted).toEqual({beats:[],room:"room-at-finish",race:"race-at-finish"});
});
