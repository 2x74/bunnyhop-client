#pragma once
#include "practice.hpp"
#include "input_binds.hpp"
#include "run_session.hpp"
#include <optional>

namespace native {

struct PracticeController : Practice {
    std::optional<std::string> activate(BhContext *core, const std::string &tool);
    nlohmann::json
    enter(BhContext *core,
          const std::string &tool,
          RunRecorder &recorder,
          RunHeartbeat &heartbeat,
          std::string &score_notice);
    static std::string help(const BindTable &binds);
    void
    save(BhContext *core,
         const Input &input,
         const std::string &selected_style,
         const std::string &active_style,
         uint32_t track);
    void begin_flight(const BhState &state);
    bool exit_flight(BhContext *core, const Input &input, BhState &current, BhState &previous);
    BhCmd restore(BhContext *core) const;
    BhState restore_velocity(BhContext *core, bool keep_velocity);
    nlohmann::json state(const std::string &unavailable, bool third_person, bool keep_velocity) const;
};

}  // namespace native
