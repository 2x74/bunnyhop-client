import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeWindowBounds,restoreWindowBounds} from '../window-state.mjs';
test('window geometry rejects corrupt saved values and restores after a display is unplugged',()=>{
 assert.equal(sanitizeWindowBounds({x:NaN,y:0,width:800,height:600}),null);
 const d={workArea:{x:0,y:0,width:1920,height:1080}};
 assert.deepEqual(restoreWindowBounds({x:5000,y:100,width:1000,height:800},[d],d),{x:920,y:100,width:1000,height:800});
 assert.deepEqual(restoreWindowBounds({x:-100,y:-100,width:800,height:600},[d],d),{x:0,y:0,width:800,height:600});
});

test('pending mode survives close and fullscreen actions, while CLI mode remains one-off',async()=>{
 const {settingsAfterWindowClose,settingsAfterFullscreenAction}=await import('../window-state.mjs');
 const saved={windowMode:'windowed',profile:'compatibility'};
 const bounds={x:10,y:20,width:1000,height:700};
 assert.equal(settingsAfterWindowClose(saved,bounds).windowMode,'windowed');
 assert.equal(settingsAfterFullscreenAction(saved,{fullscreen:true,launchMode:'fullscreen'}),saved);
 const initial={windowMode:'fullscreen'};
 assert.equal(settingsAfterFullscreenAction(initial,{fullscreen:false,launchMode:'fullscreen',cliMode:'windowed'}),initial);
 assert.equal(settingsAfterWindowClose(initial,bounds).windowMode,'fullscreen');
 assert.equal(settingsAfterFullscreenAction(initial,{fullscreen:false,launchMode:'fullscreen'}).windowMode,'windowed');
});
