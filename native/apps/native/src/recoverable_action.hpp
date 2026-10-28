#pragma once
#include <exception>
#include <iostream>
#include <utility>

namespace native {

template <class Action, class Notice>
class RecoverableAction {
public:
    RecoverableAction(Action action, Notice notice) : action_(std::move(action)), notice_(std::move(notice)) {}

    template <class... Args>
    void operator()(Args &&...args) const {
        try {
            action_(std::forward<Args>(args)...);
        } catch (const std::exception &error) {
            std::cerr << "Input action: " << error.what() << '\n';
            notice_(error.what());
        } catch (...) {
            std::cerr << "Input action failed\n";
            notice_("The action couldn't be completed.");
        }
    }

private:
    Action action_;
    Notice notice_;
};

}  // namespace native
