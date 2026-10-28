import type { Prefs } from '../ui/settings';
/** Applied only on an explicit preset selection; existing persisted custom settings are never migrated. */
export function cinematicSettings(current:Prefs['graphics']):Prefs['graphics'] {
 return {...current,preset:'cinematic',potato:false,bloom:true,mapProfiles:true,ambienceShowcase:true,lightingProfile:'auto',skyMode:'pack',skyPackId:'cloudy-day',skyRotation:0,skyExposure:0,lightingSource:'map',directContribution:1,ambientContribution:1,clouds:false,materialResponse:true,spatialAA:true,contactShading:true,atmosphere:true,volumetric:false,sunShafts:false,dynamicShadows:true,shadowQuality:'high',shadowDistance:1024,shadowStrength:.22,localLights:true,localQuality:'medium',localBudget:2,localStrength:.2,tracedGI:true,dynamicGI:false,giQuality:'low',giStrength:.25,giRange:256};
}
