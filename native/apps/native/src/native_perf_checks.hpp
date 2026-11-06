#pragma once

namespace native_perf {
inline bool compilation_complete = false;
inline unsigned premature_queries = 0;

inline void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}

inline nlohmann::json compilation_checks(native::Gl &gl, const std::filesystem::path &assets) {
    auto models = std::make_unique<native::NativeViewmodel>(gl, assets);
    native_render::Actor actor;
    actor.id = "completion-check";
    actor.outfit = "outfit-cream";
    actor.loadout = "2;knife-bunnyfly;fin-geode;glove-dress-lapis";
    actor.frame.weapon = 1;
    gl.MaxShaderCompilerThreadsKHR = nullptr;
    reset();
    require(!models->warm_actor_step(actor), "Fallback link did not yield a frame");
    require(calls["CompileShader"]["count"] == 1, "Fallback compiled both shaders in one frame");
    unsigned previous_links = 0;
    for (int frame = 0; frame < 16; ++frame) {
        const bool ready = models->warm_actor_step(actor);
        const unsigned links = calls.contains("LinkProgram") ? calls["LinkProgram"]["count"].get<unsigned>() : 0;
        require(links - previous_links <= 1, "Fallback linked more than one program per frame");
        previous_links = links;
        if (ready) break;
    }
    require(calls["LinkProgram"]["count"] == 1, "Fallback did not cache the linked program");
    recording = false;
    models.reset();

    models = std::make_unique<native::NativeViewmodel>(gl, assets);
    const auto get_program = gl.GetProgramiv;
    const auto uniform = gl.GetUniformLocation;
    gl.MaxShaderCompilerThreadsKHR = [](GLuint) {
    };
    gl.GetProgramiv = [](GLuint id, GLenum name, GLint *value) {
        if (name == 0x91B1) {
            *value = compilation_complete ? GL_TRUE : GL_FALSE;
            return;
        }
        if (!compilation_complete) ++premature_queries;
        original.GetProgramiv(id, name, value);
    };
    gl.GetUniformLocation = [](GLuint id, const GLchar *name) {
        if (!compilation_complete) ++premature_queries;
        return original.GetUniformLocation(id, name);
    };
    compilation_complete = false;
    premature_queries = 0;
    require(!models->warm_actor_step(actor), "Parallel submission did not yield");
    for (int frame = 0; frame < 4; ++frame)
        require(!models->warm_actor_step(actor), "Incomplete program became ready");
    require(premature_queries == 0, "Link status or uniforms queried before completion");
    compilation_complete = true;
    for (int frame = 0; frame < 16; ++frame)
        if (models->warm_actor_step(actor)) break;
    require(models->warm_actor_step(actor), "Completed program was not admitted");
    gl.GetProgramiv = get_program;
    gl.GetUniformLocation = uniform;
    gl.MaxShaderCompilerThreadsKHR = original.MaxShaderCompilerThreadsKHR;
    return {{"fallbackOneLinkPerFrame", true},
            {"programCache", true},
            {"simulatedParallelCompletion", true},
            {"prematureStatusOrUniformQueries", premature_queries}};
}

inline nlohmann::json lifecycle_checks(native::Gl &gl, const std::filesystem::path &assets) {
    auto models = std::make_unique<native::NativeViewmodel>(gl, assets);
    auto warmup = std::make_unique<native::ActorWarmup>(assets);
    native_render::Actor actor;
    actor.id = "lifecycle";
    actor.outfit = "outfit-cream";
    actor.loadout = "2;knife-leek;fin-aurora;glove-aviator-bomber";
    actor.frame.weapon = 10;
    warmup->frame(std::span(&actor, 1), *models);
    warmup->frame({}, *models);
    require(!warmup->ready(actor), "Departed player was admitted");
    const auto old = actor;
    actor.loadout = "2;knife-sprouts;fin-rift;glove-mitts-whiteout";
    actor.frame.weapon = 1;
    for (int frame = 0; frame < 600; ++frame) {
        warmup->frame(std::span(&actor, 1), *models);
        require(!warmup->ready(old), "Stale appearance was admitted");
        if (warmup->ready(actor)) break;
        SDL_Delay(16);
    }
    require(warmup->ready(actor), "Latest appearance never became ready");
    warmup->frame({}, *models);
    require(!warmup->ready(actor), "Leave retained the model admission");
    actor.id = "repeat";
    warmup->frame(std::span(&actor, 1), *models);
    require(warmup->ready(actor), "Repeated look missed the graphics cache");
    models.reset();
    warmup.reset();
    return {{"leaveDuringPreparation", true}, {"appearanceReplacement", true}, {"repeatAdmission", true}};
}

inline nlohmann::json cancellation_checks(const std::filesystem::path &assets) {
    LoadoutPreviewService service(assets, 2.);
    nlohmann::json request = {
            {"id", 1}, {"thumbnail", true}, {"view", "knife"}, {"loadout", "2;knife-carrot;fin-garden;glove-knit"}
    };
    service.request(request);
    service.cancel(1);
    request["id"] = 2;
    service.request(request);
    unsigned replies = 0;
    const auto start = Clock::now();
    while (elapsed(start) < 15000 && replies == 0) {
        for (const auto &js : service.take_replies()) {
            const auto first = js.find('(');
            const auto reply = nlohmann::json::parse(js.substr(first + 1, js.size() - first - 2));
            require(reply.at("id") == 2, "Canceled preview delivered a stale image");
            require(!reply.at("png").get<std::string>().empty(), "Async preview was empty");
            ++replies;
        }
        SDL_Delay(2);
    }
    require(replies == 1, "Async preview did not complete");
    request["id"] = 3;
    service.request(request);
    require(service.take_replies().size() == 1, "Thumbnail was not cached");
    request["id"] = 4;
    service.request(request);
    service.cancel_all();
    require(service.take_replies().empty(), "Closing the menu retained preview replies");
    return {{"canceledReplyDropped", true}, {"thumbnailCache", true}, {"closeClearsQueue", true}};
}
}  // namespace native_perf
