#include "gfx_resource_owners.hpp"
#include <cassert>
#include <memory>
#include <stdexcept>

namespace {
struct Resource {
    int &live;

    explicit Resource(int &count) : live(count) { ++live; }

    ~Resource() { --live; }
};

void failed_startup_releases_resources() {
    int live = 0;
    try {
        native::gfx::ResourceOwners context;
        const auto first = context.keep(std::make_unique<Resource>(live));
        context.keep(std::make_unique<Resource>(live));
        assert(live == 2);
        context.release<Resource>(first);
        assert(live == 1);
        context.keep(std::make_unique<Resource>(live));
        throw std::runtime_error("Asset setup failed");
    } catch (const std::runtime_error &) {
    }
    assert(live == 0);
}

void explicit_cleanup_does_not_release_twice() {
    int live = 0;
    {
        native::gfx::ResourceOwners context;
        const auto first = context.keep(std::make_unique<Resource>(live));
        const auto second = context.keep(std::make_unique<Resource>(live));
        context.release<Resource>(second);
        context.release<Resource>(first);
        context.release<Resource>(0);
        assert(live == 0);
    }
    assert(live == 0);
}
}  // namespace

int main() {
    failed_startup_releases_resources();
    explicit_cleanup_does_not_release_twice();
}
