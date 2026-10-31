#pragma once

// Include after menu_backdrop.hpp. Owns an independent cosmetic renderer and offscreen target.
class NativeLoadoutPreview {
    struct Request {
        std::string view, packed, outfit, ghost, trail;
        int w = 0, h = 0;
        float yaw = 0, pitch = 0;
        bool onboarding = false;
    };

    struct Frame {
        bool changed = false;
        unsigned presses = 0;
    };

    std::optional<native::gfx::Context> ownedContext;
    native::gfx::Context &context;
    native::NativeViewmodel models;
    native::gfx::RenderTarget target;
    native::gfx::Pipeline clearPipeline;
    native::gfx::Compare depthCompare;
    int width = 0, height = 0;
    unsigned inspect = 0;
    double started = -1;
    std::string signature;

    static bool valid_stage(const nlohmann::json &job) {
        if (!job.contains("stage") || !job["stage"].is_object()) return false;
        const auto &s = job["stage"];
        for (const char *key : {"position", "velocity"}) {
            if (!s.contains(key) || !s[key].is_array() || s[key].size() != 3) return false;
            for (const auto &v : s[key])
                if (!v.is_number() || !std::isfinite(v.get<double>()) || std::abs(v.get<double>()) > 10000)
                    return false;
        }
        if (!s.contains("acting") || !s["acting"].is_object()) return false;
        for (const auto &v : s["acting"])
            if (!v.is_number() || !std::isfinite(v.get<double>()) || std::abs(v.get<double>()) > 180) return false;
        for (const char *key : {"yaw", "pitch", "squash", "spin", "clock"})
            if (!s.contains(key) || !s[key].is_number() || !std::isfinite(s[key].get<double>())) return false;
        if (std::abs(s["squash"].get<double>()) > .2 || s["clock"].get<double>() < 0) return false;
        return true;
    }

    static std::optional<Request> parse_request(const nlohmann::json &job) {
        if (!job.is_object() || job.dump().size() > 8192) return {};
        const auto id = job.value("id", 0u);
        const auto view = job.value("view", std::string("fp"));
        if (!id || (view != "fp" && view != "close" && view != "bunny" && view != "ghost" && view != "onboarding"))
            return {};
        const int w = std::clamp(job.value("width", 768), 384, 960);
        const int h = std::clamp(job.value("height", 480), 240, 600);
        const float yaw = job.value("yaw", 0.f), pitch = job.value("pitch", 0.f);
        if (!std::isfinite(yaw) || !std::isfinite(pitch)) return {};
        const auto packed = job.value("loadout", std::string("")),
                   outfit = job.value("outfit", std::string("outfit-cream")),
                   ghost = job.value("ghost", std::string("ghost-gold"));
        if (packed.size() > 512 || outfit.size() > 80 || ghost.size() > 80) return {};
        const auto trail = job.value("trail", std::string("trail-gold"));
        if (trail.size() > 80) return {};
        const bool onboarding = view == "onboarding";
        if (onboarding && !valid_stage(job)) return {};
        return Request{view, packed, outfit, ghost, trail, w, h, yaw, pitch, onboarding};
    }

    Frame prepare_models(const nlohmann::json &job, const Request &request, double now) {
        const auto &[view, packed, outfit, ghost, trail, w, h, yaw, pitch, onboarding] = request;
        const auto next = onboarding ? view : outfit + ";" + packed + ";" + view + ";" + ghost;
        const bool changed = signature != next;
        if (changed) {
            signature = next;
            models.reset_presentation();
            models.cosmetics(outfit, packed);
            inspect = 0;
            started = now;
        }
        if (onboarding) models.cosmetics(outfit, packed);
        models.ghost_cosmetics(ghost);
        models.player_glow(job.contains("playerGlow") ? native_render::parse_glow(job["playerGlow"]) : std::nullopt);
        models.trail_cosmetics(trail);
        const unsigned count = job.value("inspect", 0u);
        const unsigned presses = count >= inspect ? std::min(count - inspect, 4u) : 0;
        inspect = count;

        return {changed, presses};
    }

    std::array<float, 4> bind_target(const Request &request) {
        const auto &[view, packed, outfit, ghost, trail, w, h, yaw, pitch, onboarding] = request;
        if (width != w || height != h) {
            context.destroy(target);
            target = context.create_target({w, h, native::gfx::Format::rgba8, native::gfx::Format::depth24});
            width = w;
            height = h;
        }
        context.bind_target(target);
        context.viewport({0, 0, w, h});
        context.pipeline(clearPipeline);
        const std::array<float, 4> background =
                onboarding ? std::array<float, 4>{0, 0, 0, 0} : std::array<float, 4>{.045f, .06f, .085f, 1};
        context.clear_color(background);
        context.clear_depth();
        return background;
    }

    void
    draw(const nlohmann::json &job,
         const Request &request,
         Frame frame,
         double now,
         const std::array<float, 4> &background) {
        const auto &[view, packed, outfit, ghost, trail, w, h, yaw, pitch, onboarding] = request;
        const auto [changed, presses] = frame;
        // Settle the weapon draw clip before delivering the first frame; otherwise the first
        // request can capture hands still below the camera and no animation is requested yet.
        if (changed && !onboarding) {
            models.draw_menu_preview(w, h, view, 0, yaw, pitch, 0, false, depthCompare);
            context.clear_color(background);
            context.clear_depth();
        }
        if (onboarding || view == "bunny" || view == "ghost") depthCompare = native::gfx::Compare::less_equal;
        if (onboarding)
            models.draw_onboarding_preview(w, h, job["stage"], job["stage"]["clock"], presses ? 1 : 0);
        else
            models.draw_menu_preview(
                    w,
                    h,
                    view,
                    2 + std::max(0., now - started),
                    yaw,
                    pitch,
                    presses,
                    job.value("held", false),
                    depthCompare
            );
    }

public:
    NativeLoadoutPreview(
            native::gfx::Context &graphics,
            const std::filesystem::path &assets,
            native::gfx::Compare comparison = native::gfx::Compare::less_equal
    )
        : context(graphics)
        , models(context, assets)
        , depthCompare(comparison) {
        clearPipeline = context.create_pipeline({});
    }

    NativeLoadoutPreview(
            native::Gl &api,
            const std::filesystem::path &assets,
            native::gfx::Compare comparison = native::gfx::Compare::less_equal
    )
        : ownedContext(std::in_place, api)
        , context(*ownedContext)
        , models(context, assets)
        , depthCompare(comparison) {
        clearPipeline = context.create_pipeline({});
    }

    ~NativeLoadoutPreview() {
        context.destroy(target);
        context.destroy(clearPipeline);
    }

    std::string render(const nlohmann::json &job, double now) {
        const auto request = parse_request(job);
        if (!request) return {};
        const auto frame = prepare_models(job, *request, now);

        struct Restore {
            native::gfx::Context &context;
            native::gfx::TargetView target;
            native::gfx::Rect viewport;

            ~Restore() {
                context.bind_target(target);
                context.viewport(viewport);
            }
        } restore{context, context.current_target(), context.current_viewport()};

        const auto background = bind_target(*request);
        draw(job, *request, frame, now, background);
        return native::target_png(context, target, request->w, request->h, 2000000);
    }
};
