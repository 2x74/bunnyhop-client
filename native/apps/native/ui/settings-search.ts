/** Token search also accepts words in a different order and familiar aliases. */
const aliases: Record<string,string> = { sens:"sensitivity", sound:"audio volume", fps:"fps frame", jhud:"jump stats", ssj:"jump stats", keyboard:"keys bind", weapon:"viewmodel weapon", drag:"hud layout position" };
export const searchWords=(value:string):string[]=>value.toLowerCase().match(/[a-z0-9]+/g)??[];
export function settingsMatch(text:string,query:string):boolean {
 const source=text.toLowerCase();return searchWords(query).every(word=>source.includes(word)||(aliases[word]??"").split(" ").filter(Boolean).some(alias=>source.includes(alias)));
}
function distance(a:string,b:string):number {let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}return row[b.length];}
export function settingsSuggestion(query:string,texts:string[]):string|null {
 const words=[...new Set(texts.flatMap(searchWords))];let changed=false;
 const corrected=searchWords(query).map(word=>{if(words.includes(word)||aliases[word])return word;let best=word,score=word.length>5?2:1;for(const candidate of words){const d=distance(word,candidate);if(d<=score&&candidate.length>2){best=candidate;score=d;}}changed ||= best!==word;return best;}).join(" ");
 return changed&&texts.some(text=>settingsMatch(text,corrected))?corrected:null;
}
