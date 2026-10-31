#pragma once

namespace native::log {

// A last line in the log when the process dies: what killed it and the last map state. Covers std::terminate,
// unhandled exceptions on Windows and fatal signals on macOS and Linux. Windows fail-fast exits (0xc0000409) can't run
// any handler; the next launch notes that the session ended without a clean exit.
void install_crash_notes();

}  // namespace native::log
