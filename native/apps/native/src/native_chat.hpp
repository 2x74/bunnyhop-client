#pragma once
#include <algorithm>
#include <cstdint>
#include <cmath>
#include <limits>
#include <deque>
#include <string>
#include <string_view>
#include <vector>
#include "graphemes.hpp"
#include "text_raster.hpp"
#include "chat_links.hpp"
#include "name_tags.hpp"

namespace native {
struct ChatDecoration {
    std::string color, badge, country, rank, profile;
    std::string color2, effect, rank_color;
    NameAppearance appearance;
};
inline ChatDecoration chat_decoration(const nlohmann::json &message) {
    ChatDecoration decoration;
    decoration.color = json_text(message, "nativeNameColor");
    decoration.color2 = json_text(message, "nativeNameColor2");
    decoration.effect = json_text(message, "nativeNameEffect");
    decoration.badge = json_text(message, "nativeBadge");
    decoration.country = json_text(message, "nativeCountry", 2);
    decoration.rank = json_text(message, "nativeRank", 64);
    decoration.rank_color = json_text(message, "nativeRankColor");
    decoration.profile = json_text(message, "nativeProfileId");
    if (decoration.country.empty())
        decoration.country = json_text(message, "country", 2);
    const auto rank = message.find("rank");
    if (decoration.rank.empty() && rank != message.end() && rank->is_object()) {
        decoration.rank = json_text(*rank, "name", 64);
        decoration.rank_color = json_text(*rank, "color");
    }
    decoration.appearance = name_appearance(message);
    if (!decoration.color.empty())
        decoration.appearance.color = name_color(decoration.color);
    if (!decoration.color2.empty())
        decoration.appearance.second = name_color(decoration.color2);
    if (!decoration.effect.empty()) {
        const auto &effect = decoration.effect;
        decoration.appearance.effect = effect == "glow"                           ? NameEffect::glow
                                       : effect == "paint" || effect == "shimmer" ? NameEffect::paint
                                       : effect == "sparkle"                      ? NameEffect::sparkle
                                                                                  : NameEffect::plain;
    }
    // Older menu adapters send labels. Keep their marks without printing the words in game.
    constexpr std::array<std::pair<std::string_view, NameMark>, 8> legacy = {{{"Owner", NameMark::owner},
                                                                              {"Admin", NameMark::staff},
                                                                              {"Moderator", NameMark::staff},
                                                                              {"Verified", NameMark::verified},
                                                                              {"creator", NameMark::creator},
                                                                              {"Booster", NameMark::booster},
                                                                              {"Supporter", NameMark::supporter},
                                                                              {"Mapper", NameMark::mapper}}};
    for (const auto &[label, mark] : legacy) {
        if (decoration.badge.find(label) != std::string::npos)
            decoration.appearance.marks |= 1u << unsigned(mark);
    }
    const auto look = message.find("nativeName");
    const auto marks = message.find("nativeMarks");
    if (look != message.end() || marks != message.end())
        decoration.appearance =
            host_name_appearance(look != message.end() ? *look : nlohmann::json(),
                                 marks != message.end() ? *marks : nlohmann::json(), decoration.appearance);
    return decoration;
}
struct ChatLine { std::string text,name,kind; double expires=0; ChatDecoration decoration;uint64_t sequence=0; };
// The editor owns text only. Opening it must clear gameplay input, not stop the
// simulation or change the recorded camera. Byte cursors always sit on UTF-8 boundaries.
class Chat {
    std::deque<std::string> history;
    size_t history_index=0;
    std::string draft;
    size_t scroll_=0;
    uint64_t next_sequence_=0;
    size_t anchor_=0;
    mutable std::vector<ChatLine> visible_cache_;
    mutable uint64_t visible_sequence_ = ~uint64_t(0);
    mutable size_t visible_scroll_ = 0;
    mutable size_t visible_limit_ = 0;
    mutable bool visible_active_ = false;
    mutable double visible_until_ = -1;
    bool erase_selection(){if(!selected)return false;const auto [first,last]=selection();input.erase(first,last-first);cursor=first;anchor_=cursor;selected=false;return true;}
    void move(size_t to,bool extend){cursor_secondary=false;if(extend){if(!selected)anchor_=cursor;cursor=grapheme_floor(input,to);selected=cursor!=anchor_;}else{cursor=grapheme_floor(input,to);anchor_=cursor;selected=false;}}

public:
    bool active=false,selected=false,cursor_secondary=false;
    std::string input,composition;
    size_t cursor=0;
    std::vector<std::string> suggestions;
    std::deque<ChatLine> lines;
    static std::string clean(std::string_view raw,size_t maximum=512) {
        std::string out;
        for(size_t i=0;i<raw.size()&&out.size()<maximum;) {
            const auto c=uint8_t(raw[i]);size_t n=c<128?1:c>=0xc2&&c<=0xdf?2:c>=0xe0&&c<=0xef?3:c>=0xf0&&c<=0xf4?4:0;
            if(!n||i+n>raw.size()){++i;continue;}
            bool valid=true;for(size_t j=1;j<n;++j)valid&=(uint8_t(raw[i+j])&0xc0)==0x80;
            if(n==3)valid&=!(c==0xe0&&uint8_t(raw[i+1])<0xa0)&&!(c==0xed&&uint8_t(raw[i+1])>=0xa0);
            if(n==4)valid&=!(c==0xf0&&uint8_t(raw[i+1])<0x90)&&!(c==0xf4&&uint8_t(raw[i+1])>=0x90);
            if(!valid){++i;continue;}
            if(n==1&&(c<32||c==127)){if((c=='\n'||c=='\r'||c=='\t')&&!out.empty()&&out.back()!=' ')out+=' ';i+=n;continue;}
            if(out.size()+n>maximum)break;out.append(raw.substr(i,n));i+=n;
        }
        return out;
    }
    void open(bool command=false) {cursor_secondary=false;active=true;selected=false;anchor_=0;input=command?"!":"";cursor=input.size();composition.clear();suggestions.clear();history_index=history.size();draft.clear();scroll_=0;}
    void close(){active=false;scroll_=0;composition.clear();suggestions.clear();}
    void select_all(){cursor_secondary=false;selected=!input.empty();anchor_=0;cursor=input.size();}
    std::pair<size_t,size_t> selection()const{return selected?std::pair{std::min(anchor_,cursor),std::max(anchor_,cursor)}:std::pair{cursor,cursor};}
    std::string selected_text()const{const auto [a,b]=selection();return input.substr(a,b-a);}
    void position(size_t byte,bool extend=false){move(byte,extend);}
    void position(const TextCaret &caret,bool extend=false){move(caret.byte,extend);cursor_secondary=caret.secondary;}
    void visual_move(bool right,const std::vector<TextCaret>& carets,bool extend=false){
        if(carets.empty()){if(right)this->right(extend);else left(extend);return;}
        auto ordered=carets;std::stable_sort(ordered.begin(),ordered.end(),[](const auto&a,const auto&b){return a.x<b.x;});
        if(selected&&!extend){const auto [a,b]=selection();const TextCaret *first=nullptr,*last=nullptr;
            for(const auto &c:ordered)if(c.byte==a||c.byte==b){if(!first)first=&c;last=&c;}
            if(first&&last){position(right?*last:*first);return;}}
        auto at=std::find_if(ordered.begin(),ordered.end(),[&](const auto&c){return c.byte==cursor&&c.secondary==cursor_secondary;});
        if(at==ordered.end())at=std::find_if(ordered.begin(),ordered.end(),[&](const auto&c){return c.byte==cursor;});
        if(at==ordered.end()){move(right?input.size():0,extend);return;}
        const auto index=size_t(at-ordered.begin());position(ordered[right?std::min(index+1,ordered.size()-1):index?index-1:0],extend);
    }
    void pointer(float x,const std::vector<TextCaret>& carets,bool extend=false){if(carets.empty())return;const auto at=std::min_element(carets.begin(),carets.end(),[&](const auto&a,const auto&b){return std::abs(a.x-x)<std::abs(b.x-x);});position(*at,extend);}
    void insert(std::string_view text){if(!active)return;cursor_secondary=false;auto part=clean(text,4096);const auto [first,last]=selection();const auto available=512-(input.size()-(last-first));if(part.size()>available)part.resize(grapheme_floor(part,available));if(part.empty())return;erase_selection();input.insert(cursor,part);cursor=grapheme_after(input,cursor+part.size()-1);composition.clear();suggestions.clear();}
    void backspace(){cursor_secondary=false;if(!erase_selection()&&cursor){auto at=grapheme_before(input,cursor);input.erase(at,cursor-at);cursor=at;}anchor_=cursor;suggestions.clear();}
    void erase(){cursor_secondary=false;if(!erase_selection()&&cursor<input.size())input.erase(cursor,grapheme_after(input,cursor)-cursor);anchor_=cursor;suggestions.clear();}
    void left(bool extend=false){if(selected&&!extend)move(selection().first,false);else move(grapheme_before(input,cursor),extend);}
    void right(bool extend=false){if(selected&&!extend)move(selection().second,false);else move(grapheme_after(input,cursor),extend);}
    void home(bool extend=false){move(0,extend);}
    void end(bool extend=false){move(input.size(),extend);}
    void clear_input(){cursor_secondary=false;selected=false;anchor_=0;input.clear();cursor=0;composition.clear();suggestions.clear();}
    void history_step(int direction){cursor_secondary=false;
        if(history.empty())return;selected=false;
        if(history_index==history.size())draft=input;
        if(direction<0&&history_index) --history_index;
        else if(direction>0&&history_index<history.size())++history_index;
        input=history_index<history.size()?history[history_index]:draft;cursor=input.size();suggestions.clear();composition.clear();
    }
    std::string submit(){
        std::string result=input;const auto first=result.find_first_not_of(' ');if(first==std::string::npos)result.clear();else result=result.substr(first,result.find_last_not_of(' ')-first+1);
        if(!result.empty()&&(history.empty()||history.back()!=result)){history.push_back(result);if(history.size()>100)history.pop_front();}
        close();input.clear();cursor=0;return result;
    }
    void complete(){cursor_secondary=false;if(!suggestions.empty()){selected=false;input=clean(suggestions.front());cursor=input.size();suggestions.clear();}}
    void push(std::string text,std::string name,std::string kind,double now,double lifetime=12,ChatDecoration decoration={}){
        text=clean(text,2048);if(text.empty())return;
        decoration.badge=clean(decoration.badge,64);decoration.rank=clean(decoration.rank,64);decoration.country=clean(decoration.country,8);if(!chat_identifier(decoration.profile))decoration.profile.clear();
        if(decoration.color.size()!=7||decoration.color[0]!='#'||!std::all_of(decoration.color.begin()+1,decoration.color.end(),[](unsigned char c){return(c>='0'&&c<='9')||(c>='a'&&c<='f')||(c>='A'&&c<='F');}))decoration.color.clear();
        if(scroll_)++scroll_;
        lines.push_back({std::move(text),clean(name,256),clean(kind,32),now+std::clamp(lifetime,1.,60.),std::move(decoration),++next_sequence_});
        while(lines.size()>100)lines.pop_front();
        if(scroll_)scroll_=std::min(scroll_,lines.size()>8?lines.size()-8:0);
    }
    void scroll(int older,size_t limit=8){if(!active)return;const auto maximum=lines.size()>limit?lines.size()-limit:0;const auto next=int64_t(scroll_)+older;scroll_=size_t(std::clamp<int64_t>(next,0,int64_t(maximum)));}
    size_t scroll_offset()const{return scroll_;}
    uint64_t viewport(double now,size_t limit=8)const{uint64_t hash=1469598103934665603ull;for(const auto&line:visible(now,limit)){hash^=line.sequence;hash*=1099511628211ull;}return hash^(scroll_<<1)^uint64_t(active);}
    void scroll_bottom(){scroll_=0;}
    const std::vector<ChatLine> &visible(double now, size_t limit = 8) const {
        if (visible_sequence_ == next_sequence_ && visible_scroll_ == scroll_ && visible_limit_ == limit &&
            visible_active_ == active && now < visible_until_)
            return visible_cache_;
        visible_cache_.clear();
        visible_until_ = std::numeric_limits<double>::infinity();
        size_t skipped = 0;
        for (auto line = lines.rbegin(); line != lines.rend() && visible_cache_.size() < limit; ++line) {
            if (!active && line->expires <= now)
                continue;
            if (active && skipped++ < scroll_)
                continue;
            visible_cache_.push_back(*line);
            if (!active)
                visible_until_ = std::min(visible_until_, line->expires);
        }
        std::reverse(visible_cache_.begin(), visible_cache_.end());
        visible_sequence_ = next_sequence_;
        visible_scroll_ = scroll_;
        visible_limit_ = limit;
        visible_active_ = active;
        return visible_cache_;
    }
};
}
