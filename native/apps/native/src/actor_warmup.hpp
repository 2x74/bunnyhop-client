#pragma once

class ActorWarmup {
    struct Work {
        native_render::Actor actor;
        std::optional<NativeViewmodel::ActorGraphics> graphics;
        bool wanted = false, queued = false, failed = false, imported = false;
    };

    struct Admission {
        std::shared_ptr<Work> work;
        bool seen = false, ready = false;
    };

    struct State {
        std::mutex mutex;
        std::condition_variable changed;
        bool stop = false, failed = false, budget = false;
        std::unordered_map<std::string, std::shared_ptr<Work>> cache;
        std::deque<std::shared_ptr<Work>> queue;
    };

    // Some drivers serialize cold first-use draws across a share group. Prime that work outside the game's group.
    HiddenGlContext isolatedContext{false}, context{true};
    std::unique_ptr<State> state = std::make_unique<State>();
    std::filesystem::path assets;
    std::thread worker;
    std::unordered_map<std::string, Admission> actors;

    static bool same_look(const native_render::Actor &a, const native_render::Actor &b) {
        return a.outfit == b.outfit && a.loadout == b.loadout && a.frame.weapon == b.frame.weapon
               && a.emptyHand == b.emptyHand && a.silenced == b.silenced
               && NativeViewmodel::ghost_source_of(a) == NativeViewmodel::ghost_source_of(b);
    }

    static std::string key(const native_render::Actor &actor) {
        return nlohmann::json{
                actor.outfit,
                actor.loadout,
                actor.frame.weapon,
                actor.emptyHand,
                actor.silenced,
                int(NativeViewmodel::ghost_source_of(actor))
        }
                .dump();
    }

    std::shared_ptr<Work> request(const native_render::Actor &actor) {
        constexpr size_t max_cached_looks = 128;
        if (state->cache.size() >= max_cached_looks) {
            const auto unused = std::find_if(state->cache.begin(), state->cache.end(), [](const auto &entry) {
                return !entry.second->wanted && !entry.second->queued;
            });
            if (unused != state->cache.end()) state->cache.erase(unused);
        }
        auto &work = state->cache[key(actor)];
        if (!work) {
            work = std::make_shared<Work>();
            work->actor = actor;
            // Motion belongs to the game context. This rig only primes all solid/outline/halo draw states.
            work->actor.source = NativeViewmodel::ghost_source_of(actor);
            work->actor.id = "warm-player";
            work->actor.frame.yaw = 0;
            work->actor.frame.pitch = 0;
            work->actor.frame.flags = 2;
            std::fill_n(work->actor.frame.position, 3, 0.f);
            std::fill_n(work->actor.frame.velocity, 3, 0.f);
            work->actor.inspect = work->actor.attack = 0;
            work->actor.inspectHeld = false;
            work->actor.opacity = 1;
            work->actor.playerGlow = native_render::Glow{};
            work->actor.playerGlow->enabled = true;
            work->actor.playerGlow->aura = true;
        }
        if (!work->graphics && !work->failed && !work->queued) {
            work->queued = true;
            state->queue.push_back(work);
        }
        return work;
    }

    bool frame_budget() {
        std::unique_lock lock(state->mutex);
        state->changed.wait(lock, [&] { return state->stop || state->budget; });
        if (state->stop) return false;
        state->budget = false;
        return true;
    }

    struct Pass {
        HiddenGlContext &context;
        Gl gl;
        std::unique_ptr<NativeViewmodel> models;
        GLsync fence = nullptr;

        Pass(HiddenGlContext &target, const std::filesystem::path &assets) : context(target) {
            context.bind();
            gl.load();
            models = std::make_unique<NativeViewmodel>(gl, assets, false, NativeViewmodel::GraphicsMode::actor_only);
        }

        ~Pass() {
            context.bind_for_cleanup();
            if (fence) gl.DeleteSync(fence);
            models.reset();
        }

