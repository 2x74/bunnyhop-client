#include "map_audio_scene.hpp"
#include "data_location.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
using namespace native;
using Json = nlohmann::json;
size_t checks = 0;

void require(bool condition, const char *reason) {
    ++checks;
    if (!condition) throw std::runtime_error(reason);
}

struct Fixture {
    std::filesystem::path root;

    explicit Fixture(const std::filesystem::path &directory) {
        const auto stamp = std::chrono::steady_clock::now().time_since_epoch().count();
        root = directory / ("load-test-" + std::to_string(stamp));
        std::filesystem::create_directories(root / "content");
    }

    ~Fixture() {
        std::error_code error;
        std::filesystem::remove_all(root, error);
    }

    void manifest(const Json &value) const {
        std::ofstream stream(root / "manifest.json");
        stream << value;
    }
};

void silent(MapAudioScene &scene, const char *reason) {
    MapAudioMixer mixer;
    scene.play_command(mixer, "play aoki/xfiles.wav", 0, true);
    scene.assign(nullptr, mixer, {}, 0, 0, 0, 1);
    std::array<float, 2048> output{};
    mixer.mix(output.data(), output.size() / 2, 1);
    require(std::all_of(output.begin(), output.end(), [](float value) { return value == 0; }), reason);
}

void fail_closed(const std::filesystem::path &directory) {
    Fixture fixture(directory);
    const auto bsp = directory / "map.bsp";
    std::ifstream stream(directory / "manifest.json");
    const auto allowed = Json::parse(stream);
    stream.close();
    const std::atomic_bool cancel = false;
    const std::string entities = R"([{"classname":"ambient_generic","message":"aoki/xfiles.wav",
        "health":"10","spawnflags":"1"}])";
    auto load = [&] {
        return load_map_audio(bsp, fixture.root / "content", entities, "[]", cancel);
    };
    require(!load(), "missing allow list played");
    {
        std::ofstream broken(fixture.root / "manifest.json");
        broken << "{broken";
    }
    require(!load(), "unparsable allow list played");
    fixture.manifest(Json{{"mapSha256", allowed.at("mapSha256")}, {"optional", Json::object()}});
    require(!load(), "missing mapSounds group played");
    auto invalid = allowed;
    invalid["mapSha256"] = std::string(64, '0');
    fixture.manifest(invalid);
    require(!load(), "allow list for another BSP played");
    invalid = allowed;
    invalid["optional"]["mapSounds"]["files"]["sound/a.wav"]["size"] = "bad";
    fixture.manifest(invalid);
    require(!load(), "invalid allow-list entry played");
    fixture.manifest(allowed);
    auto scene = load();
    require(scene && scene->files.size() == 1, "allowed pak sound did not decode");
    require(scene->find_file("sound/aoki/xfiles.wav") < 0, "excluded pak sound decoded");
    silent(*scene, "excluded packed emitter or command produced output");
    MapAudioMixer mixer;
    scene->play_command(mixer, "play a.wav", 0, true);
    scene->assign(nullptr, mixer, {}, 0, 0, 0, 1);
    std::array<float, 2048> output{};
    mixer.mix(output.data(), output.size() / 2, 1);
    require(std::any_of(output.begin(), output.end(), [](float value) { return value != 0; }), "allowed sound silent");
    invalid = allowed;
    invalid["optional"]["mapSounds"]["files"]["sound/a.wav"]["sha256"] = std::string(64, '0');
    fixture.manifest(invalid);
    scene = load();
    require(scene && !scene->file_ready[0].load(), "changed pak sound decoded");
    auto stock = allowed;
    stock["optional"]["mapSounds"]["files"]["sound/a.wav"]["stock"] = true;
    const auto cache = fixture.root / "map-audio-cache";
    std::filesystem::create_directories(cache);
    const std::string sha = allowed.at("optional").at("mapSounds").at("files").at("sound/a.wav").at("sha256");
    std::filesystem::copy_file(directory / "pcm.wav", cache / sha);
    fixture.manifest(stock);
    scene = load();
    require(scene && scene->file_ready[0].load(), "allowed cached stock sound did not decode");
    auto loose = allowed;
    loose["optional"]["mapSounds"]["files"] = {
            {"sound/loose.wav", allowed.at("optional").at("mapSounds").at("files").at("sound/a.wav")}
    };
    std::filesystem::create_directories(fixture.root / "content" / "sound");
    std::filesystem::copy_file(directory / "pcm.wav", fixture.root / "content" / "sound" / "loose.wav");
    fixture.manifest(loose);
    scene = load();
    require(scene && !scene->file_ready[0].load(), "packed sound fell back to a loose replacement");
}

void exodus_exclusion(const std::filesystem::path &directory, const std::filesystem::path &bsp) {
    Fixture fixture(directory);
    const auto path = data_location::utf8(bsp);
    std::unique_ptr<BhSoundPak, decltype(&bh_sound_pak_close)> pak(bh_sound_pak_open(path.c_str()), bh_sound_pak_close);
    require(bool(pak), "cannot open exodus pak");
    size_t size = 0;
    const auto *excluded = bh_sound_pak_read(pak.get(), "sound/aoki/xfiles.wav", &size);
    require(excluded && size == 720304, "excluded exodus song fragment fixture changed");
    std::array<char, 65> map_hash{};
    require(bh_sha256_file(path.c_str(), std::filesystem::file_size(bsp), map_hash.data()), "exodus hash");
    const auto *click = bh_sound_pak_read(pak.get(), "sound/aoki/szs/click.wav", &size);
    require(click != nullptr, "allowed exodus click missing");
    std::array<char, 65> click_hash{};
    require(bh_sha256(click, size, click_hash.data()), "exodus click hash");
    fixture.manifest(
            Json{{"mapSha256", map_hash.data()},
                 {"optional",
                  {{"mapSounds",
                    {{"files", {{"sound/aoki/szs/click.wav", {{"sha256", click_hash.data()}, {"size", size}}}}}}}}}}
    );
    const std::atomic_bool cancel = false;
    const std::string entities = R"([{"classname":"ambient_generic","message":"aoki/xfiles.wav",
        "health":"10","spawnflags":"1"}])";
    auto scene = load_map_audio(bsp, fixture.root / "content", entities, "[]", cancel);
    require(scene && scene->files.size() == 1, "exodus allow list load failed");
    silent(*scene, "excluded real exodus song fragment produced output");
}
}  // namespace

int main(int argc, char **argv) {
    try {
        require(argc >= 2, "pass oracle directory and optional exodus BSP");
        const auto directory = native::data_location::from_utf8(argv[1]);
        fail_closed(directory);
        if (argc > 2) exodus_exclusion(directory, native::data_location::from_utf8(argv[2]));
        std::cout << "Map audio allow list: " << checks << " checks passed\n";
    } catch (const std::exception &error) {
        std::cerr << "Map audio allow list: " << error.what() << '\n';
        return 1;
    }
}
