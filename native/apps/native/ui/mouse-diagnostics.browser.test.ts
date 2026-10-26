import {test,expect} from 'bun:test';
import {chromium} from 'playwright';
import {readFile,mkdir} from 'node:fs/promises';
test('mouse diagnostics expose delivered rate without claiming hardware polling frequency',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const html=await readFile(new URL('../../../target/native-menu/menu.html',import.meta.url),'utf8'),page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000);
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>r.request().url()==='https://bunnyhop.lol/mouse-diagnostic-test'?r.fulfill({contentType:'text/html',body:html}):r.abort());
  await page.addInitScript(()=>{localStorage.setItem("bunnyhop:onboarded","1");localStorage.setItem("bunnyhop:first-seen",String(Date.now()));(window as any).messages=[];window.addEventListener('bunnyhop:native-message',e=>(window as any).messages.push((e as CustomEvent).detail));});
  await page.goto('https://bunnyhop.lol/mouse-diagnostic-test');await page.waitForFunction(()=>!!window.bunnyhopNativeMenu);await page.evaluate(()=>window.bunnyhopNativeMenu.open?.('settings','mouse'));
  await page.getByRole('checkbox',{name:'Input diagnostics overlay',exact:true}).check();expect(await page.evaluate(()=>(window as any).messages.filter((m:any)=>m.type==='settings').at(-1))).toEqual({type:'settings',patch:{mouseDiagnostics:true}});
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('bunnyhop:mouse-diagnostics',{detail:{active:false,seconds:1,eventsPerSecond:8000,events:8000,peakBurst:134,averageAgeMs:4.2,maxAgeMs:12,maxPumpMs:.8,relative:false,systemScaling:false,sdl:'3.4.18'}})));
  const panel=page.getByRole('region',{name:'Mouse input diagnostics'});expect(await panel.textContent()).toContain('8,000 motion events/s');expect(await panel.textContent()).toContain('not the configured USB polling rate');expect(await panel.textContent()).toContain('Last captured');
  const before=await panel.textContent();await page.evaluate(()=>window.dispatchEvent(new CustomEvent('bunnyhop:mouse-diagnostics',{detail:{eventsPerSecond:Infinity}})));expect(await panel.textContent()).toBe(before);expect(errors).toEqual([]);
  await mkdir('artifacts/native-040-review',{recursive:true});await page.screenshot({path:'artifacts/native-040-review/mouse-diagnostics-ui-fixture.png'});
 }finally{await browser.close();}
},20000);
