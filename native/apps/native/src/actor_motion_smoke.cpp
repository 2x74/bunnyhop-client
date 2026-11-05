// Actual-GL captures of the third-person bunny's motion (hidden window): standing after the idle shift starts, banking
// into an air strafe seen from behind, the apex tuck from the side, and a bunny far enough away for the distance
// contour. Writes PNGs for a look and fails on GL errors or blank frames.
#include "menu_backdrop.hpp"
#include "renderer.hpp"
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>

namespace {

constexpr int width = 640, height = 480;
constexpr double frame_seconds = 1. / 60;

void require(bool value, const std::string &message) {
    if (!value) throw std::runtime_error(message);
}

struct Shot {
    std::string name;
    // Seconds of motion before the capture, the bunny's velocity, the view's turn rate (degrees/s), the strafe key.
    double seconds;
    std::array<float, 3> velocity;
    double turn_rate, sidemove;
    bool grounded;
    // Camera: offset from the bunny's feet in its own frame (+x ahead, +y left) and the look angles from its yaw.
    std::array<float, 3> camera;
    double yaw, pitch;
};

class Captures {
public:
    Captures(native::Gl &gl, const std::filesystem::path &assets, std::filesystem::path output)
        : gl_(gl)
        , models_(gl, assets)
        , output_(std::move(output)) {
        std::filesystem::create_directories(output_);
    }

    void take(const Shot &shot) {
        native_render::Actor actor;
        actor.id = "smoke-" + shot.name;
        actor.opacity = 1;
        actor.frame.weapon = 1;
        actor.frame.flags = shot.grounded ? 2 : 0;
        actor.sidemove = float(shot.sidemove);
        std::copy(shot.velocity.begin(), shot.velocity.end(), actor.frame.velocity);
        double time = 0;
        float yaw = 0;
        for (; time < shot.seconds; time += frame_seconds) {
            yaw += float(shot.turn_rate * frame_seconds);
            actor.frame.yaw = yaw;
            models_.pose_actor(actor, time);
        }
        const double radians = yaw * native::radians, c = std::cos(radians), s = std::sin(radians);
        const float eye[3] = {
                float(c * shot.camera[0] - s * shot.camera[1]),
                float(s * shot.camera[0] + c * shot.camera[1]),
                shot.camera[2]
        };
        const auto view = native::camera_matrix(eye, yaw + shot.yaw, shot.pitch, float(width) / height);
        gl_.Viewport(0, 0, width, height);
        gl_.ClearColor(.55f, .62f, .7f, 1);
        gl_.DepthMask(GL_TRUE);
        gl_.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
        models_.draw_actor(actor, view, eye, time);
        require(gl_.GetError() == GL_NO_ERROR, shot.name + ": GL error");
        const auto png = backbuffer_png(gl_, width, height, 4000000);
        require(png.size() > 1000 && seen_.insert(png).second, shot.name + ": blank or repeated capture");
        std::ofstream(output_ / (shot.name + ".png"), std::ios::binary) << png;
        std::cout << shot.name << ": bank " << models_.actor_bank(actor.id) << " degrees\n";
    }

private:
    native::Gl &gl_;
    native::NativeViewmodel models_;
    std::filesystem::path output_;
    std::set<std::string> seen_;
};

}  // namespace

int main(int argc, char **argv) {
    try {
        require(argc == 3, "usage: actor-motion-smoke ASSETS OUTPUT");
        require(SDL_Init(SDL_INIT_VIDEO), SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 24);
        auto *window = SDL_CreateWindow("Bunny motion", width, height, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        require(window, SDL_GetError());
        auto context = SDL_GL_CreateContext(window);
        require(context, SDL_GetError());
        SDL_GL_MakeCurrent(window, context);
        native::Gl gl;
        gl.load();
        {
            Captures captures(gl, argv[1], argv[2]);
            // Behind is -x (the bunny faces +x at yaw 0); the side is -y.
            captures.take({"idle-front", 3, {0, 0, 0}, 0, 0, true, {110, 0, 40}, 180, 8});
            captures.take({"strafe-right-behind", 1.2, {500, 0, 120}, -30, 450, false, {-110, 0, 52}, 0, 10});
            captures.take({"strafe-left-behind", 1.2, {500, 0, 120}, 30, -450, false, {-110, 0, 52}, 0, 10});
            captures.take({"apex-side", .3, {0, 0, 0}, 0, 0, false, {0, -110, 36}, 90, 0});
            captures.take({"far-behind", 2, {0, 0, 0}, 0, 0, true, {-420, 0, 120}, 0, 12});
        }
        SDL_GL_DestroyContext(context);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 0;
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
