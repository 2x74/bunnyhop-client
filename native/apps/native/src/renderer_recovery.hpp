#pragma once
#include "client_graphics.hpp"
#include "game_session.hpp"
#include "renderer_launch.hpp"
#include "run_session.hpp"
#include <exception>
#include <iostream>

namespace native {
// Save while the simulation still exists, before a failed graphics session unwinds its resources.
class RendererRecovery {
    ClientGraphics &graphics_;
    GameSession &game_;
    RunRecorder &recorder_;
    RendererLaunch &launch_;
    int exceptions_ = std::uncaught_exceptions();

public:
    RendererRecovery(ClientGraphics &graphics, GameSession &game, RunRecorder &recorder, RendererLaunch &launch)
        : graphics_(graphics)
        , game_(game)
        , recorder_(recorder)
        , launch_(launch) {}

    ~RendererRecovery() {
        if (std::uncaught_exceptions() <= exceptions_ || !graphics_.failed()) return;
        launch_.device_lost = true;
        try {
            launch_.recovery = recorder_.preserve_interrupted(game_.core.get());
        } catch (const std::exception &error) {
            std::cerr << "Saving interrupted replay: " << error.what() << '\n';
            launch_.recovery = " The unfinished replay could not be saved.";
        }
    }
};
}  // namespace native
