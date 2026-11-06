#pragma once
#include "nlohmann/json.hpp"
#include <array>
#include <cctype>
#include <string>
#include <vector>

namespace native_actor_anim {

struct AnimationClip {
    int frames = 0;
    double fps = 0;
};

struct PoseParameter {
    std::string name;
    double start = 0, end = 0, loop = 0;
};

struct AnimationLayer {
    int seq = 0, pose = 0, flags = 0;
    double start = 0, peak = 0, tail = 0, end = 0;
};

struct AnimationSequence {
    std::string name, activity;
    int flags = 0;
    double fadeIn = 0, fadeOut = 0;
    std::array<int, 2> params{}, groupSize{};
    std::array<double, 2> paramStart{}, paramEnd{};
    std::vector<int> anims;
    std::vector<double> weights, poseKeys;
    std::vector<AnimationLayer> layers;

    explicit AnimationSequence(const nlohmann::json &value) {
        name = value.at("name");
        for (char &character : name)
            character = char(std::tolower(static_cast<unsigned char>(character)));
        activity = value.at("activity");
        flags = value.at("flags");
        fadeIn = value.at("fadeIn");
        fadeOut = value.at("fadeOut");
        params = value.at("params").get<decltype(params)>();
        groupSize = value.at("groupSize").get<decltype(groupSize)>();
        paramStart = value.at("paramStart").get<decltype(paramStart)>();
        paramEnd = value.at("paramEnd").get<decltype(paramEnd)>();
        anims = value.at("anims").get<decltype(anims)>();
        weights = value.at("weights").get<decltype(weights)>();
        poseKeys = value.at("poseKeys").get<decltype(poseKeys)>();
        for (const auto &raw : value.at("layers")) {
            layers.push_back(
                    {raw.at("seq"),
                     raw.at("pose"),
                     raw.at("flags"),
                     raw.at("start"),
                     raw.at("peak"),
                     raw.at("tail"),
                     raw.at("end")}
            );
        }
    }
};

}  // namespace native_actor_anim
