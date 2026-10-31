#pragma once

namespace native {
// Window policy also runs without a graphics device in display tests and recovery windows.
class WindowPresenter {
public:
    virtual ~WindowPresenter() = default;
    virtual bool exclusive(bool enabled) = 0;
};
}  // namespace native
