// Preserve the current web Support screen; replace its one top-level page navigation at the native boundary.
export function adaptSupportSource(input:string,checkoutPath:string,bridgePath:string):string {
 const from='        location.href = (await api.supportCheckout(dollars() * 100)).url;';
 if(input.split(from).length!==2)throw new Error("Native support checkout anchor changed");
 input=input.replace('  const model = previewModel(() => supporter);',`  const model = previewModel(() => supporter);
  const nativeCheckout=new SupportCheckout({checkout:cents=>api.supportCheckout(cents,profileWriteGuard(lastKnownMe()?.id??"")),openExternal,generation:accountGeneration,alive:()=>!disposed&&root.isConnected});`);
 if(!input.includes('const nativeCheckout='))throw new Error("Native support controller anchor changed");
 input=input.replace(from,`        const result=await nativeCheckout.start(dollars()*100,min*100);
        if(result==="opened"){
          err.textContent="Payment page opened in your browser. After checkout, use Refresh support status here.";
          err.hidden=false;err.dataset.kind="opened";
          window.dispatchEvent(new Event("bunnyhop:checkout-opened"));
        }
        btn.disabled=amount.disabled=false;btn.textContent=label;`);
 input=input.replace('      } catch (e) {\n        err.textContent','      } catch (e) {\n        err.dataset.kind="";\n        err.textContent');
 // Enter and click must share the same synchronous busy fence, before the server request starts.
 input=input.replace('      if (!valid()) return;','      if (!valid() || btn.disabled) return;');
 return `import {SupportCheckout} from ${JSON.stringify(checkoutPath)};\nimport {openExternal} from ${JSON.stringify(bridgePath)};\n${input}`;
}
