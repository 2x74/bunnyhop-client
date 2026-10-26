import {test,expect} from "bun:test";
import {state,settingsPatch} from "./bridge";
import {DEFAULT_ANNOUNCER,announcerPatch} from "./audio-settings";
import {importSettings,exportSettings} from "./settings-transfer";
test("announcer and granular channel settings persist and validate atomically",()=>{
 const next={...state.settings,ambienceVolume:.3,muteAmbience:true,muteSfx:true,muteUi:true,muteMusic:true,muteInBackground:false,classicSounds:true,perfectTick:true,announcer:{...DEFAULT_ANNOUNCER,enabled:true,volume:.7,pb:"holyshit" as const}};
 expect(importSettings(JSON.parse(exportSettings(next))).patch).toMatchObject(next);
 for(const invalid of [{speedThreshold:0},{streakThreshold:2.5},{volume:Infinity},{wr:"file:///tmp/sound.wav"},{evil:true}])expect(announcerPatch(invalid,DEFAULT_ANNOUNCER)).toBeNull();
 expect(settingsPatch({ambienceVolume:2,announcer:{streakThreshold:1}})).toEqual({});
});
test("web audio import maps supported buses, mutes and announcer without losing custom values",()=>{
 const imported=importSettings({crosshair:{style:"cross"},audio:{sfx:.3,ambience:.4,classic:true,perfectTick:true,muteInBackground:false,mute:{sfx:true,ui:true,ambience:true,music:true},announcer:{...DEFAULT_ANNOUNCER,enabled:true,highSpeedThreshold:3200}}});
 expect(imported.patch).toMatchObject({sfxVolume:.3,ambienceVolume:.4,classicSounds:true,perfectTick:true,muteSfx:true,muteUi:true,muteAmbience:true,muteMusic:true,muteInBackground:false,announcer:{enabled:true,highSpeedThreshold:3200}});
});
