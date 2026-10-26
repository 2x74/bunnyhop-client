#!/usr/bin/env python3
"""Sequential matched renderer captures. Use --probe-dir from locally validated camera captures."""
import argparse, hashlib, json, pathlib, subprocess
p=argparse.ArgumentParser();p.add_argument('--probe-dir',required=True);p.add_argument('--web-root',required=True);p.add_argument('--runs',type=int,default=3);p.add_argument('--frames',type=int,default=5000);p.add_argument('--warmup',type=int,default=500)
p.add_argument("--maps",default="bhop_lol_aero,bhop_xcsource,bh_aztec");p.add_argument("--resolutions",default="720,1080");
a=p.parse_args();native=pathlib.Path(__file__).resolve().parents[3];root=pathlib.Path(a.probe_dir).resolve();records=[]
for repeat in range(a.runs):
 for name in a.maps.split(','):
  original=json.loads((root/(name+'-probe-spec.json')).read_text());camera=json.loads((root/(name+'-probe.json')).read_text())
  for h in map(int,a.resolutions.split(',')):
   w=round(h*16/9)
   for engine in (['native','web'] if repeat%2==0 else ['web','native']):
    stem=f'{name}-{h}p-r{repeat+1}-{engine}';out=root/(stem+'.json');spec={**original,'eye':camera['eye'],'yaw':camera['yaw'],'pitch':camera['pitch'],'width':w,'height':h,'frames':a.frames,'warmup':a.warmup,'out':str(out),'profile':False,'sourceLook':False,'floorWeapons':True,'sync':'readback'}
    specfile=root/(stem+'-spec.json');specfile.write_text(json.dumps(spec,indent=2)+'\n')
    cmd=[str(native/'apps/native/build/bunnyhop-native-render-benchmark'),str(specfile)] if engine=='native' else ['bun',str(native/'apps/native/tools/web-render-benchmark.ts'),'--run','--web-root',a.web_root,'--spec',str(specfile)]
    with (root/(stem+'.log')).open('w') as log:subprocess.run(cmd,cwd=native,stdout=log,stderr=subprocess.STDOUT,check=True)
    result=json.loads(out.read_text());samples=result['wallMs'];fps=1000*len(samples)/sum(samples)
    if result.get('missingFiles') or result.get('missingMaterialCandidates') or result.get('errors') or result.get('glError'):raise RuntimeError('Incomplete/invalid measured scene: '+stem)
    records.append({'engine':engine,'map':name,'height':h,'repeat':repeat+1,'file':out.name,'fps':fps,'sha256':hashlib.sha256(pathlib.Path(spec['path']).read_bytes()).hexdigest()})
    print(f'{stem}: {fps:.1f} synchronized scene frames/s',flush=True)
(root/'runs.json').write_text(json.dumps(records,indent=2)+'\n')
