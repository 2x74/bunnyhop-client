#pragma once

namespace native::anti_lag {

// AMD Anti-Lag 2 (ffx_antilag2_dx11.h). initialize() is true on an AMD driver that has it, once a D3D11 device
// exists. update() goes just before input is read, once a frame.
bool initialize();
void update(bool enabled, unsigned max_fps);
void shutdown();

}  // namespace native::anti_lag
