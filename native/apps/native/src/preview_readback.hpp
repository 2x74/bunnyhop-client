#pragma once
#include <cstring>
#include <span>

namespace native {
// One transfer per slot. A zero-timeout fence poll keeps mapping from waiting for GPU work.
class PreviewReadback {
    Gl &gl;
    GLuint buffer = 0;
    GLsync fence = nullptr;
    int width = 0, height = 0;

public:
    struct Pixels {
        int width = 0, height = 0;
        std::vector<unsigned char> rgb;
    };

    explicit PreviewReadback(Gl &api) : gl(api) { gl.GenBuffers(1, &buffer); }

    ~PreviewReadback() {
        if (fence) gl.DeleteSync(fence);
        gl.DeleteBuffers(1, &buffer);
    }

    PreviewReadback(const PreviewReadback &) = delete;
    PreviewReadback &operator=(const PreviewReadback &) = delete;

    bool pending() const { return fence != nullptr; }

    void submit(int w, int h) {
        if (pending()) throw std::runtime_error("Preview readback slot is busy");
        GLint previous = 0, alignment = 4;
        gl.GetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &previous);
        gl.GetIntegerv(GL_PACK_ALIGNMENT, &alignment);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, buffer);
        gl.PixelStorei(GL_PACK_ALIGNMENT, 1);
        if (width != w || height != h) {
            width = w;
            height = h;
            gl.BufferData(GL_PIXEL_PACK_BUFFER, size_t(w) * h * 3, nullptr, GL_STREAM_READ);
        }
        gl.ReadPixels(0, 0, w, h, GL_RGB, GL_UNSIGNED_BYTE, nullptr);
        fence = gl.FenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.PixelStorei(GL_PACK_ALIGNMENT, alignment);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, GLuint(previous));
        if (!fence) throw std::runtime_error("Preview readback fence failed");
    }

    std::optional<Pixels> poll() {
        if (!fence) return std::nullopt;
        const auto status = gl.ClientWaitSync(fence, GL_SYNC_FLUSH_COMMANDS_BIT, 0);
        if (status == GL_TIMEOUT_EXPIRED) return std::nullopt;
        if (status == GL_WAIT_FAILED) throw std::runtime_error("Preview readback fence wait failed");
        gl.DeleteSync(fence);
        fence = nullptr;
        Pixels pixels{width, height, std::vector<unsigned char>(size_t(width) * height * 3)};
        GLint previous = 0;
        gl.GetIntegerv(GL_PIXEL_PACK_BUFFER_BINDING, &previous);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, buffer);
        const auto *mapped = gl.MapBufferRange(GL_PIXEL_PACK_BUFFER, 0, pixels.rgb.size(), GL_MAP_READ_BIT);
        if (mapped) std::memcpy(pixels.rgb.data(), mapped, pixels.rgb.size());
        const bool valid = mapped && gl.UnmapBuffer(GL_PIXEL_PACK_BUFFER);
        gl.BindBuffer(GL_PIXEL_PACK_BUFFER, GLuint(previous));
        if (!valid) throw std::runtime_error("Preview readback mapping failed");
        return pixels;
    }
};
}  // namespace native
