#pragma once

// Stateless smoke sampling keeps a paused view and replay seeks deterministic.
// Keyvalues are read once at load, as the website's map-effects/smoke.ts does: reading them per particle walked every
// key of the entity about a dozen times per particle per frame. The expressions below are the same ones, in the same
// order, so the particles land where they did.
class NativeMapEffects {
    struct Emitter {
        uint32_t entity = 0;
        int model = -1, parent = -1;
        native_render::Vec3 origin{};
        native_render::Bounds bounds;
        bool volume = false, trail = false, initial = true;
        std::array<float, 3> color{};
        float speed = 30, life = 1, rate = 20, renderamt = 1;
        float twist = 0, base_spread = 20, spread_speed = 15, wind_cos = 1, wind_sin = 0, wind_speed = 0;
        float start_size = 20, end_size = 30;
        float movement = 10, half_draw_width = 64, density = .5f;
        size_t count = 1;
        float trail_life = .5f, trail_width = 4, trail_alpha = 1;
        // Where the particles can be, before the parent or brush transform: what the view test uses.
        native_render::Bounds reach;
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

    static void read_keys(Emitter &a, const nlohmann::json &e) {
        a.color = vector(value(e, a.volume ? "Color1" : "rendercolor", "255 255 255"));
        for (float &c : a.color)
            c = std::clamp(c / 255.f, 0.f, 1.f);
        a.renderamt = std::clamp(number(e, "renderamt", 255) / 255.f, 0.f, 1.f);
        if (a.trail) {
            a.trail_life = number(e, "lifetime", .5f);
            a.trail_width = std::max(.1f, number(e, "startwidth", 8)) * .5f;
            return;
        }
        a.speed = std::max(.1f, number(e, "speed", 30));
        a.life = std::clamp(number(e, "JetLength", 200) / a.speed, .1f, 60.f);
        a.rate = std::clamp(number(e, "Rate", 20), .01f, 512.f);
        a.count = std::min<size_t>(512, size_t(std::max(1.f, std::ceil(a.rate * a.life))));
        if (a.volume) {
            const float spacing = std::max(16.f, number(e, "ParticleSpacingDistance", 64));
            float volume = 1;
            for (int k = 0; k < 3; k++)
                volume *= std::ceil(std::max(1.f, a.bounds.hi[k] - a.bounds.lo[k]) / spacing);
            a.count = std::min<size_t>(384, size_t(std::max(1.f, volume)));
            a.movement = number(e, "MovementSpeed", 10);
            a.half_draw_width = std::max(1.f, number(e, "ParticleDrawWidth", 128)) * .5f;
            a.density = std::clamp(number(e, "Density", .5f), 0.f, 1.f);
            // A billboard's corner reaches size·√2 from its centre.
            const float pad = a.half_draw_width * 1.5f;
            for (int k = 0; k < 3; k++) {
                a.reach.lo[k] = a.bounds.lo[k] - a.origin[k] - pad;
                a.reach.hi[k] = a.bounds.hi[k] - a.origin[k] + pad;
            }
            return;
        }
        a.twist = number(e, "twist", 0);
        a.base_spread = number(e, "BaseSpread", 20);
        a.spread_speed = number(e, "SpreadSpeed", 15);
        const float wind = number(e, "WindAngle", 0) * native::radians;
        a.wind_cos = std::cos(wind);
        a.wind_sin = std::sin(wind);
        a.wind_speed = number(e, "WindSpeed", 0);
        a.start_size = number(e, "StartSize", 20);
        a.end_size = number(e, "EndSize", 30);
        const float size = std::max({0.f, a.start_size, a.end_size}) * 1.5f;
        const float drift = a.life * (std::abs(a.spread_speed) + std::abs(a.wind_speed));
        const float side = std::abs(a.base_spread) + drift + size;
        a.reach.lo = {a.origin[0] - side, a.origin[1] - side, a.origin[2] - size};
        a.reach.hi = {a.origin[0] + side, a.origin[1] + side, a.origin[2] + a.life * a.speed + size};
    }

public:
    void load(BhContext *core) {
        size_t count = 0;
        const char *raw = bh_entities_json(core, &count);
        if (!raw || !count) return;
        const auto entities = nlohmann::json::parse(raw, raw + count);
        raw = bh_models_json(core, &count);
        load(entities, raw && count ? nlohmann::json::parse(raw, raw + count) : nlohmann::json::array());
    }

