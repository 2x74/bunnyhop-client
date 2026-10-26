# Run from the repository root. Fetches pinned Unicode17 source data; stdlib only.
import urllib.request
base="https://www.unicode.org/Public/17.0.0/ucd/"
for name,path in [("grapheme","auxiliary/GraphemeBreakProperty.txt"),("emoji","emoji/emoji-data.txt"),("derived","DerivedCoreProperties.txt"),("tests","auxiliary/GraphemeBreakTest.txt"),("license","https://www.unicode.org/license.txt")]:
 data=urllib.request.urlopen(path if path.startswith("https:") else base+path).read()
 open("/tmp/bunnyhop-unicode-"+name+".txt","wb").write(data)
import re
from pathlib import Path
out=Path('native/apps/native/src/unicode_grapheme_data.hpp')
props={'Other':0,'CR':1,'LF':2,'Control':3,'Extend':4,'ZWJ':5,'Regional_Indicator':6,'Prepend':7,'SpacingMark':8,'L':9,'V':10,'T':11}
ranges=[]
for raw in Path('/tmp/bunnyhop-unicode-grapheme.txt').read_text().splitlines():
 line=raw.split('#')[0].strip()
 if not line:continue
 a,prop=map(str.strip,line.split(';'))
 if prop not in props:continue
 parts=a.split('..');ranges.append((int(parts[0],16),int(parts[-1],16),props[prop]))
ep=[];incb=[]
for raw in Path('/tmp/bunnyhop-unicode-emoji.txt').read_text().splitlines():
 line=raw.split('#')[0].strip()
 if not line:continue
 a,prop=map(str.strip,line.split(';'))
 if prop!='Extended_Pictographic':continue
 parts=a.split('..');ep.append((int(parts[0],16),int(parts[-1],16),1))
for raw in Path('/tmp/bunnyhop-unicode-derived.txt').read_text().splitlines():
 line=raw.split('#')[0].strip()
 if not line:continue
 parts=[v.strip() for v in line.split(';')]
 if len(parts)<3 or parts[1]!='InCB':continue
 a=parts[0].split('..');incb.append((int(a[0],16),int(a[-1],16),{'Consonant':1,'Extend':2,'Linker':3}[parts[2]]))
def table(name,values):
 values.sort();merged=[]
 for a,b,v in values:
  if merged and merged[-1][1]+1==a and merged[-1][2]==v:merged[-1]=(merged[-1][0],b,v)
  else:merged.append((a,b,v))
 return 'inline constexpr Range '+name+'[]={\n'+''.join(f'{{0x{a:x},0x{b:x},{v}}},\n' for a,b,v in merged)+'};\n'
out.write_text('// Generated from Unicode17.0 UCD GraphemeBreakProperty,emoji-data,DerivedCoreProperties.\n// Unicode data license: ../vendor/unicode/LICENSE.txt. Regenerate using tools/generate-graphemes.py.\n#pragma once\n#include <cstdint>\n#include <cstddef>\nnamespace native::unicode_grapheme {\nstruct Range{uint32_t first,last;unsigned char value;};\n'+table('gcb',ranges)+table('pictographic',ep)+table('conjunct',incb)+'''template<size_t N> inline unsigned lookup(uint32_t cp,const Range(&ranges)[N]){size_t lo=0,hi=N;while(lo<hi){const auto mid=(lo+hi)/2;if(cp<ranges[mid].first)hi=mid;else if(cp>ranges[mid].last)lo=mid+1;else return ranges[mid].value;}return 0;}
inline unsigned property(uint32_t cp){if(cp>=0xac00&&cp<=0xd7a3)return (cp-0xac00)%28?13:12;return lookup(cp,gcb);}
}
''')
Path('native/apps/native/vendor/unicode/LICENSE.txt').write_bytes(Path('/tmp/bunnyhop-unicode-license.txt').read_bytes())
Path('native/apps/native/vendor/unicode/GraphemeBreakTest-17.0.0.txt').write_bytes(Path('/tmp/bunnyhop-unicode-tests.txt').read_bytes())
print('generated',out.stat().st_size)
