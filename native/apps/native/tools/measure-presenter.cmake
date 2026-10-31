# Only the benchmark compiles this instrumented copy. Fail if a renderer change moves an anchor.
function(measure_replace original replacement)
    string(FIND "${measure_source}" "${original}" position)
    if(position EQUAL -1)
        message(FATAL_ERROR "Measurement presenter anchor moved: ${original}")
    endif()
    string(REPLACE "${original}" "${replacement}" measure_source "${measure_source}")
    set(measure_source "${measure_source}" PARENT_SCOPE)
endfunction()
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/src/low_latency_windows.cpp")
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/src/low_latency_windows.cpp" measure_source)
measure_replace("#include <windows.h>" "#include <windows.h>\n#include \"benchmark_latency_windows.hpp\"")
measure_replace("    if (!state.lock_frame())"
    "    benchmark_latency::clock_start();\n    if (!state.lock_frame())")
measure_replace("    state.gl.BindFramebuffer(GL_FRAMEBUFFER, state.framebuffer);"
    "    benchmark_latency::clock_end(benchmark_latency::lock);\n    state.gl.BindFramebuffer(GL_FRAMEBUFFER, state.framebuffer);")
measure_replace("    state.unlock_frame();\n    state.blit();"
    "    benchmark_latency::clock_start();\n    state.unlock_frame();\n    benchmark_latency::clock_end(benchmark_latency::unlock);\n    benchmark_latency::copy_start(state.device.Get(), state.context.Get());\n    benchmark_latency::clock_start();\n    state.blit();\n    benchmark_latency::clock_end(benchmark_latency::copy);\n    benchmark_latency::copy_end(state.context.Get());")
measure_replace("    const HRESULT result = state.swapchain->Present"
    "    benchmark_latency::clock_start();\n    const HRESULT result = state.swapchain->Present")
measure_replace("    if (state.use_reflex) reflex().marker(state.device.Get(), state.frame_id, PRESENT_END);"
    "    benchmark_latency::clock_end(benchmark_latency::present);\n    if (state.use_reflex) reflex().marker(state.device.Get(), state.frame_id, PRESENT_END);\n    benchmark_latency::finish(state.device.Get(), state.context.Get(), state.use_reflex);")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/measure_presenter_windows.cpp" "${measure_source}")
