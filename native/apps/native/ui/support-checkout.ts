/** The menu document stays open; only the server's trusted Stripe checkout goes to the system browser. */
export function trustedCheckoutUrl(raw:string):string {
 let url:URL;try{url=new URL(raw);}catch{throw new Error("The payment service returned an invalid checkout link.");}
 if(url.protocol!=="https:"||url.hostname!=="checkout.stripe.com"||url.port||url.username||url.password||!/^\/(?:c\/)?pay\/[^/]+/.test(url.pathname))throw new Error("The payment service returned an untrusted checkout link.");
 return url.href;
}
export interface SupportCheckoutDeps {
 checkout(amountCents:number):Promise<{url:string}>;
 openExternal(url:string):boolean;
 generation():number;
 alive():boolean;
}
export class SupportCheckout {
 private busy=false;
 constructor(private deps:SupportCheckoutDeps){}
 /** Called from a click/Enter handler only. A new session is never opened automatically on return. */
 async start(amountCents:number,minCents:number):Promise<"opened"|"stale"|"busy"> {
  if(this.busy)return "busy";
  if(!Number.isInteger(minCents)||minCents<100||!Number.isInteger(amountCents)||amountCents<minCents||amountCents>100000||amountCents%100!==0)throw new Error("Choose a whole-dollar amount within the shown limits.");
  if(!this.deps.alive())return "stale";
  const generation=this.deps.generation();this.busy=true;
  try{
   const result=await this.deps.checkout(amountCents);
   if(generation!==this.deps.generation()||!this.deps.alive())return "stale";
   const url=trustedCheckoutUrl(result.url);
   if(!this.deps.openExternal(url))throw new Error("Couldn't open the payment page in your browser. Please try again.");
   return "opened";
  }finally{this.busy=false;}
 }
}
