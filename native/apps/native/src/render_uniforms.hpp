#pragma once

class RenderUniforms {
    Gl &gl;

public:
    explicit RenderUniforms(Gl &g) : gl(g) {}

    struct UniformNameHash {
        using is_transparent = void;

        size_t operator()(std::string_view name) const { return std::hash<std::string_view>{}(name); }
    };

    using UniformMap = std::unordered_map<std::string, GLint, UniformNameHash, std::equal_to<>>;
    std::unordered_map<GLuint, UniformMap> uniformLocations;

    GLint loc(GLuint p, const char *name) {
        auto &locations = uniformLocations[p];
        const auto found = locations.find(name);
        if (found != locations.end()) return found->second;
        const GLint value = gl.GetUniformLocation(p, name);
        locations.emplace(name, value);
        return value;
    }

};
