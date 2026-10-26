// Match web palette.ts semantic colors without importing gameplay/trigger code.
const palettes={
  redGreen:{"--gain":"#56b4e9","--loss":"#d55e00","--sync-ok":"#f0e442","--behind-soft":"rgba(213, 94, 0, 0.85)","--st-g":"#56b4e9","--st-o":"#f0e442","--st-r":"#d55e00","--zone-start":"#7fb8ff"},
  blueYellow:{"--gain":"#4dff88","--loss":"#ff5d5d","--sync-ok":"#ffd24d","--behind-soft":"rgba(255, 110, 110, 0.72)","--st-g":"#4fd08a","--st-o":"#c879ff","--st-r":"#e0473f","--zone-start":"#33dd66"},
};
export function applySemanticPalette(mode:string,style:Pick<CSSStyleDeclaration,"setProperty"|"removeProperty">=document.documentElement.style):void{
  const palette=mode==="redGreen"||mode==="blueYellow"?palettes[mode]:null;
  for(const key of Object.keys(palettes.redGreen) as Array<keyof typeof palettes.redGreen>)if(palette)style.setProperty(key,palette[key]);else style.removeProperty(key);
}
