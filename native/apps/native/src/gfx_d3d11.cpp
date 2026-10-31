#include "gfx_d3d11.hpp"
#include <algorithm>
#include <chrono>
#include <cstring>
#include <stdexcept>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <d3d11.h>
#include <d3d11sdklayers.h>
#include <wrl/client.h>
#ifdef near
#undef near
#endif
#ifdef far
#undef far
#endif
#include "../vendor/nlohmann/json.hpp"

namespace native::gfx {
namespace {
using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;

void checked(HRESULT result, const char *message) {
    if (FAILED(result)) throw std::runtime_error(std::string(message) + " (" + std::to_string(result) + ")");
}

template <typename T>
T *native(uintptr_t value) {
    return reinterpret_cast<T *>(value);
}

template <typename T>
uintptr_t handle(T *value) {
    return reinterpret_cast<uintptr_t>(value);
}

template <typename T>
void release(uintptr_t value) {
    const std::unique_ptr<T> owner(native<T>(value));
}

struct PixelFormat {
    DXGI_FORMAT texture, view, depth;
    size_t bytes;
};

PixelFormat pixel_format(Format format) {
    switch (format) {
        case Format::rgba8:
            return {DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_R8G8B8A8_UNORM, DXGI_FORMAT_UNKNOWN, 4};
        case Format::rgba16f:
            return {DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_R16G16B16A16_FLOAT, DXGI_FORMAT_UNKNOWN, 8};
        case Format::rgba32f:
            return {DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_FORMAT_R32G32B32A32_FLOAT, DXGI_FORMAT_UNKNOWN, 16};
        case Format::r32f:
            return {DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_UNKNOWN, 4};
        case Format::depth32f:
            return {DXGI_FORMAT_R32_TYPELESS, DXGI_FORMAT_R32_FLOAT, DXGI_FORMAT_D32_FLOAT, 4};
        case Format::depth24:
        case Format::depth24_stencil8:
            return {DXGI_FORMAT_R24G8_TYPELESS, DXGI_FORMAT_R24_UNORM_X8_TYPELESS, DXGI_FORMAT_D24_UNORM_S8_UINT, 4};
        default:
            throw std::runtime_error("Missing D3D11 texture format");
    }
}

D3D11_COMPARISON_FUNC comparison(Compare value) {
    if (value == Compare::less) return D3D11_COMPARISON_LESS;
    return value == Compare::less_equal ? D3D11_COMPARISON_LESS_EQUAL : D3D11_COMPARISON_ALWAYS;
}

D3D11_BLEND factor(BlendFactor value) {
    if (value == BlendFactor::zero) return D3D11_BLEND_ZERO;
    if (value == BlendFactor::source_alpha) return D3D11_BLEND_SRC_ALPHA;
    return value == BlendFactor::one ? D3D11_BLEND_ONE : D3D11_BLEND_INV_SRC_ALPHA;
}

D3D11_PRIMITIVE_TOPOLOGY primitive(Primitive value) {
    if (value == Primitive::lines) return D3D11_PRIMITIVE_TOPOLOGY_LINELIST;
    return value == Primitive::triangles ? D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST
                                         : D3D11_PRIMITIVE_TOPOLOGY_TRIANGLESTRIP;
}

struct TextureData {
    ComPtr<ID3D11Texture2D> texture;
    ComPtr<ID3D11ShaderResourceView> srv;
    ComPtr<ID3D11RenderTargetView> rtv;
    ComPtr<ID3D11DepthStencilView> dsv;
};

struct SamplerData {
    ComPtr<ID3D11SamplerState> state;
};

struct TargetData {
    TextureData *color = nullptr, *depth = nullptr;
};

struct QueryData {
    ComPtr<ID3D11Query> query;
};

struct PipelineData {
    ComPtr<ID3D11BlendState> blend[2];
    ComPtr<ID3D11DepthStencilState> depth[4];
    ComPtr<ID3D11RasterizerState> raster;
};

struct ConstantBuffer {
    unsigned stage = 0, slot = 0;
    ComPtr<ID3D11Buffer> buffer;
    std::vector<std::byte> bytes;
    bool dirty = true;
};

struct Uniform {
    ConstantBuffer *buffer;
    uint32_t offset, size, stride;
};

struct TextureSlots {
    unsigned stage;
    int texture = -1, sampler = -1;
};

struct ConstantCopy {
    ConstantBuffer *buffer;
    uint32_t source, destination, bytes;
    bool boolean;
};

struct ConstantsData {
    std::vector<ConstantCopy> copies;
};

struct ProgramData {
    ComPtr<ID3D11VertexShader> vertex;
    ComPtr<ID3D11PixelShader> pixel;
    std::span<const std::byte> vertex_bytes;
    Json reflection;
    std::vector<std::unique_ptr<ConstantBuffer>> buffers;
    std::unordered_map<std::string, std::vector<Uniform>> uniforms;
    std::unordered_map<std::string, std::vector<TextureSlots>> textures;
    std::array<std::vector<TextureSlots>, 32> units;
    std::vector<std::unique_ptr<ConstantsData>> constants;
};

struct GeometryData {
    UINT stride = 0, offset = 0, cursor = 0;
    static constexpr UINT capacity = 4 * 1024 * 1024;
    std::vector<VertexAttribute> attributes;
    std::unordered_map<ProgramData *, ComPtr<ID3D11InputLayout>> layouts;
    ComPtr<ID3D11Buffer> vertices, indices;
};

struct ReadbackData {
    QueryData completion;
    ComPtr<ID3D11Texture2D> staging, depth24;
    ID3D11Texture2D *active = nullptr;
    std::vector<float> converted;
    bool convert_depth24 = false, pack_stencil = false;
};

struct Asset {
    std::span<const std::byte> vertex, pixel;
    std::string_view reflection;
};

uint32_t constant_size(ConstantType type) {
    if (type == ConstantType::matrix4) return 64;
    if (type == ConstantType::float4) return 16;
    if (type == ConstantType::float3) return 12;
    return type == ConstantType::float2 ? 8 : 4;
}
}  // namespace

struct D3D11Context::Impl {
    ID3D11Device *device;
    ID3D11DeviceContext *context;
    ComPtr<ID3D11Device> owned_device;
    ComPtr<ID3D11DeviceContext> owned_context;
    std::span<const std::byte> archive;
    Json index;
    std::vector<ProgramData *> programs;
    std::vector<GeometryData *> geometries;
    ProgramData *program = nullptr;
    GeometryData *geometry = nullptr;
    PipelineData *current_pipeline = nullptr;
    PipelineState state;
    ID3D11BlendState *bound_blend = nullptr;
    ID3D11DepthStencilState *bound_depth = nullptr;
    ID3D11RasterizerState *bound_raster = nullptr;
    std::array<std::array<ID3D11Buffer *, 14>, 2> bound_buffers{};
    std::array<std::array<ID3D11ShaderResourceView *, 128>, 2> bound_srvs{};
    std::array<std::array<ID3D11SamplerState *, 16>, 2> bound_samplers{};

    struct Unit {
        TextureData *texture = nullptr;
        SamplerData *sampler = nullptr;
    };

    std::array<Unit, 32> units{};
    ID3D11RenderTargetView *rtv = nullptr;
    ID3D11DepthStencilView *dsv = nullptr;
    ComPtr<ID3D11Resource> color_resource, depth_resource;
    std::unique_ptr<ProgramData> depth_resolve;
    std::unique_ptr<PipelineData> depth_pipeline;
    std::unique_ptr<ProgramData> copy_program;
    std::unique_ptr<PipelineData> copy_pipeline;
    ComPtr<ID3D11Buffer> copy_constants;

