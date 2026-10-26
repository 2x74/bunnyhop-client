import { describe,expect,test } from "bun:test";
import { applyState,NATIVE_BIND_ACTIONS,settingsPatch,state } from "./bridge";
import { importSettings,exportSettings } from "./settings-transfer";
import { validHudLayout } from "./hud-layout";
describe("native gameplay preferences",()=>{
  test("all expanded defaults round trip, including layout visibility and scale",()=>{
    const parsed=JSON.parse(exportSettings(state.settings));
    const result=importSettings(parsed);expect(result.patch).toEqual(state.settings);expect(result.unsupported).toEqual([]);
    expect(NATIVE_BIND_ACTIONS).toContain("setStart");expect(NATIVE_BIND_ACTIONS).toContain("spectatorMode");
    expect(state.settings.binds.chat).toEqual(["KeyY"]);
  });
  test("reject unsupported dimensions/colors and fractional FPS before crossing the bridge",()=>{
    expect(settingsPatch({crosshairColor:"red",viewmodelFov:101,sfxVolume:-1,fpsLimit:45.5})).toEqual({});
    expect(settingsPatch({crosshairColor:"#aBc123",crosshairStyle:"circle",viewmodelX:-5,musicVolume:0})).toEqual({crosshairColor:"#aBc123",crosshairStyle:"circle",viewmodelX:-5,musicVolume:0});
    expect(validHudLayout({timer:{x:50,y:30,scale:1.2,visible:false}})).toBe(true);
    expect(validHudLayout({timer:{x:50,y:30,scale:4}})).toBe(false);
    expect(validHudLayout({timer:{x:50,y:30,injected:1}})).toBe(false);
  });
  test("web import maps supported settings without claiming incompatible layout conversion",()=>{
    const result=importSettings({prefs:{invertY:true,verticalSensitivityEnabled:true,sensitivity:3,crosshair:{style:"dot",color:"#00ff00",size:5,gap:2,thickness:2,alpha:.8,outline:false},viewmodel:{show:true,fov:60,x:1,y:2,z:-1,hand:"left",bob:0,sway:.5},hud:{hidden:false,scale:1.2,layout:{timer:{a:"bc",x:0,y:0}}},audio:{music:.4,sfx:.8,ui:.2,muted:false,footsteps:true,wind:false},graphics:{fpsLimit:240},practice:{keepVelocity:false},dpi:800}});
    expect(result.patch).toMatchObject({invertY:true,separateVertical:true,crosshairStyle:"dot",viewmodelFov:60,viewmodelLeftHand:true,hudScale:120,musicVolume:.4,practiceKeepVelocity:false});
    expect(result.patch.hudLayout).toBeUndefined();expect(result.unsupported).toContain("dpi");expect(result.unsupported).toContain("web HUD anchors/layout");
  });
  test("ghost roster keeps only four valid native slots",()=>{
    applyState({ghosts:[{slot:0,id:"a",name:"PB",enabled:true},{slot:3,id:"b",name:"WR",enabled:false},{slot:4,id:"bad",name:"bad",enabled:true},{slot:1,id:"c",name:"custom",enabled:true}]});
    expect(state.ghosts.map(item=>item.slot)).toEqual([0,3,1]);
    expect(settingsPatch({ghostOpacity:2,waterQuality:"ultra"})).toEqual({});
    expect(settingsPatch({showGhost:false,ghostNearFade:false,ghostOpacity:.8,waterQuality:"simple"})).toEqual({showGhost:false,ghostNearFade:false,ghostOpacity:.8,waterQuality:"simple"});
  });
  test("camera practice reason remains sticky after returning to first person",()=>{
    applyState({practice:{active:true,tool:"camera",thirdPerson:false}});expect(state.practice.thirdPerson).toBe(true);expect(state.practice.tool).toBeNull();
    applyState({practice:{active:false,tool:null,thirdPerson:false}});expect(state.practice.thirdPerson).toBe(false);
  });
  test("host camera state accepts known modes and ignores injection",()=>{
    applyState({playback:{camera:"chase"}});expect(state.playback.camera).toBe("chase");
    applyState({playback:{camera:"invalid"}});expect(state.playback.camera).toBe("chase");
  });
});
