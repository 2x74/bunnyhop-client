#pragma once
#include <algorithm>
#include <filesystem>
#include <stdexcept>
#include <fstream>
#include <iostream>
#include <thread>

namespace native {
// Only successful presentation clears this file; unwinding a failed launch must leave it behind.
class RendererGuard {
    std::filesystem::path marker_;
    std::thread cleanup_;
    unsigned frames_ = 0;
    bool marked_ = false;
    static constexpr unsigned startup_frames = 3;
    static constexpr unsigned failed_launch_limit = 2;

public:
    explicit RendererGuard(std::filesystem::path root) : marker_(std::move(root) / "d3d11-startup.pending") {}

    ~RendererGuard() {
        if (cleanup_.joinable()) cleanup_.join();
    }

    unsigned failures() const {
        if (!std::filesystem::exists(marker_)) return 0;
        unsigned count = 1;
        std::ifstream input(marker_);
        if (!(input >> count)) return 1;
        return std::min(count, failed_launch_limit);
    }

    bool blocked() const { return failures() >= failed_launch_limit; }

    void starting() {
        const auto count = failures() + 1;
        std::filesystem::create_directories(marker_.parent_path());
        std::ofstream output(marker_, std::ios::trunc);
        output << count << '\n';
        output.close();
        if (!output) throw std::runtime_error("Could not save D3D11 startup recovery");
        marked_ = true;
    }

    void presented() {
        if (marked_ && ++frames_ == startup_frames) clear();
    }

    void clear() {
        if (!marked_) return;
        marked_ = false;
        cleanup_ = std::thread([path = marker_] {
            std::error_code error;
            std::filesystem::remove(path, error);
            if (error) std::cerr << "Renderer startup recovery: " << error.message() << '\n';
        });
    }
};
}  // namespace native