    Impl(D3D11Device borrowed)
        : device(static_cast<ID3D11Device *>(borrowed.device))
        , context(static_cast<ID3D11DeviceContext *>(borrowed.immediate_context)) {
        if (!device || !context) throw std::runtime_error("D3D11 requires the presenter's device and context");
        if (context->GetType() != D3D11_DEVICE_CONTEXT_IMMEDIATE)
            throw std::runtime_error("D3D11 requires the immediate context");
        ComPtr<ID3D11Device> context_device;
        context->GetDevice(&context_device);
        if (context_device.Get() != device) throw std::runtime_error("D3D11 device/context mismatch");
        const auto module = GetModuleHandleW(nullptr);
        const auto resource = FindResourceW(module, MAKEINTRESOURCEW(201), MAKEINTRESOURCEW(10));
        if (!resource) throw std::runtime_error("Embedded D3D11 shader archive is missing");
        const auto bytes = static_cast<const std::byte *>(LockResource(LoadResource(module, resource)));
        const size_t size = SizeofResource(module, resource);
        if (!bytes || size < 4) throw std::runtime_error("Invalid D3D11 shader archive");
        uint32_t header_size;
        std::memcpy(&header_size, bytes, 4);
        if (header_size > size - 4) throw std::runtime_error("Invalid D3D11 shader archive index");
        index = Json::parse(bytes + 4, bytes + 4 + header_size);
        archive = {bytes + 4 + header_size, size - 4 - header_size};
    }

    Asset asset(ProgramKey key) {
        const std::string name = std::string(key.program) + ":" + std::string(key.permutation);
        if (!index.contains(name)) throw std::runtime_error("Missing precompiled D3D11 program: " + name);
        const auto &entry = index.at(name);
        const auto slice = [&](const char *field) {
            const size_t offset = entry.at(field).at(0), size = entry.at(field).at(1);
            if (offset > archive.size() || size > archive.size() - offset)
                throw std::runtime_error("Invalid D3D11 shader archive range");
            return archive.subspan(offset, size);
        };
        const auto reflection = slice("reflection");
        return {slice("vert"), slice("frag"), {reinterpret_cast<const char *>(reflection.data()), reflection.size()}};
    }

    ComPtr<ID3D11Buffer> buffer(UINT size, UINT bind, D3D11_USAGE usage = D3D11_USAGE_DYNAMIC) {
        D3D11_BUFFER_DESC desc{};
        desc.ByteWidth = size;
        desc.Usage = usage;
        desc.BindFlags = bind;
        desc.CPUAccessFlags = usage == D3D11_USAGE_DYNAMIC ? D3D11_CPU_ACCESS_WRITE : 0;
        ComPtr<ID3D11Buffer> result;
        checked(device->CreateBuffer(&desc, nullptr, &result), "Cannot create D3D11 buffer");
        return result;
    }

    std::unique_ptr<ProgramData> make_program(ProgramKey key) {
        const auto source = asset(key);
        auto result = std::make_unique<ProgramData>();
        checked(device->CreateVertexShader(source.vertex.data(), source.vertex.size(), nullptr, &result->vertex),
                "Cannot create D3D11 vertex shader");
        checked(device->CreatePixelShader(source.pixel.data(), source.pixel.size(), nullptr, &result->pixel),
                "Cannot create D3D11 pixel shader");
        result->vertex_bytes = source.vertex;
        result->reflection = Json::parse(source.reflection);
        if (key.program != "internal-copy") reflect(*result);
        return result;
    }

    void reflect_stage(ProgramData &result, const Json &reflection, unsigned stage) {
        const auto &dxbc = reflection.at("dxbc");
        for (const auto &description : dxbc.at("constantBuffers")) {
            const auto resource =
                    std::find_if(dxbc.at("resources").begin(), dxbc.at("resources").end(), [&](const Json &value) {
                        return value.at("name") == description.at("name");
                    });
            if (resource == dxbc.at("resources").end()) continue;
            auto storage = std::make_unique<ConstantBuffer>();
            storage->stage = stage;
            storage->slot = resource->at("slot");
            if (storage->slot >= 14) throw std::runtime_error("Invalid D3D11 cbuffer slot");
            storage->bytes.resize(description.at("size"));
            storage->buffer = buffer(UINT(storage->bytes.size()), D3D11_BIND_CONSTANT_BUFFER);
            const auto &original = reflection.at("constantBuffers");
            for (const auto &field : description.at("uniforms")) {
                if (!field.value("used", true)) continue;
                const std::string name = field.at("name");
                uint32_t stride = 0;
                for (const auto &block : original)
                    for (const auto &member : block.at("uniforms"))
                        if (member.at("name") == name) stride = member.value("array_stride", 0u);
                const uint32_t offset = field.at("offset"), size = field.at("size");
                if (uint64_t(offset) + size > storage->bytes.size())
                    throw std::runtime_error("Invalid D3D11 uniform range");
                result.uniforms[name].push_back({storage.get(), offset, size, stride});
                if (name == "clipHeight") std::memcpy(storage->bytes.data() + offset, &no_clip_height, 4);
            }
            result.buffers.push_back(std::move(storage));
        }
        for (const auto &texture : reflection.value("textures", Json::array())) {
            TextureSlots slots{stage};
            for (const auto &resource : dxbc.at("resources")) {
                if (resource.at("name") == texture.at("name")) slots.texture = resource.at("slot");
                if (!texture.at("samplerName").is_null() && resource.at("name") == texture.at("samplerName"))
                    slots.sampler = resource.at("slot");
            }
            if (slots.texture >= 128 || slots.sampler >= 16) throw std::runtime_error("Invalid D3D11 resource slot");
            result.textures[texture.at("name").get<std::string>()].push_back(slots);
        }
    }

    void reflect(ProgramData &result) {
        reflect_stage(result, result.reflection.at("vert"), 0);
        reflect_stage(result, result.reflection.at("frag"), 1);
    }

    void input_layout(GeometryData &geometry, ProgramData &program) {
        std::vector<D3D11_INPUT_ELEMENT_DESC> elements;
        for (const auto &input : program.reflection.at("vert").at("dxbc").at("inputs")) {
            if (input.at("systemValue") != 0) continue;
            const unsigned location = input.at("index");
            const auto attribute = std::find_if(
                    geometry.attributes.begin(), geometry.attributes.end(), [&](const VertexAttribute &field) {
                        return field.location == location;
                    }
            );
            if (input.at("semantic") != "TEXCOORD" || attribute == geometry.attributes.end()) return;
            static constexpr DXGI_FORMAT formats[] = {
                    DXGI_FORMAT_UNKNOWN,
                    DXGI_FORMAT_R32_FLOAT,
                    DXGI_FORMAT_R32G32_FLOAT,
                    DXGI_FORMAT_R32G32B32_FLOAT,
                    DXGI_FORMAT_R32G32B32A32_FLOAT
            };
            elements.push_back(
                    {"TEXCOORD",
                     location,
                     formats[attribute->components],
                     attribute->instance_step ? 1u : 0u,
                     UINT(attribute->offset),
                     attribute->instance_step ? D3D11_INPUT_PER_INSTANCE_DATA : D3D11_INPUT_PER_VERTEX_DATA,
                     attribute->instance_step}
            );
        }
        ComPtr<ID3D11InputLayout> layout;
        if (!elements.empty())
            checked(device->CreateInputLayout(
                            elements.data(),
                            UINT(elements.size()),
                            program.vertex_bytes.data(),
                            program.vertex_bytes.size(),
                            &layout
                    ),
                    "Cannot create D3D11 input layout");
        geometry.layouts.emplace(&program, std::move(layout));
    }

    void srv(unsigned stage, unsigned slot, ID3D11ShaderResourceView *view) {
        if (bound_srvs[stage][slot] == view) return;
        if (stage == 0)
            context->VSSetShaderResources(slot, 1, &view);
        else
            context->PSSetShaderResources(slot, 1, &view);
        bound_srvs[stage][slot] = view;
    }

