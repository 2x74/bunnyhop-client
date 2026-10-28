# Run with cmake -P apps/native/cmake/CheckFormat.cmake from native/.
find_program(CLANG_FORMAT NAMES clang-format clang-format-21
    HINTS /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin
    REQUIRED)
execute_process(COMMAND "${CLANG_FORMAT}" --version OUTPUT_VARIABLE FORMAT_VERSION)
if(NOT FORMAT_VERSION MATCHES "version ([0-9]+)" OR CMAKE_MATCH_1 LESS 18)
    message(FATAL_ERROR "clang-format 18 or newer is required")
endif()
get_filename_component(NATIVE_SOURCE "${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)
file(GLOB_RECURSE FORMAT_FILES
    "${NATIVE_SOURCE}/src/*.cpp" "${NATIVE_SOURCE}/src/*.hpp"
    "${NATIVE_SOURCE}/src/*.mm" "${NATIVE_SOURCE}/include/*.h")
list(FILTER FORMAT_FILES EXCLUDE REGEX "/unicode_grapheme_data\\.hpp$")
execute_process(COMMAND "${CLANG_FORMAT}" --dry-run --Werror ${FORMAT_FILES}
    COMMAND_ERROR_IS_FATAL ANY)
