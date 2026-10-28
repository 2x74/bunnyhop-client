#include "menu_webview.hpp"
#include <SDL3/SDL.h>
#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include <algorithm>
#include <utility>

namespace {
constexpr size_t max_message_bytes = 12 * 1024 * 1024;
constexpr size_t max_messages = 128;
bool game_origin(NSURL *url) {
    return [url.scheme.lowercaseString isEqualToString:@"https"] &&
        [url.host.lowercaseString isEqualToString:@"bunnyhop.lol"] &&
        (!url.port || url.port.integerValue == 443);
}
bool auth_url(NSURL *url) { return game_origin(url) && [url.path hasPrefix:@"/api/auth/"]; }
NSString *text(const std::string &value) {
    return [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
}
std::string utf8(NSString *value) { return value ? std::string(value.UTF8String ?: "") : std::string(); }
struct MenuState {
    std::vector<std::string> messages;
    std::string error;
    void push(id body) {
        if (![body isKindOfClass:NSDictionary.class]) return;
        NSData *data = [NSJSONSerialization dataWithJSONObject:body options:0 error:nil];
        size_t queued=0;for(const auto &message:messages)queued+=message.size();
        if (!data || data.length > max_message_bytes || messages.size() >= max_messages || queued+data.length>16*1024*1024) return;
        messages.emplace_back(static_cast<const char *>(data.bytes), data.length);
    }
};
}

@interface BHNativeMenuDelegate : NSObject<WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler>
@property(nonatomic, weak) WKWebView *menu;
@property(nonatomic, weak) WKWebView *auth;
@property(nonatomic) BOOL initialNavigation;
@property(nonatomic, copy) void (^messageSink)(id body);
@property(nonatomic, copy) void (^openAuth)(NSURL *url);
@property(nonatomic, copy) void (^authComplete)(void);
@property(nonatomic, copy) void (^authCancel)(void);
@property(nonatomic, copy) void (^loadFailed)(NSString *error);
@end

@implementation BHNativeMenuDelegate
- (void)closeAuth:(id)sender { if (self.authCancel) self.authCancel(); }
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
    WKSecurityOrigin *origin = message.frameInfo.securityOrigin;
    if (message.webView != self.menu || !message.frameInfo.mainFrame ||
        ![origin.protocol isEqualToString:@"https"] || ![origin.host isEqualToString:@"bunnyhop.lol"] ||
        (origin.port != 0 && origin.port != 443)) return;
    id body = message.body;
    if ([body isKindOfClass:NSString.class]) {
        NSData *data = [(NSString *)body dataUsingEncoding:NSUTF8StringEncoding];
        if (data.length > max_message_bytes) return;
        body = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    }
    if (![body isKindOfClass:NSDictionary.class] || ![body[@"type"] isKindOfClass:NSString.class] ||
        [(NSString *)body[@"type"] length] == 0 || [(NSString *)body[@"type"] length] > 64) return;
    if (self.messageSink) self.messageSink(body);
}
- (void)webView:(WKWebView *)webView decidePolicyForNavigationAction:(WKNavigationAction *)action decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = action.request.URL;
    if (webView == self.menu) {
        // Consume exactly one host-issued loadHTMLString navigation. Neither
        // remote pages, iframes nor reloads may inherit this host bridge.
        if (self.initialNavigation && action.targetFrame.mainFrame && game_origin(url) &&
            (url.path.length == 0 || [url.path isEqualToString:@"/"])) {
            self.initialNavigation = NO;
            decisionHandler(WKNavigationActionPolicyAllow); return;
        }
        decisionHandler(WKNavigationActionPolicyCancel);
        if (auth_url(url) && self.openAuth) self.openAuth(url);
        return;
    }
    if (webView == self.auth) {
        if (![url.scheme.lowercaseString isEqualToString:@"https"]) {
            decisionHandler(WKNavigationActionPolicyCancel); return;
        }
        if (action.targetFrame.mainFrame && game_origin(url) && !auth_url(url)) {
            decisionHandler(WKNavigationActionPolicyCancel);
            if (self.authComplete) self.authComplete();
            return;
        }
        decisionHandler(WKNavigationActionPolicyAllow); return;
    }
    decisionHandler(WKNavigationActionPolicyCancel);
}
- (WKWebView *)webView:(WKWebView *)webView createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration forNavigationAction:(WKNavigationAction *)action windowFeatures:(WKWindowFeatures *)features {
    // Never reuse a configuration that may carry the trusted menu's handler.
    if (webView == self.menu && auth_url(action.request.URL) && self.openAuth) self.openAuth(action.request.URL);
    else if (webView == self.auth && [action.request.URL.scheme.lowercaseString isEqualToString:@"https"]) [webView loadRequest:action.request];
    return nil;
}
- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled && self.loadFailed) self.loadFailed(error.localizedDescription);
}
- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (error.code != NSURLErrorCancelled && self.loadFailed) self.loadFailed(error.localizedDescription);
}
- (void)webViewWebContentProcessDidTerminate:(WKWebView *)webView {
    if (self.loadFailed) self.loadFailed(@"WebKit menu process terminated");
}
@end