    void sampler(unsigned stage, unsigned slot, ID3D11SamplerState *value) {
        if (bound_samplers[stage][slot] == value) return;
        if (stage == 0)
            context->VSSetSamplers(slot, 1, &value);
        else
            context->PSSetSamplers(slot, 1, &value);
        bound_samplers[stage][slot] = value;
    }

    void unbind_resource(ID3D11Resource *resource) {
        if (!resource) return;
        for (unsigned stage = 0; stage < 2; ++stage)
            for (unsigned slot = 0; slot < 128; ++slot) {
                if (!bound_srvs[stage][slot]) continue;
                ComPtr<ID3D11Resource> bound;
                bound_srvs[stage][slot]->GetResource(&bound);
                if (bound.Get() == resource) srv(stage, slot, nullptr);
            }
    }

    void textures(unsigned unit) {
        if (!program) return;
        const auto &binding = units[unit];
        auto *texture = binding.texture;
        auto *view = texture ? texture->srv.Get() : nullptr;
        if (texture
            && (texture->texture.Get() == color_resource.Get() || texture->texture.Get() == depth_resource.Get()))
            view = nullptr;
        for (const auto &slots : program->units[unit]) {
            if (slots.texture >= 0) srv(slots.stage, unsigned(slots.texture), view);
            if (slots.sampler >= 0)
                sampler(slots.stage, unsigned(slots.sampler), binding.sampler ? binding.sampler->state.Get() : nullptr);
        }
    }

    void upload_constants() {
        if (!program) throw std::runtime_error("No D3D11 program is bound");
        if (!geometry || !geometry->layouts.contains(program))
            throw std::runtime_error("D3D11 geometry does not match program");
        for (const auto &storage : program->buffers) {
            if (storage->dirty) {
                D3D11_MAPPED_SUBRESOURCE mapped{};
                checked(context->Map(storage->buffer.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped),
                        "Cannot map D3D11 constants");
                std::memcpy(mapped.pData, storage->bytes.data(), storage->bytes.size());
                context->Unmap(storage->buffer.Get(), 0);
                storage->dirty = false;
            }
            auto *value = storage->buffer.Get();
            auto &bound = bound_buffers[storage->stage][storage->slot];
            if (bound == value) continue;
            if (storage->stage == 0)
                context->VSSetConstantBuffers(storage->slot, 1, &value);
            else
                context->PSSetConstantBuffers(storage->slot, 1, &value);
            bound = value;
        }
    }

    void bind_geometry() {
        if (!geometry || !program) return;
        const auto layout = geometry->layouts.find(program);
        context->IASetInputLayout(layout == geometry->layouts.end() ? nullptr : layout->second.Get());
        ID3D11Buffer *buffers[] = {geometry->vertices.Get(), geometry->vertices.Get()};
        const UINT strides[] = {geometry->stride, geometry->stride}, offsets[] = {geometry->offset, geometry->offset};
        context->IASetVertexBuffers(0, 2, buffers, strides, offsets);
    }

    void bind_state() {
        if (!current_pipeline) return;
        auto *blend = current_pipeline->blend[state.blend.enabled ? 1 : 0].Get();
        auto *depth = current_pipeline->depth[(state.depth.test ? 2 : 0) | (state.depth.write ? 1 : 0)].Get();
        auto *raster = current_pipeline->raster.Get();
        if (bound_blend != blend) context->OMSetBlendState(blend, nullptr, ~0u);
        if (bound_depth != depth) context->OMSetDepthStencilState(depth, 0);
        if (bound_raster != raster) context->RSSetState(raster);
        bound_blend = blend;
        bound_depth = depth;
        bound_raster = raster;
    }

    std::unique_ptr<PipelineData> make_pipeline(const PipelineState &state) {
        auto result = std::make_unique<PipelineData>();
        for (unsigned enabled = 0; enabled < 2; ++enabled) {
            D3D11_BLEND_DESC desc{};
            auto &target = desc.RenderTarget[0];
            target.BlendEnable = enabled != 0;
            target.SrcBlend = target.SrcBlendAlpha = factor(state.blend.source);
            target.DestBlend = target.DestBlendAlpha = factor(state.blend.destination);
            target.BlendOp = target.BlendOpAlpha = D3D11_BLEND_OP_ADD;
            for (unsigned i = 0; i < 4; ++i)
                if (state.color_write[i]) target.RenderTargetWriteMask |= BYTE(1 << i);
            checked(device->CreateBlendState(&desc, &result->blend[enabled]), "Cannot create D3D11 blend state");
        }
        for (unsigned flags = 0; flags < 4; ++flags) {
            D3D11_DEPTH_STENCIL_DESC desc{};
            desc.DepthEnable = (flags & 2) != 0;
            desc.DepthWriteMask = flags & 1 ? D3D11_DEPTH_WRITE_MASK_ALL : D3D11_DEPTH_WRITE_MASK_ZERO;
            desc.DepthFunc = comparison(state.depth.compare);
            checked(device->CreateDepthStencilState(&desc, &result->depth[flags]), "Cannot create D3D11 depth state");
        }
        D3D11_RASTERIZER_DESC desc{};
        desc.FillMode = D3D11_FILL_SOLID;
        desc.CullMode = state.raster.cull == Cull::none    ? D3D11_CULL_NONE
                        : state.raster.cull == Cull::front ? D3D11_CULL_FRONT
                                                           : D3D11_CULL_BACK;
        // The translated vertex Y flip makes a GL CCW front face clockwise in D3D target coordinates.
        desc.FrontCounterClockwise = state.raster.winding == Winding::clockwise;
        desc.DepthClipEnable = TRUE;
        desc.MultisampleEnable = TRUE;
        if (state.raster.offset) {
            desc.SlopeScaledDepthBias = state.raster.slope_bias;
            desc.DepthBias = INT(state.raster.constant_bias);
        }
        checked(device->CreateRasterizerState(&desc, &result->raster), "Cannot create D3D11 raster state");
        return result;
    }

    static ID3D11RenderTargetView *color(const TargetView &target) {
        if (target.borrowed) return native<ID3D11RenderTargetView>(target.id);
        auto *data = native<TargetData>(target.id);
        return data && data->color ? data->color->rtv.Get() : nullptr;
    }

    static ID3D11DepthStencilView *depth(const TargetView &target) {
        if (target.borrowed) return native<ID3D11DepthStencilView>(target.native_depth);
        auto *data = native<TargetData>(target.id);
        return data && data->depth ? data->depth->dsv.Get() : nullptr;
    }

    void detach_outputs() {
        context->OMSetRenderTargets(0, nullptr, nullptr);
        rtv = nullptr;
        dsv = nullptr;
        color_resource.Reset();
        depth_resource.Reset();
    }
};

D3D11Context::D3D11Context(D3D11Device borrowed) : impl_(std::make_unique<Impl>(borrowed)) {
    impl_->depth_resolve = impl_->make_program({"internal-depth-resolve", ""});
    impl_->copy_program = impl_->make_program({"internal-copy", ""});
    impl_->copy_pipeline = impl_->make_pipeline({{}, {false, false}, {}});
    impl_->copy_constants = impl_->buffer(16, D3D11_BIND_CONSTANT_BUFFER);
    impl_->depth_pipeline = impl_->make_pipeline({{}, {true, true, Compare::always}, {}});
}

D3D11Context::~D3D11Context() = default;

std::unique_ptr<D3D11Context> D3D11Context::warp() {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_0};
    checked(D3D11CreateDevice(
                    nullptr,
                    D3D_DRIVER_TYPE_WARP,
                    nullptr,
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_DEBUG,
                    levels,
                    1,
                    D3D11_SDK_VERSION,
                    &device,
                    nullptr,
                    &context
            ),
            "Cannot create WARP device");
    auto result = std::make_unique<D3D11Context>(D3D11Device{device.Get(), context.Get()});
    result->impl_->owned_device = std::move(device);
    result->impl_->owned_context = std::move(context);
    return result;
}

