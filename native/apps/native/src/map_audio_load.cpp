#include "map_audio_scene.hpp"
#include "data_location.hpp"
#include "online.hpp"
#include <fstream>
#include <iostream>

namespace native {
namespace {
using Json = nlohmann::json;
constexpr size_t manifest_byte_limit = 16u << 20;
constexpr size_t allowed_file_limit = 4096;
constexpr uint64_t bsp_byte_limit = 768u << 20;

std::vector<unsigned char> read_bytes(const std::filesystem::path &path, size_t limit) {
    const auto size = std::filesystem::file_size(path);
    if (size > limit) throw std::runtime_error("audio file exceeds byte budget");
    std::vector<unsigned char> bytes(size_t(size), 0);
    std::ifstream stream(path, std::ios::binary);
    if (!stream.read(reinterpret_cast<char *>(bytes.data()), std::streamsize(bytes.size())))
        throw std::runtime_error("cannot read map audio file");
    return bytes;
}

bool valid_sha(const std::string &sha) {
    return sha.size() == 64 && std::all_of(sha.begin(), sha.end(), [](char ch) {
               return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f');
           });
}

Json read_group(const std::filesystem::path &bsp, const std::filesystem::path &root) {
    if (root.empty()) throw std::runtime_error("no map sound allow list");
    const auto bytes = read_bytes(root.parent_path() / "manifest.json", manifest_byte_limit);
    const auto manifest = Json::parse(bytes);
    const auto path = data_location::utf8(bsp);
    std::array<char, 65> actual{};
    const auto bsp_size = std::filesystem::file_size(bsp);
    constexpr uint64_t streaming_hash_byte_limit = 512u << 20;
    bool hashed = false;
    if (bsp_size <= streaming_hash_byte_limit) {
        hashed = bh_sha256_file(path.c_str(), bsp_size, actual.data()) != 0;
    } else {
        const auto map_bytes = read_bytes(bsp, bsp_byte_limit);
        hashed = bh_sha256(map_bytes.data(), map_bytes.size(), actual.data()) != 0;
    }
    if (!hashed || manifest.at("mapSha256") != actual.data())
        throw std::runtime_error("map sound allow list does not match BSP");
    const auto group = manifest.at("optional").at("mapSounds");
    const auto &files = group.at("files");
    if (!files.is_object() || files.size() > allowed_file_limit) throw std::runtime_error("invalid sound allow list");
    for (const auto &[name, info] : files.items()) {
        if (!safe_content_path(name) || name != map_sound_path(name)
            || (!name.ends_with(".wav") && !name.ends_with(".mp3")))
            throw std::runtime_error("invalid allowed sound path");
        if (!info.is_object() || !info.at("size").is_number_unsigned()
            || info.at("size").get<uint64_t>() > max_pack_file_bytes || !valid_sha(info.at("sha256").get<std::string>())
            || (info.contains("stock") && !info.at("stock").is_boolean()))
            throw std::runtime_error("invalid allowed sound file");
    }
    return group;
}

std::vector<unsigned char> sound_bytes(
        const std::string &path,
        const Json &info,
        BhSoundPak *pak,
        const std::filesystem::path &root,
        const std::atomic_bool &cancel
) {
    const size_t size = info.at("size");
    const auto sha = info.at("sha256").get<std::string>();
    std::vector<unsigned char> bytes;
    if (info.value("stock", false)) {
        const auto cache_file = root.parent_path() / "map-audio-cache" / sha;
        if (std::filesystem::is_regular_file(cache_file)) bytes = read_bytes(cache_file, size);
        std::array<char, 65> cached_hash{};
        if (bytes.size() != size || !bh_sha256(bytes.data(), bytes.size(), cached_hash.data())
            || sha != cached_hash.data()) {
            bytes = fetch_https("https://bunnyhop.lol/content/" + sha, size, &cancel);
        }
    } else {
        size_t length = 0;
        const auto *data = bh_sound_pak_read(pak, path.c_str(), &length);
        if (!data || length != size) throw std::runtime_error("allowed packed sound is missing or has changed");
        bytes.assign(data, data + length);
    }
    std::array<char, 65> actual{};
    if (bytes.size() != size || !bh_sha256(bytes.data(), bytes.size(), actual.data()) || sha != actual.data())
        throw std::runtime_error("map sound hash mismatch");
    if (info.value("stock", false)) {
        const auto cache_file = root.parent_path() / "map-audio-cache" / sha;
        std::error_code error;
        std::filesystem::create_directories(cache_file.parent_path(), error);
        if (!error) {
            std::ofstream stream(cache_file, std::ios::binary | std::ios::trunc);
            stream.write(reinterpret_cast<const char *>(bytes.data()), std::streamsize(bytes.size()));
        }
    }
    return bytes;
}

std::vector<size_t> load_order(const MapAudioScene &scene) {
    std::vector<size_t> order;
    std::vector<bool> queued(scene.files.size(), false);
    order.reserve(scene.files.size());
    const auto append = [&](size_t file) {
        if (queued[file]) return;
        queued[file] = true;
        order.push_back(file);
    };
    for (const auto &sound : scene.sounds)
        if (sound.used && sound.on) append(size_t(sound.file));
    for (const auto &sound : scene.sounds)
        if (sound.used) append(size_t(sound.file));
    for (size_t file = 0; file < scene.files.size(); ++file)
        append(file);
    return order;
}

void decode_files(
        MapAudioScene &scene,
        const Json &group,
        BhSoundPak *pak,
        const std::filesystem::path &root,
        const std::atomic_bool &cancel
) {
    size_t decoded_bytes = 0;
    for (size_t index : load_order(scene)) {
        if (cancel || decoded_bytes >= map_decoded_byte_limit) return;
        const auto &path = scene.files[index].path;
        const auto &info = group.at("files").at(path);
        try {
            const auto bytes = sound_bytes(path, info, pak, root, cancel);
            MapAudioFile file;
            std::string error;
            const size_t remaining_samples = (map_decoded_byte_limit - decoded_bytes) / sizeof(float);
            if (!decode_sfx_bytes(bytes, &file.audio, &error, remaining_samples)) throw std::runtime_error(error);
            if (file.audio.channels < 1 || file.audio.channels > 2)
                throw std::runtime_error("unsupported channel count");
            if (sniff_audio(bytes.data(), bytes.size()) == AudioFormat::wav) file.loop = map_wave_loop(bytes);
            const auto frames = int64_t(file.audio.samples.size() / size_t(file.audio.channels));
            if (file.loop.start >= 0 && file.loop.start < frames) {
                file.loop.end = file.loop.end > file.loop.start ? std::min(file.loop.end, frames) : frames;
            } else
                file.loop = {};
            if (!std::all_of(file.audio.samples.begin(), file.audio.samples.end(), [](float sample) {
                    return std::isfinite(sample);
                }))
                throw std::runtime_error("non-finite audio samples");
            decoded_bytes += file.audio.samples.capacity() * sizeof(float);
            scene.files[index].audio = std::move(file.audio);
            scene.files[index].loop = file.loop;
            scene.file_ready[index].store(true, std::memory_order_release);
        } catch (const std::exception &error) {
            std::cerr << "Map sounds: " << path << ": " << error.what() << '\n';
        }
    }
}
}  // namespace

std::shared_ptr<MapAudioScene> load_map_audio(
        const std::filesystem::path &bsp,
        const std::filesystem::path &content_root,
        const std::string &entities,
        const std::string &models,
        const std::atomic_bool &cancel,
        MapAudioLoad *publication
) {
    try {
        const auto group = read_group(bsp, content_root);
        if (cancel) return {};
        const auto path = data_location::utf8(bsp);
        const std::unique_ptr<BhSoundPak, decltype(&bh_sound_pak_close)> pak(
                bh_sound_pak_open(path.c_str()), bh_sound_pak_close
        );
        if (!pak) throw std::runtime_error("cannot read BSP sound pakfile");
        auto scene = std::make_shared<MapAudioScene>();
        scene->files.reserve(group.at("files").size());
        for (const auto &[name, info] : group.at("files").items()) {
            const size_t index = scene->files.size();
            scene->files.push_back(MapAudioFile{name, {}, {}});
            scene->file_ready[index].store(false, std::memory_order_relaxed);
            scene->file_seen[index] = false;
        }
        scene->build(Json::parse(entities), Json::parse(models), group);
        if (publication) {
            publication->scene = scene;
            publication->published.store(true, std::memory_order_release);
        }
        decode_files(*scene, group, pak.get(), content_root, cancel);
        if (cancel) return {};
        return scene;
    } catch (const std::exception &error) {
        std::cerr << "Map sounds: " << error.what() << '\n';
    } catch (...) {
        std::cerr << "Map sounds: loading failed\n";
    }
    return {};
}
}  // namespace native
