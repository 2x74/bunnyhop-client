#include "discord_rpc.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <iostream>
#include <string>
#ifndef _WIN32
#include <filesystem>
#include <sys/socket.h>
#include <sys/un.h>
#include <thread>
#include <unistd.h>
#endif

using native::discord::Json;
namespace d = native::discord;

static std::string fake_hash(const std::string &text) { return std::string(64, text.size() % 2 ? 'a' : 'b'); }

int main() {
    // Frames round-trip and arrive whole even when split.
    {
        auto bytes = d::encode_frame(1, {{"cmd", "X"}});
        std::string buffer = bytes.substr(0, 5);
        assert(d::decode_frames(buffer).empty());
        buffer += bytes.substr(5) + d::encode_frame(3, {{"n", 1}});
        const auto frames = d::decode_frames(buffer);
        assert(frames.size() == 2 && frames[0].op == 1 && frames[0].payload["cmd"] == "X" && frames[1].op == 3 && buffer.empty());
        std::string huge("\x01\0\0\0\xff\xff\xff\x00", 8);
        bool threw = false; try { d::decode_frames(huge); } catch (...) { threw = true; }
        assert(threw);
    }
    // Join secrets only ever lead to a server or a lobby id.
    assert(d::join_secret("eu-1") == "bh1:s:eu-1" && d::join_secret("p-abcdefghij") == "bh1:l:abcdefghij");
    assert(d::join_target("bh1:s:eu-1") == std::optional<std::string>("eu-1"));
    assert(d::join_target("bh1:l:abcdefghij") == std::optional<std::string>("p-abcdefghij"));
    for (const char *bad : {"", "bh1:s:", "bh1:s:../x", "bh1:l:short", "bh1:s:p-abcdefghij", "bh1:x:eu-1", "bh1:s:EU-1", "bh1:l:abcdefghi1"})
        assert(!d::join_target(bad));
    // Activity: what shows, and what privacy hides.
    {
        d::Status s; s.kind = "playing"; s.mode = "multiplayer"; s.map = "bhop_arcane"; s.style = "Normal"; s.started_at = 1'800'000'000; s.room = "eu-1";
        d::Settings on;
        auto a = d::build_activity(s, on, fake_hash, 1'800'000'100);
        assert(a["details"] == "Hopping on bhop_arcane" && a["state"] == "Multiplayer · Normal" && a["timestamps"]["start"] == 1'800'000'000);
        assert(a["secrets"]["join"] == "bh1:s:eu-1" && a["party"]["id"].get<std::string>().size() == 32 && !a.contains("buttons"));
        auto stripped = d::without_join(a);
        assert(!stripped.contains("secrets") && !stripped.contains("party") && stripped["buttons"][0]["url"] == "https://bunnyhop.lol");
        d::Settings hidden; hidden.show_map = false;
        assert(d::build_activity(s, hidden, fake_hash, 1'800'000'100)["details"] == "Bunnyhopping");
        d::Settings privacy; privacy.privacy = true;
        auto p = d::build_activity(s, privacy, fake_hash, 1'800'000'100);
        assert(p["details"] == "Bunnyhopping" && p["state"] == "Multiplayer" && !p.contains("secrets"));
        d::Settings no_join; no_join.join = false;
        assert(!d::build_activity(s, no_join, fake_hash, 1'800'000'100).contains("secrets"));
        s.room = "p-abcdefghij";
        assert(!d::build_activity(s, on, fake_hash, 1'800'000'100).contains("secrets"));   // lobbies are opt-in
        d::Settings lobbies; lobbies.join_lobbies = true;
        assert(d::build_activity(s, lobbies, fake_hash, 1'800'000'100)["secrets"]["join"] == "bh1:l:abcdefghij");
        s.kind = "menu";
        auto m = d::build_activity(s, lobbies, fake_hash, 1'800'000'100);
        assert(m["details"] == "In the menu" && m["state"] == "Bunnyhop" && !m.contains("secrets"));
        s.kind = "playing"; s.started_at = 5;   // nonsense start: falls back to now
        assert(d::build_activity(s, on, fake_hash, 1'800'000'100)["timestamps"]["start"] == 1'800'000'100);
        s.map = std::string("evil\n\x01map") + std::string(200, 'x');
        const auto details = d::build_activity(s, on, fake_hash, 1'800'000'100)["details"].get<std::string>();
        assert(details.find('\n') == std::string::npos && details.size() <= 11 + 64);
    }
#ifndef _WIN32
    // The whole loop against a fake Discord: handshake, READY, activity,
    // a friend's Join, and the client noticing Discord go away.
    {
        const auto dir = std::filesystem::temp_directory_path() / ("bh-discord-test-" + std::to_string(getpid()));
        std::filesystem::create_directories(dir);
        setenv("XDG_RUNTIME_DIR", dir.c_str(), 1);
        const auto path = (dir / "discord-ipc-0").string();
        const int server = socket(AF_UNIX, SOCK_STREAM, 0);
        sockaddr_un addr{}; addr.sun_family = AF_UNIX; std::strcpy(addr.sun_path, path.c_str());
        assert(bind(server, reinterpret_cast<sockaddr *>(&addr), sizeof addr) == 0 && listen(server, 1) == 0);

        d::Client client;
        std::string joined;
        client.on_join = [&](const std::string &id) { joined = id; };
        Json activity = {{"details", "Hopping on bhop_arcane"}, {"secrets", {{"join", "bh1:s:eu-1"}}}, {"party", {{"id", "x"}}}};
        client.update(true, activity);
        assert(client.state == "connecting");
        const int peer = accept(server, nullptr, nullptr);
        assert(peer >= 0);
        std::string inbox; std::vector<d::Frame> got;
        auto receive = [&](size_t want) {
            char buffer[4096];
            for (int spins = 0; got.size() < want && spins < 200; ++spins) {
                client.update(true, activity);
                timeval tv{0, 5000}; setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
                const auto n = recv(peer, buffer, sizeof buffer, 0);
                if (n > 0) { inbox.append(buffer, size_t(n)); for (auto &f : d::decode_frames(inbox)) got.push_back(f); }
            }
            assert(got.size() >= want);
        };
        auto say = [&](uint32_t op, const Json &payload) { const auto f = d::encode_frame(op, payload); assert(send(peer, f.data(), f.size(), 0) == ssize_t(f.size())); };
        receive(1);
        assert(got[0].op == d::op_handshake && got[0].payload["client_id"] == d::application_id && got[0].payload["v"] == 1);
        say(d::op_frame, {{"cmd", "DISPATCH"}, {"evt", "READY"}, {"data", Json::object()}});
        receive(3);
        assert(client.state == "ready");
        assert(got[1].payload["cmd"] == "SUBSCRIBE" && got[1].payload["evt"] == "ACTIVITY_JOIN");
        assert(got[2].payload["cmd"] == "SET_ACTIVITY" && got[2].payload["args"]["activity"]["secrets"]["join"] == "bh1:s:eu-1");
        assert(got[2].payload["args"]["pid"] == long(getpid()));
        // Discord turns down the Join secret: the same activity goes again without it.
        say(d::op_frame, {{"cmd", "SET_ACTIVITY"}, {"evt", "ERROR"}, {"data", {{"message", "no"}}}});
        receive(4);
        assert(got[3].payload["cmd"] == "SET_ACTIVITY" && !got[3].payload["args"]["activity"].contains("secrets"));
        assert(got[3].payload["args"]["activity"]["buttons"][0]["label"] == "Play Bunnyhop");
        // Ping is answered.
        say(d::op_ping, {{"n", 7}});
        receive(5);
        assert(got[4].op == d::op_pong && got[4].payload["n"] == 7);
        // A friend presses Join; a forged secret is ignored.
        say(d::op_frame, {{"cmd", "DISPATCH"}, {"evt", "ACTIVITY_JOIN"}, {"data", {{"secret", "bh1:s:../../etc"}}}});
        for (int i = 0; i < 20; ++i) client.update(true, activity);
        assert(joined.empty());
        say(d::op_frame, {{"cmd", "DISPATCH"}, {"evt", "ACTIVITY_JOIN"}, {"data", {{"secret", "bh1:s:eu-1"}}}});
        for (int i = 0; i < 50 && joined.empty(); ++i) { client.update(true, activity); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
        assert(joined == "eu-1");
        // Discord quits: the client notices and backs off instead of spinning.
        close(peer);
        for (int i = 0; i < 50 && client.state != "reconnecting"; ++i) { client.update(true, activity); std::this_thread::sleep_for(std::chrono::milliseconds(2)); }
        assert(client.state == "reconnecting");
        client.update(false, Json());
        assert(client.state == "disabled");
        close(server); std::filesystem::remove_all(dir);
    }
#endif
    std::cout << "discord rpc ok\n";
}
