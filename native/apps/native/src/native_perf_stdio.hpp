#pragma once

namespace native_perf {
// The headless menu fixture uses the real asynchronous host service over newline-delimited JSON.
inline void serve_previews(const std::filesystem::path &assets) {
    LoadoutPreviewService previews(assets);
    std::atomic_bool closed = false;
    std::thread input([&] {
        std::string line;
        while (std::getline(std::cin, line)) {
            try {
                auto request = nlohmann::json::parse(line);
                if (request.value("type", std::string()) == "loadoutPreviewCancel")
                    previews.cancel(request.value("id", 0u));
                else
                    previews.request(std::move(request));
            } catch (const std::exception &error) {
                std::cerr << "Preview fixture: " << error.what() << '\n';
            }
        }
        closed = true;
    });
    while (!closed) {
        for (const auto &reply : previews.take_replies()) {
            const auto start = reply.find('(');
            std::cout << reply.substr(start + 1, reply.size() - start - 2) << std::endl;
        }
        SDL_Delay(2);
    }
    input.join();
}
}  // namespace native_perf
