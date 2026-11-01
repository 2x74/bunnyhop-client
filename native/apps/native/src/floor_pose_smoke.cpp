// Actual-GL regression for the immutable floor pose and animated-pose restoration.
#include "renderer.hpp"

namespace {
void(APIENTRY *realTexImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *) = nullptr;
size_t identityUploads = 0, allUploads = 0, textureDefinitions = 0, floorDrawCalls = 0;
static decltype(native::Gl::TexSubImage2D) realTexSubImage2D = nullptr;
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
    ++textureDefinitions;
    if (internal == GL_RGBA32F && width == 3 && height == 1 && pixels) {
        ++identityUploads;
        GLint binding = 0;
        trackedGl->GetIntegerv(GL_TEXTURE_BINDING_2D, &binding);
        identityTexture = GLuint(binding);
    }
    realTexImage2D(target, level, internal, width, height, border, format, type, pixels);
}

void APIENTRY countTexSubImage2D(
        GLenum target,
        GLint level,
        GLint x,
        GLint y,
        GLsizei width,
        GLsizei height,
        GLenum format,
        GLenum type,
        const void *pixels
) {
    ++allUploads;
    realTexSubImage2D(target, level, x, y, width, height, format, type, pixels);
}

void require(bool value, const char *message) {
    if (!value) throw std::runtime_error(message);
}
}  // namespace

namespace {
void capture(native::Gl &gl, const std::filesystem::path &directory, const char *name) {
    if (directory.empty()) return;
    std::filesystem::create_directories(directory);
    constexpr int capture_size = 128;
    std::array<uint8_t, capture_size * capture_size * 3> pixels;
    gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
    gl.ReadPixels(0, 0, capture_size, capture_size, GL_RGB, GL_UNSIGNED_BYTE, pixels.data());
    std::ofstream file(directory / (std::string(name) + ".ppm"), std::ios::binary);
    file << "P6\n" << capture_size << ' ' << capture_size << "\n255\n";
    file.write(reinterpret_cast<const char *>(pixels.data()), pixels.size());
}

void clear_capture(native::Gl &gl) {
    gl.Viewport(0, 0, 128, 128);
    gl.DepthMask(GL_TRUE);
    gl.ColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
    gl.ClearColor(.045f, .06f, .085f, 1);
    gl.Clear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

void capture_weapons(native::Gl &gl, native::NativeViewmodel &models, const std::filesystem::path &output) {
    if (output.empty()) return;
    models.cosmetics("outfit-cream", "2;knife-bayonet;fin-geode;glove-sport-pandora");
    for (bool mirrored : {false, true}) {
        models.settings(54, .6f, 1.5f, -.9f, mirrored);
        for (uint32_t weapon : {1u, 3u}) {
            models.reset_presentation();
            BhSnapshot snapshot{};
            models.draw(128, 128, snapshot, weapon, 0, false, 0, 0);
            clear_capture(gl);
            models.draw(128, 128, snapshot, weapon, 0, false, 0, 2);
            const auto name = std::string(mirrored ? "mirrored-" : "") + (weapon == 1 ? "knife" : "gun");
            capture(gl, output, name.c_str());
        }
    }
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
        const std::filesystem::path output = argc > 2 ? argv[2] : "";
        trackedGl = &gl;
        realTexImage2D = gl.TexImage2D;
        gl.TexImage2D = countTexImage2D;
        realTexSubImage2D = gl.TexSubImage2D;
        gl.TexSubImage2D = countTexSubImage2D;
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
            const auto definitions = textureDefinitions;
            clear_capture(gl);
            const auto beforeFloor = allUploads;
            checkFloor = true;
            for (int frame = 0; frame < 2; frame++)
                for (int i = 0; i < 10; i++)
                    viewmodel.draw_floor(floor, vp, eye, frame / 60.);
            checkFloor = false;
            capture(gl, output, "floor");
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
            capture(gl, output, "actor");
            capture_weapons(gl, viewmodel, output);
            require(identityUploads == 1, "floor pose must stay immutable across frames and animation");
            require(textureDefinitions == definitions, "animated draws must reuse allocated bone storage");
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
