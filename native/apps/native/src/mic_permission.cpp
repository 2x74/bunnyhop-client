#include "mic_permission.hpp"

namespace native {

MicAccess mic_access() {
    return MicAccess::granted;
}

void request_mic_access(std::function<void(bool granted)> done) {
    done(true);
}

}  // namespace native
