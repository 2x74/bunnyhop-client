#!/usr/bin/env python3
"""Create the checked-in chart, compact report and compressed samples from matched captures."""
import argparse,datetime,gzip,hashlib,json,pathlib,statistics,subprocess
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
p=argparse.ArgumentParser();p.add_argument('--input',required=True);p.add_argument('--output',required=True);p.add_argument('--hardware-json',required=True);a=p.parse_args()
root=pathlib.Path(a.input).resolve();out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
entries=json.loads((root/'runs.json').read_text());native=pathlib.Path(__file__).resolve().parents[3];repo=native.parent
names=list(dict.fromkeys(e['map'] for e in entries));labels=[{'bhop_lol_aero':'Aero','bhop_xcsource':'XCSource','bh_aztec':'Aztec','bhop_bfur':'BFur'}.get(n,n) for n in names];groups=list(dict.fromkeys((e['map'],e['height']) for e in entries))
summary=[];raw=[]
def percent(v,q):return sorted(v)[min(len(v)-1,int(q*len(v)))]
for e in entries:
 d=json.loads((root/e['file']).read_text());wall=d['wallMs'];cpu=d['submissionMs'];assert len(wall)==len(cpu)==d['frames']
 assert all(x>0 for x in wall) and all(x>=0 for x in cpu)
 spec=json.loads((root/e['file'].replace('.json','-spec.json')).read_text())
 summary.append({**e,'frames':len(wall),'warmup':d['warmup'],'wallMs':{'mean':statistics.mean(wall),'p50':percent(wall,.5),'p95':percent(wall,.95),'p99':percent(wall,.99),'max':max(wall)},'submissionMs':{'mean':statistics.mean(cpu),'p95':percent(cpu,.95)},'eye':spec['eye'],'yaw':spec['yaw'],'pitch':spec['pitch'],'gpu':d['gpu'],'errors':d.get('errors',[]),'missingFiles':d.get('missingFiles',[]),'floorWeapons':d.get('floorWeapons',{'enabled':d.get('settings',{}).get('floorWeapons'),'count':d.get('profileLast',{}).get('floorCount') if d.get('profiling') else None}),'settings':d.get('settings'), 'sync':d.get('sync','readback')})
 raw.append({'run':e['file'],'wallMs':wall,'submissionMs':cpu,'finishMs':d.get('finishMs'),'readbackMs':d.get('readbackMs')})
report={'schema':1,'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hardware':json.loads(pathlib.Path(a.hardware_json).read_text()),'native':{'head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'uncommittedChanges':True,'binarySHA256':hashlib.sha256((native/'apps/native/build/bunnyhop-native-render-benchmark').read_bytes()).hexdigest(),'build':'CMake Release, AppleClang, OpenGL 4.1'},'web':{'build':json.loads((native/'target/perf-web/benchmark-build.json').read_text()),'backend':'Chromium headless, ANGLE Metal'},'method':{'framesPerRun':summary[0]['frames'],'warmupFrames':summary[0]['warmup'],'repetitions':3,'scene':'fixed camera, matching BSP/content bytes, Source FOV90, classic/simple water, floor weapons included, no players/viewmodel/HUD/zones','clock':'visual time increments by 1/60 per frame, simulation does not advance','synchronization':'glFinish + one-pixel RGBA readback after every warmup/measured frame','throughput':'1000 / mean synchronized wall milliseconds','chart':'median of three run throughputs; points and whiskers show all runs/min-max, not confidence intervals','excluded':['simulation','input','network','menu','HUD','browser compositor','window presentation','image encoding','asset loading'],'caveats':['Different GL drivers and material implementations; not pixel-identical','Not displayed gameplay FPS or input latency','Four fixed views on one Mac, not Windows/Linux qualification','No CPU/GPU frequency or background desktop control']},'runs':summary}
report['web']['build'].pop('webRoot',None)
(out/'results.json').write_text(json.dumps(report,indent=2)+'\n')
with gzip.GzipFile(filename=str(out/'samples.json.gz'),mode='wb',mtime=0) as f:f.write(json.dumps(raw,separators=(',',':')).encode())
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10,'axes.spines.top':False,'axes.spines.right':False,'svg.fonttype':'none'})
fig,axes=plt.subplots(2,1,figsize=(11,8),layout='constrained');colors={'native':'#bd6400','web':'#2477a7'}
for ax,key,title,unit in [(axes[0],'fps','Synchronized scene throughput — higher is better','Rendered scene frames / second'),(axes[1],'p95','95th-percentile synchronized frame time — lower is better','Milliseconds')]:
 for e,shift in [('native',-.18),('web',.18)]:
  values=[];lo=[];hi=[]
  for n,h in groups:
   v=[r['fps'] if key=='fps' else r['wallMs']['p95'] for r in summary if r['map']==n and r['height']==h and r['engine']==e];m=statistics.median(v);values.append(m);lo.append(m-min(v));hi.append(max(v)-m)
  xs=[i+shift for i in range(len(groups))];ax.bar(xs,values,.33,label='Native · OpenGL' if e=='native' else 'Web · ANGLE Metal',color=colors[e],alpha=.82,yerr=[lo,hi],capsize=4,error_kw={'elinewidth':1})
  for i,(n,h) in enumerate(groups):
   v=[r['fps'] if key=='fps' else r['wallMs']['p95'] for r in summary if r['map']==n and r['height']==h and r['engine']==e];ax.scatter([xs[i]]*len(v),v,s=13,color='#202020',zorder=4)
   if key=='fps':ax.annotate(f'{values[i]:,.0f}',(xs[i],values[i]),xytext=(0,5),textcoords='offset points',ha='center',fontsize=8)
 ax.set_xticks(range(len(groups)),[labels[names.index(n)]+'\n'+str(h)+'p' for n,h in groups]);ax.set_ylabel(unit);ax.set_title(title,loc='left',fontsize=12,pad=12);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True);ax.set_ylim(bottom=0)
axes[0].set_ylim(top=axes[0].get_ylim()[1]*1.18)
axes[0].legend(loc='upper right',frameon=False)
fig.suptitle('Native vs web · controlled renderer comparison',fontsize=16,x=.06,ha='left')
fig.text(.06,-.035,f"{report['hardware']['chartLabel']} · {summary[0]["frames"]:,} frames/run after {summary[0]["warmup"]} warmup · 3 repetitions\nBars: medians. Dots/whiskers: measured runs/range. World + floor guns, readback benchmark; not displayed gameplay FPS.",fontsize=9,color='#444444')
fig.savefig(out/'native-vs-web.png',dpi=160,bbox_inches='tight',facecolor='white');fig.savefig(out/'native-vs-web.svg',bbox_inches='tight',facecolor='white')
rows=['| Scene | Native frames/s | Web frames/s | Native p95 ms | Web p95 ms |','|---|---:|---:|---:|---:|']
for n,h in groups:
 vals=[]
 for e in ['native','web']:
  g=[r for r in summary if r['map']==n and r['height']==h and r['engine']==e];vals.append((statistics.median([r['fps'] for r in g]),statistics.median([r['wallMs']['p95'] for r in g])) )
 rows.append(f'| {labels[names.index(n)]} {h}p | {vals[0][0]:,.0f} | {vals[1][0]:,.0f} | {vals[0][1]:.3f} | {vals[1][1]:.3f} |')
(out/'table.md').write_text('\n'.join(rows)+'\n');print('\n'.join(rows))
