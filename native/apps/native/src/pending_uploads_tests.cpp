#include "menu_messages.hpp"
#include "pending_uploads.hpp"
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <chrono>
#include <fstream>

namespace {

void pending_upload_files_round_trip() {
    const auto root =
            std::filesystem::temp_directory_path()
            / ("bunnyhop-pending-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::filesystem::create_directories(root / "replays");
    {
        std::ofstream(root / "replays" / "bhop_a-1.bhr", std::ios::binary) << std::string("\x1f\x8b\x00\x01", 4);
    }
    const native::PendingUploadFiles files(root / "pending-uploads", root / "replays");
    assert(files.list().empty());
    files.save("bhop_a-1.bhr", {{"beats", {"t1", "t2"}}, {"account", "u1"}});
    const auto listed = files.list();
    assert(listed.size() == 1 && listed[0].first == "bhop_a-1.bhr" && listed[0].second["account"] == "u1");
    assert(files.replay("bhop_a-1.bhr") == std::string("\x1f\x8b\x00\x01", 4));
    assert(!files.replay("bhop_gone-2.bhr"));
    bool refused = false;
    try {
        files.save("../escape.bhr", nlohmann::json::object());
    } catch (const std::exception &) {
        refused = true;
    }
    assert(refused);
    const auto answer =
            native::PendingUploads::answer(files, {{"action", "replay"}, {"id", "bhop_a-1.bhr"}, {"request", "r1"}});
    assert(answer && (*answer)["replayBase64"] == "H4sAAQ==" && (*answer)["request"] == "r1");
    const auto list = native::PendingUploads::answer(files, {{"action", "list"}, {"request", "r2"}});
    assert(list && (*list)["records"].size() == 1);
    // Removing a record leaves the replay in the archive.
    native::PendingUploads::answer(files, {{"action", "remove"}, {"id", "bhop_a-1.bhr"}});
    assert(files.list().empty() && files.replay("bhop_a-1.bhr"));
    std::filesystem::remove_all(root);
}

}  // namespace

// The menu's save message carries the largest record the store keeps.
void the_host_accepts_a_full_record() {
    assert(native::menu_message_limit("pendingUpload") > native::PendingUploadFiles::max_record_bytes);
}

int main() {
    pending_upload_files_round_trip();
    the_host_accepts_a_full_record();
}
