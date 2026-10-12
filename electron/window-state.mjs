export function sanitizeWindowBounds(raw) {
 if(!raw || typeof raw!=='object')return null;
 const {x,y,width,height}=raw;
 if(![x,y,width,height].every(Number.isFinite) || width<640 || height<480 || width>16000 || height>16000 || Math.abs(x)>100000 || Math.abs(y)>100000)return null;
 return {x:Math.round(x),y:Math.round(y),width:Math.round(width),height:Math.round(height)};
}
export function restoreWindowBounds(saved,displays,selected) {
 const b=sanitizeWindowBounds(saved);
 const area=(displays.find(d=>b && b.x<d.workArea.x+d.workArea.width && b.x+b.width>d.workArea.x && b.y<d.workArea.y+d.workArea.height && b.y+b.height>d.workArea.y) || selected)?.workArea || {x:0,y:0,width:1600,height:900};
 const width=Math.min(b?.width || 1600,area.width),height=Math.min(b?.height || 900,area.height);
 return {x:Math.max(area.x,Math.min(b?.x ?? area.x,area.x+area.width-width)),y:Math.max(area.y,Math.min(b?.y ?? area.y,area.y+area.height-height)),width,height};
}

// Closing saves geometry, never replaces a pending launch preference.
export function settingsAfterWindowClose(settings,bounds) {
 return {...settings,windowBounds:sanitizeWindowBounds(bounds)};
}
// An explicit fullscreen action may persist only when no launch override or
// newly selected mode is waiting for restart.
export function settingsAfterFullscreenAction(settings,{fullscreen,launchMode,cliMode=null}={}) {
 if(cliMode !== null || settings.windowMode !== launchMode)return settings;
 return {...settings,windowMode:fullscreen?'fullscreen':'windowed'};
}
