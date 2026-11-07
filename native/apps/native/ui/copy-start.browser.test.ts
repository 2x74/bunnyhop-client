import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { nativeMenuBoundary } from "../menu-boundary";

test("native leaderboard Copy start and room PB picks reach the host without opening a replay", async () => {
  const module = (path: string) => JSON.stringify(resolve(import.meta.dir, path));
  const contents = `
    import {api} from ${module("../../web/src/api.ts")};
    import {leaderboardPanel} from ${module("../../web/src/ui/leaderboard.ts")};
    import {NativeCopyStart} from ${module("./copy-start.ts")};
    import {NativeRoomService} from ${module("./room-service.ts")};
    import {installGamepadNavigation} from ${module("./gamepad.ts")};
    const messages = [], replies = [], queries = [];
    const context = {map:'fixture',style:'legit',track:0,loading:false};
    const entry = {rank:1,runId:'run-1',player:{id:'hopper',name:'Hopper',provider:'guest',rank:null},
      ticks:1000,time:10,jumps:6,sync:90,physics:26,date:'2026-11-06T00:00:00Z'};
    api.available=()=>true;
    api.me=async()=>null;
    api.leaderboard=async(map,style,options)=>{
      queries.push({map,style,options}); return {map,style,total:1,entries:[entry],offset:0,me:null};
    };
    const room=new NativeRoomService({connect(){throw Error('unexpected connection')},
      ensureAccount:async()=>true,send(){}});
    room.view.id='easy'; room.view.you=0;
    room.view.players=[{slot:2,id:'hopper',name:'Hopper',provider:'guest',rank:null,admin:false,
      style:'hsw',spec:null,pb:{hsw:10},joinedAt:0}];
    const service=new NativeCopyStart({context:()=>context,room,send:message=>messages.push(message),
      reply:text=>replies.push(text),replay:async()=>new Uint8Array([1,2,3])});
    service.update();
    const menu = document.createElement('main'); menu.id='menu';
    menu.append(leaderboardPanel('fixture','autohop')); document.body.append(menu);
    const pad = installGamepadNavigation(()=>true);
    let escapes = 0;
    document.addEventListener('keydown', e=>{if(e.key==='Escape'&&!e.defaultPrevented) escapes++});
    window.fixture={messages,replies,queries,service,context,leaderboardPanel,pad,get escapes(){return escapes}};
  `;
  const modules = new Set<string>();
  const built = await Bun.build({
    entrypoints: ["copy-start-browser-entry"],
    target: "browser",
    format: "iife",
    outdir: resolve(import.meta.dir, "../../../target/copy-start-browser"),
    define: { "import.meta.env": JSON.stringify({ VITE_API_URL: "https://bunnyhop.lol/api", VITE_WAVEDASH: "0" }) },
    plugins: [
      {
        name: "copy-start-browser-entry",
        setup(build) {
          build.onResolve({ filter: /^copy-start-browser-entry$/ }, () => ({
            path: "entry",
            namespace: "copy-start-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "copy-start-test" }, () => ({ contents, loader: "ts" }));
        },
      },
      await nativeMenuBoundary(modules),
    ],
  });
  if (!built.success) throw new AggregateError(built.logs);
  expect([...modules].some((path) => path.endsWith("/sim.ts"))).toBe(false);
  const script = await built.outputs.find((output) => output.path.endsWith(".js"))!.text();
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) =>
      route.request().url() === "https://bunnyhop.lol/copy-start-test"
        ? route.fulfill({
            contentType: "text/html",
            body: `<html><head><meta charset="utf-8"></head><body><script>${script.replaceAll("</script", "<\\/script")}</script></body></html>`,
          })
        : route.abort(),
    );
    await page.goto("https://bunnyhop.lol/copy-start-test");
    const more = page.getByRole("button", { name: "More for Hopper's run", exact: true });
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: "Copy start", exact: true }).evaluate((el) => el === document.activeElement),
    ).resolves.toBe(true);
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await more.evaluate((el) => el === document.activeElement)).toBe(true);
    expect(await page.evaluate("window.fixture.escapes")).toBe(0);
    const pad = async (button: number) =>
      page.evaluate(`{
        const buttons = Array(16).fill(0); buttons[${button}] = 1;
        window.fixture.pad({ buttons, axes: [] });
        window.fixture.pad({ buttons: [], axes: [] });
      }`);
    await pad(0);
    await pad(13);
    expect(
      await page
        .getByRole("menuitem", { name: "Copy link", exact: true })
        .evaluate((el) => el === document.activeElement),
    ).toBe(true);
    await pad(1);
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await page.evaluate("window.fixture.escapes")).toBe(0);
    await pad(0);
    await pad(0);
    await page.waitForFunction("window.fixture.messages.length === 1");
    expect(await page.evaluate("window.fixture.messages[0]")).toMatchObject({
      type: "copyStart",
      map: "fixture",
      who: "Hopper",
      replayBase64: "AQID",
    });
    await page.evaluate('window.fixture.service.receive({id:1,text:"Copied Hopper\'s start point",ok:true})');
    expect(await page.evaluate("window.fixture.replies")).toEqual(["Copied Hopper's start point"]);
    await page.evaluate("window.fixture.service.roomCommand('Hopper')");
    await page.waitForFunction("window.fixture.messages.length === 2");
    expect(await page.evaluate("window.fixture.queries.at(-1)")).toMatchObject({
      map: "fixture",
      style: "hsw",
      options: { around: "hopper", track: 0 },
    });
    await page.evaluate("document.body.replaceChildren(window.fixture.leaderboardPanel('other','autohop'))");
    await page.getByRole("button", { name: "Watch Hopper's run", exact: true }).waitFor();
    await page.getByRole("button", { name: "More for Hopper's run", exact: true }).click();
    expect(await page.getByRole("menuitem", { name: "Copy start", exact: true }).count()).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
  }
}, 30000);
