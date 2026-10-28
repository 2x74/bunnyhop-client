// Actual-GL regression for the immutable floor pose and animated-pose restoration.
#include "renderer.hpp"

namespace {
void(APIENTRY *realTexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *) = nullptr;
size_t identityUploads = 0, allUploads = 0, floorDrawCalls = 0;
native::Gl *trackedGl = nullptr;
GLuint identityTexture = 0;
bool checkFloor = false;
void(APIENTRY *realDrawElements)(GLenum, GLsizei, GLenum, const void *) = nullptr;
void(APIENTRY *realDrawArrays)(GLenum, GLint, GLsizei) = nullptr;

void checkFloorBinding() {
    if (checkFloor) {
        GLint binding = 0;
        trackedGl->GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
        if (GLuint(binding) != identityTexture)
            throw std::runtime_error("floor draw did not bind immutable identity pose");
        ++floorDrawCalls;
    }
}

void APIENTRY countDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
    checkFloorBinding();
    realDrawElements(mode, count, type, indices);
}

void APIENTRY countDrawArrays(GLenum mode, GLint first, GLsizei count) {
    checkFloorBinding();
    realDrawArrays(mode, first, count);
}

void APIENTRY countTexImage2D(
        GLenum target,
        GLint level,
        GLint internal,
        GLsizei width,
        GLsizei height,
        GLint border,
        GLenum format,
        GLenum type,
        const void *pixels
) {
    ++allUploads;
    if (internal == GL_RGBA32F && width == 3 && height == 1 && pixels) {
        ++identityUploads;
        GLint binding = 0;
        trackedGl->GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
        identityTexture = GLuint(binding);
    }
    realTexImage2D(target, level, internal, width, height, border, format, type, pixels);
}

void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
}  // namespace

int main(int argc, char **argv) {
    try {
        require(SDL_Init(SDL_INIT_VIDEO), SDL_GetError());
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
        SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
        auto *window = SDL_CreateWindow("Floor pose regression", 128, 128, SDL_WINDOW_OPENGL | SDL_WINDOW_HIDDEN);
        require(window, SDL_GetError());
        auto context = SDL_GL_CreateContext(window);
        require(context, SDL_GetError());
        SDL_GL_MakeCurrent(window, context);
        native::Gl gl;
        gl.load();
        trackedGl = &gl;
        realTexImage2D = gl.TexImage2D;
        gl.TexImage2D = countTexImage2D;
        realDrawElements = gl.DrawElements;
        gl.DrawElements = countDrawElements;
        realDrawArrays = gl.DrawArrays;
        gl.DrawArrays = countDrawArrays;
        {
            native::NativeViewmodel viewmodel(
                    gl, argc > 1 ? std::filesystem::path(argv[1]) : std::filesystem::path(BUNNYHOP_NATIVE_ASSET_ROOT)
            );
            require(identityUploads == 1, "identity pose must upload exactly once at construction");
            GLint animated = 0;
            gl.GetIntegerv(GL_TEXTURE_BINDING_2D, &animated);
            require(animated != 0, "animated bones binding absent");
            const float eye[3] = {0, 0, 64};
            const auto vp = native::camera_matrix(eye, 0, 20, 1);
            BhFloorWeapon floor{};
            floor.weapon = 3;
            floor.position[0] = 64;
            const auto beforeFloor = allUploads;
            checkFloor = true;
            for (int frame = 0; frame < 2; frame++)
                for (int i = 0; i < 10; i++)
                    viewmodel.draw_floor(floor, vp, eye, frame / 60.);
            checkFloor = false;
            require(floorDrawCalls == 20, "expected twenty real floor weapon draws");
            require(allUploads == beforeFloor, "floor draws must not upload textures");
            GLint binding = 0;
            gl.GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
            require(binding == animated, "floor draws must restore animated bones binding");
            BhSnapshot snapshot{};
            snapshot.player.tick = 1;
            viewmodel.draw(128, 128, snapshot, 1, 0, false, 0, 1.);
            require(allUploads > beforeFloor, "animated viewmodel must still upload its pose");
            gl.GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
            require(binding == animated, "animated viewmodel must select its own bones texture");
            const auto beforeAgain = allUploads;
            checkFloor = true;
            viewmodel.draw_floor(floor, vp, eye, 1.1);
            checkFloor = false;
            require(allUploads == beforeAgain, "floor following animated pose must reuse identity texture");
            gl.GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
            require(binding == animated, "floor following animation must restore animated binding");
            native_render::Actor actor;
            actor.id = "floor-pose-smoke";
            actor.frame.position[0] = 64;
            actor.frame.flags = 2;
            actor.frame.weapon = 1;
            actor.frame.tick = 1;
            const auto beforeActor = allUploads;
            viewmodel.draw_actor(actor, vp, eye, 1.2);
            require(allUploads > beforeActor, "animated actor must still upload its pose");
            gl.GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
            require(binding == animated, "animated actor must select its own bones texture");
            require(identityUploads == 1, "floor pose must stay immutable across frames and animation");
            require(gl.GetError() == GL_NO_ERROR, "GL error in floor pose regression");
            std::cout << "Floor pose regression passed: identity uploads=1; 21 floor draws=0 uploads; animated binding "
                         "restored\n";
        }
        SDL_GL_DestroyContext(context);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 0;
    } catch (const std::exception &e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
