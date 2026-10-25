/** Bytes as base64 for the bridge, in chunks (a spread of megabytes overflows the call stack). */
export function base64Bytes(bytes:Uint8Array):string {let text="";for(let at=0;at<bytes.length;at+=16384)text+=String.fromCharCode(...bytes.subarray(at,at+16384));return btoa(text);}
