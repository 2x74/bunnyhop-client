import {test,expect} from "bun:test";
import {readUpdateStatus} from "./update-panel";
test("update state only accepts known phases and bounded values",()=>{
 expect(readUpdateStatus(null)).toBeNull();expect(readUpdateStatus({status:"installed"})).toBeNull();
 expect(readUpdateStatus({status:"available",version:"1.2.0",received:NaN,bytes:-4})).toEqual({status:"available",message:"",currentVersion:"local",version:"1.2.0",received:0,bytes:undefined});
 expect(readUpdateStatus({status:"error",message:"x".repeat(2000)})?.message).toHaveLength(1000);
});
