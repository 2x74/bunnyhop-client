#include "native_chat.hpp"
#include <cassert>

int main() {
    native::Chat chat;
    chat.open();
    chat.insert("a😀é中");
    assert(chat.cursor == 10);
    chat.left();
    chat.backspace();
    assert(chat.input == "a😀中");
    chat.home();
    chat.right();
    chat.erase();
    assert(chat.input == "a中");
    chat.end();
    chat.insert("\nhello\tworld");
    assert(chat.input == "a中hello world");
    assert(chat.submit() == "a中hello world");
    assert(!chat.active);
    chat.open(true);
    assert(chat.input == "!");
    chat.insert("cp");
    assert(chat.submit() == "!cp");
    chat.open();
    chat.insert("draft");
    chat.history_step(-1);
    assert(chat.input == "!cp");
    chat.history_step(-1);
    assert(chat.input == "a中hello world");
    chat.history_step(1);
    chat.history_step(1);
    assert(chat.input == "draft");
    chat.clear_input();
    chat.insert(std::string(510, 'x'));
    chat.insert("😀");
    assert(chat.input.size() == 510);
    chat.insert("é");
    assert(chat.input.size() == 512);
    chat.insert("z");
    assert(chat.input.size() == 512);
    assert(native::Chat::clean(std::string("\xc0\xaf\xed\xa0\x80", 5)).empty());
    assert(native::Chat::clean("ok\r\nline") == "ok line");
    chat.close();
    for (int i = 0; i < 110; ++i)
        chat.push(std::to_string(i), "player", "chat", 0);
    assert(chat.lines.size() == 100);
    assert(chat.visible(1).size() == 8);
    assert(chat.visible(13).empty());
    chat.open();
    assert(chat.visible(13).size() == 8);
    auto before = chat.visible(13);
    chat.scroll(5);
    assert(chat.scroll_offset() == 5 && chat.visible(13).back().text == "104");
    chat.push("110", "other", "chat", 14);
    assert(chat.visible(14).back().text == "104");
    chat.scroll(-100);
    assert(chat.scroll_offset() == 0 && chat.visible(14).back().text == "110");
    chat.scroll(1000);
    assert(chat.visible(14).size() == 8);
    chat.close();
    assert(chat.scroll_offset() == 0);
    chat.push(
            "decorated",
            "runner",
            "chat",
            14,
            12,
            {"#00ffAA", "SUPPORTER", "US", "Gold", "player-1", {}, {}, {}, {}, {}}
    );
    const auto decorated = chat.visible(14).back();
    assert(decorated.decoration.color == "#00ffAA" && decorated.decoration.badge == "SUPPORTER");
    chat.push(
            "unsafe", "runner", "error", 14, 12, {"red;bad", "badge\nline", "USAUSAUSA", "rank", "", {}, {}, {}, {}, {}}
    );
    assert(chat.visible(14).back().decoration.color.empty() && chat.visible(14).back().decoration.country.size() == 8);
    chat.open();
    chat.clear_input();
    chat.insert("selected😀");
    chat.select_all();
    chat.insert("replacement");
    assert(chat.input == "replacement");
    chat.select_all();
    chat.backspace();
    assert(chat.input.empty());
    chat.suggestions = {"!restart"};
    chat.complete();
    assert(chat.input == "!restart");
    assert(chat.cursor == 8);
    // Editing follows extended graphemes, not codepoints: accent, family emoji,
    // Indic conjunct and flag each move/delete as one user-perceived character.
    for (const std::string cluster : {"é", "👩‍👩‍👧‍👦", "क्ष", "🇺🇸", "각"}) {
        chat.open();
        chat.insert("a" + cluster + "b");
        chat.left();
        chat.backspace();
        assert(chat.input == "ab");
        chat.home();
        chat.right(true);
        assert(chat.selected_text() == "a");
        chat.right(true);
        assert(chat.selected_text() == "ab");
        chat.insert(cluster);
        assert(chat.input == cluster);
        chat.home();
        chat.erase();
        assert(chat.input.empty());
    }
    chat.open();
    chat.insert("אבג");
    const std::vector<native::TextCaret> rtl{{0, 30}, {2, 20}, {4, 10}, {6, 0}};
    chat.home();
    chat.visual_move(false, rtl);
    assert(chat.cursor == 2);
    chat.visual_move(false, rtl, true);
    assert(chat.selected_text() == "ב");
    chat.pointer(29, rtl);
    assert(chat.cursor == 0);
    chat.pointer(1, rtl, true);
    assert(chat.selected_text() == "אבג");
    chat.visual_move(true, rtl);
    assert(chat.cursor == 0 && !chat.selected);
    const auto link = native::safe_chat_target("https://bunnyhop.lol/u/alice");
    assert(link && link->kind == "profile");
    assert(!native::safe_chat_target("https://bunnyhop.lol.evil/u/alice"));
    assert(!native::safe_chat_target("https://bunnyhop.lol/api/auth/logout"));
    assert(!native::safe_chat_target("https://bunnyhop.lol/maps/.."));
    assert(!native::safe_chat_target("https://bunnyhop.lol/u/alice?x=1"));
    assert(!native::safe_chat_target("https://bunnyhop.lol/u/%61lice"));
    const auto links = native::chat_links("Watch https://bunnyhop.lol/replay/run-1, and https://evil.test/u/alice");
    assert(links.size() == 1 && links[0].target.id == "run-1");
    native::ChatLinkHits hits;
    hits.set({{10, 20, 100, 30, *link, 1}}, 123);
    assert(hits.hit(10, 20, 123));
    assert(!hits.hit(110, 20, 123));
    assert(!hits.hit(20, 20, 124));
    hits.clear();
    assert(!hits.hit(20, 20, 123));
    const auto viewport = chat.viewport(1);
    chat.push("new", "", "say", 1);
    assert(chat.viewport(1) != viewport);

    chat.open();
    chat.insert(std::string(510, 'x'));
    chat.insert("é");
    assert(chat.input.size() == 510);  // Pasting never cuts a grapheme at the byte cap.
    chat.open();
    chat.insert("👩👧");
    chat.position(4);
    chat.insert("‍");
    assert(chat.cursor == chat.input.size());
    chat.backspace();
    assert(chat.input.empty());

    // A bidi boundary has two visual locations for one logical byte position.
    // Moving or clicking to its secondary location must not jump to primary.
    chat.open();
    chat.insert("aאבb");
    const std::vector<native::TextCaret> mixed{
            {0, 0}, {1, 10}, {1, 30, true}, {3, 20}, {5, 30}, {5, 10, true}, {6, 40}
    };
    chat.position(native::TextCaret{1, 30, true});
    assert(chat.cursor == 1 && chat.cursor_secondary);
    chat.visual_move(false, mixed);
    assert(chat.cursor == 3 && !chat.cursor_secondary);
    chat.visual_move(true, mixed);
    assert(chat.cursor == 1 && chat.cursor_secondary);
    chat.insert("x");
    assert(chat.input == "axאבb" && !chat.cursor_secondary);
}
