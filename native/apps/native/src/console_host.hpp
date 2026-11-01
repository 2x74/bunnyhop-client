#pragma once

namespace native::console {

// Windows builds the game as a windowed program, so it opens no terminal and starts with no output to write to. Run
// from a terminal, or with --console, this connects stdout and stderr to a console so --help, --export-video and log
// lines print. Output a parent already redirected to a file or pipe is left alone. Call it first thing in main.
// Other systems need nothing here.
#ifdef _WIN32
void connect(int argc, char **argv);
#else
inline void connect(int, char **) {
}
#endif

}  // namespace native::console