int D3D11Context::max_texture_size() const {
    return D3D11_REQ_TEXTURE2D_U_OR_V_DIMENSION;
}

void D3D11Context::check_error(const char *message) {
    checked(impl_->device->GetDeviceRemovedReason(), message);
    ComPtr<ID3D11InfoQueue> diagnostics;
    if (FAILED(impl_->device->QueryInterface(IID_PPV_ARGS(&diagnostics)))) return;
    for (UINT64 i = 0; i < diagnostics->GetNumStoredMessagesAllowedByRetrievalFilter(); ++i) {
        SIZE_T size = 0;
        diagnostics->GetMessage(i, nullptr, &size);
        std::vector<std::byte> storage(size);
        auto *entry = reinterpret_cast<D3D11_MESSAGE *>(storage.data());
        checked(diagnostics->GetMessage(i, entry, &size), "Cannot read D3D11 diagnostic");
        if (entry->Severity <= D3D11_MESSAGE_SEVERITY_ERROR
            || entry->ID == D3D11_MESSAGE_ID_DEVICE_PSSETSHADERRESOURCES_HAZARD
            || entry->ID == D3D11_MESSAGE_ID_DEVICE_VSSETSHADERRESOURCES_HAZARD
            || entry->ID == D3D11_MESSAGE_ID_DEVICE_OMSETRENDERTARGETS_HAZARD)
            throw std::runtime_error(std::string(message) + ": " + entry->pDescription);
    }
}

Program D3D11Context::create_program(const ProgramDesc &source) {
    auto result = impl_->make_program(source.key);
    for (auto *geometry : impl_->geometries)
        impl_->input_layout(*geometry, *result);
    impl_->programs.push_back(result.get());
    return {handle(result.release())};
}

void D3D11Context::destroy(Program &program) {
    auto *value = native<ProgramData>(program.id);
    if (impl_->program == value) impl_->program = nullptr;
    for (auto *geometry : impl_->geometries)
        geometry->layouts.erase(value);
    std::erase(impl_->programs, value);
    for (auto &stage : impl_->bound_buffers)
        stage.fill(nullptr);
    release<ProgramData>(program.id);
    program = {};
}

void D3D11Context::bind_program(Program program) {
    auto *value = native<ProgramData>(program.id);
    if (impl_->program == value) return;
    impl_->program = value;
    impl_->context->VSSetShader(value ? value->vertex.Get() : nullptr, nullptr, 0);
    impl_->context->PSSetShader(value ? value->pixel.Get() : nullptr, nullptr, 0);
    if (!value) return;
    for (unsigned unit = 0; unit < impl_->units.size(); ++unit)
        impl_->textures(unit);
    impl_->bind_geometry();
}

ConstantBinding D3D11Context::create_constants(Program program, const ConstantLayout &layout) {
    auto *value = native<ProgramData>(program.id);
    auto result = std::make_unique<ConstantsData>();
    for (const auto &field : layout.fields) {
        const uint32_t size = constant_size(field.type), stride = field.array_stride ? field.array_stride : size;
        if (!field.name || !field.count || stride < size || stride % 4 || field.offset % 4
            || field.size < uint64_t(field.count - 1) * stride + size
            || uint64_t(field.offset) + field.size > layout.byte_size
            || (field.type == ConstantType::matrix4 && field.matrix_stride != 16))
            throw std::runtime_error("Invalid reflected constant layout");
        const auto found = value->uniforms.find(field.name);
        if (found == value->uniforms.end()) continue;
        for (const auto &uniform : found->second) {
            if (layout.stage != ShaderStage::both && unsigned(layout.stage) != uniform.buffer->stage) continue;
            const auto destination_stride = uniform.stride ? uniform.stride : size;
            if (uint64_t(field.count - 1) * destination_stride + size > uniform.size)
                throw std::runtime_error("D3D11 constant exceeds reflected storage");
            for (uint32_t i = 0; i < field.count; ++i)
                result->copies.push_back(
                        {uniform.buffer,
                         field.offset + i * stride,
                         uniform.offset + i * destination_stride,
                         size,
                         field.type == ConstantType::bool32}
                );
        }
    }
    ConstantBinding binding;
    binding.id = handle(result.get());
    binding.byte_size = layout.byte_size;
    value->constants.push_back(std::move(result));
    return binding;
}

void D3D11Context::constants(const ConstantBinding &binding, const void *bytes) {
    for (const auto &copy : native<ConstantsData>(binding.id)->copies) {
        const auto *source = static_cast<const std::byte *>(bytes) + copy.source;
        uint32_t boolean = 0;
        if (copy.boolean) {
            std::memcpy(&boolean, source, 4);
            boolean = boolean != 0;
            source = reinterpret_cast<const std::byte *>(&boolean);
        }
        auto *destination = copy.buffer->bytes.data() + copy.destination;
        if (std::memcmp(destination, source, copy.bytes) == 0) continue;
        std::memcpy(destination, source, copy.bytes);
        copy.buffer->dirty = true;
    }
}

void D3D11Context::texture_unit(Program program, const char *name, unsigned unit) {
    if (unit >= impl_->units.size()) throw std::runtime_error("D3D11 logical texture unit exceeds limit");
    auto *value = native<ProgramData>(program.id);
    const auto found = value->textures.find(name);
    if (found == value->textures.end()) return;
    for (auto &bindings : value->units)
        for (const auto &slots : found->second)
            std::erase_if(bindings, [&](const TextureSlots &binding) {
                return binding.stage == slots.stage && binding.texture == slots.texture
                       && binding.sampler == slots.sampler;
            });
    value->units[unit].insert(value->units[unit].end(), found->second.begin(), found->second.end());
    if (impl_->program == value) impl_->textures(unit);
}

Pipeline D3D11Context::create_pipeline(const PipelineState &state) {
    auto result = impl_->make_pipeline(state);
    return {state, handle(result.release())};
}

void D3D11Context::destroy(Pipeline &pipeline) {
    if (impl_->current_pipeline == native<PipelineData>(pipeline.id)) impl_->current_pipeline = nullptr;
    impl_->bound_blend = nullptr;
    impl_->bound_depth = nullptr;
    impl_->bound_raster = nullptr;
    release<PipelineData>(pipeline.id);
    pipeline = {};
}

void D3D11Context::pipeline(const Pipeline &pipeline) {
    impl_->current_pipeline = native<PipelineData>(pipeline.id);
    impl_->state = pipeline.state;
    impl_->bind_state();
}

void D3D11Context::depth_write(bool enabled) {
    impl_->state.depth.write = enabled;
    impl_->bind_state();
}

void D3D11Context::depth_test(bool enabled) {
    impl_->state.depth.test = enabled;
    impl_->bind_state();
}

void D3D11Context::blend(bool enabled) {
    impl_->state.blend.enabled = enabled;
    impl_->bind_state();
}

