#pragma once
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <vector>

namespace native::gfx {
// Startup exceptions can bypass a renderer's explicit handle cleanup before it falls back to another backend.
class ResourceOwners {
    struct Resource {
        void *pointer;
        void (*destroy)(void *);
    };

    std::vector<Resource> resources_;

    template <class T>
    static void destroy(void *pointer) {
        const std::unique_ptr<T> owner(static_cast<T *>(pointer));
    }

public:
    ResourceOwners() = default;
    ResourceOwners(const ResourceOwners &) = delete;
    ResourceOwners &operator=(const ResourceOwners &) = delete;

    ~ResourceOwners() {
        for (auto resource = resources_.rbegin(); resource != resources_.rend(); ++resource)
            resource->destroy(resource->pointer);
    }

    template <class T>
    uintptr_t keep(std::unique_ptr<T> resource) {
        resources_.push_back({resource.get(), destroy<T>});
        return reinterpret_cast<uintptr_t>(resource.release());
    }

    template <class T>
    void release(uintptr_t handle) {
        if (!handle) return;
        auto *pointer = reinterpret_cast<T *>(handle);
        for (size_t index = 0; index < resources_.size(); ++index) {
            if (resources_[index].pointer != pointer) continue;
            resources_[index] = resources_.back();
            resources_.pop_back();
            const std::unique_ptr<T> owner(pointer);
            return;
        }
        throw std::runtime_error("Graphics resource belongs to another context or was already destroyed");
    }
};
}  // namespace native::gfx
