// Bound writes while retaining the latest state even without another event.
export function coalescedWriter(write,{intervalMs=1000,now=Date.now,schedule=setTimeout,cancel=clearTimeout}={}) {
 let latest,last=-Infinity,timer=null;
 const flush=()=>{timer=null;last=now();write(latest);};
 return {
  update(value){latest=value;const wait=intervalMs-(now()-last);if(wait<=0){if(timer!==null)cancel(timer);flush();}else if(timer===null)timer=schedule(flush,wait);},
  stop(){if(timer!==null)cancel(timer);timer=null;},
 };
}