Texture D3D11Context::create_texture(const TextureDesc &desc, std::span<const void *const> faces) {
    if (desc.width < 1 || desc.height < 1 || desc.samples < 1 || desc.levels < 1 || desc.levels > 15
        || (desc.samples > 1 && (desc.kind == TextureKind::cube || desc.levels != 1 || !faces.empty()))
        || (desc.kind == TextureKind::cube && desc.width != desc.height))
        throw std::runtime_error("Invalid texture dimensions");
    const unsigned face_count = desc.kind == TextureKind::cube ? 6 : 1;
    if (!faces.empty() && faces.size() != face_count) throw std::runtime_error("Incomplete texture faces");
    const auto format = pixel_format(desc.format);
    D3D11_TEXTURE2D_DESC texture{};
    texture.Width = UINT(desc.width);
    texture.Height = UINT(desc.height);
    texture.MipLevels = UINT(desc.levels);
    texture.ArraySize = face_count;
    texture.Format = format.texture;
    texture.SampleDesc.Count = UINT(desc.samples);
    texture.Usage = D3D11_USAGE_DEFAULT;
    texture.BindFlags = D3D11_BIND_SHADER_RESOURCE
                        | (format.depth == DXGI_FORMAT_UNKNOWN ? D3D11_BIND_RENDER_TARGET : D3D11_BIND_DEPTH_STENCIL);
    texture.MiscFlags = desc.kind == TextureKind::cube ? D3D11_RESOURCE_MISC_TEXTURECUBE : 0;
    if (desc.levels > 1 && format.depth == DXGI_FORMAT_UNKNOWN) texture.MiscFlags |= D3D11_RESOURCE_MISC_GENERATE_MIPS;
    auto result = std::make_unique<TextureData>();
    checked(impl_->device->CreateTexture2D(&texture, nullptr, &result->texture), "Cannot create D3D11 texture");
    if (!faces.empty()) {
        if (format.depth != DXGI_FORMAT_UNKNOWN) throw std::runtime_error("Upload depth through a render target");
        for (unsigned face = 0; face < face_count; ++face)
            impl_->context->UpdateSubresource(
                    result->texture.Get(),
                    D3D11CalcSubresource(0, face, desc.levels),
                    nullptr,
                    faces[face],
                    UINT(size_t(desc.width) * format.bytes),
                    0
            );
    }
    D3D11_SHADER_RESOURCE_VIEW_DESC srv{};
    srv.Format = format.view;
    if (desc.samples > 1)
        srv.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2DMS;
    else if (desc.kind == TextureKind::cube) {
        srv.ViewDimension = D3D11_SRV_DIMENSION_TEXTURECUBE;
        srv.TextureCube.MipLevels = UINT(desc.levels);
    } else {
        srv.ViewDimension = D3D11_SRV_DIMENSION_TEXTURE2D;
        srv.Texture2D.MipLevels = UINT(desc.levels);
    }
    checked(impl_->device->CreateShaderResourceView(result->texture.Get(), &srv, &result->srv),
            "Cannot create D3D11 texture SRV");
    if (format.depth != DXGI_FORMAT_UNKNOWN) {
        D3D11_DEPTH_STENCIL_VIEW_DESC view{};
        view.Format = format.depth;
        view.ViewDimension = desc.samples > 1 ? D3D11_DSV_DIMENSION_TEXTURE2DMS : D3D11_DSV_DIMENSION_TEXTURE2D;
        checked(impl_->device->CreateDepthStencilView(result->texture.Get(), &view, &result->dsv),
                "Cannot create D3D11 depth view");
    } else if (desc.kind == TextureKind::image) {
        D3D11_RENDER_TARGET_VIEW_DESC view{};
        view.Format = format.view;
        view.ViewDimension = desc.samples > 1 ? D3D11_RTV_DIMENSION_TEXTURE2DMS : D3D11_RTV_DIMENSION_TEXTURE2D;
        checked(impl_->device->CreateRenderTargetView(result->texture.Get(), &view, &result->rtv),
                "Cannot create D3D11 color view");
    }
    return {handle(result.release()), desc};
}

void D3D11Context::generate_mips(Texture texture) {
    impl_->context->GenerateMips(native<TextureData>(texture.id)->srv.Get());
}

void D3D11Context::destroy(Texture &texture) {
    auto *value = native<TextureData>(texture.id);
    if (value) {
        impl_->unbind_resource(value->texture.Get());
        if (value->texture.Get() == impl_->color_resource.Get() || value->texture.Get() == impl_->depth_resource.Get())
            impl_->detach_outputs();
        for (auto &unit : impl_->units)
            if (unit.texture == value) unit.texture = nullptr;
    }
    release<TextureData>(texture.id);
    texture = {};
}

Sampler D3D11Context::create_sampler(const SamplerDesc &desc) {
    D3D11_SAMPLER_DESC sampler{};
    sampler.Filter = D3D11_ENCODE_BASIC_FILTER(
            desc.minification == Filter::linear ? D3D11_FILTER_TYPE_LINEAR : D3D11_FILTER_TYPE_POINT,
            desc.magnification == Filter::linear ? D3D11_FILTER_TYPE_LINEAR : D3D11_FILTER_TYPE_POINT,
            desc.mip_filter == Filter::linear ? D3D11_FILTER_TYPE_LINEAR : D3D11_FILTER_TYPE_POINT,
            desc.compare ? D3D11_FILTER_REDUCTION_TYPE_COMPARISON : D3D11_FILTER_REDUCTION_TYPE_STANDARD
    );
    const auto address = desc.address == Address::clamp    ? D3D11_TEXTURE_ADDRESS_CLAMP
                         : desc.address == Address::repeat ? D3D11_TEXTURE_ADDRESS_WRAP
                         : desc.address == Address::mirror ? D3D11_TEXTURE_ADDRESS_MIRROR
                                                           : D3D11_TEXTURE_ADDRESS_BORDER;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = address;
    sampler.ComparisonFunc = comparison(desc.comparison);
    sampler.MaxAnisotropy = 1;
    sampler.MinLOD = desc.mipmapped ? desc.min_lod : 0;
    sampler.MaxLOD = desc.mipmapped ? desc.max_lod : 0;
    std::copy(desc.border_color.begin(), desc.border_color.end(), sampler.BorderColor);
    auto result = std::make_unique<SamplerData>();
    checked(impl_->device->CreateSamplerState(&sampler, &result->state), "Cannot create D3D11 sampler");
    return {handle(result.release())};
}

void D3D11Context::destroy(Sampler &sampler) {
    auto *value = native<SamplerData>(sampler.id);
    if (value) {
        for (auto &unit : impl_->units)
            if (unit.sampler == value) unit.sampler = nullptr;
        for (unsigned stage = 0; stage < 2; ++stage)
            for (unsigned slot = 0; slot < 16; ++slot)
                if (impl_->bound_samplers[stage][slot] == value->state.Get()) impl_->sampler(stage, slot, nullptr);
    }
    release<SamplerData>(sampler.id);
    sampler = {};
}

void D3D11Context::bind_texture(unsigned slot, Texture texture, Sampler sampler) {
    if (slot >= impl_->units.size()) throw std::runtime_error("D3D11 logical texture unit exceeds limit");
    impl_->units[slot] = {native<TextureData>(texture.id), native<SamplerData>(sampler.id)};
    impl_->textures(slot);
}

void D3D11Context::unbind_sampler(unsigned slot) {
    if (slot >= impl_->units.size()) throw std::runtime_error("D3D11 logical texture unit exceeds limit");
    impl_->units[slot].sampler = nullptr;
    impl_->textures(slot);
}

RenderTarget D3D11Context::create_target(const TargetDesc &desc) {
    RenderTarget result;
    result.desc = desc;
    auto data = std::make_unique<TargetData>();
    try {
        if (desc.color != Format::none)
            result.color = create_texture({desc.width, desc.height, desc.color, TextureKind::image, desc.samples});
        if (desc.depth != Format::none)
            result.depth = create_texture({desc.width, desc.height, desc.depth, TextureKind::image, desc.samples});
        data->color = native<TextureData>(result.color.id);
        data->depth = native<TextureData>(result.depth.id);
        result.id = handle(data.release());
    } catch (...) {
        destroy(result);
        throw;
    }
    return result;
}

void D3D11Context::destroy(RenderTarget &target) {
    destroy(target.color);
    destroy(target.depth);
    release<TargetData>(target.id);
    target = {};
}

