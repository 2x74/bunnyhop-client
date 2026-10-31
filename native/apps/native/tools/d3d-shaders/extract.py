"""Evaluate shader expressions with C++, including the client's own player_defines()."""
import json
import os
from pathlib import Path
import re
import subprocess

from bootstrap import HERE, NATIVE, run

SOURCE = NATIVE / "apps/native/src"
TOKEN = re.compile(r'R"([^ ()\\\t\r\n]*)\([\s\S]*?\)\1"|"(?:\\.|[^"\\])*"|'
                   r'//[^\n]*|/\*[\s\S]*?\*/|[A-Za-z_]\w*|[^\s]')
DECLARATION = re.compile(r'(?:inline\s+)?(?:static\s+)?(?:constexpr\s+)?const\s+'
                         r'(?:std::string|char\s*\*|auto)\s*(\w+)\s*=')
NAMESPACES = {"render_shaders.hpp": "native_render", "source_hdr.hpp": "native_hdr",
              "enhanced_look.hpp": "native_look"}
NAMES = {
    "video_frames.hpp": ["video"], "native_presentation.hpp": ["presentation"], "hud.hpp": ["hud"],
    "enhanced_look.hpp": ["look-bright", "look-blur", "look-contact", "look-composite", "look-fxaa"],
    "source_hdr.hpp": ["hdr-downsample", "hdr-blur", "hdr-composite", "hdr-luminance", "graphics-target"],
    "ghost_route.hpp": ["ghost-route"],
    "world_pass.hpp": ["world"],
    "sky_pass.hpp": ["sky"],
    "shadow_pass.hpp": ["depth", "cutout-depth"],
    "native_viewmodel.hpp": ["player"],
}


def tokens(source):
    return [match for match in TOKEN.finditer(source) if not match[0].startswith(("//", "/*"))]


def ending(source, start, terminator):
    depth = 0
    for match in tokens(source[start:]):
        token = match[0]
        if token == terminator and depth == 0:
            return start + match.end()
        if token in ("(", "{", "["):
            depth += 1
        elif token in (")", "}", "]"):
            depth -= 1
    raise ValueError(f"Unterminated C++ expression at {start}")


def declarations(source):
    return [(match.start(), match[1], source[match.start():ending(source, match.end(), ";")])
            for match in DECLARATION.finditer(source)]


def shader_source(path):
    return path.suffix in (".hpp", ".cpp") and not path.name.endswith("_smoke.cpp")


def arguments(expression):
    result = []
    start = 0
    depth = 0
    for item in tokens(expression):
        if item[0] == "," and depth == 0:
            result.append(expression[start:item.start()].strip())
            start = item.end()
        elif item[0] in ("(", "{", "["):
            depth += 1
        elif item[0] in (")", "}", "]"):
            depth -= 1
    result.append(expression[start:].strip())
    return result


def calls(source):
    result = []
    items = tokens(source)
    for i, match in enumerate(items):
        if match[0] not in ("link_program", "create_program") or items[i + 1][0] != "(":
            continue
        end = ending(source, items[i + 1].end(), ")")
        expression = source[items[i + 1].end():end - 1]
        if expression.startswith("Gl &"):
            continue
        if match[0] == "create_program":
            if not expression.startswith("{") or not expression.endswith("}"):
                continue
            expression = expression[1:-1]
        parts = arguments(expression)
        if len(parts) != 3:
            raise ValueError(f"Unknown shader creation signature: {expression}")
        if match[0] == "link_program" and parts[1:] == ["source.vertex", "source.fragment"]:
            continue
        site = (match.start(), parts[1:])
        if match[0] == "create_program":
            key = arguments(parts[0][1:-1])
            if len(key) != 2:
                raise ValueError(f"Unknown program key: {parts[0]}")
            site += tuple(json.loads(part) for part in key)
        result.append(site)
    return result


def function(source, name):
    match = re.search(r'inline std::string ' + name + r'\([^)]*\)\s*\{', source)
    if not match:
        raise ValueError(f"Missing C++ function {name}")
    return source[match.start():ending(source, match.end(), "}")]


def player_variants(finishes):
    result = []
    for material in ("solid", "ghost", "gun", "world_gun"):
        details = (False, True) if material == "solid" else (material == "gun",)
        for finish in finishes if material == "solid" else [0]:
            for detail in details:
                for glove in (False,) if material == "world_gun" else (False, True):
                    result.append(dict(material=material, finish=finish, detail=detail, glove=glove))
    return result


