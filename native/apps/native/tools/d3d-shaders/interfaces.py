"""Give linked varyings shared locations; glslang --aml maps each stage separately."""
import struct


def link_locations(vertex, fragment):
    outputs = {item["name"]: item for item in vertex.get("outputs", [])}
    for field in fragment.get("inputs", []):
        source = outputs.get(field["name"])
        if not source or source["type"] != field["type"] or source.get("array") != field.get("array"):
            raise ValueError(f'Unlinked GLSL varying: {field}')
    if any("array" in field or field["type"].startswith("mat") for field in outputs.values()):
        raise ValueError("Register location spans for new array/matrix varyings")
    return {name: index for index, name in enumerate(sorted(outputs))}


def remap(path, fields, locations):
    data = path.read_bytes()
    words = list(struct.unpack(f'<{len(data) // 4}I', data))
    if words[0] != 0x07230203:
        raise ValueError("Expected little-endian SPIR-V")
    names = {}
    instructions = []
    cursor = 5
    while cursor < len(words):
        count, opcode = words[cursor] >> 16, words[cursor] & 0xffff
        if not count or cursor + count > len(words):
            raise ValueError("Invalid SPIR-V instruction")
        instructions.append((cursor, count, opcode))
        if opcode == 5:  # OpName
            raw = struct.pack(f'<{count - 2}I', *words[cursor + 2:cursor + count])
            names[words[cursor + 1]] = raw.split(b'\0', 1)[0].decode()
        cursor += count
    wanted = {field["name"] for field in fields}
    changed = set()
    for cursor, count, opcode in instructions:
        if opcode == 71 and count == 4 and words[cursor + 2] == 30:  # OpDecorate Location
            name = names.get(words[cursor + 1])
            if name in wanted:
                words[cursor + 3] = locations[name]
                changed.add(name)
    if changed != wanted:
        raise ValueError(f'Cannot map interface locations: {wanted - changed}')
    path.write_bytes(struct.pack(f'<{len(words)}I', *words))


def match_hlsl(vertex, fragment):
    import re

    def fields(source, name):
        pattern = r'(struct ' + name + r'\s*\{)([\s\S]*?)(\};)'
        return re.search(pattern, source)

    output = fields(vertex, 'SPIRV_Cross_Output')
    input = fields(fragment, 'SPIRV_Cross_Input')
    if not input:
        return fragment
    if not output:
        raise ValueError('Fragment inputs without a vertex output interface')

    def declarations(block):
        result = {}
        for line in block[2].splitlines():
            if not line.strip():
                continue
            field = re.fullmatch(r'\s*(.*?)\s+(\w+)\s*:\s*(\w+)\s*;\s*', line)
            if not field:
                raise ValueError(f'Unknown HLSL interface field: {line}')
            result[field[3].upper()] = (field[1], field[2], line)
        return result

    incoming = declarations(input)
    lines = []
    for semantic, (type, name, line) in declarations(output).items():
        field = incoming.pop(semantic, None)
        if field and field[0] != type:
            raise ValueError(f'HLSL interface type mismatch: {semantic}')
        lines.append(field[2] if field else line)
    lines += [field[2] for field in incoming.values()]
    # Unread VS outputs still occupy registers. Keeping their declarations in the PS
    # input makes FXC pack both signatures identically, including the ghost subset.
    return fragment[:input.start(2)] + '\n' + '\n'.join(lines) + '\n' + fragment[input.end(2):]


def check_dxbc(vertex, fragment):
    outputs = {(field['semantic'].upper(), field['index']): field for field in vertex['outputs']}
    for field in fragment['inputs']:
        semantic = field['semantic'].upper()
        if semantic == 'SV_ISFRONTFACE':
            continue
        source = outputs.get((semantic, field['index']))
        if not source or any(source[key] != field[key] for key in ('register', 'mask', 'componentType')):
            raise ValueError(f'DXBC interface mismatch: {field}')