TargetView D3D11Context::borrow_target(void *rtv, const TargetDesc &desc, void *dsv) {
    return {handle(rtv), desc, handle(dsv), true};
}

void D3D11Context::bind_target(const TargetView &target) {
    auto *rtv = Impl::color(target);
    auto *dsv = Impl::depth(target);
    impl_->color_resource.Reset();
    impl_->depth_resource.Reset();
    if (rtv) rtv->GetResource(&impl_->color_resource);
    if (dsv) dsv->GetResource(&impl_->depth_resource);
    impl_->unbind_resource(impl_->color_resource.Get());
    impl_->unbind_resource(impl_->depth_resource.Get());
    if (rtv != impl_->rtv || dsv != impl_->dsv)
        impl_->context->OMSetRenderTargets(rtv ? 1 : 0, rtv ? &rtv : nullptr, dsv);
    impl_->rtv = rtv;
    impl_->dsv = dsv;
}

void D3D11Context::viewport(Rect rect) {
    const D3D11_VIEWPORT viewport{float(rect.x), float(rect.y), float(rect.width), float(rect.height), 0, 1};
    impl_->context->RSSetViewports(1, &viewport);
}

void D3D11Context::clear_color(std::array<float, 4> color) {
    if (impl_->rtv) impl_->context->ClearRenderTargetView(impl_->rtv, color.data());
}

void D3D11Context::clear_depth() {
    if (impl_->dsv) impl_->context->ClearDepthStencilView(impl_->dsv, D3D11_CLEAR_DEPTH, 1, 0);
}

void D3D11Context::resolve_color(const TargetView &source, const TargetView &destination) {
    if (!Impl::color(source) || !Impl::color(destination)) throw std::runtime_error("Missing color resolve view");
    ComPtr<ID3D11Resource> from, to;
    Impl::color(source)->GetResource(&from);
    Impl::color(destination)->GetResource(&to);
    impl_->detach_outputs();
    impl_->unbind_resource(from.Get());
    impl_->unbind_resource(to.Get());
    if (source.desc.samples == 1)
        impl_->context->CopyResource(to.Get(), from.Get());
    else
        impl_->context->ResolveSubresource(to.Get(), 0, from.Get(), 0, pixel_format(destination.desc.color).view);
}

void D3D11Context::resolve_depth(const TargetView &source, const TargetView &destination) {
    if (!Impl::depth(source) || !Impl::depth(destination)) throw std::runtime_error("Missing depth resolve view");
    if (source.desc.width != destination.desc.width || source.desc.height != destination.desc.height
        || destination.desc.samples != 1)
        throw std::runtime_error("Invalid D3D11 depth resolve dimensions");
    ComPtr<ID3D11Resource> from, to;
    Impl::depth(source)->GetResource(&from);
    Impl::depth(destination)->GetResource(&to);
    impl_->detach_outputs();
    impl_->unbind_resource(from.Get());
    impl_->unbind_resource(to.Get());
    if (source.desc.samples == 1) {
        impl_->context->CopyResource(to.Get(), from.Get());
        return;
    }
    if (source.borrowed) throw std::runtime_error("Depth resolve requires a seam-owned multisample source");
    const auto *data = native<TargetData>(source.id);
    bind_target({0, destination.desc, handle(Impl::depth(destination)), true});
    viewport({0, 0, destination.desc.width, destination.desc.height});
    impl_->program = nullptr;
    impl_->geometry = nullptr;
    impl_->context->VSSetShader(impl_->depth_resolve->vertex.Get(), nullptr, 0);
    impl_->context->PSSetShader(impl_->depth_resolve->pixel.Get(), nullptr, 0);
    impl_->context->IASetInputLayout(nullptr);
    impl_->current_pipeline = impl_->depth_pipeline.get();
    impl_->state = {{}, {true, true, Compare::always}, {}};
    impl_->bind_state();
    impl_->srv(1, 0, data->depth->srv.Get());
    impl_->context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    impl_->context->Draw(3, 0);
    impl_->srv(1, 0, nullptr);
    impl_->detach_outputs();
}

void D3D11Context::copy_color(const TargetView &source, Rect region, Texture destination, int x, int y) {
    if (!Impl::color(source)) throw std::runtime_error("Missing copy source");
    if (source.desc.samples != 1 || destination.desc.samples != 1)
        throw std::runtime_error("D3D11 color copy requires single-sample textures");
    if (region.x < 0 || region.y < 0 || x < 0 || y < 0 || region.width < 1 || region.height < 1
        || region.x + region.width > source.desc.width || region.y + region.height > source.desc.height
        || x + region.width > destination.desc.width || y + region.height > destination.desc.height)
        throw std::runtime_error("Invalid color copy region");
    ComPtr<ID3D11Resource> from;
    Impl::color(source)->GetResource(&from);
    auto *to = native<TextureData>(destination.id)->texture.Get();
    impl_->detach_outputs();
    impl_->unbind_resource(from.Get());
    impl_->unbind_resource(to);
    if (source.desc.color != destination.desc.format) {
        if (source.borrowed || destination.desc.kind != TextureKind::image)
            throw std::runtime_error("Color conversion requires seam-owned 2D targets");
        const auto *data = native<TargetData>(source.id);
        bind_target(
                {handle(native<TextureData>(destination.id)->rtv.Get()),
                 {destination.desc.width, destination.desc.height, destination.desc.format},
                 0,
                 true}
        );
        viewport({x, y, region.width, region.height});
        const int32_t offset[] = {region.x - x, region.y - y, 0, 0};
        D3D11_MAPPED_SUBRESOURCE mapped{};
        checked(impl_->context->Map(impl_->copy_constants.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped),
                "Cannot map D3D11 copy constants");
        std::memcpy(mapped.pData, offset, sizeof(offset));
        impl_->context->Unmap(impl_->copy_constants.Get(), 0);
        auto *constants = impl_->copy_constants.Get();
        impl_->context->PSSetConstantBuffers(0, 1, &constants);
        impl_->bound_buffers[1][0] = constants;
        impl_->program = nullptr;
        impl_->geometry = nullptr;
        impl_->context->VSSetShader(impl_->copy_program->vertex.Get(), nullptr, 0);
        impl_->context->PSSetShader(impl_->copy_program->pixel.Get(), nullptr, 0);
        impl_->context->IASetInputLayout(nullptr);
        impl_->current_pipeline = impl_->copy_pipeline.get();
        impl_->state = {{}, {false, false}, {}};
        impl_->bind_state();
        impl_->srv(1, 0, data->color->srv.Get());
        impl_->context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        impl_->context->Draw(3, 0);
        impl_->srv(1, 0, nullptr);
        impl_->detach_outputs();
        return;
    }
    const D3D11_BOX box{
            UINT(region.x), UINT(region.y), 0, UINT(region.x + region.width), UINT(region.y + region.height), 1
    };
    impl_->context->CopySubresourceRegion(to, 0, UINT(x), UINT(y), 0, from.Get(), 0, &box);
}

Geometry D3D11Context::create_geometry(size_t stride, std::span<const VertexAttribute> attributes) {
    if (stride > UINT32_MAX || (!attributes.empty() && stride == 0))
        throw std::runtime_error("Invalid D3D11 vertex stride");
    auto result = std::make_unique<GeometryData>();
    result->stride = UINT(stride);
    for (const auto &attribute : attributes) {
        if (attribute.components < 1 || attribute.components > 4
            || attribute.offset + attribute.components * 4 > stride)
            throw std::runtime_error("Invalid D3D11 vertex attribute");
        result->attributes.push_back(attribute);
    }
    if (stride) result->vertices = impl_->buffer(GeometryData::capacity, D3D11_BIND_VERTEX_BUFFER);
    for (auto *program : impl_->programs)
        impl_->input_layout(*result, *program);
    impl_->geometries.push_back(result.get());
    return {handle(result.release())};
}

