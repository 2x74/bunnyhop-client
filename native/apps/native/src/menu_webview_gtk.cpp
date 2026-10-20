#include "menu_webview.hpp"
#include <SDL3/SDL.h>
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <jsc/jsc.h>
#include <algorithm>
#include <cstring>
#include <utility>

namespace {
constexpr size_t max_message_bytes = 12 * 1024 * 1024;
constexpr size_t max_messages = 128;
constexpr const char *bridge_world = "bunnyhop-trusted-menu";
bool game_origin(const char *value) {
    if (!value) return false;
    GError *error = nullptr;
    GUri *uri = g_uri_parse(value, G_URI_FLAGS_NONE, &error);
    if (!uri) { g_clear_error(&error); return false; }
    const char *scheme = g_uri_get_scheme(uri), *host = g_uri_get_host(uri);
    const bool valid = scheme && host && !g_ascii_strcasecmp(scheme, "https") &&
        !g_ascii_strcasecmp(host, "bunnyhop.lol") && (g_uri_get_port(uri) == -1 || g_uri_get_port(uri) == 443);
    g_uri_unref(uri); return valid;
}
bool auth_url(const char *url) {
    if (!game_origin(url)) return false;
    GUri *uri = g_uri_parse(url, G_URI_FLAGS_NONE, nullptr);
    const char *path = uri ? g_uri_get_path(uri) : nullptr;
    const bool valid = path && g_str_has_prefix(path, "/api/auth/");
    if (uri) g_uri_unref(uri);
    return valid;
}
std::string quote(const std::string &value) {
    std::string out = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 32) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += static_cast<char>(c);
    }
    return out + '"';
}
struct MenuState {
    std::vector<std::string> messages;
    std::string error;
    void push(std::string value) {
        size_t queued=0;for(const auto &message:messages)queued+=message.size();
        if (value.size() <= max_message_bytes && messages.size() < max_messages && queued+value.size()<=16*1024*1024) messages.push_back(std::move(value));
    }
    void fail(const char *reason) {
        error = reason ? reason : "WebKitGTK menu failed";
        push("{\"type\":\"menuError\",\"error\":" + quote(error) + "}");
    }
};
std::string restricted_html(const std::string &source) {
    const std::string policy = "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; font-src https://bunnyhop.lol data:; connect-src https://bunnyhop.lol wss://bunnyhop.lol; base-uri 'none'; frame-src 'none'; object-src 'none'; form-action 'none'\">";
    std::string lower = source;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(g_ascii_tolower(c)); });
    auto head = lower.find("<head");
    if (head == std::string::npos) head = lower.find("<!doctype");
    const auto end = head == std::string::npos ? std::string::npos : lower.find('>', head);
    const size_t at = end == std::string::npos ? 0 : end + 1;
    return source.substr(0, at) + policy + source.substr(at);
}
void pump_glib() {
    // SDL remains the application's event loop. Bound GTK work per game frame
    // and never wait for events or present/refocus a window from here.
    const gint64 until = g_get_monotonic_time() + 2000;
    for (int n = 0; n < 64 && g_main_context_pending(nullptr) && g_get_monotonic_time() < until; ++n)
        g_main_context_iteration(nullptr, FALSE);
}
}

namespace native {
struct MenuWebView::Impl {
    GtkWidget *window = nullptr, *auth_window = nullptr;
    WebKitWebView *menu = nullptr, *auth = nullptr;
    WebKitUserContentManager *manager = nullptr;
    WebKitWebContext *context = nullptr;
    GCancellable *pending = nullptr;
    std::shared_ptr<MenuState> state = std::make_shared<MenuState>();
    bool shown = false, initial_navigation = true;
    guint auth_complete_idle = 0;

