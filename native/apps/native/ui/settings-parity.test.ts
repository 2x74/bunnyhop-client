import {test,expect} from "bun:test";
import {settingsMatch,settingsSuggestion} from "./settings-search";
import {dragPosition} from "./hud-editor";
test("settings search matches unordered words, aliases and typo corrections",()=>{
 expect(settingsMatch("Modifier yaw speed second turn speed","speed modifier")).toBe(true);
 expect(settingsMatch("Sensitivity mouse movement","sens")).toBe(true);
 expect(settingsMatch("Jump stats mode","ssj")).toBe(true);
 expect(settingsMatch("Volume audio","mouse")).toBe(false);
 expect(settingsSuggestion("sensitivty",["Sensitivity mouse movement","Volume audio"])).toBe("sensitivity");
 expect(settingsSuggestion("unrelatedxyz",["Sensitivity mouse movement"])).toBeNull();
 expect(settingsSuggestion("speed modifer",["Modifier yaw speed"])).toBe("speed modifier");
});
test("HUD dragging scales deltas to viewport percent, clamps and preserves visibility/scale",()=>{
 const at={x:50,y:20,visible:false,scale:1.5};
 expect(dragPosition(at,100,50,1000,500)).toEqual({x:60,y:30,visible:false,scale:1.5});
 expect(dragPosition(at,-10000,10000,1000,500)).toEqual({x:0,y:100,visible:false,scale:1.5});
 expect(dragPosition(at,1,1,0,0)).toEqual({x:100,y:100,visible:false,scale:1.5});
 expect(at.x).toBe(50);
});

import {parsePresets,presetNameProblem} from "./settings-presets";
test("preset storage discards invalid entries, duplicate names and unsupported settings",()=>{
 expect(parsePresets(null)).toEqual({active:"",list:[]});
 expect(parsePresets({active:"Missing",list:[null,{name:"  ",settings:{sensitivity:2}},{name:"Practice",settings:{sensitivity:2,customCss:"bad",fov:999}},{name:"practice",settings:{sensitivity:3}},{name:"Empty",settings:{customCss:"bad"}}]})).toEqual({active:"",list:[{name:"Practice",settings:{sensitivity:2}}]});
 expect(presetNameProblem(" practice ",["Practice"])).toBe("That name is already in use.");
 expect(presetNameProblem("Practice",["Practice"],"Practice")).toBeNull();
 expect(presetNameProblem("x".repeat(41),[])).toBe("Use 40 characters or fewer.");
});
