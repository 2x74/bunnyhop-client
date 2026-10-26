import { settingsPatch,type NativeSettings } from "./bridge";
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==="object"&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Import only settings whose native behavior exists. Unknown web features are
 * reported rather than appearing to have been applied. No account data leaves. */
export function importSettings(value:unknown):{patch:Partial<NativeSettings>;unsupported:string[]} {
  const envelope=object(value),raw=object(envelope.settings??envelope.prefs??value);
  const web=typeof raw.crosshair==="object"||typeof raw.viewmodel==="object";
  const converted:Record<string,unknown>={...raw};
  if(web){
    const ghost=object(raw.ghost),crosshair=object(raw.crosshair),vm=object(raw.viewmodel),audio=object(raw.audio),hud=object(raw.hud),graphics=object(raw.graphics),practice=object(raw.practice);
    const audioMute=object(audio.mute);
    Object.assign(converted,{ghostOpacity:ghost.opacity,ghostNearFade:ghost.nearFade,ghostTag:ghost.tag,othersAudio:audio.others,ghostAudio:audio.ghosts,separateVertical:raw.verticalSensitivityEnabled,crosshair:crosshair.style!=="none",crosshairStyle:crosshair.style,crosshairColor:crosshair.color,crosshairSize:crosshair.size,crosshairGap:crosshair.gap,crosshairThickness:crosshair.thickness,crosshairAlpha:crosshair.alpha,crosshairOutline:crosshair.outline,
      viewmodel:vm.show,viewmodelFov:vm.fov,viewmodelX:vm.x,viewmodelY:vm.y,viewmodelZ:vm.z,viewmodelLeftHand:vm.hand==="left",viewmodelBob:vm.bob,viewmodelSway:vm.sway,
      hud:!hud.hidden,hudScale:typeof hud.scale==="number"?Math.round(hud.scale*100):undefined,muted:audio.muted,sfxVolume:audio.sfx,musicVolume:audio.music,uiVolume:audio.ui,ambienceVolume:audio.ambience,muteSfx:audioMute.sfx,muteMusic:audioMute.music,muteUi:audioMute.ui,muteAmbience:audioMute.ambience,muteInBackground:audio.muteInBackground,classicSounds:audio.classic,perfectTick:audio.perfectTick,announcer:audio.announcer,footsteps:audio.footsteps,wind:audio.wind,practiceKeepVelocity:practice.keepVelocity,fpsLimit:graphics.fpsLimit});
    delete converted.hudLayout; // web anchors and offsets use a different coordinate contract
  }
  const patch=settingsPatch(converted),supported=new Set(Object.keys(patch));
  const mapped=new Set(["verticalSensitivityEnabled","crosshair","viewmodel","hud","audio","practice","graphics","ghost"]);
  const unsupported=Object.keys(raw).filter(key=>!supported.has(key)&&!(web&&mapped.has(key)));
  if(web){unsupported.push("web HUD anchors/layout", "graphics options other than FPS limit");}
  return {patch,unsupported};
}
export function exportSettings(settings:NativeSettings):string{return JSON.stringify({format:"bunnyhop-native-settings",version:1,settings},null,2)+"\n";}
