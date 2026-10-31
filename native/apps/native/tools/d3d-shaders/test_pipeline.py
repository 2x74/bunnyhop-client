import struct
import tempfile
from pathlib import Path
import unittest

from extract import NAMES, SOURCE, calls, function, player_variants
from interfaces import check_dxbc, link_locations, match_hlsl, remap
from reflection import check_interfaces, normalize, type_size


class ShaderPipelineTests(unittest.TestCase):
    def test_cpp_literals_do_not_create_shader_sites(self):
        source = '''// link_program(gl, bad, bad);
        const char *s = R"tag(link_program(gl, fake, fake); { })tag";
        link_program(gl, std::string("v,") + R"(vert)", R"(frag)");'''
        found = calls(source)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0][1], ['std::string("v,") + R"(vert)"', 'R"(frag)"'])
        self.assertIn('return "}";', function('inline std::string shader() { return "}"; }', 'shader'))

    def test_every_creation_site_is_registered(self):
        found = {}
        for path in SOURCE.iterdir():
            if path.suffix in ('.hpp', '.cpp'):
                count = len(calls(path.read_text(encoding="utf-8")))
                if count:
                    found[path.name] = count
        self.assertEqual(found, {name: len(sites) for name, sites in NAMES.items()})
        shader_creation = sum(
            path.read_text(encoding="utf-8").count('gl.CreateShader(') for path in SOURCE.glob('*.hpp'))
        self.assertEqual(shader_creation, 1)

    def test_reachable_player_cache_keys(self):
        variants = player_variants(range(28))
        self.assertEqual(len(variants), 117)
        self.assertEqual(sum(v['material'] == 'solid' for v in variants), 112)
        self.assertTrue(all(not v['finish'] for v in variants if v['material'] != 'solid'))
        self.assertTrue(all(v['detail'] for v in variants if v['material'] == 'gun'))
        self.assertEqual([v for v in variants if v['material'] == 'world_gun'],
                         [dict(material='world_gun', finish=0, detail=False, glove=False)])

    def test_stage_locations_are_linked_by_name(self):
        vertex = dict(outputs=[dict(name='uv', type='vec2', location=0), dict(name='normal', type='vec3', location=1)])
        fragment = dict(inputs=[dict(name='uv', type='vec2', location=1)])
        with self.assertRaises(ValueError):
            check_interfaces(vertex, fragment)
        locations = link_locations(vertex, fragment)
        self.assertEqual(locations, dict(normal=0, uv=1))
        fragment['inputs'][0]['type'] = 'vec3'
        with self.assertRaises(ValueError):
            link_locations(vertex, fragment)

    def test_spirv_remap_preserves_other_decorations(self):
        words = [0x07230203, 0x10000, 0, 3, 0,
                 (4 << 16) | 5, 1, *struct.unpack('<2I', b'uv\0\0\0\0\0\0'),
                 (4 << 16) | 71, 1, 30, 7,
                 (3 << 16) | 71, 1, 14]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'test.spv'
            path.write_bytes(struct.pack(f'<{len(words)}I', *words))
            remap(path, [dict(name='uv')], dict(uv=2))
            actual = list(struct.unpack(f'<{len(words)}I', path.read_bytes()))
        expected = list(words)
        expected[12] = 2
        self.assertEqual(actual, expected)

    def test_ghost_subset_keeps_identical_hlsl_register_packing(self):
        vertex = """struct SPIRV_Cross_Output {
    float2 aura : TEXCOORD0;
    float3 color : TEXCOORD1;
    float4 gl_Position : SV_Position;
};"""
        fragment = """struct SPIRV_Cross_Input {
    float3 color : TEXCOORD1;
    float4 gl_FragCoord : SV_Position;
    bool facing : SV_IsFrontFace;
};"""
        fixed = match_hlsl(vertex, fragment)
        self.assertLess(fixed.index('aura :'), fixed.index('color :'))
        self.assertLess(fixed.index('color :'), fixed.index('gl_FragCoord :'))
        self.assertIn('bool facing : SV_IsFrontFace;', fixed)
        field = dict(semantic='TEXCOORD', index=1, register=0, mask=7, componentType=3)
        check_dxbc(dict(outputs=[field]), dict(inputs=[dict(field)]))
        shifted = dict(field, register=1)
        with self.assertRaises(ValueError):
            check_dxbc(dict(outputs=[field]), dict(inputs=[shifted]))

    def test_std140_arrays_and_structs(self):
        self.assertEqual(type_size(dict(type='vec3', array=[8], array_stride=16), {}), 128)
        self.assertEqual(type_size(dict(type='mat4', matrix_stride=16), {}), 64)
        types = dict(S=dict(members=[dict(name='on', type='uint', offset=0),
                                     dict(name='color', type='vec3', offset=16)]))
        self.assertEqual(type_size(dict(type='S'), types), 28)

    def test_dxbc_offsets_cannot_silently_drift(self):
        spirv = dict(entryPoints=[dict(mode='vert')], types=dict(B=dict(members=[
            dict(name='enabled', type='uint', offset=0)])),
            ubos=[dict(name='NativeUniforms', type='B', binding=0, block_size=4)])
        hlsl = 'uint _17_enabled : packoffset(c0);'
        dxbc = dict(constantBuffers=[dict(name='NativeUniforms', size=16, uniforms=[
            dict(hlslName='_17_enabled', offset=0, size=4)])], resources=[])
        result = normalize(spirv, hlsl, dxbc)
        self.assertEqual(result['dxbc']['constantBuffers'][0]['uniforms'][0]['name'], 'enabled')
        dxbc['constantBuffers'][0]['uniforms'][0]['offset'] = 4
        with self.assertRaises(ValueError):
            normalize(spirv, hlsl, dxbc)


if __name__ == '__main__':
    unittest.main()
