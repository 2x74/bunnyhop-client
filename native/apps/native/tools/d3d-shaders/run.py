"""Extract, translate and (on Windows) compile every native shader program."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time

from bootstrap import HERE, NATIVE, PIN, TARGET, run, tools
from extract import extract
from reflection import check_interfaces, normalize
from interfaces import check_dxbc, link_locations, match_hlsl, remap

GLSLANG_FLAGS = ["-V", "-R", "--auto-map-bindings", "--auto-map-locations",
                 "--set-default-uniform-block", "NativeUniforms", "0", "0", "-l"]
CROSS_FLAGS = ["--hlsl", "--shader-model", "50", "--fixup-clipspace", "--flip-vert-y"]


def command(arguments, directory, log):
    start = time.perf_counter()
    result = subprocess.run([str(value) for value in arguments], cwd=directory, capture_output=True,
                            text=True, encoding="utf-8", errors="replace")
    log.append(result.stdout + result.stderr)
    if result.returncode:
        raise RuntimeError(f'{Path(arguments[0]).name} exited {result.returncode}: {log[-1][-2000:]}')
    return time.perf_counter() - start, result.stdout


def windows_compiler(output):
    sdk = Path(os.environ.get("ProgramFiles(x86)", r'C:\Program Files (x86)')) / "Windows Kits/10"
    compiler = sdk / "bin" / PIN["windowsSdk"] / "x64/d3dcompiler_47.dll"
    if not compiler.exists():
        raise RuntimeError(f'Install Windows SDK {PIN["windowsSdk"]}: {compiler}')
    digest = hashlib.sha256(compiler.read_bytes()).hexdigest()
    if digest != PIN["d3dCompilerSha256"]:
        raise RuntimeError(f'Pinned D3D compiler hash changed: {digest}')
    executable = output / "compile.exe"
    run(["cl", "/nologo", "/std:c++20", "/EHsc", "/utf-8", "/W4", "/O2", HERE / "compile.cpp",
         f'/I{NATIVE / "apps/native/vendor"}', f'/Fe:{executable}', f'/Fo:{output / "compile.obj"}',
         "/link", "dxguid.lib"])
    return executable, compiler


def compile_program(program, output, translators, compiler):
    name = program["name"]
    directory = output / "programs" / name
    directory.mkdir(parents=True, exist_ok=True)
    result = dict(name=name, family=program["family"], stages={}, status="failed")
    log = []
    try:
        for stage in ("vert", "frag"):
            shutil.copyfile(output / f'{name}.{stage}', directory / f'input.{stage}')
        seconds, _ = command([translators["glslang"], *GLSLANG_FLAGS, "input.vert", "input.frag"], directory, log)
        result["glslangSeconds"] = seconds
        spirv = {}
        reflection = {}
        for stage in ("vert", "frag"):
            _, raw = command([translators["spirv-cross"], f'{stage}.spv', "--reflect"], directory, log)
            spirv[stage] = json.loads(raw)
        locations = link_locations(spirv["vert"], spirv["frag"])
        for stage, direction in (("vert", "outputs"), ("frag", "inputs")):
            remap(directory / f'{stage}.spv', spirv[stage].get(direction, []), locations)
        for stage, profile in (("vert", "vs_5_0"), ("frag", "ps_5_0")):
            _, raw = command([translators["spirv-cross"], f'{stage}.spv', "--reflect"], directory, log)
            spirv[stage] = json.loads(raw)
            seconds, hlsl = command([translators["spirv-cross"], f'{stage}.spv', *CROSS_FLAGS], directory, log)
            if stage == "frag":
                vertex_hlsl = (directory / 'vert.hlsl').read_text(encoding='utf-8')
                hlsl = match_hlsl(vertex_hlsl, hlsl)
            (directory / f'{stage}.hlsl').write_text(hlsl, encoding="utf-8")
            stage_result = dict(crossSeconds=seconds, hlslBytes=len(hlsl.encode()),
                                sourceSha256=hashlib.sha256((directory / f'input.{stage}').read_bytes()).hexdigest())
            dxbc = None
            if compiler:
                command([compiler[0], f'{stage}.hlsl', profile, stage, compiler[1]], directory, log)
                dxbc = json.loads((directory / f'{stage}.dxbc.json').read_text(encoding="utf-8"))
                stage_result.update(fxcSeconds=dxbc["seconds"], dxbcBytes=dxbc["bytes"])
            reflection[stage] = normalize(spirv[stage], hlsl, dxbc)
            result["stages"][stage] = stage_result
        check_interfaces(spirv["vert"], spirv["frag"])
        if compiler:
            check_dxbc(reflection["vert"]["dxbc"], reflection["frag"]["dxbc"])
        (directory / "reflection.json").write_text(json.dumps(reflection, indent=2) + '\n', encoding='utf-8')
        result["status"] = "dxbc" if compiler else "translated"
    except (RuntimeError, ValueError, KeyError, StopIteration) as error:
        result["error"] = str(error)
    (directory / "compile.log").write_text('\n'.join(log), encoding='utf-8')
    print(f'{name}: {result["status"]}', flush=True)
    return result


def compile_presenter(output, compiler):
    name = "existing-dxgi-blit"
    directory = output / "programs" / name
    directory.mkdir(parents=True, exist_ok=True)
    source = (NATIVE / "apps/native/src/low_latency_windows.cpp").read_text(encoding="utf-8")
    shader = re.search(r'constexpr char blit_shader\[\] = R"\(([\s\S]*?)\)";', source)
    if not shader:
        raise ValueError("Register the changed DXGI presenter shader source")
    (directory / "input.hlsl").write_text(shader[1], encoding="utf-8")
    result = dict(name=name, status="hlsl-source", stages={})
    reflection = {}
    log = []
    if compiler:
        try:
            for stage, profile, entry in (("vert", "vs_5_0", "vs_main"), ("frag", "ps_5_0", "ps_main")):
                command([compiler[0], "input.hlsl", profile, stage, compiler[1], entry], directory, log)
                dxbc = json.loads((directory / f'{stage}.dxbc.json').read_text(encoding="utf-8"))
                reflection[stage] = dict(dxbc=dxbc)
                result["stages"][stage] = dict(fxcSeconds=dxbc["seconds"], dxbcBytes=dxbc["bytes"])
            check_dxbc(reflection["vert"]["dxbc"], reflection["frag"]["dxbc"])
            (directory / "reflection.json").write_text(json.dumps(reflection, indent=2) + '\n', encoding='utf-8')
            result["status"] = "dxbc"
        except (RuntimeError, ValueError) as error:
            result.update(status="failed", error=str(error))
    (directory / "compile.log").write_text('\n'.join(log), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--translate-only", action="store_true", help="Skip Windows FXC; this does not prove DXBC")
    parser.add_argument("--jobs", type=int, default=4)
    args = parser.parse_args()
    output = TARGET / "output"
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    translators = tools()
    manifest = extract(output)
    compiler = windows_compiler(output) if os.name == "nt" and not args.translate_only else None
    unique = [program for program in manifest if "alias" not in program]
    start = time.perf_counter()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        results = list(pool.map(lambda program: compile_program(program, output, translators, compiler), unique))
    presenter = compile_presenter(output, compiler)
    by_name = {result["name"]: result for result in results}
    for program in manifest:
        target = program.get("alias", program["name"])
        reflection = output / "programs" / target / "reflection.json"
        if reflection.exists():
            content = json.loads(reflection.read_text(encoding="utf-8"))
            content["program"] = program
            (output / f'{program["name"]}.json').write_text(json.dumps(content, indent=2) + '\n', encoding='utf-8')
        program["status"] = by_name[target]["status"]
    report = dict(toolchain=PIN, glslangFlags=GLSLANG_FLAGS, crossFlags=CROSS_FLAGS,
                  host=os.name, dxbc=bool(compiler), seconds=time.perf_counter() - start,
                  sourceCommit=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=NATIVE, text=True).strip(),
                  cacheEntries=len(manifest), uniquePrograms=len(unique), programs=manifest, results=results,
                  existingHlsl=[presenter])
    if compiler:
        report["compilerSha256"] = hashlib.sha256(compiler[1].read_bytes()).hexdigest()
    (output / "report.json").write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    failed = [result for result in results + [presenter] if result["status"] == "failed"]
    print(f'{sum(result["status"] != "failed" for result in results)}/{len(unique)} GLSL programs; {len(manifest)} cache entries; '
          f'{"DXBC" if compiler else "HLSL only"}; {report["seconds"]:.2f}s')
    print(f'Existing DXGI HLSL presenter: {presenter["status"]}')
    for result in failed:
        print(result["name"], result["error"])
    raise SystemExit(bool(failed))


if __name__ == "__main__":
    main()
