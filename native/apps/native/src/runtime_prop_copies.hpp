#pragma once
#include "bunnyhop_native.h"
#include <algorithm>
#include <span>
#include <vector>

namespace native {

// Copies share their template's frozen geometry, as on web. Rebuilding this observation removes stale seek/reset
// copies.
class RuntimePropCopies {
public:
    static constexpr size_t entity_limit = 65536;

    void load(std::span<const BhPropGroup> groups) {
        groups_.clear();
        for (const auto &group : groups) {
            if (group.entity < 0 || group.sky3d) continue;
            const auto entity = size_t(group.entity);
            if (entity >= entity_limit) continue;
            if (groups_.size() <= entity) groups_.resize(entity + 1);
            groups_[entity].push_back(group);
        }
        rows_.resize(entity_limit);
        at_.assign(entity_limit, -1);
        count_ = 0;
    }

    void refresh(BhContext *core) {
        clear_indices();
        count_ = bh_entity_instances(core, rows_.data(), rows_.size());
        index_rows();
    }

    // Also used by the headless presentation tests.
    void observe(std::span<const BhEntityInstance> rows) {
        clear_indices();
        count_ = std::min(rows.size(), rows_.size());
        std::copy_n(rows.data(), count_, rows_.data());
        index_rows();
    }

    std::span<const BhEntityInstance> instances() const { return {rows_.data(), count_}; }

    std::span<const BhPropGroup> groups(uint32_t source) const {
        return source < groups_.size() ? std::span<const BhPropGroup>(groups_[source]) : std::span<const BhPropGroup>();
    }

    const BhEntityInstance *find(int32_t entity) const {
        if (entity < 0 || size_t(entity) >= at_.size() || at_[size_t(entity)] < 0) return nullptr;
        return &rows_[size_t(at_[size_t(entity)])];
    }

private:
    std::vector<std::vector<BhPropGroup>> groups_;
    std::vector<BhEntityInstance> rows_;
    std::vector<int32_t> at_;
    size_t count_ = 0;

    void clear_indices() {
        for (const auto &row : instances())
            if (row.entity < at_.size()) at_[row.entity] = -1;
    }

    void index_rows() {
        for (size_t i = 0; i < count_; ++i)
            if (rows_[i].entity < at_.size()) at_[rows_[i].entity] = int32_t(i);
    }
};

}  // namespace native