def extract(output):
    assets = output / "assets"
    run(["bun", HERE / "generate.ts", assets], cwd=NATIVE)
    finishes = json.loads((assets / "finishes.json").read_text(encoding="utf-8"))
    manifest = []
    cpp = ['#include <string>', '#include <fstream>', '#include <filesystem>',
           '#include "nlohmann/json.hpp"', 'using json = nlohmann::json;']
    for filename, namespace in NAMESPACES.items():
        source = (SOURCE / filename).read_text(encoding="utf-8")
        globals = [code for _, _, code in declarations(source) if code.startswith("inline")]
        if filename == "render_shaders.hpp":
            globals += [function(source, name) for name in ("world_fragment", "sky_fragment")]
        cpp.append(f'namespace {namespace} {{\n' + '\n'.join(globals) + '\n}')
    player = (SOURCE / "player_material.hpp").read_text(encoding="utf-8")
    enum = re.search(r'enum class PlayerMaterial \{[^}]+\};', player)[0]
    cpp += ['namespace native_render {', enum, function(player, "player_defines"), '}']
    cpp += ['std::string read(const char *path) { std::ifstream f(path); return {std::istreambuf_iterator<char>(f), {}}; }',
            'void emit(const std::string &name, const std::string &v, const std::string &f) {',
            'std::ofstream(name + ".vert") << v;', 'std::ofstream(name + ".frag") << f;', '}',
            'int main(int argc, char **argv) {', 'std::filesystem::current_path(argv[1]);']
    discovered = {}
    for path in sorted(SOURCE.glob("*")):
        if not shader_source(path):
            continue
        source = path.read_text(encoding="utf-8")
        sites = calls(source)
        if not sites:
            continue
        if path.name not in NAMES or len(sites) != len(NAMES[path.name]):
            raise ValueError(f"Register new shader sites in NAMES: {path.name}: {len(sites)}")
        discovered[path.name] = len(sites)
        for name, creation in zip(NAMES[path.name], sites):
            position, arguments = creation[:2]
            if len(creation) == 4 and creation[2:] != (name, ""):
                raise ValueError(f"ProgramKey does not match the shader manifest: {creation[2:]}")
            site = f'{path.relative_to(NATIVE).as_posix()}:{source[:position].count(chr(10)) + 1}'
            if name == "player":
                for variant in player_variants(finishes):
                    material, finish, detail, glove = (
                        variant[k] for k in ("material", "finish", "detail", "glove"))
                    key = f'player-{material}-{finish}-g{int(glove)}-d{int(detail)}'
                    v = "player-gun-vertex" if material in ("gun", "world_gun") else "player-vertex"
                    fragments = dict(solid="player-solid", ghost="player-ghost",
                                     gun="player-gun", world_gun="player-gun")
                    f = fragments[material]
                    # The C++ function stays authoritative for the generated defines.
                    cpp.append('{ auto defines = native_render::player_defines('
                               f'{finish}, {str(glove).lower()}, {str(detail).lower()}, '
                               f'native_render::PlayerMaterial::{material});')
                    vertex = f'read("assets/{v}.glsl")'
                    fragment = f'read("assets/{f}.glsl")'
                    cpp.append(f'emit("{key}", defines + {vertex}, defines + {fragment}); }}')
                    manifest.append(dict(name=key, family=f'player-{material}', site=site, variant=variant))
                continue
            cpp.append('{')
            if path.name in NAMESPACES:
                cpp.append(f'using namespace {NAMESPACES[path.name]};')
            local = {}
            for start, variable, code in declarations(source):
                if start < position and variable in ("vertex", "fragment", "vs", "fs"):
                    local[variable] = code
            cpp += list(local.values())
            cpp.append(f'emit("{name}", {arguments[0]}, {arguments[1]}); }}')
            manifest.append(dict(name=name, family=name, site=site))
    if set(discovered) != set(NAMES):
        raise ValueError("A registered shader site disappeared")
    cpp.append('}')
    cpp_path = output / "extract.cpp"
    cpp_path.write_text('\n'.join(cpp) + '\n', encoding='utf-8')
    executable = output / ("extract.exe" if os.name == "nt" else "extract")
    if os.name == "nt":
        run(["cl", "/nologo", "/std:c++20", "/EHsc", "/utf-8", f'/I{NATIVE / "apps/native/vendor"}',
             cpp_path, f'/Fe:{executable}', f'/Fo:{output / "extract.obj"}'])
    else:
        run([os.environ.get("CXX", "c++"), "-std=c++20", "-I", NATIVE / "apps/native/vendor",
             cpp_path, "-o", executable])
    run([executable, output])
    # Cache keys that emit identical sources still get an explicit alias in the manifest.
    unique = {}
    for program in manifest:
        pair = tuple((output / f'{program["name"]}.{stage}').read_bytes() for stage in ("vert", "frag"))
        if pair in unique:
            program["alias"] = unique[pair]
        else:
            unique[pair] = program["name"]
    inventory = dict(sites=discovered, programs=manifest)
    (output / "manifest.json").write_text(json.dumps(inventory, indent=2) + '\n', encoding='utf-8')
    return manifest