    Impl(SDL_Window *sdl, const std::string &html) {
        if (!sdl) { state->error = "No SDL window for web menus"; return; }
        if (!gtk_init_check(nullptr, nullptr)) { state->error = "GTK could not open the display for native menus"; return; }
        gchar *data = g_build_filename(g_get_user_data_dir(), "bunnyhop-native", "webkit", nullptr);
        gchar *cache = g_build_filename(g_get_user_cache_dir(), "bunnyhop-native", "webkit", nullptr);
        if (g_mkdir_with_parents(data, 0700) || g_mkdir_with_parents(cache, 0700)) {
            state->error = "Could not create the native menu cookie/cache directories";
            g_free(data); g_free(cache); return;
        }
        auto *store = webkit_website_data_manager_new("base-data-directory", data, "base-cache-directory", cache, nullptr);
        context = webkit_web_context_new_with_website_data_manager(store);
        gchar *cookies = g_build_filename(data, "cookies.sqlite", nullptr);
        webkit_cookie_manager_set_persistent_storage(webkit_website_data_manager_get_cookie_manager(store), cookies, WEBKIT_COOKIE_PERSISTENT_STORAGE_SQLITE);
        g_free(cookies); g_free(data); g_free(cache); g_object_unref(store);
        pending = g_cancellable_new();
        manager = webkit_user_content_manager_new();
        // The actual native capability lives in an isolated script world and
        // is relayed only by a top-frame injected script. Default-world frames
        // and the independently constructed authentication view have no native
        // handler. The relay transfers JSON strings, never JS object proxies.
        g_signal_connect(manager, "script-message-received::bunnyhop", G_CALLBACK(message), this);
        if (!webkit_user_content_manager_register_script_message_handler_in_world(manager, "bunnyhop", bridge_world)) {
            state->error = "Could not register the native menu message handler"; return;
        }
        auto *relay = webkit_user_script_new_for_world(R"js(
if (window === top && location.origin === 'https://bunnyhop.lol') {
  window.addEventListener('__bunnyhopNativeMessage', event => {
    if (typeof event.detail === 'string' && event.detail.length <= 12582912)
      window.webkit.messageHandlers.bunnyhop.postMessage(event.detail);
  });
}
)js", WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, bridge_world, nullptr, nullptr);
        auto *api = webkit_user_script_new(R"js(
if (window === top && location.origin === 'https://bunnyhop.lol') {
  const postMessage = value => {
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    if (data.length <= 12582912) window.dispatchEvent(new CustomEvent('__bunnyhopNativeMessage', {detail:data}));
  };
  Object.defineProperty(window, 'webkit', {value:Object.freeze({messageHandlers:Object.freeze({bunnyhop:Object.freeze({postMessage})})}), writable:false, configurable:false});
}
)js", WEBKIT_USER_CONTENT_INJECT_TOP_FRAME, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, nullptr, nullptr);
        webkit_user_content_manager_add_script(manager, relay); webkit_user_content_manager_add_script(manager, api);
        webkit_user_script_unref(relay); webkit_user_script_unref(api);
        menu = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", context, "user-content-manager", manager, nullptr));
        settings(menu);
        window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        gtk_window_set_title(GTK_WINDOW(window), "Bunnyhop — menus & account");
        gtk_window_set_default_size(GTK_WINDOW(window), 1120, 760);
        gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(menu));
        g_signal_connect(window, "delete-event", G_CALLBACK(delete_menu), this);
        connect_view(menu);
        const auto source = restricted_html(html);
        webkit_web_view_load_html(menu, source.c_str(), "https://bunnyhop.lol/");
        // Do not show, activate or take focus here. Hidden --frames runs must
        // remain hidden and the host explicitly controls the menu lifecycle.
    }
    ~Impl() {
        if (pending) g_cancellable_cancel(pending);
        close_auth(false, false);
        if (manager) {
            g_signal_handlers_disconnect_by_data(manager, this);
            webkit_user_content_manager_unregister_script_message_handler_in_world(manager, "bunnyhop", bridge_world);
        }
        if (menu) { g_signal_handlers_disconnect_by_data(menu, this); webkit_web_view_stop_loading(menu); }
        if (window) { g_signal_handlers_disconnect_by_data(window, this); gtk_widget_destroy(window); }
        if (manager) g_object_unref(manager);
        if (context) g_object_unref(context);
        if (pending) g_object_unref(pending);
    }
    static void settings(WebKitWebView *view) {
        auto *prefs = webkit_web_view_get_settings(view);
        webkit_settings_set_enable_webgl(prefs, FALSE);
        webkit_settings_set_enable_developer_extras(prefs, FALSE);
        webkit_settings_set_javascript_can_open_windows_automatically(prefs, FALSE);
        // TLS validation, web security and the WebKit process sandbox keep
        // their platform defaults. No localhost server or CORS bypass is used.
    }
    void connect_view(WebKitWebView *view) {
        g_signal_connect(view, "decide-policy", G_CALLBACK(policy), this);
        g_signal_connect(view, "create", G_CALLBACK(create), this);
        g_signal_connect(view, "load-failed", G_CALLBACK(load_failed), this);
        g_signal_connect(view, "web-process-terminated", G_CALLBACK(terminated), this);
        g_signal_connect(view, "permission-request", G_CALLBACK(permission), this);
    }
    static void message(WebKitUserContentManager *, WebKitJavascriptResult *result, gpointer data) {
        auto &self = *static_cast<Impl *>(data);
        if (!self.menu || !game_origin(webkit_web_view_get_uri(self.menu))) return;
        JSCValue *value = webkit_javascript_result_get_js_value(result);
        if (!jsc_value_is_string(value)) return;
        gchar *raw = jsc_value_to_string(value);
        if (!raw || std::strlen(raw) > max_message_bytes) { g_free(raw); return; }
        JSCValue *object = jsc_value_new_from_json(jsc_value_get_context(value), raw);
        if (object && jsc_value_is_object(object) && !jsc_value_is_array(object)) {
            JSCValue *type = jsc_value_object_get_property(object, "type");
            if (type && jsc_value_is_string(type)) {
                gchar *name = jsc_value_to_string(type);
                if (name && std::strlen(name) > 0 && std::strlen(name) <= 64) self.state->push(raw);
                g_free(name);
            }
            if (type) g_object_unref(type);
        }
        if (object) g_object_unref(object);
        g_free(raw);
    }
    static gboolean policy(WebKitWebView *view, WebKitPolicyDecision *decision, WebKitPolicyDecisionType kind, gpointer data) {
        auto &self = *static_cast<Impl *>(data);
        if (kind != WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION && kind != WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) return FALSE;
        auto *action = webkit_navigation_policy_decision_get_navigation_action(WEBKIT_NAVIGATION_POLICY_DECISION(decision));
        const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
        if (view == self.menu) {
            if (self.initial_navigation && game_origin(uri) && kind == WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION) {
                self.initial_navigation = false; webkit_policy_decision_use(decision); return TRUE;
            }
            webkit_policy_decision_ignore(decision);
            if (auth_url(uri)) self.open_auth(uri);
            return TRUE;
        }
        if (view == self.auth) {
            if (!uri || !g_str_has_prefix(uri, "https://")) { webkit_policy_decision_ignore(decision); return TRUE; }
            if (game_origin(uri) && !auth_url(uri)) {
                webkit_policy_decision_ignore(decision);
                // Defer widget destruction until after WebKit's policy signal.
                if (!self.auth_complete_idle) self.auth_complete_idle = g_idle_add_full(G_PRIORITY_DEFAULT_IDLE, [](gpointer pointer) -> gboolean {
                    auto &owner = *static_cast<Impl *>(pointer);
                    owner.auth_complete_idle = 0; owner.close_auth(true); return G_SOURCE_REMOVE;
                }, &self, nullptr);
                return TRUE;
            }
            if (kind == WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION) {
                webkit_policy_decision_ignore(decision); webkit_web_view_load_uri(self.auth, uri); return TRUE;
            }
            webkit_policy_decision_use(decision); return TRUE;
        }
        webkit_policy_decision_ignore(decision); return TRUE;
    }
    static GtkWidget *create(WebKitWebView *view, WebKitNavigationAction *action, gpointer data) {
        auto &self = *static_cast<Impl *>(data);
        const char *uri = webkit_uri_request_get_uri(webkit_navigation_action_get_request(action));
        if (view == self.menu && auth_url(uri)) self.open_auth(uri);
        else if (view == self.auth && uri && g_str_has_prefix(uri, "https://")) webkit_web_view_load_uri(self.auth, uri);
        return nullptr;
    }
    static gboolean delete_menu(GtkWidget *, GdkEvent *, gpointer data) {
        auto &self = *static_cast<Impl *>(data);
        self.shown = false;
        if (self.auth_window) gtk_widget_hide(self.auth_window);
        gtk_widget_hide(self.window);
        self.state->push("{\"type\":\"resume\"}");
        return TRUE;
    }
    static gboolean delete_auth(GtkWidget *, GdkEvent *, gpointer data) {
        static_cast<Impl *>(data)->close_auth(false); return TRUE;
    }
    static gboolean load_failed(WebKitWebView *, WebKitLoadEvent, const gchar *, GError *error, gpointer data) {
        if (!g_error_matches(error, WEBKIT_NETWORK_ERROR, WEBKIT_NETWORK_ERROR_CANCELLED)) static_cast<Impl *>(data)->state->fail(error->message);
        return FALSE;
    }
    static void terminated(WebKitWebView *, WebKitWebProcessTerminationReason, gpointer data) {
        static_cast<Impl *>(data)->state->fail("WebKitGTK menu process terminated");
    }
    static gboolean permission(WebKitWebView *, WebKitPermissionRequest *request, gpointer) {
        webkit_permission_request_deny(request); return TRUE;
    }
    bool open_auth(const char *url) {
        if (!menu || !auth_url(url)) { state->error = "Authentication must begin at https://bunnyhop.lol/api/auth/"; return false; }
        close_auth(false, false);
        auto *empty = webkit_user_content_manager_new();
        // Do not use new_with_related_view: it would inherit the host manager.
        auth = WEBKIT_WEB_VIEW(g_object_new(WEBKIT_TYPE_WEB_VIEW, "web-context", context, "user-content-manager", empty, nullptr));
        g_object_unref(empty); settings(auth); connect_view(auth);
        auth_window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        gtk_window_set_title(GTK_WINDOW(auth_window), "Bunnyhop — sign in");
        gtk_window_set_default_size(GTK_WINDOW(auth_window), 760, 760);
        gtk_window_set_transient_for(GTK_WINDOW(auth_window), GTK_WINDOW(window));
        gtk_container_add(GTK_CONTAINER(auth_window), GTK_WIDGET(auth));
        g_signal_connect(auth_window, "delete-event", G_CALLBACK(delete_auth), this);
        webkit_web_view_load_uri(auth, url);
        if (shown) { gtk_widget_show_all(auth_window); gtk_window_present(GTK_WINDOW(auth_window)); }
        return true;
    }
    void close_auth(bool complete, bool notify = true) {
        if (auth_complete_idle) { g_source_remove(auth_complete_idle); auth_complete_idle = 0; }
        if (!auth_window) return;
        g_signal_handlers_disconnect_by_data(auth, this); webkit_web_view_stop_loading(auth);
        g_signal_handlers_disconnect_by_data(auth_window, this); gtk_widget_destroy(auth_window);
        auth_window = nullptr; auth = nullptr;
        if (notify) state->push(std::string("{\"type\":\"auth\",\"status\":\"") + (complete ? "complete" : "cancelled") + "\"}");
    }
};

