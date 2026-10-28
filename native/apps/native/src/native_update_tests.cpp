#include "native_update.hpp"
#include <cassert>
#include <fstream>
#include <iostream>

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
    std::cout << count << " signed manifest cases and updater policy checks passed\n";
}