        bool step(const native_render::Actor &actor) {
            context.bind();
            if (fence) {
                const auto status = gl.ClientWaitSync(fence, GL_SYNC_FLUSH_COMMANDS_BIT, 0);
                if (status == GL_TIMEOUT_EXPIRED) return false;
                gl.DeleteSync(fence);
                fence = nullptr;
                if (status == GL_WAIT_FAILED) throw std::runtime_error("Player warm-up fence failed");
                return true;
            }
            if (!models->warm_actor_step(actor)) return false;
            const float eye[3] = {110, 0, 40};
            const auto projection = native::camera_matrix(eye, 180, 8, 1);
            gl.Viewport(0, 0, 32, 32);
            gl.DepthMask(GL_TRUE);
            gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
            models->draw_actor(actor, projection, eye, 2.);
            fence = gl.FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
            if (!fence) throw std::runtime_error("Player warm-up fence creation failed");
            return false;
        }
    };

    void render(Pass &isolated, Pass &shared) {
        std::shared_ptr<Work> current;
        bool isolated_ready = false;
        while (frame_budget()) {
            if (!current) {
                std::lock_guard lock(state->mutex);
                while (!state->queue.empty()) {
                    current = std::move(state->queue.front());
                    state->queue.pop_front();
                    if (current->wanted) break;
                    current->queued = false;
                    current.reset();
                }
                if (!current) continue;
                isolated_ready = false;
            }
            try {
                auto &pass = isolated_ready ? shared : isolated;
                if (!pass.step(current->actor)) continue;
                if (!isolated_ready) {
                    isolated_ready = true;
                    continue;
                }
                auto graphics = shared.models->export_actor_graphics(current->actor);
                std::lock_guard lock(state->mutex);
                current->graphics = std::move(graphics);
                current->queued = false;
                current.reset();
            } catch (const std::exception &error) {
                std::cerr << "Player warm-up: " << error.what() << '\n';
                std::lock_guard lock(state->mutex);
                current->failed = true;
                current->queued = false;
                current.reset();
            }
        }
    }

    void run() {
        SDL_SetCurrentThreadPriority(SDL_THREAD_PRIORITY_LOW);
        try {
            Pass isolated(isolatedContext, assets);
            Pass shared(context, assets);
            render(isolated, shared);
        } catch (const std::exception &error) {
            std::cerr << "Player warm-up worker: " << error.what() << '\n';
            std::lock_guard lock(state->mutex);
            state->failed = true;
        }
        isolatedContext.unbind();
    }

public:
    explicit ActorWarmup(std::filesystem::path asset_root) : assets(std::move(asset_root)), worker([this] { run(); }) {}

    ~ActorWarmup() {
        {
            std::lock_guard lock(state->mutex);
            state->stop = true;
        }
        state->changed.notify_all();
        worker.join();
    }

    ActorWarmup(const ActorWarmup &) = delete;
    ActorWarmup &operator=(const ActorWarmup &) = delete;

    void frame(std::span<const native_render::Actor> room, NativeViewmodel &models) {
        std::lock_guard lock(state->mutex);
        for (auto &[id, admission] : actors) {
            admission.seen = false;
            admission.work->wanted = false;
        }
        for (const auto &actor : room) {
            if (actor.id == native_render::own_actor_id) continue;
            auto &admission = actors[actor.id];
            admission.seen = true;
            if (!admission.work || !same_look(admission.work->actor, actor)) {
                admission.work = request(actor);
                admission.ready = false;
            }
            auto &work = *admission.work;
            work.wanted = true;
            if (work.graphics) {
                if (!work.imported) {
                    models.import_actor_graphics(*work.graphics);
                    work.imported = true;
                }
                admission.ready = true;
            }
        }
        std::erase_if(actors, [](const auto &entry) { return !entry.second.seen; });
        std::erase_if(state->queue, [](const auto &work) {
            if (work->wanted) return false;
            work->queued = false;
            return true;
        });
        state->budget = true;
        state->changed.notify_one();
    }

    bool ready(const native_render::Actor &actor) const {
        if (actor.id == native_render::own_actor_id) return true;
        const auto found = actors.find(actor.id);
        return found != actors.end() && found->second.ready && same_look(found->second.work->actor, actor);
    }

    void
    draw(NativeViewmodel &models,
         const native_render::Actor &actor,
         const Matrix &projection,
         const float eye[3],
         double seconds) const {
        if (ready(actor)) {
            models.draw_actor(actor, projection, eye, seconds);
            return;
        }
        auto fallback = actor;
        fallback.outfit = "outfit-cream";
        fallback.loadout.clear();
        fallback.frame.weapon = 1;
        fallback.emptyHand = false;
        fallback.silenced = false;
        models.draw_actor(fallback, projection, eye, seconds);
    }
};