namespace native {
struct MenuWebView::Impl {
    __weak NSWindow *window = nil;
    __weak NSResponder *previous_responder = nil;
    WKWebView *menu = nil;
    WKWebView *auth = nil;
    NSView *auth_container = nil;
    BHNativeMenuDelegate *delegate = nil;
    std::shared_ptr<MenuState> state = std::make_shared<MenuState>();
    bool shown = false, backdrop = false;

    // A responder inside the menu or the sign-in view.
    bool owns(NSResponder *responder) const {
        if (![responder isKindOfClass:NSView.class])
            return false;
        NSView *view = (NSView *)responder;
        if (menu && [view isDescendantOf:menu])
            return true;
        return auth_container && [view isDescendantOf:auth_container];
    }

    Impl(SDL_Window *sdl, const std::string &html) {
        if (!NSThread.isMainThread) { state->error = "WebKit menus must be created on the SDL main thread"; return; }
        if (!sdl) { state->error = "No SDL window for web menus"; return; }
        window = (__bridge NSWindow *)SDL_GetPointerProperty(SDL_GetWindowProperties(sdl), SDL_PROP_WINDOW_COCOA_WINDOW_POINTER, nullptr);
        if (!window || !window.contentView) { state->error = "SDL window has no Cocoa content view"; return; }
        NSString *source = text(html);
        if (!source) { state->error = "Bundled menu HTML is not UTF-8"; return; }

        auto config = [WKWebViewConfiguration new];
        config.websiteDataStore = WKWebsiteDataStore.defaultDataStore;
        delegate = [BHNativeMenuDelegate new];
        delegate.initialNavigation = YES;
        const auto shared = state;
        delegate.messageSink = ^(id body) { shared->push(body); };
        delegate.loadFailed = ^(NSString *error) {
            shared->error = utf8(error);
            shared->push(@{@"type": @"menuError", @"error": error ?: @"WebKit load failed"});
        };
        delegate.openAuth = ^(NSURL *url) { open_auth(url); };
        delegate.authComplete = ^{ close_auth(true); };
        delegate.authCancel = ^{ close_auth(false); };
        [config.userContentController addScriptMessageHandler:delegate name:@"bunnyhop"];
        menu = [[WKWebView alloc] initWithFrame:window.contentView.bounds configuration:config];
        // WKWebView otherwise paints an opaque page over the SDL OpenGL view.
        // WebKit exposes this macOS switch via KVC rather than public WK API.
        // Keep the opaque fallback if a future WebKit removes it.
        @try { [menu setValue:@NO forKey:@"drawsBackground"]; backdrop = true; }
        @catch (NSException *) { backdrop = false; }
        if (@available(macOS 12.0, *)) menu.underPageBackgroundColor = NSColor.clearColor;
        menu.navigationDelegate = delegate;
        menu.UIDelegate = delegate;
        menu.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        menu.hidden = YES;
        delegate.menu = menu;
        [window.contentView addSubview:menu positioned:NSWindowAbove relativeTo:nil];

        // Local inline menu code is trusted; remote executable content and
        // frames cannot enter that document. Fetch uses normal HTTPS/CORS and
        // the real bunnyhop.lol origin established by baseURL (spike verified).
        NSString *policy = @"<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data: blob:; font-src https://bunnyhop.lol data: blob:; connect-src https://bunnyhop.lol wss://bunnyhop.lol; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'none'\">";
        // Keep the bundled doctype first so the menu stays in standards mode.
        NSRange head = [source rangeOfString:@"<head" options:NSCaseInsensitiveSearch];
        NSRange insertion = NSMakeRange(NSNotFound, 0);
        if (head.location != NSNotFound) insertion = [source rangeOfString:@">" options:0 range:NSMakeRange(head.location, source.length - head.location)];
        if (insertion.location == NSNotFound) {
            NSRange doctype = [source rangeOfString:@"<!doctype" options:NSCaseInsensitiveSearch];
            if (doctype.location != NSNotFound) insertion = [source rangeOfString:@">" options:0 range:NSMakeRange(doctype.location, source.length - doctype.location)];
        }
        const NSUInteger at = insertion.location == NSNotFound ? 0 : NSMaxRange(insertion);
        NSString *restricted = [NSString stringWithFormat:@"%@%@%@", [source substringToIndex:at], policy, [source substringFromIndex:at]];
        [menu loadHTMLString:restricted baseURL:[NSURL URLWithString:@"https://bunnyhop.lol/"]];
    }
    ~Impl() {
        delegate.openAuth = nil; delegate.authComplete = nil; delegate.authCancel = nil; delegate.messageSink = nil; delegate.loadFailed = nil;
        close_auth(false, false);
        [menu.configuration.userContentController removeScriptMessageHandlerForName:@"bunnyhop"];
        menu.navigationDelegate = nil; menu.UIDelegate = nil;
        [menu stopLoading]; [menu removeFromSuperview];
        if (window && previous_responder) [window makeFirstResponder:previous_responder];
        menu = nil; delegate = nil;
    }
    bool open_auth(NSURL *url) {
        if (!menu || !auth_url(url)) { state->error = "Authentication must begin at https://bunnyhop.lol/api/auth/"; return false; }
        close_auth(false, false);
        auto config = [WKWebViewConfiguration new];
        config.websiteDataStore = menu.configuration.websiteDataStore;
        // A new userContentController is essential: no bunnyhop handler or
        // bundled script is exposed to providers or any other remote document.
        const NSRect bounds = window.contentView.bounds;
        constexpr CGFloat toolbar_height = 44;
        auth_container = [[NSView alloc] initWithFrame:bounds];
        auth_container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        auth = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, bounds.size.width, std::max<CGFloat>(0, bounds.size.height - toolbar_height)) configuration:config];
        auth.navigationDelegate = delegate; auth.UIDelegate = delegate;
        auth.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [auth_container addSubview:auth];
        auto *toolbar = [[NSBox alloc] initWithFrame:NSMakeRect(0, bounds.size.height - toolbar_height, bounds.size.width, toolbar_height)];
        toolbar.autoresizingMask = NSViewWidthSizable | NSViewMinYMargin;
        toolbar.boxType = NSBoxCustom; toolbar.borderWidth = 0;
        toolbar.titlePosition = NSNoTitle; toolbar.fillColor = NSColor.windowBackgroundColor;
        toolbar.contentViewMargins = NSZeroSize;
        auto *back = [NSButton buttonWithTitle:@"Back to menu" target:delegate action:@selector(closeAuth:)];
        back.frame = NSMakeRect(12, 8, 140, 28);
        [toolbar.contentView addSubview:back]; [auth_container addSubview:toolbar positioned:NSWindowAbove relativeTo:nil];
        auth_container.hidden = !shown;
        delegate.auth = auth;
        [window.contentView addSubview:auth_container positioned:NSWindowAbove relativeTo:nil];
        if (shown) [window makeFirstResponder:auth];
        [auth loadRequest:[NSURLRequest requestWithURL:url]];
        return true;
    }
    void close_auth(bool complete, bool notify = true) {
        if (!auth) return;
        auth.navigationDelegate = nil; auth.UIDelegate = nil;
        [auth stopLoading]; [auth_container removeFromSuperview]; auth = nil; auth_container = nil; delegate.auth = nil;
        if (shown) [window makeFirstResponder:menu];
        if (notify) state->push(@{@"type": @"auth", @"status": complete ? @"complete" : @"cancelled"});
    }
};

