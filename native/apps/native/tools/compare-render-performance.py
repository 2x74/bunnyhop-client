#!/usr/bin/env python3
"""Sequential matched renderer captures. Use --probe-dir from locally validated camera captures."""
import argparse, hashlib, json, pathlib, subprocess
import math
import os
import statistics
import sys


def native_pair():
    parser = argparse.ArgumentParser(description="Interleaved native renderer comparison; no web runtime")
    parser.add_argument("--native-pair", action="store_true", required=True)
    parser.add_argument("--baseline", type=pathlib.Path, required=True)
    parser.add_argument("--candidate", type=pathlib.Path, required=True)
    parser.add_argument("--spec", type=pathlib.Path, action="append", required=True)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    parser.add_argument("--runs", type=int, default=7)
    args = parser.parse_args()
    if args.runs < 3:
        parser.error("Use at least three pairs")
    args.output.mkdir(parents=True, exist_ok=False)
    native = pathlib.Path(__file__).resolve().parents[3]
    records = []
    for spec_path in args.spec:
        original = json.loads(spec_path.read_text())
        name = spec_path.stem
        for repeat in range(args.runs):
            order = ("baseline", "candidate") if repeat % 2 == 0 else ("candidate", "baseline")
            for label in order:
                stem = f"{name}-{repeat + 1}-{label}"
                out = (args.output / (stem + ".json")).resolve()
                spec = {**original, "out": str(out)}
                spec_file = args.output / (stem + "-spec.json")
                spec_file.write_text(json.dumps(spec, indent=2) + "\n")
                binary = getattr(args, label).resolve()
                with (args.output / (stem + ".log")).open("w") as log:
                    subprocess.run([str(binary), str(spec_file.resolve())], cwd=native,
                                   env={**os.environ, "SDL_MAC_BACKGROUND_APP": "1"},
                                   stdout=log, stderr=subprocess.STDOUT, check=True)
                result = json.loads(out.read_text())
                if any(result.get(key) for key in ("missingFiles", "missingMaterialCandidates", "errors", "glError")):
                    raise RuntimeError("Invalid measured scene: " + stem)
                records.append({"case": name, "repeat": repeat, "label": label,
                                "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                                "inputSha256": hashlib.sha256(pathlib.Path(spec["path"]).read_bytes()).hexdigest(),
                                "gpu": result["gpu"], "driver": result["driver"],
                                "wallUs": statistics.mean(result["wallMs"]) * 1000,
                                "submissionUs": statistics.mean(result["submissionMs"]) * 1000,
                                "batchUs": result["batchMs"] * 1000 / result["frames"]})
                print(f"{stem}: {records[-1]['wallUs']:.2f} us/frame", flush=True)
    comparisons = []
    for name in dict.fromkeys(record["case"] for record in records):
        for metric in ("wallUs", "submissionUs", "batchUs"):
            baseline = [r[metric] for r in records if r["case"] == name and r["label"] == "baseline"]
            candidate = [r[metric] for r in records if r["case"] == name and r["label"] == "candidate"]
            deltas = [after - before for before, after in zip(baseline, candidate)]
            # A conservative 95% Student interval (df >= 2); report uncertainty instead of rounding it away.
            critical = {3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306}.get(args.runs, 2.262)
            margin = critical * statistics.stdev(deltas) / math.sqrt(len(deltas))
            delta = statistics.mean(deltas)
            comparisons.append({"case": name, "metric": metric, "baseline": statistics.mean(baseline),
                                "candidate": statistics.mean(candidate), "delta": delta,
                                "delta95": [delta - margin, delta + margin], "pairedDeltas": deltas})
    report = {"schema": 1, "records": records, "comparisons": comparisons}
    (args.output / "comparison.json").write_text(json.dumps(report, indent=2) + "\n")
    for comparison in comparisons:
        print(json.dumps(comparison), flush=True)


if "--native-pair" in sys.argv:
    native_pair()
    sys.exit(0)

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
