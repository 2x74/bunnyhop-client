import {test,expect} from "bun:test";
import {chromium} from "playwright";
import {readFile,mkdir} from "node:fs/promises";
import {DEFAULT_COSMETICS,COSMETICS} from "../../web/src/progression";
const menu=process.env.NATIVE_SUPPORT_MENU??new URL("../../../target/native-menu/menu.html",import.meta.url).pathname;
test("support/account reuse web flows with explicit checkout and server-reviewed gifts; all requests mocked",async()=>{
 await mkdir("/tmp/bunnyhop-support-review",{recursive:true});const html=await readFile(menu!,"utf8"),browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(7000);await page.emulateMedia({reducedMotion:"reduce"});const errors:string[]=[],writes:{path:string;body:any}[]=[];let user={id:"support-fixture",name:"Support Hopper",provider:"email",avatarUrl:null};let credits=2;
  const wallet=()=>({credits,earnedCredits:3,spentCredits:3-credits,donationCents:2000,giftsSent:1,tier:1,nextTier:5});
  page.on("pageerror",e=>errors.push(e.message));await page.addInitScript(()=>{const w=window as unknown as {webkit:unknown;__supportMessages:unknown[]};w.__supportMessages=[];w.webkit={messageHandlers:{bunnyhop:{postMessage:(raw:string)=>w.__supportMessages.push(JSON.parse(raw))}}};localStorage.setItem("bunnyhop:onboarded","1");});
  await page.routeWebSocket("**/*",ws=>ws.close());
  await page.route("**/*",async route=>{const req=route.request(),u=new URL(req.url()),path=u.pathname;if(path==="/native-support-test")return route.fulfill({contentType:"text/html",body:html});if(!path.startsWith("/api/"))return route.fulfill({status:204});let body:unknown;
   if(req.method()!=="GET")writes.push({path,body:req.postDataJSON()});
   if(path==="/api/me")body=user;
   else if(path==="/api/auth/providers")body={discord:true,email:true};
   else if(path==="/api/config")body={discordInvite:null};
   else if(path==="/api/me/account")body={user,methods:[{provider:"email",label:"fixture@example.test"}],canUnlink:{email:false,discord:false},name:{changesLeft:3,limit:3,isDefault:false}};
   else if(path==="/api/me/supporter")body={supporter:null,payments:true,minUsd:5};
   else if(path==="/api/supporters")body={names:[],top:[]};
   else if(path==="/api/support/checkout")body={url:"https://checkout.stripe.com/c/pay/cs_test_native_fixture"};
   else if(path==="/api/me/gifts/preview")body={cost:2,eligibleCount:2,linkedCount:2,guestCount:0,credits,canDeliver:true};
   else if(path==="/api/me/gifts"){if(req.method()==="POST"){const posted=req.postDataJSON();credits=0;body={requestId:posted.requestId,cost:2,wallet:wallet(),delivered:[{id:"one",name:"Fixture One"},{id:"two",name:"Fixture Two"}],replayed:false};}else body=wallet();}
   else if(path==="/api/me/name"){user={...user,name:req.postDataJSON().name};body=user;}
   else if(path==="/api/names/check")body={name:u.searchParams.get("name"),ok:true,available:true};
   else if(path==="/api/auth/logout"){user={...user,provider:"guest"};body={};}
   else if(path==="/api/me/cosmetics")body={choice:DEFAULT_COSMETICS,unlocked:COSMETICS.map(c=>c.id)};
   else if(path.includes("/friends"))body={friends:[],following:[],followers:[],blocked:[],canMessage:true,appearOffline:false};
   else if(path.endsWith("/pbs"))body={pbs:[],next:null};else if(path.endsWith("/favorites"))body={maps:[]};
   else return route.fulfill({status:503,json:{error:"offline_fixture"}});
   return route.fulfill({json:body});
  });
  await page.goto("https://bunnyhop.lol/native-support-test",{waitUntil:"domcontentloaded"});await page.waitForFunction(()=>!!window.bunnyhopNativeMenu);await page.evaluate(()=>window.bunnyhopNativeMenu.open?.("support"));
  await page.getByRole("spinbutton",{name:"Amount in US dollars"}).waitFor();expect(writes.filter(x=>x.path==="/api/support/checkout")).toHaveLength(0);expect(await page.getByText("In first person",{exact:true}).count()).toBe(1);
  await page.screenshot({path:"/tmp/bunnyhop-support-review/support.png",fullPage:true});await page.locator(".sp-ask").getByRole("button",{name:"Support",exact:true}).click();await page.waitForFunction(()=>((window as any).__supportMessages as any[]).some(x=>x.type==="openExternal"&&x.url.startsWith("https://checkout.stripe.com/")));
  expect(writes.filter(x=>x.path==="/api/support/checkout").map(x=>x.body)).toEqual([{amountCents:500}]);expect(page.url()).toBe("https://bunnyhop.lol/native-support-test");
  await page.getByRole("tab",{name:"Gifting",exact:true}).click();await page.getByRole("button",{name:"Gift Supporter",exact:true}).click();const gift=page.getByRole("dialog",{name:"Gift Supporter"});await gift.getByRole("button",{name:"Continue",exact:true}).waitFor();await gift.getByRole("spinbutton",{name:"Number of gifts"}).fill("2");
  await gift.getByRole("button",{name:"Continue",exact:true}).click();await gift.getByRole("button",{name:"Send 2 gifts",exact:true}).waitFor();expect(writes.filter(x=>x.path==="/api/me/gifts")).toHaveLength(0);await page.screenshot({path:"/tmp/bunnyhop-support-review/gift-confirmation.png",fullPage:true});
  await page.evaluate(()=>window.bunnyhopNativeMenu.onAuth());await gift.waitFor({state:"hidden"});expect(writes.filter(x=>x.path==="/api/me/gifts")).toHaveLength(0);
  await page.getByRole("button",{name:"Gift Supporter",exact:true}).click();await gift.getByRole("spinbutton",{name:"Number of gifts"}).fill("2");await gift.getByRole("button",{name:"Continue",exact:true}).click();await gift.getByRole("button",{name:"Send 2 gifts",exact:true}).waitFor();
  await gift.getByRole("button",{name:"Send 2 gifts",exact:true}).click();await gift.getByText("2 gifts sent. Thank you!",{exact:true}).waitFor();const delivery=writes.find(x=>x.path==="/api/me/gifts")!;expect(delivery.body.maxCost).toBe(2);expect(delivery.body.count).toBe(2);expect(delivery.body.requestId).toMatch(/^[\w-]{36}$/);await gift.getByRole("button",{name:"Close",exact:true}).click();
  await page.evaluate(()=>window.bunnyhopNativeMenu.open?.("home"));await page.getByRole("button",{name:"Support Hopper: name and account",exact:true}).click();const account=page.getByRole("dialog",{name:"Account",exact:true});await account.getByRole("textbox",{name:"Display name"}).waitFor();await page.screenshot({path:"/tmp/bunnyhop-support-review/account.png",fullPage:true});
  const field=account.getByRole("textbox",{name:"Display name"});await field.fill("Renamed Hopper");await field.press("Enter");await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('[aria-label="Display name"]')?.value==="Renamed Hopper");expect(writes.filter(x=>x.path==="/api/me/name")).toHaveLength(1);
  const signOut=account.getByRole("button",{name:"Sign out everywhere (press and hold)",exact:true});await signOut.click();expect(writes.filter(x=>x.path==="/api/auth/logout")).toHaveLength(0);await signOut.focus();await page.keyboard.down("Enter");await page.waitForTimeout(800);await page.keyboard.up("Enter");await page.waitForFunction(()=>document.querySelector('.acct-who-status')?.textContent?.includes("Guest:"));expect(writes.find(x=>x.path==="/api/auth/logout")?.body).toEqual({everywhere:true});
  expect(await page.evaluate(()=>(window as any).__nativeMenuGraphics)).toEqual({contexts:0,attempts:0});expect(errors).toEqual([]);
 }finally{await browser.close();}
},30000);