void D3D11Context::destroy(Geometry &geometry) {
    auto *value = native<GeometryData>(geometry.array);
    if (impl_->geometry == value) impl_->geometry = nullptr;
    std::erase(impl_->geometries, value);
    release<GeometryData>(geometry.array);
    geometry = {};
}

void D3D11Context::bind_geometry(Geometry geometry) {
    impl_->geometry = native<GeometryData>(geometry.array);
    impl_->bind_geometry();
}

void D3D11Context::stream_vertices(Geometry geometry, std::span<const std::byte> data) {
    auto *value = native<GeometryData>(geometry.array);
    if (!value->stride || data.size() > GeometryData::capacity || data.size() % value->stride)
        throw std::runtime_error("D3D11 vertex stream exceeds the ring capacity or stride");
    if (data.empty()) return;
    const UINT aligned = ((value->cursor + value->stride - 1) / value->stride) * value->stride;
    const bool discard = value->cursor == 0 || size_t(aligned) + data.size() > GeometryData::capacity;
    value->offset = discard ? 0 : aligned;
    D3D11_MAPPED_SUBRESOURCE mapped{};
    checked(impl_->context->Map(
                    value->vertices.Get(),
                    0,
                    discard ? D3D11_MAP_WRITE_DISCARD : D3D11_MAP_WRITE_NO_OVERWRITE,
                    0,
                    &mapped
            ),
            "Cannot map D3D11 vertex ring");
    std::memcpy(static_cast<std::byte *>(mapped.pData) + value->offset, data.data(), data.size());
    impl_->context->Unmap(value->vertices.Get(), 0);
    value->cursor = value->offset + UINT(data.size());
    if (impl_->geometry == value) impl_->bind_geometry();
}

void D3D11Context::upload_indices(Geometry &geometry, std::span<const std::byte> data) {
    auto *value = native<GeometryData>(geometry.array);
    if (data.empty() || data.size() > UINT32_MAX) throw std::runtime_error("Invalid D3D11 index data");
    value->indices = impl_->buffer(UINT(data.size()), D3D11_BIND_INDEX_BUFFER, D3D11_USAGE_DEFAULT);
    impl_->context->UpdateSubresource(value->indices.Get(), 0, nullptr, data.data(), 0, 0);
}

void D3D11Context::draw(Primitive topology, int first, int count) {
    impl_->upload_constants();
    impl_->context->IASetPrimitiveTopology(primitive(topology));
    impl_->context->Draw(UINT(count), UINT(first));
}

void D3D11Context::draw_instanced(Primitive topology, int first, int count, int instances) {
    impl_->upload_constants();
    impl_->context->IASetPrimitiveTopology(primitive(topology));
    impl_->context->DrawInstanced(UINT(count), UINT(instances), UINT(first), 0);
}

void D3D11Context::draw_indexed(Primitive topology, IndexType type, size_t byte_offset, int count, int instances) {
    if (!impl_->geometry || !impl_->geometry->indices) throw std::runtime_error("No D3D11 index buffer is bound");
    impl_->upload_constants();
    impl_->context->IASetPrimitiveTopology(primitive(topology));
    impl_->context->IASetIndexBuffer(
            impl_->geometry->indices.Get(),
            type == IndexType::u16 ? DXGI_FORMAT_R16_UINT : DXGI_FORMAT_R32_UINT,
            UINT(byte_offset)
    );
    impl_->context->DrawIndexedInstanced(UINT(count), UINT(instances), 0, 0, 0);
}

Fence D3D11Context::signal() {
    auto result = std::make_unique<QueryData>();
    const D3D11_QUERY_DESC desc{D3D11_QUERY_EVENT, 0};
    checked(impl_->device->CreateQuery(&desc, &result->query), "Cannot create D3D11 fence");
    impl_->context->End(result->query.Get());
    return {handle(result.release())};
}