MenuWebView::MenuWebView(SDL_Window *window, const std::string &html) : impl_(std::make_unique<Impl>(window, html)) {}
MenuWebView::~MenuWebView() = default;
bool MenuWebView::available() const { return impl_->menu && impl_->window; }
const std::string &MenuWebView::error() const { return impl_->state->error; }
bool MenuWebView::visible() const { return impl_->shown; }
void MenuWebView::set_visible(bool show) {
    if (!available() || show == impl_->shown) return;
    impl_->shown = show;
    if (show) {
        gtk_widget_show_all(impl_->window);
        gtk_window_present(GTK_WINDOW(impl_->window));
        if (impl_->auth_window) { gtk_widget_show_all(impl_->auth_window); gtk_window_present(GTK_WINDOW(impl_->auth_window)); }
    } else {
        if (impl_->auth_window) gtk_widget_hide(impl_->auth_window);
        gtk_widget_hide(impl_->window);
    }
}
std::vector<std::string> MenuWebView::drain_messages() {
    pump_glib();
    std::vector<std::string> result; result.swap(impl_->state->messages); return result;
}
void MenuWebView::evaluate_js(const std::string &script) {
    if (!available()) return;
    auto *state = new std::shared_ptr<MenuState>(impl_->state);
    const auto source = script + "\n;null;";
    webkit_web_view_evaluate_javascript(impl_->menu, source.c_str(), source.size(), nullptr, nullptr, impl_->pending,
        [](GObject *object, GAsyncResult *result, gpointer pointer) {
            std::unique_ptr<std::shared_ptr<MenuState>> state(static_cast<std::shared_ptr<MenuState> *>(pointer));
            GError *error = nullptr;
            JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(object), result, &error);
            if (error && !g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) (*state)->fail(error->message);
            if (value) g_object_unref(value);
            g_clear_error(&error);
        }, state);
}
bool MenuWebView::open_auth(const std::string &url) { return impl_->open_auth(url.c_str()); }
void MenuWebView::close_auth() { impl_->close_auth(false); }
bool MenuWebView::screenshot(const std::string &path) {
    if (!available() || path.empty()) return false;
    struct Snapshot { std::shared_ptr<MenuState> state; std::string path; };
    auto *snapshot = new Snapshot{impl_->state, path};
    webkit_web_view_get_snapshot(impl_->menu, WEBKIT_SNAPSHOT_REGION_VISIBLE, WEBKIT_SNAPSHOT_OPTIONS_NONE, impl_->pending,
        [](GObject *object, GAsyncResult *result, gpointer pointer) {
            std::unique_ptr<Snapshot> snapshot(static_cast<Snapshot *>(pointer));
            GError *error = nullptr;
            cairo_surface_t *surface = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(object), result, &error);
            const auto status = surface ? cairo_surface_write_to_png(surface, snapshot->path.c_str()) : CAIRO_STATUS_NULL_POINTER;
            const bool ok = surface && status == CAIRO_STATUS_SUCCESS;
            snapshot->state->push("{\"type\":\"menuSnapshot\",\"ok\":" + std::string(ok ? "true" : "false") +
                ",\"path\":" + quote(snapshot->path) + ",\"error\":" + quote(error ? error->message : ok ? "" : cairo_status_to_string(status)) + "}");
            if (surface) cairo_surface_destroy(surface);
            g_clear_error(&error);
        }, snapshot);
    return true;
}
}
