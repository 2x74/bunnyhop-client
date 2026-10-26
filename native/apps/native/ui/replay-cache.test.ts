import {expect,test} from "bun:test";
import {ReplayCache} from "./replay-cache";
test("prefetch shares in-flight bytes and evicts the least recent replay",async()=>{
  const fetched:string[]=[];const cache=new ReplayCache(async id=>{fetched.push(id);return new Uint8Array([1]);},2);
  const a=cache.get("a"),again=cache.get("a");expect(a).toBe(again);await a;await cache.get("b");await cache.get("a");await cache.get("c");await cache.get("b");expect(fetched).toEqual(["a","b","c","b"]);
});
test("failed and oversized replay fetches can be retried",async()=>{
  let calls=0;const cache=new ReplayCache(async()=>{calls++;if(calls===1)throw new Error("temporary");if(calls===2)return new Uint8Array(0);return new Uint8Array([1]);});
  await expect(cache.get("run")).rejects.toThrow("temporary");await expect(cache.get("run")).rejects.toThrow("between 1 byte");expect(await cache.get("run")).toEqual(new Uint8Array([1]));expect(calls).toBe(3);
});
