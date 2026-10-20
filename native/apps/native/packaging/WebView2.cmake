# Microsoft-owned NuGet feed, pinned SDK; do not replace this with an unverified mirror.
# https://www.nuget.org/packages/Microsoft.Web.WebView2/1.0.4258.31
set(BUNNYHOP_WEBVIEW2_VERSION "1.0.4258.31")
set(BUNNYHOP_WEBVIEW2_SHA256 "56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9")
function(bunnyhop_windows_menu target)
    if(NOT WIN32 OR NOT MSVC OR NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
        message(FATAL_ERROR "The Windows menu build requires the MSVC x64 toolchain")
    endif()
    if(CMAKE_SYSTEM_PROCESSOR MATCHES "[Aa][Rr][Mm]|aarch64" OR CMAKE_GENERATOR_PLATFORM MATCHES "[Aa][Rr][Mm]")
        message(FATAL_ERROR "The pinned native menu loader currently supports Windows x64, not ARM64")
    endif()
    set(sdk "${CMAKE_BINARY_DIR}/webview2-${BUNNYHOP_WEBVIEW2_VERSION}")
    set(package "${CMAKE_BINARY_DIR}/webview2-${BUNNYHOP_WEBVIEW2_VERSION}.nupkg")
    if(NOT EXISTS "${sdk}/build/native/include/WebView2.h")
        file(DOWNLOAD
            "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${BUNNYHOP_WEBVIEW2_VERSION}/microsoft.web.webview2.${BUNNYHOP_WEBVIEW2_VERSION}.nupkg"
            "${package}" EXPECTED_HASH "SHA256=${BUNNYHOP_WEBVIEW2_SHA256}"
            TLS_VERIFY ON STATUS result)
        list(GET result 0 code)
        if(NOT code EQUAL 0)
            message(FATAL_ERROR "Could not fetch the pinned official WebView2 SDK: ${result}")
        endif()
        file(ARCHIVE_EXTRACT INPUT "${package}" DESTINATION "${sdk}")
    endif()
    target_sources(${target} PRIVATE "${CMAKE_CURRENT_FUNCTION_LIST_DIR}/../src/menu_webview_windows.cpp")
    target_include_directories(${target} PRIVATE "${sdk}/build/native/include")
    target_link_libraries(${target} PRIVATE "${sdk}/build/native/x64/WebView2LoaderStatic.lib"
        ole32 oleaut32 shlwapi urlmon comctl32 version advapi32)
    target_compile_definitions(${target} PRIVATE UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
endfunction()
