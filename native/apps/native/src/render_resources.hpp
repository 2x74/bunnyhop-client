#pragma once

struct RenderGeometry {
    gfx::Geometry geometry;
    size_t indices = 0;
};

class RenderResources {
    gfx::Context &context;
    BhContext *&core;

public:
    RenderResources(gfx::Context &g, BhContext *&c) : context(g), core(c) {}

    gfx::Geometry emptyGeometry;
    gfx::Texture white, checker;
    std::array<gfx::Sampler, 4> samplers;
    std::vector<gfx::Texture> ownedTextures;
    std::unordered_map<uint64_t, gfx::Texture> textures;
    std::unordered_map<int32_t, std::pair<uint32_t, uint32_t>> textureSizes;
    std::unordered_map<int32_t, std::array<float, 3>> textureAverages;
    // Textures a cutout or translucent material reads alpha from (texture_bleed.hpp).
    std::unordered_set<int32_t> cutoutTextures;

    gfx::Texture upload(const BhImage &image, bool mipmap, bool srgb = true) {
        if (!image.rgba || !image.width || !image.height || uint64_t(image.width) * image.height * 4 > image.byte_count)
            throw std::runtime_error("Invalid native texture");
        const auto limit = uint32_t(context.max_texture_size());
        if (image.width > limit || image.height > limit) throw std::runtime_error("Native texture exceeds GPU limit");
        const int levels = mipmap ? 1 + int(std::floor(std::log2(std::max(image.width, image.height)))) : 1;
        const gfx::TextureDesc desc{
                int(image.width),
                int(image.height),
                srgb ? gfx::Format::srgb8 : gfx::Format::rgba8,
                gfx::TextureKind::image,
                1,
                levels
        };
        const void *pixels[] = {image.rgba};
        const auto texture = context.create_texture(desc, pixels);
        ownedTextures.push_back(texture);
        if (mipmap) context.generate_mips(texture);
        return texture;
    }

    void sampling(float anisotropy) {
        for (unsigned i = 0; i < samplers.size(); ++i) {
            context.destroy(samplers[i]);
            gfx::SamplerDesc desc;
            desc.address = i & 1 ? gfx::Address::repeat : gfx::Address::clamp;
            desc.mipmapped = i & 2;
            desc.max_anisotropy = anisotropy;
            samplers[i] = context.create_sampler(desc);
        }
    }

    void bind(unsigned unit, gfx::Texture texture, bool repeat = true) {
        const unsigned sampling = unsigned(repeat) | (texture.desc.levels > 1 ? 2u : 0u);
        context.bind_texture(unit, texture, samplers[sampling]);
    }

    gfx::Texture texture(int32_t index, bool raw = false) {
        if (index < 0) return white;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        const auto found = textures.find(key);
        return found == textures.end() ? checker : found->second;
    }

    ResourceLoading cache_texture(int32_t index, bool raw = false) {
        if (index < 0) co_return;
        const uint64_t key = uint32_t(index) | (uint64_t(raw) << 32);
        if (textures.count(key)) co_return;
        BhImage image{};
        gfx::Texture id = checker;
        if (bh_texture(core, index, &image)) {
            textureSizes[index] = {image.width, image.height};
            std::vector<uint8_t> pixels;
            if (!raw && cutoutTextures.count(index)) {
                pixels.assign(image.rgba, image.rgba + image.byte_count);
                const auto width = image.width, height = image.height;
                std::packaged_task<std::vector<uint8_t>()> prepare(
                        [pixels = std::move(pixels), width, height]() mutable {
                            if (native_render::has_transparent_texels(pixels))
                                native_render::bleed_transparent_texels(pixels, width, height);
                            return std::move(pixels);
                        }
                );
                auto result = prepare.get_future();
                std::thread(std::move(prepare)).detach();
                while (result.wait_for(std::chrono::seconds(0)) != std::future_status::ready)
                    co_yield "cutout pixels";
                pixels = result.get();
            }
            co_yield "upload texture";
            const BhImage prepared{
                    pixels.empty() ? image.rgba : pixels.data(), image.byte_count, image.width, image.height
            };
            id = upload(prepared, true, !raw);
            if (!raw) {
                std::array<float, 3> average{};
                const size_t pixels = size_t(image.width) * image.height;
                const size_t step = std::max(size_t(1), pixels / 4096);
                size_t count = 0;
                for (size_t pixel = 0; pixel < pixels; pixel += step) {
                    for (size_t channel = 0; channel < 3; ++channel) {
                        average[channel] += native_render::srgb_linear(float(image.rgba[pixel * 4 + channel]) / 255);
                    }
                    ++count;
                }
                for (auto &channel : average)
                    channel /= std::max(size_t(1), count);
                textureAverages[index] = average;
            }
        }
        textures.emplace(key, id);
    }

