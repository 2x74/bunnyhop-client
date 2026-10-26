import {test,expect} from "bun:test";
import {nativeChatDecoration} from "./chat-decoration";
import {NAME_COLORS} from "../../web/src/creators";
test("native decorations map trusted structured marks without coercing objects",()=>{const color=NAME_COLORS[0];expect(nativeChatDecoration({nameColor:color.id,rank:{name:"Legend",color:"#ff00ff"},role:"admin",verified:true,country:"us"})).toEqual({nativeNameColor:color.hex,nativeBadge:"Admin · Verified",nativeRank:"Legend",nativeCountry:"US"});});
test("unknown colors/countries/objects never become host rendering values",()=>{expect(nativeChatDecoration({nameColor:"url(evil)",rank:{name:{}},staff:{},country:"USA",verified:"yes"})).toEqual({});expect(nativeChatDecoration({rank:{name:"a\nb"}}).nativeRank).toBe("ab");});

test("creator badges use the shared platform catalog",()=>{expect(nativeChatDecoration({creator:"youtube"}).nativeBadge).toBe("YouTube creator");expect(nativeChatDecoration({creator:"unknown"})).toEqual({});});