    void load(const nlohmann::json &entities, const nlohmann::json &bounds) {
        for (size_t i = 0; i < entities.size(); i++) {
            const auto &e = entities[i];
            auto classname = value(e, "classname");
            std::transform(classname.begin(), classname.end(), classname.begin(), [](unsigned char c) {
                return char(std::tolower(c));
            });
            if (classname != "env_smokestack" && classname != "func_smokevolume" && classname != "env_spritetrail")
                continue;
            Emitter a;
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
            read_keys(a, e);
            emitters.push_back(std::move(a));
            if (emitters.size() >= 256) break;
        }
    }

    void reset() {
        for (auto &e : emitters)
            e.history.clear();
    }

    // Returns the particles drawn. Emitters wholly outside the view are skipped but still use their share of the
    // particle budget, so the ones in view draw exactly what they would have.
    template <class Out>
    size_t
    draw(Out &out,
         BhContext *core,
         const native::Matrix &vp,
         const float eye[3],
         double seconds,
         const native_render::Vec3 &right,
         const native_render::Vec3 &up,
         bool visible) {
        if (!visible) return 0;
        size_t stateCount = 0;
        const auto *rawStates = bh_effect_states(core, &stateCount);
        std::unordered_map<uint32_t, bool> states;
        for (size_t i = 0; rawStates && i + 1 < stateCount; i += 2)
            states[rawStates[i]] = rawStates[i + 1] != 0;
        size_t budget = 4096, drawn = 0;
        for (auto &a : emitters) {
            if (!(states.count(a.entity) ? states[a.entity] : a.initial) || !budget) continue;
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
            const auto &color = a.color;
            if (a.trail) {
                const double life = std::clamp(double(a.trail_life), .01, 20.);
                if (!a.history.empty() && seconds < a.history.back().first) a.history.clear();
                if (a.history.empty() || seconds - a.history.back().first > .015)
                    a.history.emplace_back(seconds, origin);
                while (!a.history.empty() && (seconds - a.history.front().first > life || a.history.size() > 128))
                    a.history.pop_front();
                for (size_t i = 1; i < a.history.size(); i++) {
                    const float alpha = float(1 - (seconds - a.history[i].first) / life) * a.renderamt;
                    out.ribbon(
                            a.history[i - 1].second,
                            a.history[i].second,
                            a.trail_width,
                            {color[0], color[1], color[2], alpha},
                            eye
                    );
                }
                continue;
            }
            const float speed = a.speed, life = a.life, rate = a.rate;
            const size_t count = std::min(budget, a.count);
            budget -= count;
            std::array<float, 4> rect;
            const bool moved = a.parent >= 0 || a.volume;
            if (!native_render::screen_rect(
                        moved ? native_render::transformed_bounds(a.reach, transform) : a.reach, vp, rect
                ))
                continue;
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
                    const float movement = a.movement;
                    for (int k = 0; k < 3; k++) {
                        const float extent = std::max(1.f, a.bounds.hi[k] - a.bounds.lo[k]);
                        float q = rand(k) + float(seconds) * movement * (k == 0 ? 1.f : k == 1 ? .61f : .37f) / extent;
                        q -= std::floor(q);
                        p[k] = a.bounds.lo[k] + q * extent;
                    }
                    for (int k = 0; k < 3; k++)
                        p[k] -= a.origin[k];
                    p = native_render::transform_point(transform, p);
                    size = a.half_draw_width;
                    alpha = a.density;
                } else {
                    if (id < 0 || age < 0 || age > life) continue;
                    const float theta = rand(0) * float(2 * 3.141592653589793) + age * a.twist * native::radians,
                                radius = std::sqrt(rand(1)) * a.base_spread + age * a.spread_speed * rand(2);
                    auto local = a.origin;
                    local[0] += std::cos(theta) * radius + a.wind_cos * age * a.wind_speed;
                    local[1] += std::sin(theta) * radius + a.wind_sin * age * a.wind_speed;
                    local[2] += age * speed;
                    p = a.parent >= 0 ? native_render::transform_point(transform, local) : local;
                    size = std::max(0.f, a.start_size + (a.end_size - a.start_size) * f);
                    alpha = std::pow(.5f - .5f * std::cos(f * float(2 * 3.141592653589793)), f > .5f ? 2.f : 1.f)
                            * a.renderamt;
                }
                out.billboard(p, size, {color[0], color[1], color[2], alpha * .85f}, right, up, 2);
                ++drawn;
            }
        }
        return drawn;
    }
};
