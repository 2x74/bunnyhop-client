#include "renderer_prompt.hpp"
#include <windows.h>
#include <commctrl.h>
#include <iostream>

namespace native {
RendererChoice ask_renderer() {
    constexpr int opengl_button = 100;
    constexpr int d3d11_button = 101;
    constexpr int continue_button = 102;
    const TASKDIALOG_BUTTON choices[] = {{opengl_button, L"OpenGL"}, {d3d11_button, L"Direct3D 11"}};
    const TASKDIALOG_BUTTON buttons[] = {{continue_button, L"Continue"}};
    TASKDIALOGCONFIG dialog{};
    dialog.cbSize = sizeof(dialog);
    dialog.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_SIZE_TO_CONTENT;
    dialog.pszWindowTitle = L"Bunnyhop Native";
    dialog.pszMainInstruction = L"Choose a renderer";
    dialog.pszContent = L"OpenGL: default for everyday play.\n"
                        L"Direct3D 11: experimental alternative for Windows.\n\n"
                        L"You can change this later in Settings > Display.";
    dialog.cRadioButtons = UINT(std::size(choices));
    dialog.pRadioButtons = choices;
    dialog.nDefaultRadioButton = opengl_button;
    dialog.cButtons = UINT(std::size(buttons));
    dialog.pButtons = buttons;
    dialog.nDefaultButton = continue_button;
    int button = IDCANCEL, selected = opengl_button;
    const auto result = TaskDialogIndirect(&dialog, &button, &selected, nullptr);
    if (FAILED(result)) std::cerr << "Renderer choice dialog failed: " << std::hex << result << std::dec << '\n';
    return SUCCEEDED(result) && button == continue_button && selected == d3d11_button ? RendererChoice::d3d11
                                                                                      : RendererChoice::opengl;
}
}  // namespace native
