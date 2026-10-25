import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeRunService, RunServiceStatus } from "./run-service";
import type { api as realApi } from "../../web/src/api";

const identity = {map:"bhop_eazy",track:0,style:"autohop" as const,build:"bunnyhop-native/123456789abc",wasm:"bunnyhop-web/abcdef012345"};
const beat = (generation = 1, tick = 512) => ({type:"beat",generation,...identity,tick,hash:"1234abcd",paused:false});
const finish = (generation = 1) => ({type:"finish",generation,...identity,replayBase64:btoa("original-native-replay")});
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise,resolve};
}
async function drainMicrotasks() { for (let i=0;i<60;i++) await Promise.resolve(); }

interface TransportHooks {
  deviceHeaders(): Promise<Record<string,string>>;
  fetch(url:string,init:RequestInit): Promise<Response>;
}
let bundled: {api:typeof realApi; NativeRunService:typeof NativeRunService; hooks:TransportHooks};
let directory: string;

// Bundle only these modules, replacing their external I/O dependencies locally.
// No mock.module(), global fetch replacement, browser state, or network access.
// Negative control: NATIVE_TRANSPORT_MUTATION=without-dispatch bun test <this file>
// The optional revision mutation proves the ownership-promise boundary is exercised.
beforeAll(async () => {
  const apiPath = join(import.meta.dir,"../../web/src/api.ts");
  const servicePath = join(import.meta.dir,"run-service.ts");
  const devicePath = join(import.meta.dir,"../../web/src/device.ts");
  const result = await Bun.build({
    entrypoints:["native-transport-entry"],target:"bun",format:"esm",
    define:{"import.meta.env":JSON.stringify({VITE_API_URL:"https://native-transport.invalid/api",VITE_WAVEDASH:"0"})},
    plugins:[{name:"isolated-native-transport",setup(build) {
      build.onResolve({filter:/^native-transport-(entry|hooks)$/},args=>({path:args.path,namespace:"native-transport"}));
      build.onLoad({filter:/.*/,namespace:"native-transport"},args=>({loader:"ts",contents:args.path.endsWith("entry")
        ? `export {api} from ${JSON.stringify(apiPath)}; export {NativeRunService} from ${JSON.stringify(servicePath)}; export {hooks} from "native-transport-hooks";`
        : `export const hooks = {deviceHeaders: () => {throw new Error("Unconfigured device headers");}, fetch: () => {throw new Error("Unconfigured fetch");}}; export const deviceHeaders = () => hooks.deviceHeaders(); export const transportFetch = (url, init) => hooks.fetch(url, init);`}));
      build.onLoad({filter:/\/(api|device|run-service)\.ts$/},async args=>{
        if(args.path===devicePath) return {loader:"ts",contents:'export {deviceHeaders} from "native-transport-hooks";'};
        if(args.path!==apiPath && args.path!==servicePath) return;
        let contents = await Bun.file(args.path).text();
        if(args.path===apiPath) {
          contents = 'import {transportFetch as fetch} from "native-transport-hooks";\n'+contents;
          if(process.env.NATIVE_TRANSPORT_MUTATION==="without-dispatch") {
            const hook = "res = await (dispatch ? dispatch(send) : send());";
            if(!contents.includes(hook)) throw new Error("Dispatch mutation no longer matches the API source");
            contents = contents.replace(hook,"res = await send();");
          }
        } else if(process.env.NATIVE_TRANSPORT_MUTATION==="without-dispatch-revision-check") {
          const check = "if(revision!==this.accountRevision) continue;\n        // The HTTP adapter";
          if(!contents.includes(check)) throw new Error("Revision mutation no longer matches the service source");
          contents = contents.replace(check,"// The HTTP adapter");
        }
        return {loader:"ts",contents};
      });
    }}],
  });
  if(!result.success) throw new AggregateError(result.logs,"Transport fixture bundle failed");
  directory = await mkdtemp(join(tmpdir(),"native-run-transport-"));
  const path = join(directory,"transport.mjs");
  await Bun.write(path,result.outputs[0]);
  bundled = await import(path);
});
afterAll(async () => {if(directory) await rm(directory,{recursive:true,force:true});});

async function fixture() {
  let credentials = "alice";
  let confirmAccount = () => Promise.resolve<string|null>(credentials);
  const statuses:RunServiceStatus[] = [];
  const requests:{path:string;owner:string;init:RequestInit}[] = [];
  bundled.hooks.deviceHeaders = async () => ({"x-bh-device":"test-device","x-bh-fp":"test-fingerprint"});
  bundled.hooks.fetch = async (url,init) => {
    const path = new URL(url).pathname;
    requests.push({path,owner:credentials,init});
    if(path==="/api/runs/beat") return Response.json({sid:`${credentials}-session`,token:`${credentials}-token`});
    if(path==="/api/runs") return Response.json({id:`${credentials}-run`,status:"verified"});
    throw new Error(`Unexpected mocked request: ${url}`);
  };
  const service = new bundled.NativeRunService({
    api:bundled.api,account:()=>confirmAccount(),send:status=>statuses.push(status),origin:()=>"https://bunnyhop.lol",
    version:async()=>({wasm:identity.wasm,native:[{build:identity.build,wasm:identity.wasm,until:Date.now()+60_000}]}),
  });
  await service.receive({type:"reset",generation:1});
  await service.receive(beat(1,0));
  expect(requests.map(request=>request.owner)).toEqual(["alice"]);
  requests.length = 0;
  return {
    service,statuses,requests,
    refresh(owner:string) {
      const confirmation = deferred<string|null>();
      credentials = owner;
      confirmAccount = () => confirmation.promise;
      service.refreshAccount();
      return confirmation;
    },
    delayHeaders() {
      const entered = deferred<void>(),release = deferred<Record<string,string>>();
      bundled.hooks.deviceHeaders = () => {entered.resolve();return release.promise;};
      return {entered:entered.promise,release:()=>release.resolve({"x-bh-device":"delayed-device","x-bh-fp":"delayed-fingerprint"})};
    },
  };
}

