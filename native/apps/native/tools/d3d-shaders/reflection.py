"""Keep GLSL uniform names alongside the actual HLSL/DXBC binding layout."""
import re


def type_size(member, types):
    if "array" in member:
        return member["array_stride"] * member["array"][-1]
    name = member["type"]
    if name in types:
        fields = types[name]["members"]
        return max((field["offset"] + type_size(field, types) for field in fields), default=0)
    if name.startswith("mat"):
        return member["matrix_stride"] * int(name[3])
    vector = re.fullmatch(r'[biud]?vec([234])', name)
    return 4 * int(vector[1]) if vector else 4


def normalize(spirv, hlsl, dxbc=None):
    result = dict(constantBuffers=[], textures=[], vertexInputs=[])
    for buffer in spirv.get("ubos", []):
        fields = []
        for member in spirv["types"][buffer["type"]]["members"]:
            field = dict(member)
            field["size"] = type_size(member, spirv["types"])
            field["hlslName"] = None
            pattern = r'\b(\w*' + re.escape(member["name"]) + r')\s*(?:\[[^]]+\])?\s*:\s*packoffset'
            found = re.search(pattern, hlsl)
            if found:
                field["hlslName"] = found[1]
            fields.append(field)
        result["constantBuffers"].append(dict(name=buffer["name"], slot=buffer["binding"],
                                              size=(buffer["block_size"] + 15) // 16 * 16, uniforms=fields))
    for texture in spirv.get("textures", []):
        name = re.escape(texture["name"])
        resource = re.search(r'\b(' + name + r')\s*:\s*register\(t(\d+)\)', hlsl)
        sampler = re.search(r'\b(\w*' + name + r'_sampler)\s*:\s*register\(s(\d+)\)', hlsl)
        result["textures"].append(dict(name=texture["name"], type=texture["type"],
                                       textureSlot=int(resource[2]) if resource else None,
                                       samplerSlot=int(sampler[2]) if sampler else None,
                                       samplerName=sampler[1] if sampler else None))
    if spirv["entryPoints"][0]["mode"] == "vert":
        for field in spirv.get("inputs", []):
            result["vertexInputs"].append(dict(field, semantic="TEXCOORD", semanticIndex=field["location"]))
    # Preserve nested structs, array strides, and all stage interfaces for backend consumers.
    result["spirv"] = spirv
    if dxbc is not None:
        result["dxbc"] = dxbc
        for buffer in dxbc["constantBuffers"]:
            expected = next(item for item in result["constantBuffers"] if item["name"] == buffer["name"])
            if expected["size"] != buffer["size"]:
                raise ValueError(f'Cbuffer size mismatch: {buffer["name"]}')
            for variable in buffer["uniforms"]:
                field = next(item for item in expected["uniforms"] if item["hlslName"] == variable["hlslName"])
                if variable["offset"] != field["offset"] or variable["size"] > field["size"]:
                    raise ValueError(f'Uniform layout mismatch: {field["name"]}')
                variable["name"] = field["name"]
        resources = {item["name"]: item for item in dxbc["resources"]}
        for texture in result["textures"]:
            for name, slot in ((texture["name"], texture["textureSlot"]),
                               (texture["samplerName"], texture["samplerSlot"])):
                if name in resources and resources[name]["slot"] != slot:
                    raise ValueError(f'Resource binding mismatch: {name}')
    return result


def check_interfaces(vertex, fragment):
    outputs = {item["location"]: item for item in vertex.get("outputs", [])}
    for field in fragment.get("inputs", []):
        source = outputs.get(field["location"])
        if not source or (source["name"], source["type"]) != (field["name"], field["type"]):
            raise ValueError(f'Unlinked varying: {field}')
