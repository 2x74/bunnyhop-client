#pragma once

// Stateless smoke sampling keeps a paused view and replay seeks deterministic.
class NativeMapEffects {
    struct Emitter {
        nlohmann::json data;
        uint32_t entity = 0;
        int model = -1, parent = -1;
        native_render::Vec3 origin{};
        native_render::Bounds bounds;
        bool volume = false, trail = false, initial = true;
        std::deque<std::pair<double, native_render::Vec3>> history;
    };

    std::vector<Emitter> emitters;

    static std::string value(const nlohmann::json &e, const std::string &key, const std::string &fallback = "") {
        for (auto it = e.begin(); it != e.end(); ++it) {
            auto name = it.key();
            std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            auto wanted = key;
            std::transform(wanted.begin(), wanted.end(), wanted.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            if (name == wanted && it.value().is_string()) return it.value();
        }
        return fallback;
    }

    static float number(const nlohmann::json &e, const std::string &key, float fallback) {
        try {
            const auto text = value(e, key);
            size_t used = 0;
            const float n = std::stof(text, &used);
            return used == text.size() && std::isfinite(n) ? n : fallback;
        } catch (...) {
            return fallback;
        }
    }

    static native_render::Vec3 vector(const std::string &text) {
        native_render::Vec3 v{};
        std::stringstream in(text);
        for (float &n : v) {
            if (!(in >> n) || !std::isfinite(n)) n = 0;
        }
        return v;
    }

    static int model(const std::string &name) {
        try {
            return name.size() > 1 && name[0] == '*' ? std::stoi(name.substr(1)) : -1;
        } catch (...) {
            return -1;
        }
    }

public:
    void load(BhContext *core) {
        size_t count = 0;
        const char *raw = bh_entities_json(core, &count);
        if (!raw || !count) return;
        const auto entities = nlohmann::json::parse(raw, raw + count);
        raw = bh_models_json(core, &count);
        const auto bounds = raw && count ? nlohmann::json::parse(raw, raw + count) : nlohmann::json::array();
        for (size_t i = 0; i < entities.size(); i++) {
            const auto &e = entities[i];
            auto classname = value(e, "classname");
            std::transform(classname.begin(), classname.end(), classname.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            if (classname != "env_smokestack" && classname != "func_smokevolume" && classname != "env_spritetrail")
                continue;
            Emitter a;
            a.data = e;
            a.entity = uint32_t(i);
            a.volume = classname == "func_smokevolume";
            a.trail = classname == "env_spritetrail";
            a.origin = vector(value(e, "origin"));
            a.model = model(value(e, "model"));
            a.initial = a.volume  ? number(e, "StartDisabled", 0) == 0
                        : a.trail ? true
                                  : number(e, "InitialState", 0) != 0;
            if (a.volume) {
                if (a.model < 0 || size_t(a.model) >= bounds.size()) continue;
                for (int k = 0; k < 3; k++) {
                    a.bounds.lo[k] = bounds[a.model]["mins"][k];
                    a.bounds.hi[k] = bounds[a.model]["maxs"][k];
                }
            }
            const auto parent = value(e, "parentname");
            if (!parent.empty())
                for (const auto &p : entities)
                    if (value(p, "targetname") == parent) {
                        a.parent = model(value(p, "model"));
                        if (a.parent >= 0) {
                            const auto po = vector(value(p, "origin"));
                            for (int k = 0; k < 3; k++)
                                a.origin[k] -= po[k];
                        }
                        break;
                    }
            emitters.push_back(std::move(a));
            if (emitters.size() >= 256) break;
        }
    }

    void reset() {
        for (auto &e : emitters)
            e.history.clear();
    }

    void
    draw(NativePresentation &out,
         BhContext *core,
         const float eye[3],
         double seconds,
         const native_render::Vec3 &right,
         const native_render::Vec3 &up,
         bool visible) {
        if (!visible) return;
        size_t stateCount = 0;
        const auto *rawStates = bh_effect_states(core, &stateCount);
        std::unordered_map<uint32_t, bool> states;
        for (size_t i = 0; rawStates && i + 1 < stateCount; i += 2)
            states[rawStates[i]] = rawStates[i + 1] != 0;
        size_t budget = 4096;
        for (auto &a : emitters) {
            if (!(states.count(a.entity) ? states[a.entity] : a.initial) || !budget) continue;
            const auto &e = a.data;
            auto origin = a.origin;
            native::Matrix transform = native::identity();
            BhTransform t{};
            t.visible = 1;
            if (a.parent >= 0) {
                bh_model_transform(core, a.parent, &t);
                if (!t.visible) continue;
                transform = native::model_matrix(t);
                origin = native_render::transform_point(transform, origin);
            } else if (a.volume && a.model >= 0) {
                bh_model_transform(core, a.model, &t);
                if (!t.visible) continue;
                transform = native::model_matrix(t);
            }
            auto color = vector(value(e, a.volume ? "Color1" : "rendercolor", "255 255 255"));
            for (float &c : color)
                c = std::clamp(c / 255.f, 0.f, 1.f);
            if (a.trail) {
                const double life = std::clamp(double(number(e, "lifetime", .5f)), .01, 20.);
                if (!a.history.empty() && seconds < a.history.back().first) a.history.clear();
                if (a.history.empty() || seconds - a.history.back().first > .015)
                    a.history.emplace_back(seconds, origin);
                while (!a.history.empty() && (seconds - a.history.front().first > life || a.history.size() > 128))
                    a.history.pop_front();
                const float width = std::max(.1f, number(e, "startwidth", 8)) * .5f;
                for (size_t i = 1; i < a.history.size(); i++) {
                    const float alpha = float(1 - (seconds - a.history[i].first) / life)
                                        * std::clamp(number(e, "renderamt", 255) / 255.f, 0.f, 1.f);
                    out.ribbon(
                            a.history[i - 1].second,
                            a.history[i].second,
                            width,
                            {color[0], color[1], color[2], alpha},
                            eye
                    );
                }
                continue;
            }
            const float speed = std::max(.1f, number(e, "speed", 30)),
                        life = std::clamp(number(e, "JetLength", 200) / speed, .1f, 60.f),
                        rate = std::clamp(number(e, "Rate", 20), .01f, 512.f);
            size_t count = std::min<size_t>({budget, 512, size_t(std::max(1.f, std::ceil(rate * life)))});
            if (a.volume) {
                const float spacing = std::max(16.f, number(e, "ParticleSpacingDistance", 64));
                float volume = 1;
                for (int k = 0; k < 3; k++)
                    volume *= std::ceil(std::max(1.f, a.bounds.hi[k] - a.bounds.lo[k]) / spacing);
                count = std::min<size_t>({budget, 384, size_t(std::max(1.f, volume))});
            }
            budget -= count;
            const int64_t newest = int64_t(std::floor(std::max(0., seconds) * rate));
            for (size_t j = 0; j < count; j++) {
                const int64_t id = a.volume ? int64_t(j) : newest - int64_t(j);
                const float age = float(seconds - double(id) / rate), f = age / life;
                auto rand = [&](uint32_t salt) {
                    return native_render::particle_random(uint32_t(id) + a.entity * 100003u, salt);
                };
                native_render::Vec3 p{};
                float size, alpha;
                if (a.volume) {
                    const float movement = number(e, "MovementSpeed", 10);
                    for (int k = 0; k < 3; k++) {
                        const float extent = std::max(1.f, a.bounds.hi[k] - a.bounds.lo[k]);
                        float q = rand(k) + float(seconds) * movement * (k == 0 ? 1.f : k == 1 ? .61f : .37f) / extent;
                        q -= std::floor(q);
                        p[k] = a.bounds.lo[k] + q * extent;
                    }
                    for (int k = 0; k < 3; k++)
                        p[k] -= a.origin[k];
                    p = native_render::transform_point(transform, p);
                    size = std::max(1.f, number(e, "ParticleDrawWidth", 128)) * .5f;
                    alpha = std::clamp(number(e, "Density", .5f), 0.f, 1.f);
                } else {
                    if (id < 0 || age < 0 || age > life) continue;
                    const float theta = rand(0) * float(2 * 3.141592653589793)
                                        + age * number(e, "twist", 0) * native::radians,
                                radius = std::sqrt(rand(1)) * number(e, "BaseSpread", 20)
                                         + age * number(e, "SpreadSpeed", 15) * rand(2),
                                wind = number(e, "WindAngle", 0) * native::radians;
                    auto local = a.origin;
                    local[0] += std::cos(theta) * radius + std::cos(wind) * age * number(e, "WindSpeed", 0);
                    local[1] += std::sin(theta) * radius + std::sin(wind) * age * number(e, "WindSpeed", 0);
                    local[2] += age * speed;
                    p = a.parent >= 0 ? native_render::transform_point(transform, local) : local;
                    size = std::max(
                            0.f,
                            number(e, "StartSize", 20) + (number(e, "EndSize", 30) - number(e, "StartSize", 20)) * f
                    );
                    alpha = std::pow(.5f - .5f * std::cos(f * float(2 * 3.141592653589793)), f > .5f ? 2.f : 1.f)
                            * std::clamp(number(e, "renderamt", 255) / 255.f, 0.f, 1.f);
                }
                out.billboard(p, size, {color[0], color[1], color[2], alpha * .85f}, right, up, 2);
            }
        }
    }
};
