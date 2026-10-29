#include "native_update.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#ifndef _WIN32
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <random>
#include <thread>

namespace {
using native::updates::Json;
namespace fs = std::filesystem;

// A loopback HTTP server for the updater's test hooks: one request per connection, Connection: close.
class ReleaseServer {
    int socket_ = -1;
    std::thread thread_;
    std::atomic_bool stop_{false};
    std::mutex mutex_;
    std::string manifest_, body_;

    std::string respond(const std::string &path) {
        std::lock_guard lock(mutex_);
        const auto ok = [](const std::string &text) {
            return "HTTP/1.1 200 OK\r\nContent-Length: " + std::to_string(text.size()) + "\r\n\r\n" + text;
        };
        const auto redirect = [](const std::string &location) {
            return "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nContent-Length: 6\r\n\r\nmoved!";
        };
        if (path == "/manifest") return ok(manifest_);
        if (path.starts_with("/redirect/")) return redirect("/files/" + path.substr(10));
        if (path.starts_with("/files/")) return ok(body_);
        if (path == "/offsite") return redirect("http://127.0.0.1:1/files/package.zip");
        return "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
    }

    void serve() {
        while (!stop_) {
            const int client = accept(socket_, nullptr, nullptr);
            if (client < 0) continue;
            char buffer[4096]{};
            const auto received = recv(client, buffer, sizeof buffer - 1, 0);
            const std::string request(buffer, received > 0 ? size_t(received) : 0);
            const auto start = request.find(' ') + 1;
            const auto reply = respond(request.substr(start, request.find(' ', start) - start));
            send(client, reply.data(), reply.size(), 0);
            close(client);
        }
    }

public:
    bool listening = false;

    explicit ReleaseServer(int port, std::string body) : body_(std::move(body)) {
        socket_ = socket(AF_INET, SOCK_STREAM, 0);
        const int reuse = 1;
        setsockopt(socket_, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
        sockaddr_in address{};
        address.sin_family = AF_INET;
        address.sin_port = htons(uint16_t(port));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        listening =
                bind(socket_, reinterpret_cast<sockaddr *>(&address), sizeof address) == 0 && listen(socket_, 8) == 0;
        if (listening) thread_ = std::thread([this] { serve(); });
    }

    ~ReleaseServer() {
        stop_ = true;
        shutdown(socket_, SHUT_RDWR);
        close(socket_);
        if (thread_.joinable()) thread_.join();
    }

    void publish(const Json &envelope) {
        std::lock_guard lock(mutex_);
        manifest_ = envelope.dump();
    }
};

Json settle(native::updates::Service &service) {
    for (int attempt = 0; attempt < 600; attempt++) {
        auto state = service.state();
        const auto status = state.value("status", std::string());
        if (status != "checking" && status != "downloading" && status != "staging") return state;
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
    return service.state();
}

// check → download through the real fetch loop, against releases the oracle signed.
void service_against_local_releases(const Json &fixture) {
    ReleaseServer server(fixture.at("port").get<int>(), fixture.at("body").get<std::string>());
    if (!server.listening) {
        std::cout << "skipped loopback release checks: port " << fixture.at("port") << " is busy\n";
        return;
    }
    const auto folder =
            fs::temp_directory_path() / ("bunnyhop-update-service-" + std::to_string(std::random_device()()));
    const auto &trust = fixture.at("trust");
    const auto &releases = fixture.at("releases");
    native::updates::Service service(trust, folder, "0.6.2", "bunnyhop-native/" + std::string(24, 'a'));

    server.publish(releases.at("older"));
    service.check();
    assert(settle(service).at("status") == "current");  // a downgrade is never offered

    server.publish(releases.at("otherPlatform"));
    service.check();
    assert(settle(service).at("status") == "error");

    server.publish(releases.at("tampered"));
    service.check();
    assert(settle(service).at("status") == "available");
    service.download();
    const auto tampered = settle(service);
    assert(tampered.at("status") == "error" && !tampered.at("packageSaved").get<bool>());

    server.publish(releases.at("newer"));
    service.check();
    const auto available = settle(service);
    assert(available.at("status") == "available" && available.at("version") == "9.0.0");
    assert(available.at("notes") == "Notes for 9.0.0" && available.at("wasm") == "bunnyhop-web/ffffffffffff");
    service.download();
    const auto ready = settle(service);
    assert(ready.at("status") == "ready" && ready.at("packageSaved").get<bool>());  // no install layout: manual
    assert(!ready.at("inPlace").get<bool>());

    native::updates::Transfer transfer{{}, nullptr, 1024, 0, nullptr, nullptr};
    std::atomic_bool cancel{false};
    transfer.cancel = &cancel;
    const auto origin = trust.at("downloadOrigins").at(0).get<std::string>();
    bool refused = false;
    try {
        native::updates::fetch(origin + "/offsite", trust, transfer);
    } catch (const std::exception &e) {
        refused = std::string(e.what()).find("pinned") != std::string::npos;
    }
    assert(refused);  // a redirect to another port is another origin
    std::error_code ec;
    fs::remove_all(folder, ec);
}
}  // namespace
#endif

int main(int argc, char **argv) {
    using namespace native::updates;
    assert(argc == 2);
    std::ifstream file(argv[1]);
    const auto fixtures = Json::parse(file);
    unsigned count = 0;
    for (const auto &c : fixtures.at("cases")) {
        bool accepted = false;
        try {
            verify_manifest(c.at("envelope").dump(), fixtures.at("trust"), fixtures.at("now"));
            accepted = true;
        } catch (const std::exception &) {
        }
        if (accepted != c.at("valid").get<bool>()) {
            std::cerr << "Failed case: " << c.at("name") << '\n';
            return 1;
        }
        ++count;
    }
    assert(newer("0.4.0", "0.3.9"));
    assert(!newer("0.3.9", "0.4.0"));
    assert(!newer("0.4.0", "0.4.0"));
    assert(newer("0.4.0", "0.4.0-rc.10"));
    assert(newer("0.4.0-rc.10", "0.4.0-rc.2"));
    assert(!newer("0.4.0-rc.2", "0.4.0"));
    assert(newer("0.4.0", "local"));
    for (const std::string url :
         {"http://download.example.test/a",
          "https://user@download.example.test/a",
          "https://download.example.test:444/a",
          "https://evil.test/a",
          "https://download.example.test/a#frag"}) {
        bool failed = false;
        try {
            allowed(url, fixtures.at("trust"));
        } catch (...) {
            failed = true;
        }
        assert(failed);
    }
    allowed("https://download.example.test:443/a", fixtures.at("trust"));
    Service disabled(
            {{"schema", 1}, {"keys", Json::array()}, {"downloadOrigins", Json::array()}}, "/unused", "0.4.0", "local"
    );
    assert(disabled.state().at("status") == "disabled");
    disabled.check();
    disabled.download();
    assert(disabled.state().at("status") == "disabled");
#ifndef _WIN32
    service_against_local_releases(fixtures.at("service"));
#endif
    std::cout << count << " signed manifest cases and updater policy checks passed\n";
}
