#pragma once

// The website's reduced-motion policy (viewmodel/feel.ts motionScale). It has no setting of its own: it follows the
// system's prefers-reduced-motion, which the menu's page reports here (home-menu.ts menuAppearance). Under it the
// third-person bunny's bank, idle shift, jump poses and rebound, and the first-person weapons' bob, sway, hand idle,
// movement response, shot FOV kick, switch-away lower and hard-landing camera settle run at 45%; the ear twitches and
// the speed FOV stay off.

namespace native {

inline constexpr double reduced_motion_scale = .45;

inline constexpr double motion_scale(bool reduced) {
    return reduced ? reduced_motion_scale : 1;
}

}  // namespace native
