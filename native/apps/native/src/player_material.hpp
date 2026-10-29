#pragma once
#include "native_math.hpp"
#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <string>
#include <unordered_map>

// The website's player materials, compiled at build time by export-player-materials.ts: the bunny, hats, wigs, gloves,
// knives and guns all run the website's own GLSL. Those shaders work in three.js's Y-up world, so every draw hands
// them its model, camera and view in that space; native skinning and projection stay in Source space.
namespace native_render {

enum class PlayerMaterial { solid, ghost, gun, world_gun };

// Uniform locations, looked up once per program.
struct PlayerProgram {
    GLuint id = 0;
    GLint projection = -1, model = -1, modelMatrix = -1, viewMatrix = -1, cameraPosition = -1, offset = -1, mirror = -1,
          auraPass = -1, auraSize = -1, glowTime = -1, boneMatrices = -1;
    GLint palette = -1, accent = -1, glove = -1, finTime = -1, cosTier = -1, playerLook = -1, fabric = -1;
    GLint headwearScale = -1, headwearOffset = -1, headwearFaceScale = -1, headwearFaceOffset = -1, hairColor = -1;
    GLint propellerAngle = -1, capybara = -1, ponytail = -1;
    GLint finEnvOn = -1, cosEnvOn = -1, playerEnvOn = -1, finSunDir = -1, finSunColor = -1, finEnv = -1, cosEnv = -1,
          playerEnv = -1, gunFlash = -1, gunFlashPos = -1;
    GLint glowEnabled = -1, glowColor = -1, glowIntensity = -1, glowOpacity = -1, glowAxisA = -1, glowAxisB = -1,
          glowNearFade = -1, glowDistance = -1;
    GLint ghost = -1, ghostRim = -1, opacity = -1, axisA = -1, axisB = -1, nearFade = -1;
};

// Source (x, y, z) -> three.js (x, z, -y).
inline std::array<float, 3> to_web_space(const float source[3]) {
    return {source[0], source[2], -source[1]};
}

// three.js world from a Source-space model matrix.
inline native::Matrix web_model(const native::Matrix &model) {
    const native::Matrix source_to_web = {1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1};
    return native::multiply(source_to_web, model);
}

// The camera's rotation for three.js directions, read from a perspective view-projection: its x and y rows are the
// camera's right and up scaled by the projection, and its w row is the forward direction.
inline native::Matrix web_view(const native::Matrix &view_projection) {
    auto axis = [&](int row) {
        std::array<float, 3> v = {view_projection[row], view_projection[4 + row], view_projection[8 + row]};
        const float length = std::hypot(std::hypot(v[0], v[1]), v[2]);
        for (auto &value : v)
            value = length > 0 ? value / length : 0;
        return v;
    };
    const auto right = axis(0), up = axis(1), forward = axis(3);
    // Rows right, up, -forward, applied to Source directions; columns reordered for three.js (x, y, z) =
    // Source (x, -z, y).
    native::Matrix view{};
    const std::array<std::array<float, 3>, 3> rows = {
            right, up, std::array<float, 3>{-forward[0], -forward[1], -forward[2]}
    };
    for (int r = 0; r < 3; ++r) {
        view[0 * 4 + r] = rows[size_t(r)][0];
        view[1 * 4 + r] = rows[size_t(r)][2];
        view[2 * 4 + r] = -rows[size_t(r)][1];
    }
    view[15] = 1;
    return view;
}

struct PlayerShaderSources {
    std::string vertex, gunVertex, solid, ghost, gun;

    static std::string read(const std::filesystem::path &path) {
        std::ifstream file(path);
        if (!file) throw std::runtime_error("Native player material absent: " + path.string());
        return std::string(std::istreambuf_iterator<char>(file), {});
    }

    explicit PlayerShaderSources(const std::filesystem::path &root)
        : vertex(read(root / "player-vertex.glsl"))
        , gunVertex(read(root / "player-gun-vertex.glsl"))
        , solid(read(root / "player-solid.glsl"))
        , ghost(read(root / "player-ghost.glsl"))
        , gun(read(root / "player-gun.glsl")) {}
};

inline int player_program_key(int finish, bool glove, bool detail, PlayerMaterial material) {
    return finish | (glove ? 64 : 0) | (detail ? 128 : 0) | (int(material) << 8);
}

// The #defines three.js would give the same material (viewmodel/finishes/shader.ts lookDefines, guns/material.ts).
inline std::string player_defines(int finish, bool glove, bool detail, PlayerMaterial material) {
    std::string defines = "#version 330 core\n";
    if (material == PlayerMaterial::ghost) return defines;
    if (finish) defines += "#define FINISH " + std::to_string(finish) + "\n";
    if (glove || detail) defines += "#define GLOVE 1\n";
    if (detail) defines += "#define VM_DETAIL 1\n";
    if (material == PlayerMaterial::gun) defines += "#define GUN_SHADE 1\n#define GUN_FLASH 1\n";
    if (material == PlayerMaterial::world_gun) defines += "#define GUN_SHADE 1\n#define GUN_NO_ENV 1\n";
    return defines;
}

}  // namespace native_render
