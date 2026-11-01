#include <windows.h>
#include <d3d11shader.h>
#include <d3dcompiler.h>
#include <wrl/client.h>
#include "nlohmann/json.hpp"
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

using nlohmann::json;
using Microsoft::WRL::ComPtr;

json reflect_type(ID3D11ShaderReflectionType *type) {
    D3D11_SHADER_TYPE_DESC desc{};
    if (FAILED(type->GetDesc(&desc))) throw std::runtime_error("Cannot reflect uniform type");
    json result = {{"class", desc.Class}, {"type", desc.Type}, {"rows", desc.Rows}, {"columns", desc.Columns},
                   {"elements", desc.Elements}, {"members", json::array()}};
    for (UINT i = 0; i < desc.Members; ++i) {
        auto *member = type->GetMemberTypeByIndex(i);
        D3D11_SHADER_TYPE_DESC member_desc{};
        member->GetDesc(&member_desc);
        result["members"].push_back({{"name", type->GetMemberTypeName(i)}, {"offset", member_desc.Offset},
                                     {"layout", reflect_type(member)}});
    }
    return result;
}

json signature(ID3D11ShaderReflection *reflection, UINT count, bool input) {
    json result = json::array();
    for (UINT i = 0; i < count; ++i) {
        D3D11_SIGNATURE_PARAMETER_DESC desc{};
        const auto status = input ? reflection->GetInputParameterDesc(i, &desc)
                                  : reflection->GetOutputParameterDesc(i, &desc);
        if (FAILED(status)) throw std::runtime_error("Cannot reflect signature");
        result.push_back({{"semantic", desc.SemanticName}, {"index", desc.SemanticIndex},
                          {"register", desc.Register}, {"mask", desc.Mask}, {"componentType", desc.ComponentType},
                          {"systemValue", desc.SystemValueType}, {"readWriteMask", desc.ReadWriteMask}});
    }
    return result;
}

json reflect(ID3DBlob *bytecode, HMODULE compiler) {
    const auto reflect_shader = reinterpret_cast<decltype(&D3DReflect)>(GetProcAddress(compiler, "D3DReflect"));
    ComPtr<ID3D11ShaderReflection> reflection;
    if (!reflect_shader || FAILED(reflect_shader(bytecode->GetBufferPointer(), bytecode->GetBufferSize(),
                                                IID_ID3D11ShaderReflection, &reflection)))
        throw std::runtime_error("D3DReflect failed");
    D3D11_SHADER_DESC desc{};
    reflection->GetDesc(&desc);
    json result = {{"constantBuffers", json::array()}, {"resources", json::array()},
                   {"inputs", signature(reflection.Get(), desc.InputParameters, true)},
                   {"outputs", signature(reflection.Get(), desc.OutputParameters, false)},
                   {"instructions", desc.InstructionCount}};
    for (UINT i = 0; i < desc.BoundResources; ++i) {
        D3D11_SHADER_INPUT_BIND_DESC resource{};
        reflection->GetResourceBindingDesc(i, &resource);
        result["resources"].push_back({{"name", resource.Name}, {"kind", resource.Type},
                                      {"slot", resource.BindPoint}, {"count", resource.BindCount}});
    }
    for (UINT i = 0; i < desc.ConstantBuffers; ++i) {
        auto *buffer = reflection->GetConstantBufferByIndex(i);
        D3D11_SHADER_BUFFER_DESC buffer_desc{};
        buffer->GetDesc(&buffer_desc);
        json variables = json::array();
        for (UINT j = 0; j < buffer_desc.Variables; ++j) {
            auto *variable = buffer->GetVariableByIndex(j);
            D3D11_SHADER_VARIABLE_DESC variable_desc{};
            variable->GetDesc(&variable_desc);
            variables.push_back({{"hlslName", variable_desc.Name}, {"offset", variable_desc.StartOffset},
                                 {"size", variable_desc.Size}, {"used", bool(variable_desc.uFlags & D3D_SVF_USED)},
                                 {"layout", reflect_type(variable->GetType())}});
        }
        result["constantBuffers"].push_back({{"name", buffer_desc.Name}, {"size", buffer_desc.Size},
                                             {"uniforms", variables}});
    }
    return result;
}

int wmain(int argc, wchar_t **argv) {
    try {
        if (argc != 5 && argc != 6)
            throw std::runtime_error("compile input.hlsl profile output-prefix compiler.dll [entry]");
        const std::filesystem::path input(argv[1]), output(argv[3]);
        const std::wstring wide_profile(argv[2]);
        const std::string profile(wide_profile.begin(), wide_profile.end());
        const std::wstring wide_entry(argc == 6 ? argv[5] : L"main");
        const std::string entry(wide_entry.begin(), wide_entry.end());
        std::ifstream stream(input, std::ios::binary);
        const std::string source{std::istreambuf_iterator<char>(stream), {}};
        if (source.empty()) throw std::runtime_error("HLSL input is empty");
        const auto compiler = LoadLibraryExW(argv[4], nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR
                                                            | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS);
        if (!compiler) throw std::runtime_error("Pinned SDK d3dcompiler_47.dll is absent");
        const auto compile_shader = reinterpret_cast<pD3DCompile>(GetProcAddress(compiler, "D3DCompile"));
        if (!compile_shader) throw std::runtime_error("D3DCompile is absent");
        ComPtr<ID3DBlob> bytecode, errors;
        const auto start = std::chrono::steady_clock::now();
        const UINT flags = D3DCOMPILE_ENABLE_STRICTNESS | D3DCOMPILE_IEEE_STRICTNESS | D3DCOMPILE_OPTIMIZATION_LEVEL3;
        const auto status = compile_shader(source.data(), source.size(), input.string().c_str(), nullptr, nullptr,
                                           entry.c_str(), profile.c_str(), flags, 0, &bytecode, &errors);
        const double seconds = std::chrono::duration<double>(std::chrono::steady_clock::now() - start).count();
        if (errors) std::cerr.write(static_cast<const char *>(errors->GetBufferPointer()), errors->GetBufferSize());
        if (FAILED(status)) throw std::runtime_error("FXC failed");
        auto result = reflect(bytecode.Get(), compiler);
        result["seconds"] = seconds;
        result["bytes"] = bytecode->GetBufferSize();
        result["flags"] = flags;
        std::ofstream(output.string() + ".dxbc", std::ios::binary)
                .write(static_cast<const char *>(bytecode->GetBufferPointer()), bytecode->GetBufferSize());
        std::ofstream(output.string() + ".dxbc.json") << result.dump(2) << '\n';
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
