// Menus/account only. The native SDL window retains OpenGL and raw game input.
// SDK: packaging/WebView2.cmake; API: learn.microsoft.com/microsoft-edge/webview2/reference/win32/.
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include "menu_webview.hpp"
#include <SDL3/SDL.h>
#include <windows.h>
#include <commctrl.h>
#include <shlwapi.h>
#include <urlmon.h>
#include <wrl.h>
#include <WebView2.h>
#include <nlohmann/json.hpp>
#include <algorithm>
#include <chrono>
#include <filesystem>
#include <utility>
#include <iterator>
#include <cwchar>
#include <cstdint>
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Callback;
namespace {
constexpr wchar_t menu_url[]=L"https://bunnyhop.lol/__native_menu__/index.html";
constexpr UINT auth_close_message=WM_APP+0x4b2;
constexpr size_t max_message_bytes=12*1024*1024;
std::wstring wide(const std::string &s) {
    if(s.empty())return {};
    const int n=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),nullptr,0);
    if(n<=0)return {};std::wstring out(size_t(n),L'\0');
    MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s.data(),int(s.size()),out.data(),n);return out;
}
std::string narrow(const wchar_t *s) {
    if(!s)return {};const int n=WideCharToMultiByte(CP_UTF8,0,s,-1,nullptr,0,nullptr,nullptr);
    if(n<=1)return {};std::string out(size_t(n),0);WideCharToMultiByte(CP_UTF8,0,s,-1,out.data(),n,nullptr,nullptr);out.pop_back();return out;
}
struct Text {LPWSTR value=nullptr;~Text(){CoTaskMemFree(value);}operator LPCWSTR()const{return value?value:L"";}};
bool https(const wchar_t *url) {ComPtr<IUri> uri;if(!url||FAILED(CreateUri(url,Uri_CREATE_CANONICALIZE,0,&uri)))return false;BSTR scheme=nullptr;uri->GetSchemeName(&scheme);const bool ok=scheme&&!_wcsicmp(scheme,L"https");SysFreeString(scheme);return ok;}
bool game_origin(const wchar_t *url) {
    ComPtr<IUri> uri;if(!https(url)||FAILED(CreateUri(url,Uri_CREATE_CANONICALIZE,0,&uri)))return false;
    BSTR host=nullptr,user=nullptr;DWORD port=0;uri->GetHost(&host);uri->GetUserInfo(&user);uri->GetPort(&port);
    const bool ok=host&&!_wcsicmp(host,L"bunnyhop.lol")&&port==443&&(!user||!SysStringLen(user));SysFreeString(host);SysFreeString(user);return ok;
}
bool auth_url(const wchar_t *url) {
    ComPtr<IUri> uri;if(!game_origin(url)||FAILED(CreateUri(url,Uri_CREATE_CANONICALIZE,0,&uri)))return false;
    BSTR path=nullptr;uri->GetPath(&path);const bool ok=path&&std::wstring(path).starts_with(L"/api/auth/");SysFreeString(path);return ok;
}
void pump() {MSG message;for(int i=0;i<128&&PeekMessageW(&message,nullptr,0,0,PM_REMOVE);++i){if(message.message==WM_QUIT){PostQuitMessage(int(message.wParam));break;}TranslateMessage(&message);DispatchMessageW(&message);}}
std::wstring profile_path() {
    wchar_t local[32768];const DWORD n=GetEnvironmentVariableW(L"LOCALAPPDATA",local,DWORD(std::size(local)));
    if(!n||n>=std::size(local))return {};
    const auto path=std::filesystem::path(local)/L"Bunnyhop"/L"WebView2";
    std::error_code error;std::filesystem::create_directories(path,error);return error?L"":path.wstring();
}
void restrict_webview(ICoreWebView2 *view,bool trusted) {
    ComPtr<ICoreWebView2Settings> settings;if(SUCCEEDED(view->get_Settings(&settings))){
        settings->put_IsWebMessageEnabled(trusted);settings->put_AreHostObjectsAllowed(FALSE);
        settings->put_AreDevToolsEnabled(FALSE);settings->put_AreDefaultContextMenusEnabled(FALSE);
        settings->put_IsStatusBarEnabled(FALSE);
        ComPtr<ICoreWebView2Settings3> s3;if(SUCCEEDED(settings.As(&s3)))s3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
    }
    EventRegistrationToken token{};
    view->add_PermissionRequested(Callback<ICoreWebView2PermissionRequestedEventHandler>([](ICoreWebView2*,ICoreWebView2PermissionRequestedEventArgs *a)->HRESULT{return a->put_State(COREWEBVIEW2_PERMISSION_STATE_DENY);}).Get(),&token);
    ComPtr<ICoreWebView2_4> v4;if(SUCCEEDED(view->QueryInterface(IID_PPV_ARGS(&v4))))
        v4->add_DownloadStarting(Callback<ICoreWebView2DownloadStartingEventHandler>([](ICoreWebView2*,ICoreWebView2DownloadStartingEventArgs*a)->HRESULT{return a->put_Cancel(TRUE);}).Get(),&token);
}
}
namespace native {
struct MenuWebView::Impl {
    struct State {Impl *owner=nullptr;std::string error;std::vector<std::string> messages;
        void push(nlohmann::json value){auto text=value.dump();size_t bytes=0;for(const auto &m:messages)bytes+=m.size();if(text.size()<=max_message_bytes&&messages.size()<128&&bytes+text.size()<=16*1024*1024)messages.push_back(std::move(text));}
        void fail(const char *s){error=s;push({{"type","menuError"},{"error",error}});}
    };
    std::shared_ptr<State> state=std::make_shared<State>();
    HWND window=nullptr,auth_window=nullptr;ComPtr<ICoreWebView2Environment> environment;
    ComPtr<ICoreWebView2Controller> controller,auth_controller;ComPtr<ICoreWebView2> menu,auth;
    bool backdrop=false,shown=false,initial_navigation=true,served=false,com_initialized=false,failed=false;
    uint64_t auth_generation=0;std::string html;
    static LRESULT CALLBACK host_proc(HWND h,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR,DWORD_PTR data){auto *self=reinterpret_cast<Impl*>(data);
        if(msg==WM_SIZE&&self->controller){RECT bounds;GetClientRect(h,&bounds);self->controller->put_Bounds(bounds);}
        if(msg==WM_MOVE&&self->controller)self->controller->NotifyParentWindowPositionChanged();
        if(msg==auth_close_message){self->close_auth(wp!=0);return 0;}
        return DefSubclassProc(h,msg,wp,lp);
    }
    static LRESULT CALLBACK auth_proc(HWND h,UINT msg,WPARAM wp,LPARAM lp){
        auto *self=reinterpret_cast<Impl*>(GetWindowLongPtrW(h,GWLP_USERDATA));
        if(msg==WM_NCCREATE){self=static_cast<Impl*>(reinterpret_cast<CREATESTRUCTW*>(lp)->lpCreateParams);SetWindowLongPtrW(h,GWLP_USERDATA,reinterpret_cast<LONG_PTR>(self));}
        if(self){if(msg==WM_CLOSE||(msg==WM_COMMAND&&LOWORD(wp)==1)){PostMessageW(self->window,auth_close_message,0,0);return 0;}
            if(msg==WM_SIZE&&self->auth_controller){RECT r;GetClientRect(h,&r);r.top=42;self->auth_controller->put_Bounds(r);}
        }return DefWindowProcW(h,msg,wp,lp);
    }
    Impl(SDL_Window *sdl,const std::string &source):html(source){
        state->owner=this;
        window=sdl?static_cast<HWND>(SDL_GetPointerProperty(SDL_GetWindowProperties(sdl),SDL_PROP_WINDOW_WIN32_HWND_POINTER,nullptr)):nullptr;
        if(!window){state->fail("SDL window has no Win32 HWND");return;}
        const HRESULT init=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED);
        if(FAILED(init)){state->fail("WebView2 requires an STA main thread");return;}com_initialized=true;
        if(wide(html).empty()){state->fail("Bundled menu HTML is not UTF-8");return;}
        const auto data=profile_path();if(data.empty()){state->fail("Cannot create the WebView2 account profile");return;}
        SetWindowSubclass(window,host_proc,0x4248,reinterpret_cast<DWORD_PTR>(this));
        const auto life=state;
        const HRESULT hr=CreateCoreWebView2EnvironmentWithOptions(nullptr,data.c_str(),nullptr,
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>([life](HRESULT result,ICoreWebView2Environment *env)->HRESULT{
                auto *self=life->owner;if(!self)return S_OK;
                if(FAILED(result)||!env){self->failed=true;life->fail("Microsoft WebView2 Runtime unavailable. Install the official Evergreen Runtime from Microsoft.");return S_OK;}
                self->environment=env;
                const HRESULT created=env->CreateCoreWebView2Controller(self->window,Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([life](HRESULT result,ICoreWebView2Controller *created)->HRESULT{
                    auto *self=life->owner;if(!self){if(created)created->Close();return S_OK;}
                    if(FAILED(result)||!created){self->failed=true;life->fail("Could not create the WebView2 menu controller");return S_OK;}
                    self->controller=created;if(FAILED(created->get_CoreWebView2(&self->menu))){self->failed=true;life->fail("Could not obtain the WebView2 menu");return S_OK;}
                    self->configure();return S_OK;
                }).Get());
                if(FAILED(created)){self->failed=true;life->fail("Could not start the WebView2 menu controller");}return S_OK;
            }).Get());
        if(FAILED(hr)){failed=true;state->fail("Could not start Microsoft WebView2 Runtime");return;}
        // Construction is bounded. Afterwards SDL's normal Win32 pump delivers WebView2 callbacks.
        const auto until=std::chrono::steady_clock::now()+std::chrono::seconds(15);
        while(!menu&&!failed&&std::chrono::steady_clock::now()<until){pump();MsgWaitForMultipleObjects(0,nullptr,FALSE,10,QS_ALLINPUT);}
        if(!menu&&!failed){failed=true;state->fail("WebView2 startup timed out");}
    }
    void configure(){
        // WebView2 alpha reveals the native OpenGL child surface. CSS remains
        // opaque until the client explicitly enables the scene presentation.
        ComPtr<ICoreWebView2Controller2> alpha;
        if(SUCCEEDED(controller.As(&alpha)))backdrop=SUCCEEDED(alpha->put_DefaultBackgroundColor(COREWEBVIEW2_COLOR{0,0,0,0}));
        restrict_webview(menu.Get(),true);RECT r;GetClientRect(window,&r);controller->put_Bounds(r);controller->put_IsVisible(FALSE);
        const auto life=state;EventRegistrationToken token{};
        menu->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([life](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs*a)->HRESULT{
            auto *self=life->owner;if(!self)return a->put_Cancel(TRUE);Text url;a->get_Uri(&url.value);
            if(self->initial_navigation&&std::wstring(url)==menu_url){self->initial_navigation=false;return S_OK;}
            a->put_Cancel(TRUE);if(auth_url(url))self->open_auth(url);return S_OK;
        }).Get(),&token);
        menu->add_FrameNavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs*a)->HRESULT{return a->put_Cancel(TRUE);}).Get(),&token);
        menu->AddWebResourceRequestedFilter(menu_url,COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT);
        menu->add_WebResourceRequested(Callback<ICoreWebView2WebResourceRequestedEventHandler>([life](ICoreWebView2*,ICoreWebView2WebResourceRequestedEventArgs*a)->HRESULT{
            auto *self=life->owner;if(!self)return S_OK;
            ComPtr<ICoreWebView2WebResourceRequest> request;a->get_Request(&request);Text url;request->get_Uri(&url.value);
            if(std::wstring(url)!=menu_url)return S_OK;
            const bool allowed=!self->served;self->served=true;
            const std::string body=allowed?self->html:"Blocked";
            ComPtr<IStream> stream;stream.Attach(SHCreateMemStream(reinterpret_cast<const BYTE*>(body.data()),UINT(body.size())));
            ComPtr<ICoreWebView2WebResourceResponse> response;
            self->environment->CreateWebResourceResponse(stream.Get(),allowed?200:403,allowed?L"OK":L"Forbidden",
                L"Content-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https://bunnyhop.lol data: blob:; connect-src https://bunnyhop.lol wss://bunnyhop.lol; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'none'\r\n",&response);
            return a->put_Response(response.Get());
        }).Get(),&token);
        menu->add_WebMessageReceived(Callback<ICoreWebView2WebMessageReceivedEventHandler>([life](ICoreWebView2 *view,ICoreWebView2WebMessageReceivedEventArgs*a)->HRESULT{
            auto *self=life->owner;if(!self||view!=self->menu.Get()||!self->served)return S_OK;
            Text origin,current,body;a->get_Source(&origin.value);view->get_Source(&current.value);
            if(std::wstring(origin)!=menu_url||std::wstring(current)!=menu_url||FAILED(a->TryGetWebMessageAsString(&body.value)))return S_OK;
            if(wcslen(body)>max_message_bytes)return S_OK;const auto bytes=narrow(body);if(bytes.size()>max_message_bytes)return S_OK;
            try{auto value=nlohmann::json::parse(bytes);if(value.is_object()&&value.contains("type")&&value["type"].is_string()){const auto type=value["type"].get<std::string>();if(!type.empty()&&type.size()<=64)life->push(std::move(value));}}catch(...){}return S_OK;
        }).Get(),&token);
        menu->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([life](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs*a)->HRESULT{a->put_Handled(TRUE);Text url;a->get_Uri(&url.value);if(life->owner&&auth_url(url))life->owner->open_auth(url);return S_OK;}).Get(),&token);
        menu->add_ProcessFailed(Callback<ICoreWebView2ProcessFailedEventHandler>([life](ICoreWebView2*,ICoreWebView2ProcessFailedEventArgs*)->HRESULT{life->fail("WebView2 menu process terminated");return S_OK;}).Get(),&token);
        // This adapter exists in the trusted document only; remote authentication has no user script or message handler.
        const wchar_t *bridge=LR"(if(window===window.top&&location.href==='https://bunnyhop.lol/__native_menu__/index.html'){window.webkit={messageHandlers:{bunnyhop:{postMessage(value){window.chrome.webview.postMessage(value)}}}};})";
        // A persisted remote service worker must never intercept/replace the trusted bundled document.
        // Clear only workers/caches in this app-owned profile, retaining authentication cookies/settings.
        ComPtr<ICoreWebView2_13> v13;ComPtr<ICoreWebView2Profile> profile;ComPtr<ICoreWebView2Profile2> p2;
        if(FAILED(menu.As(&v13))||FAILED(v13->get_Profile(&profile))||FAILED(profile.As(&p2))){failed=true;state->fail("Update Microsoft WebView2 Runtime to load trusted native menus");return;}
        const std::wstring bridge_source=bridge;
        const auto kinds=COREWEBVIEW2_BROWSING_DATA_KINDS_SERVICE_WORKERS|COREWEBVIEW2_BROWSING_DATA_KINDS_CACHE_STORAGE|COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE;
        const HRESULT clearing=p2->ClearBrowsingData(kinds,Callback<ICoreWebView2ClearBrowsingDataCompletedHandler>([life,bridge_source](HRESULT result)->HRESULT{
            auto *self=life->owner;if(!self)return S_OK;if(FAILED(result)){self->failed=true;life->fail("Could not clear remote workers before loading the bundled menu");return S_OK;}
            self->menu->AddScriptToExecuteOnDocumentCreated(bridge_source.c_str(),Callback<ICoreWebView2AddScriptToExecuteOnDocumentCreatedCompletedHandler>([life](HRESULT hr,LPCWSTR)->HRESULT{
                if(life->owner){if(FAILED(hr)){life->owner->failed=true;life->fail("Could not install the trusted menu bridge");}else life->owner->menu->Navigate(menu_url);}return S_OK;
            }).Get());return S_OK;
        }).Get());if(FAILED(clearing)){failed=true;state->fail("Could not isolate the trusted menu from remote workers");}
    }
    bool open_auth(const wchar_t *url){
        if(!environment||!auth_url(url)){state->error="Authentication must begin at https://bunnyhop.lol/api/auth/";return false;}
        close_auth(false,false);const auto generation=++auth_generation;const auto life=state;const std::wstring destination=url;
        static const bool registered=[](){WNDCLASSW wc{};wc.lpfnWndProc=auth_proc;wc.hInstance=GetModuleHandleW(nullptr);wc.lpszClassName=L"BunnyhopNativeAuthentication";wc.hCursor=LoadCursor(nullptr,IDC_ARROW);return RegisterClassW(&wc)||GetLastError()==ERROR_CLASS_ALREADY_EXISTS;}();
        if(!registered)return false;
        auth_window=CreateWindowExW(0,L"BunnyhopNativeAuthentication",L"Bunnyhop account",WS_OVERLAPPEDWINDOW,CW_USEDEFAULT,CW_USEDEFAULT,900,740,window,nullptr,GetModuleHandleW(nullptr),this);
        if(!auth_window)return false;
        CreateWindowW(L"BUTTON",L"Back to menu",WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,10,7,160,28,auth_window,reinterpret_cast<HMENU>(1),GetModuleHandleW(nullptr),nullptr);
        if(shown)ShowWindow(auth_window,SW_SHOW);
        const HRESULT hr=environment->CreateCoreWebView2Controller(auth_window,Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>([life,generation,destination](HRESULT result,ICoreWebView2Controller *created)->HRESULT{
            auto *self=life->owner;if(!self||generation!=self->auth_generation){if(created)created->Close();return S_OK;}
            if(FAILED(result)||!created){life->fail("Could not create isolated authentication view");self->close_auth(false);return S_OK;}
            self->auth_controller=created;created->get_CoreWebView2(&self->auth);restrict_webview(self->auth.Get(),false);
            RECT r;GetClientRect(self->auth_window,&r);r.top=42;created->put_Bounds(r);created->put_IsVisible(self->shown);
            EventRegistrationToken token{};
            self->auth->add_NavigationStarting(Callback<ICoreWebView2NavigationStartingEventHandler>([life,generation](ICoreWebView2*,ICoreWebView2NavigationStartingEventArgs*a)->HRESULT{
                auto *self=life->owner;if(!self||generation!=self->auth_generation)return a->put_Cancel(TRUE);Text url;a->get_Uri(&url.value);
                if(!https(url))return a->put_Cancel(TRUE);
                if(game_origin(url)&&!auth_url(url)){a->put_Cancel(TRUE);PostMessageW(self->window,auth_close_message,1,0);}return S_OK;
            }).Get(),&token);
            self->auth->add_NewWindowRequested(Callback<ICoreWebView2NewWindowRequestedEventHandler>([life,generation](ICoreWebView2*,ICoreWebView2NewWindowRequestedEventArgs*a)->HRESULT{
                a->put_Handled(TRUE);Text url;a->get_Uri(&url.value);if(life->owner&&generation==life->owner->auth_generation&&https(url))life->owner->auth->Navigate(url);return S_OK;
            }).Get(),&token);
            self->auth->Navigate(destination.c_str());return S_OK;
        }).Get());return SUCCEEDED(hr);
    }
    void close_auth(bool complete,bool notify=true){const bool existed=auth_window!=nullptr;++auth_generation;if(auth_controller)auth_controller->Close();auth.Reset();auth_controller.Reset();if(auth_window)DestroyWindow(auth_window);auth_window=nullptr;if(shown&&controller)controller->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);if(notify&&existed)state->push({{"type","auth"},{"status",complete?"complete":"cancelled"}});}
    ~Impl(){state->owner=nullptr;close_auth(false,false);if(controller)controller->Close();menu.Reset();controller.Reset();environment.Reset();if(window)RemoveWindowSubclass(window,host_proc,0x4248);if(com_initialized)CoUninitialize();}
};
MenuWebView::MenuWebView(SDL_Window *window,const std::string &html):impl_(std::make_unique<Impl>(window,html)){}
MenuWebView::~MenuWebView()=default;
bool MenuWebView::available()const{return impl_->menu&&!impl_->failed;}
bool MenuWebView::supports_backdrop()const{return available()&&impl_->backdrop;}
const std::string &MenuWebView::error()const{return impl_->state->error;}
bool MenuWebView::visible()const{return impl_->shown;}
bool MenuWebView::has_keyboard_focus() const {
    if (!impl_->shown)
        return false;
    const HWND focus = GetFocus();
    return focus != impl_->window;
}
// Keyboard focus follows the menu: into the web view when it opens (and again
// when the game window is activated with it open), back to the SDL window
// before the web view hides, so focus never rests in a hidden child.
void MenuWebView::set_visible(bool visible) {
    if (!available())
        return;
    impl_->shown = visible;
    if (!visible) {
        SetFocus(impl_->window);
        impl_->controller->put_IsVisible(FALSE);
        if (impl_->auth_window)
            ShowWindow(impl_->auth_window, SW_HIDE);
        return;
    }
    impl_->controller->put_IsVisible(TRUE);
    if (impl_->auth_window)
        ShowWindow(impl_->auth_window, SW_SHOW);
    auto& focus = impl_->auth_controller ? impl_->auth_controller : impl_->controller;
    focus->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
}
std::vector<std::string> MenuWebView::drain_messages(){std::vector<std::string> out;out.swap(impl_->state->messages);return out;}
void MenuWebView::evaluate_js(const std::string &script){if(available()){const auto life=impl_->state;impl_->menu->ExecuteScript(wide(script+"\n;null;").c_str(),Callback<ICoreWebView2ExecuteScriptCompletedHandler>([life](HRESULT hr,LPCWSTR)->HRESULT{if(FAILED(hr))life->fail("WebView2 host reply failed");return S_OK;}).Get());}}
bool MenuWebView::open_auth(const std::string &url){return impl_->open_auth(wide(url).c_str());}
void MenuWebView::close_auth(){impl_->close_auth(false);}
bool MenuWebView::screenshot(const std::string &path){if(!available()||path.empty())return false;ComPtr<IStream> stream;if(FAILED(SHCreateStreamOnFileEx(wide(path).c_str(),STGM_CREATE|STGM_WRITE|STGM_SHARE_EXCLUSIVE,FILE_ATTRIBUTE_NORMAL,TRUE,nullptr,&stream)))return false;const auto life=impl_->state;return SUCCEEDED(impl_->menu->CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,stream.Get(),Callback<ICoreWebView2CapturePreviewCompletedHandler>([life,path,stream](HRESULT result)->HRESULT{stream->Commit(STGC_DEFAULT);life->push({{"type","menuSnapshot"},{"ok",SUCCEEDED(result)},{"path",path},{"error",SUCCEEDED(result)?"":"WebView2 screenshot failed"}});return S_OK;}).Get()));}
}