MenuWebView::MenuWebView(SDL_Window *window, const std::string &html) : impl_(std::make_unique<Impl>(window, html)) {}
MenuWebView::~MenuWebView() = default;
bool MenuWebView::available() const { return impl_->menu != nil; }
bool MenuWebView::supports_backdrop() const { return available() && impl_->backdrop; }
const std::string &MenuWebView::error() const { return impl_->state->error; }
bool MenuWebView::visible() const { return impl_->shown; }
void MenuWebView::set_visible(bool show) {
    if (!available() || show == impl_->shown)
        return;
    impl_->shown = show;
    if (show) {
        impl_->menu.hidden = NO;
        impl_->auth_container.hidden = NO;
        impl_->previous_responder = impl_->window.firstResponder;
        [impl_->window makeFirstResponder:impl_->auth ?: impl_->menu];
        return;
    }
    // Keys go back to the game view before the web view hides. If the earlier
    // responder is gone, was the window itself or was the menu, SDL's view
    // (the content view) takes them.
    NSResponder *game = impl_->previous_responder;
    if (![game isKindOfClass:NSView.class] || impl_->owns(game))
        game = impl_->window.contentView;
    if (impl_->window && game)
        [impl_->window makeFirstResponder:game];
    impl_->menu.hidden = YES;
    impl_->auth_container.hidden = YES;
}
bool MenuWebView::has_keyboard_focus() const {
    return impl_->shown && NSApp.isActive && impl_->window.isKeyWindow && impl_->owns(impl_->window.firstResponder);
}
std::vector<std::string> MenuWebView::drain_messages() {
    std::vector<std::string> messages; messages.swap(impl_->state->messages); return messages;
}
void MenuWebView::evaluate_js(const std::string &script) {
    if (!available()) return;
    const auto state = impl_->state;
    // Host replies are statements; discard functions/promises returned by menu
    // helpers so WebKit does not report an unsupported result after success.
    [impl_->menu evaluateJavaScript:text(script + "\n;null;") completionHandler:^(id, NSError *error) {
        if (error) state->push(@{@"type": @"menuError", @"error": error.localizedDescription});
    }];
}
bool MenuWebView::open_auth(const std::string &url) { return impl_->open_auth([NSURL URLWithString:text(url)]); }
void MenuWebView::close_auth() { impl_->close_auth(false); }
bool MenuWebView::screenshot(const std::string &path) {
    if (!available() || path.empty()) return false;
    NSString *destination = text(path);
    if (!destination) return false;
    const auto state = impl_->state;
    auto config = [WKSnapshotConfiguration new];
    config.afterScreenUpdates = YES;
    [impl_->menu takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        NSData *png = nil;
        if (image && !error) {
            auto bitmap = [[NSBitmapImageRep alloc] initWithData:image.TIFFRepresentation];
            png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        }
        NSError *write_error = nil;
        const bool ok = png && [png writeToFile:destination options:NSDataWritingAtomic error:&write_error];
        state->push(@{@"type": @"menuSnapshot", @"ok": @(ok), @"path": destination,
            @"error": error.localizedDescription ?: write_error.localizedDescription ?: (ok ? @"" : @"WebKit returned no snapshot")});
    }];
    return true;
}
}