Wait D3D11Context::wait(Fence fence, uint64_t timeout_ns, bool flush) {
    auto *value = native<QueryData>(fence.id);
    if (!value) return Wait::failed;
    if (flush) impl_->context->Flush();
    const auto start = std::chrono::steady_clock::now();
    for (;;) {
        const auto result = impl_->context->GetData(value->query.Get(), nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
        if (result == S_OK) return Wait::ready;
        if (FAILED(result)) return Wait::failed;
        const auto elapsed = std::chrono::steady_clock::now() - start;
        if (std::chrono::duration_cast<std::chrono::nanoseconds>(elapsed).count() >= int64_t(timeout_ns))
            return Wait::pending;
        std::this_thread::yield();
    }
}

void D3D11Context::destroy(Fence &fence) {
    if (!fence.borrowed) release<QueryData>(fence.id);
    fence = {};
}

Readback D3D11Context::create_readback(int width, int height, Format format) {
    if (width < 1 || height < 1) throw std::runtime_error("Invalid readback dimensions");
    auto result = std::make_unique<ReadbackData>();
    const D3D11_QUERY_DESC completion{D3D11_QUERY_EVENT, 0};
    checked(impl_->device->CreateQuery(&completion, &result->completion.query), "Cannot create readback fence");
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = UINT(width);
    desc.Height = UINT(height);
    desc.MipLevels = desc.ArraySize = desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.Format = pixel_format(format).texture;
    checked(impl_->device->CreateTexture2D(&desc, nullptr, &result->staging), "Cannot create D3D11 readback");
    if (pixel_format(format).depth != DXGI_FORMAT_UNKNOWN) result->converted.resize(size_t(width) * height);
    if (format == Format::depth32f) {
        desc.Format = DXGI_FORMAT_R24G8_TYPELESS;
        checked(impl_->device->CreateTexture2D(&desc, nullptr, &result->depth24), "Cannot create depth readback");
    }
    Readback readback;
    readback.buffer = handle(result.release());
    readback.width = width;
    readback.height = height;
    readback.format = format;
    return readback;
}

size_t D3D11Context::readback_bytes(const Readback &readback) {
    return size_t(readback.width) * readback.height * pixel_format(readback.format).bytes;
}

void D3D11Context::enqueue_readback(const TargetView &source, Readback &readback, int x, int y) {
    if (pending(readback) || readback.mapped) throw std::runtime_error("Readback slot is busy");
    if (source.desc.samples != 1 || x < 0 || y < 0 || x + readback.width > source.desc.width
        || y + readback.height > source.desc.height)
        throw std::runtime_error("Invalid D3D11 readback region");
    auto *value = native<ReadbackData>(readback.buffer);
    const bool depth = pixel_format(readback.format).depth != DXGI_FORMAT_UNKNOWN;
    ComPtr<ID3D11Resource> resource;
    if (depth && Impl::depth(source)) Impl::depth(source)->GetResource(&resource);
    if (!depth && Impl::color(source)) Impl::color(source)->GetResource(&resource);
    if (!resource) throw std::runtime_error("Missing D3D11 readback attachment");
    value->convert_depth24 =
            depth && (source.desc.depth == Format::depth24 || source.desc.depth == Format::depth24_stencil8);
    value->pack_stencil = readback.format == Format::depth24_stencil8;
    if ((depth ? source.desc.depth : source.desc.color) != readback.format
        && !(value->convert_depth24 && readback.format == Format::depth32f))
        throw std::runtime_error("D3D11 readback format differs");
    value->active =
            value->convert_depth24 && readback.format == Format::depth32f ? value->depth24.Get() : value->staging.Get();
    impl_->detach_outputs();
    impl_->unbind_resource(resource.Get());
    const D3D11_BOX region{UINT(x), UINT(y), 0, UINT(x + readback.width), UINT(y + readback.height), 1};
    impl_->context->CopySubresourceRegion(value->active, 0, 0, 0, 0, resource.Get(), 0, &region);
    impl_->context->End(value->completion.query.Get());
    readback.fence = {handle(&value->completion), true};
}

bool D3D11Context::pending(const Readback &readback) const {
    return readback.fence.id != 0;
}

Wait D3D11Context::poll(const Readback &readback) {
    return wait(readback.fence);
}

MappedPixels D3D11Context::map(Readback &readback) {
    if (readback.mapped || poll(readback) != Wait::ready) throw std::runtime_error("Readback is not ready to map");
    auto *value = native<ReadbackData>(readback.buffer);
    D3D11_MAPPED_SUBRESOURCE mapped{};
    checked(impl_->context->Map(value->active, 0, D3D11_MAP_READ, D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped),
            "Cannot map D3D11 readback");
    readback.mapped = true;
    if (!value->convert_depth24)
        return {static_cast<const std::byte *>(mapped.pData), mapped.RowPitch, RowOrigin::bottom};
    for (int y = 0; y < readback.height; ++y) {
        const auto *row = reinterpret_cast<const uint32_t *>(
                static_cast<const std::byte *>(mapped.pData) + size_t(y) * mapped.RowPitch
        );
        for (int x = 0; x < readback.width; ++x)
            if (value->pack_stencil) {
                const uint32_t packed = (row[x] << 8) | (row[x] >> 24);
                std::memcpy(&value->converted[size_t(y) * readback.width + x], &packed, 4);
            } else {
                value->converted[size_t(y) * readback.width + x] = float(row[x] & 0xffffff) / float(0xffffff);
            }
    }
    return {reinterpret_cast<const std::byte *>(value->converted.data()),
            size_t(readback.width) * 4,
            RowOrigin::bottom};
}

void D3D11Context::unmap(Readback &readback) {
    if (!readback.mapped) throw std::runtime_error("Readback is not mapped");
    impl_->context->Unmap(native<ReadbackData>(readback.buffer)->active, 0);
    readback.mapped = false;
    destroy(readback.fence);
}

void D3D11Context::collect(
        Readback &readback, std::span<std::byte> destination, RowOrigin origin, uint64_t timeout_ns
) {
    if (destination.size() != readback_bytes(readback)) throw std::runtime_error("Readback size differs");
    if (wait(readback.fence, timeout_ns, true) != Wait::ready)
        throw std::runtime_error("The GPU did not finish the readback");
    const auto pixels = map(readback);
    const size_t row_bytes = size_t(readback.width) * pixel_format(readback.format).bytes;
    for (int y = 0; y < readback.height; ++y) {
        const int source_y = origin == pixels.origin ? y : readback.height - 1 - y;
        std::memcpy(
                destination.data() + size_t(y) * row_bytes, pixels.data + size_t(source_y) * pixels.row_pitch, row_bytes
        );
    }
    unmap(readback);
}

void D3D11Context::destroy(Readback &readback) {
    if (readback.mapped) unmap(readback);
    destroy(readback.fence);
    release<ReadbackData>(readback.buffer);
    readback = {};
}
}  // namespace native::gfx
#else
namespace native::gfx {
struct D3D11Context::Impl {};

namespace {
[[noreturn]] void unavailable() {
    throw std::runtime_error("D3D11 is only available on Windows");
}
}  // namespace

D3D11Context::D3D11Context(D3D11Device) {
    unavailable();
}

D3D11Context::~D3D11Context() = default;

std::unique_ptr<D3D11Context> D3D11Context::warp() {
    unavailable();
}

int D3D11Context::max_texture_size() const {
    unavailable();
}

void D3D11Context::check_error(const char *) {
    unavailable();
}

Program D3D11Context::create_program(const ProgramDesc &) {
    unavailable();
}

void D3D11Context::destroy(Program &) {
    unavailable();
}

void D3D11Context::bind_program(Program) {
    unavailable();
}

ConstantBinding D3D11Context::create_constants(Program, const ConstantLayout &) {
    unavailable();
}

void D3D11Context::constants(const ConstantBinding &, const void *) {
    unavailable();
}

void D3D11Context::texture_unit(Program, const char *, unsigned) {
    unavailable();
}

Pipeline D3D11Context::create_pipeline(const PipelineState &) {
    unavailable();
}

void D3D11Context::destroy(Pipeline &) {
    unavailable();
}

void D3D11Context::pipeline(const Pipeline &) {
    unavailable();
}

void D3D11Context::depth_write(bool) {
    unavailable();
}

void D3D11Context::depth_test(bool) {
    unavailable();
}

void D3D11Context::blend(bool) {
    unavailable();
}

Texture D3D11Context::create_texture(const TextureDesc &, std::span<const void *const>) {
    unavailable();
}

void D3D11Context::generate_mips(Texture) {
    unavailable();
}

void D3D11Context::destroy(Texture &) {
    unavailable();
}

Sampler D3D11Context::create_sampler(const SamplerDesc &) {
    unavailable();
}

void D3D11Context::destroy(Sampler &) {
    unavailable();
}

void D3D11Context::bind_texture(unsigned, Texture, Sampler) {
    unavailable();
}

void D3D11Context::unbind_sampler(unsigned) {
    unavailable();
}

RenderTarget D3D11Context::create_target(const TargetDesc &) {
    unavailable();
}

void D3D11Context::destroy(RenderTarget &) {
    unavailable();
}

TargetView D3D11Context::borrow_target(void *, const TargetDesc &, void *) {
    unavailable();
}

void D3D11Context::bind_target(const TargetView &) {
    unavailable();
}

void D3D11Context::viewport(Rect) {
    unavailable();
}

void D3D11Context::clear_color(std::array<float, 4>) {
    unavailable();
}

void D3D11Context::clear_depth() {
    unavailable();
}

void D3D11Context::resolve_color(const TargetView &, const TargetView &) {
    unavailable();
}

void D3D11Context::resolve_depth(const TargetView &, const TargetView &) {
    unavailable();
}

void D3D11Context::copy_color(const TargetView &, Rect, Texture, int, int) {
    unavailable();
}

Geometry D3D11Context::create_geometry(size_t, std::span<const VertexAttribute>) {
    unavailable();
}

void D3D11Context::destroy(Geometry &) {
    unavailable();
}

void D3D11Context::bind_geometry(Geometry) {
    unavailable();
}

void D3D11Context::stream_vertices(Geometry, std::span<const std::byte>) {
    unavailable();
}

void D3D11Context::upload_indices(Geometry &, std::span<const std::byte>) {
    unavailable();
}

void D3D11Context::draw(Primitive, int, int) {
    unavailable();
}

void D3D11Context::draw_instanced(Primitive, int, int, int) {
    unavailable();
}

void D3D11Context::draw_indexed(Primitive, IndexType, size_t, int, int) {
    unavailable();
}

Fence D3D11Context::signal() {
    unavailable();
}

Wait D3D11Context::wait(Fence, uint64_t, bool) {
    unavailable();
}

void D3D11Context::destroy(Fence &) {
    unavailable();
}

Readback D3D11Context::create_readback(int, int, Format) {
    unavailable();
}

size_t D3D11Context::readback_bytes(const Readback &) {
    unavailable();
}

void D3D11Context::enqueue_readback(const TargetView &, Readback &, int, int) {
    unavailable();
}

bool D3D11Context::pending(const Readback &) const {
    unavailable();
}

Wait D3D11Context::poll(const Readback &) {
    unavailable();
}

MappedPixels D3D11Context::map(Readback &) {
    unavailable();
}

void D3D11Context::unmap(Readback &) {
    unavailable();
}

void D3D11Context::collect(Readback &, std::span<std::byte>, RowOrigin, uint64_t) {
    unavailable();
}

void D3D11Context::destroy(Readback &) {
    unavailable();
}
}  // namespace native::gfx
#endif
