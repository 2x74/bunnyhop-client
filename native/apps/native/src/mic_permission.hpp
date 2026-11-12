#pragma once
// The operating system's microphone permission. macOS asks the player once (the app bundle carries
// NSMicrophoneUsageDescription); Windows and Linux have no prompt, so they report granted and a blocked microphone
// shows up as a device that fails to open.
#include <functional>

namespace native {

enum class MicAccess { granted, denied, undetermined };

MicAccess mic_access();
// Shows the system prompt if the player hasn't answered yet. `done` runs on any thread.
void request_mic_access(std::function<void(bool granted)> done);

}  // namespace native