    RenderGeometry geometry(
            const float *vertices,
            size_t floats,
            int stride,
            const uint32_t *indices,
            size_t count,
            const float *blend = nullptr,
            size_t blends = 0
    ) {
        RenderGeometry out;
        if (!floats || !count) return out;
        if (!vertices || !indices || floats % stride || count > size_t(std::numeric_limits<int>::max()))
            throw std::runtime_error("Invalid native geometry buffer");
        for (size_t i = 0; i < count; i++)
            if (indices[i] >= floats / stride) throw std::runtime_error("Native mesh index out of bounds");
        out.indices = count;
        const auto attributes = geometry_attributes(stride);
        const int storedStride = stride >= 8 ? 11 : stride;
        out.geometry = context.create_geometry(storedStride * sizeof(float), attributes);
        if (stride >= 8) {
            // Fixed missing attributes preserve GL's zero defaults and give D3D11 a complete world input layout.
            std::vector<float> packed(floats / stride * storedStride);
            for (size_t i = 0; i < floats / stride; ++i) {
                std::copy_n(vertices + i * stride, stride, packed.data() + i * storedStride);
                if (blend && blends == floats / stride) packed[i * storedStride + 10] = blend[i];
            }
            context.upload_vertices(out.geometry, std::as_bytes(std::span(packed)));
        } else {
            context.upload_vertices(out.geometry, std::as_bytes(std::span(vertices, floats)));
        }
        context.upload_indices(out.geometry, std::as_bytes(std::span(indices, count)));
        return out;
    }

    static std::span<const gfx::VertexAttribute> geometry_attributes(int stride) {
        static constexpr gfx::VertexAttribute attributes[] = {
                {0, 3, 0},
                {1, 3, 3 * sizeof(float)},
                {2, 2, 6 * sizeof(float)},
                {3, 2, 8 * sizeof(float)},
                {4, 1, 10 * sizeof(float)}
        };
        return {attributes, stride >= 8 ? 5u : 1u};
    }

    void destroy(RenderGeometry &mesh) { context.destroy(mesh.geometry); }

    void release() {
        for (auto &texture : ownedTextures)
            context.destroy(texture);
        for (auto &sampler : samplers)
            context.destroy(sampler);
        context.destroy(emptyGeometry);
    }

    void prepare_fallback_textures() {
        emptyGeometry = context.create_geometry(0, {});
        sampling(1);
        const uint8_t blank[4] = {255, 255, 255, 255};
        white = upload({blank, 4, 1, 1}, false);
        uint8_t fallback[8 * 8 * 4];
        for (int y = 0; y < 8; y++)
            for (int x = 0; x < 8; x++) {
                const uint8_t v = ((x / 4 + y / 4) % 2) ? 140 : 185;
                const int at = (y * 8 + x) * 4;
                fallback[at] = fallback[at + 1] = fallback[at + 2] = v;
                fallback[at + 3] = 255;
            }
        checker = upload({fallback, sizeof(fallback), 8, 8}, true);
    }
};
