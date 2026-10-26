import {lastKnownMe,type RequestDispatch} from "../api";
import {accountGeneration} from "./account-state";
export function captureProfileWrite(owner:string,source:{generation():number;owner():string|null}):RequestDispatch&{current():boolean} {
 const epoch=source.generation();const current=()=>epoch===source.generation()&&source.owner()===owner;
 const dispatch:RequestDispatch=async send=>{if(!current())throw new Error("Account changed. Reopen this profile.");const reply=await send();if(!current())throw new Error("Account changed. Reopen this profile.");return reply;};return Object.assign(dispatch,{current});
}
/** Capture when the editor opens; check immediately before fetch and before the
 * API can apply response side effects. Native keeps its document across logins. */
export function profileWriteGuard(owner:string):RequestDispatch&{current():boolean} {return captureProfileWrite(owner,{generation:accountGeneration,owner:()=>lastKnownMe()?.id??null});}