const cases = ["beat","finish"] as const;
const event = (kind:typeof cases[number]) => kind==="beat" ? beat() : finish();
const endpoint = (kind:typeof cases[number]) => kind==="beat" ? "/api/runs/beat" : "/api/runs";

describe("native ownership through the real HTTP adapter",() => {
  test.each(cases)("%s never fetches with Bob credentials after a switch during device headers",async kind=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(event(kind));
    await headers.entered;
    expect(f.requests).toHaveLength(0);
    const confirmation = f.refresh("bob");
    headers.release();
    await drainMicrotasks();
    // Cookies already belong to Bob, but the account lookup has not completed.
    expect(f.requests).toHaveLength(0);
    confirmation.resolve("bob");
    await pending;
    expect(f.requests).toHaveLength(0);
    expect(f.statuses.at(-1)).toMatchObject({status:"kept",local:true});
    expect(f.statuses.some(status=>status.message?.includes("Account changed"))).toBe(true);
    // The fence invalidates this attempt rather than disabling the transport.
    await f.service.receive({type:"reset",generation:2});
    await f.service.receive(beat(2,0));
    await f.service.receive(finish(2));
    expect(f.requests.map(request=>[request.path,request.owner])).toEqual([["/api/runs/beat","bob"],["/api/runs","bob"]]);
    const form = f.requests[1].init.body as FormData;
    expect(form.get("beats")).toBe('["bob-token"]');
  });

  test.each(cases)("%s waits for a same-account refresh and preserves the legitimate payload",async kind=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(event(kind));
    await headers.entered;
    const confirmation = f.refresh("alice");
    headers.release();
    await drainMicrotasks();
    expect(f.requests).toHaveLength(0);
    confirmation.resolve("alice");
    await pending;
    expect(f.requests.map(request=>[request.path,request.owner])).toEqual([[endpoint(kind),"alice"]]);
    const {init} = f.requests[0];
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("x-bh-device")).toBe("delayed-device");
    expect(new Headers(init.headers).get("x-bh-fp")).toBe("delayed-fingerprint");
    if(kind==="beat") {
      expect(JSON.parse(init.body as string)).toMatchObject({sid:"alice-session",tick:512,hash:"1234abcd"});
      expect(init.keepalive).toBe(true);
      expect(f.statuses.at(-1)?.status).toBe("beat");
    } else {
      const form = init.body as FormData;
      expect(form.get("beats")).toBe('["alice-token"]');
      expect(await (form.get("replay") as Blob).text()).toBe("original-native-replay");
      expect(f.statuses.at(-1)?.status).toBe("verified");
    }
  });

  test.each(cases)("%s rechecks a refresh started after ownership resolves and before its dispatch continuation",async kind=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(event(kind));
    await headers.entered;
    // Observe the real private method's promise without inserting another await.
    // This reaction runs before accountDispatch resumes from that same promise.
    const internal = f.service as unknown as {ownsAccount(...args:unknown[]):Promise<number|null>};
    const ownsAccount = internal.ownsAccount.bind(f.service);
    const switched = deferred<ReturnType<typeof f.refresh>>();
    let armed = true;
    internal.ownsAccount = (...args) => {
      const ownership = ownsAccount(...args);
      if(armed) {
        armed = false;
        void ownership.then(revision=>{
          expect(revision).not.toBeNull();
          switched.resolve(f.refresh("bob"));
        });
      }
      return ownership;
    };
    headers.release();
    const confirmation = await switched.promise;
    await drainMicrotasks();
    expect(f.requests).toHaveLength(0);
    confirmation.resolve("bob");
    await pending;
    expect(f.requests).toHaveLength(0);
    expect(f.statuses.some(status=>status.message?.includes("Account changed"))).toBe(true);
  });

  test("a heartbeat invalidated by reset while device headers wait never reaches fetch",async()=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(beat());
    await headers.entered;
    await f.service.receive({type:"reset",generation:2});
    headers.release();
    await pending;
    expect(f.requests).toHaveLength(0);
    expect(f.statuses.at(-1)).toMatchObject({generation:2,status:"reset"});
  });

  test("reset after ownership resolves still suppresses the invalidated heartbeat",async()=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(beat());
    await headers.entered;
    const internal = f.service as unknown as {ownsAccount(...args:unknown[]):Promise<number|null>};
    const ownsAccount = internal.ownsAccount.bind(f.service);
    let armed = true;
    internal.ownsAccount = (...args) => {
      const ownership = ownsAccount(...args);
      if(armed) {
        armed = false;
        void ownership.then(()=>f.service.receive({type:"reset",generation:2}));
      }
      return ownership;
    };
    headers.release();
    await pending;
    expect(f.requests).toHaveLength(0);
    expect(f.statuses.at(-1)).toMatchObject({generation:2,status:"reset"});
  });

  test("finishing while heartbeat headers wait freezes tokens and suppresses the late heartbeat",async()=>{
    const f = await fixture(),headers = f.delayHeaders();
    const pending = f.service.receive(beat());
    await headers.entered;
    bundled.hooks.deviceHeaders = async()=>({"x-bh-device":"test-device"});
    await f.service.receive(finish());
    headers.release();
    await pending;
    expect(f.requests.map(request=>request.path)).toEqual(["/api/runs"]);
    expect((f.requests[0].init.body as FormData).get("beats")).toBe('["alice-token"]');
    expect(f.statuses.at(-1)?.status).toBe("verified");
  });
});
