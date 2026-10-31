"""Embed deduplicated ahead-of-time DXBC and reflection in the executable's RCDATA."""
import argparse
import hashlib
import json
import re
import struct
import subprocess
import sys
from pathlib import Path

from bootstrap import NATIVE, TARGET, tools
from run import compile_program, windows_compiler


def smoke_programs(output, translators, compiler):
    source = (NATIVE / 'apps/native/src/gfx_smoke.cpp').read_text(encoding='utf-8')
    for name, prefix in [('gfx-smoke', ''), ('gfx-cube', 'cube_')]:
        for stage, variable in [('vert', 'vertex'), ('frag', 'fragment')]:
            match = re.search(r'const char \*' + prefix + variable + r' = R"\(([\s\S]*?)\)";', source)
            if not match:
                raise ValueError(f'Missing smoke shader {prefix}{variable}')
            (output / f'{name}.{stage}').write_text(match[1], encoding='utf-8')
        result = compile_program(dict(name=name, family=name), output, translators, compiler)
        if result['status'] != 'dxbc':
            raise ValueError(result)
    for name in ('depth-resolve', 'depth-pattern', 'copy'):
        source = Path(__file__).with_name(name + '.hlsl')
        directory = output / ('programs/internal-' + name)
        directory.mkdir(parents=True, exist_ok=True)
        reflection = {}
        for stage, profile, entry in [('vert', 'vs_5_0', 'vs_main'), ('frag', 'ps_5_0', 'ps_main')]:
            subprocess.run([str(compiler[0]), str(source), profile, str(directory / stage), str(compiler[1]), entry],
                           check=True)
            dxbc = json.loads((directory / f'{stage}.dxbc.json').read_text(encoding='utf-8'))
            reflection[stage] = dict(dxbc=dxbc, constantBuffers=[], textures=[])
        (directory / 'reflection.json').write_text(json.dumps(reflection), encoding='utf-8')


def package(output, destination):
    manifest = json.loads((output / 'manifest.json').read_text(encoding='utf-8'))['programs']
    index, content, unique = {}, bytearray(), {}

    def append(data):
        digest = hashlib.sha256(data).hexdigest()
        if digest not in unique:
            unique[digest] = [len(content), len(data)]
            content.extend(data)
        return unique[digest]

    extras = ['internal-depth-resolve', 'internal-depth-pattern', 'internal-copy', 'gfx-smoke', 'gfx-cube']
    for program in manifest + [dict(name=name, family=name) for name in extras]:
        name = program['name']
        directory = output / 'programs' / program.get('alias', name)
        reflection = json.loads((directory / 'reflection.json').read_text(encoding='utf-8'))
        for stage in ('vert', 'frag'):
            if 'dxbc' not in reflection[stage]:
                raise ValueError(f'{name}: Windows DXBC reflection is required')
        entry = {stage: append((directory / f'{stage}.dxbc').read_bytes()) for stage in ('vert', 'frag')}
        entry['reflection'] = append(json.dumps(reflection, separators=(',', ':')).encode())
        family = program['family']
        permutation = name[len(family) + 1:] if name.startswith(family + '-') else ''
        index[f'{family}:{permutation}'] = entry
        index[f'{name}:'] = entry
    header = json.dumps(index, separators=(',', ':')).encode()
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / 'd3d11-shaders.bin'
    archive.write_bytes(struct.pack('<I', len(header)) + header + content)
    (destination / 'd3d11-shaders.rc').write_text('201 RCDATA "' + archive.as_posix() + '"\n', encoding='utf-8')
    print(f'Embedded {len(index)} keys; {len(content):,} deduplicated shader/reflection bytes')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.build:
        subprocess.run([sys.executable, str(Path(__file__).with_name('run.py')), '--jobs', '4'], check=True)
    output = TARGET / 'output'
    smoke_programs(output, tools(), windows_compiler(output))
    package(output, args.output.resolve())


if __name__ == '__main__':
    main()
