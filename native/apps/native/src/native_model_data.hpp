#pragma once
#include <mutex>

namespace native_vm {
// Map renderers, the join worker and menu previews use the same immutable exported vertex/pose blob.
struct ModelData {
    nlohmann::json metadata;
    std::vector<float> vertices;

    explicit ModelData(const std::filesystem::path &root) {
        std::ifstream file(root / "viewmodels.json");
        if (!file) throw std::runtime_error("Native asset bundle absent; run native asset compiler");
        file >> metadata;
        if (metadata.at("version") != 3 || metadata.at("stride") != 26)
            throw std::runtime_error("Unsupported native asset format");
        const size_t bytes = metadata.value("bytes", size_t(0));
        constexpr size_t max_bytes = 768 * 1024 * 1024;
        if (bytes) {
            if (bytes > max_bytes || bytes % 4) throw std::runtime_error("Invalid native asset length");
            std::ifstream binary(root / "viewmodels.bin.z", std::ios::binary);
            std::vector<uint8_t> compressed(std::istreambuf_iterator<char>(binary), {});
            vertices.resize(bytes / 4);
            uLongf count = bytes;
            if (uncompress(reinterpret_cast<Bytef *>(vertices.data()), &count, compressed.data(), compressed.size())
                        != Z_OK
                || count != bytes)
                throw std::runtime_error("Invalid compressed native assets");
        } else {
            std::ifstream binary(root / "viewmodels.bin", std::ios::binary | std::ios::ate);
            const auto size = binary.tellg();
            if (!binary || size < 0 || size > std::streamoff(max_bytes) || size % 4)
                throw std::runtime_error("Invalid native assets");
            vertices.resize(size_t(size) / 4);
            binary.seekg(0);
            binary.read(reinterpret_cast<char *>(vertices.data()), size);
            if (!binary) throw std::runtime_error("Truncated native assets");
        }
    }

    static std::shared_ptr<const ModelData> load(const std::filesystem::path &root) {
        static std::mutex mutex;
        static std::filesystem::path cached_root;
        static std::weak_ptr<const ModelData> cached;
        std::lock_guard lock(mutex);
        if (root == cached_root)
            if (auto data = cached.lock()) return data;
        auto data = std::make_shared<const ModelData>(root);
        cached_root = root;
        cached = data;
        return data;
    }
};
}  // namespace native_vm
