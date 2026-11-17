#pragma once
// The charm you wear, on the knife in first person (web viewmodel/viewmodel.ts KnifeCharm): the exported catalogue and
// fits, the charm and its options from the menu (loadout.ts packLoadoutExt), the fit of the knife, hilt and glove in
// hand, and the swing each frame. Drawing is the viewmodel's (one more mesh in the knife's material on its own bones).
#include "charm_fit.hpp"
#include "nlohmann/json.hpp"
#include <functional>
#include <map>
#include <memory>

namespace native_charm {

class FirstPersonCharm {
public:
    // The meshes the client already has, by name; empty when it has none.
    using MeshLookup = std::function<std::optional<MeshView>(const std::string &)>;
    // A living hilt's pieces as triangle corners (bind space) on a knife, or none.
    using HiltCorners = std::function<std::vector<float>(const std::string &hilt, const std::string &knife)>;

    explicit FirstPersonCharm(const nlohmann::json &metadata) {
        if (!metadata.contains("charms")) return;
        catalogue = &metadata.at("charms");
        const auto range = [&](const char *name) {
            const auto &r = catalogue->at("ranges").at(name);
            return Range{r.at("min"), r.at("max"), r.at("default"), r.at("step")};
        };
        length = range("length");
        size = range("size");
        swing = range("swing");
        hardware = {
                catalogue->at("topDrop"),
                catalogue->at("bottomRise"),
                catalogue->at("cordLength"),
                catalogue->at("scale")
        };
        for (const auto &[id, raw] : catalogue->at("charms").items())
            defs.emplace(id, def_of(id, raw));
    }

    // The charm and its options (loadout.ts packLoadoutExt text); an unknown charm or none hides it.
    void set_options(const std::string &text) {
        const auto parsed = unpack_options(text, length, size, swing);
        const auto found = parsed ? defs.find(parsed->charm) : defs.end();
        worn = found == defs.end() ? nullptr : &found->second;
        if (worn) options = *parsed;
        charm.set(worn, options, hardware, worn ? fit.get() : nullptr);
    }

    bool shown() const { return worn && fit && charm.placed(); }

    const CharmDef *charm_def() const { return worn; }

    const std::string &mount_mesh() const { return charm.placed() ? charm.placed()->mount_mesh : no_mesh; }

    const std::array<float, bone_count * 16> &bones() const { return charm.rig.bones; }

    void reset() { charm.reset(); }

    // The knife, hilt and glove style in hand; their fit is made when they change. `rest_skins`: every bone's skinning
    // matrix in the knife's idle at rest, `bind`: the bones' bind (3x4 each).
    void
    hold(const std::string &knife,
         const std::string &hilt,
         const std::string &glove,
         std::span<const float> rest_skins,
         std::span<const float> bind,
         int knife_bone,
         const std::set<int> &knife_bone_set,
         const MeshLookup &mesh,
         const HiltCorners &hilt_corners) {
        if (!catalogue || !worn) return;
        const auto key = knife + "|" + hilt + "|" + glove;
        if (key == fit_key) return;
        fit_key = key;
        const auto living = catalogue->at("fits").find(key);
        const auto plain = catalogue->at("fits").find(knife + "||" + glove);
        const auto &entry = living != catalogue->at("fits").end() ? living : plain;
        if (entry == catalogue->at("fits").end() || rest_skins.size() < size_t(knife_bone + 1) * 12) {
            fit.reset();
        } else {
            const bool hilt_pieces = living != catalogue->at("fits").end() && !hilt.empty();
            const Surfaces surfaces{rest_skins, bind, knife_bone, knife_bone_set, mesh, hilt_corners};
            fit = std::make_unique<Fit>(make_fit(*entry, knife, hilt_pieces ? hilt : "", glove, surfaces));
        }
        charm.set(worn, options, hardware, fit.get());
    }

    void update(const Frame &f) {
        if (worn && fit) charm.update(f);
    }

private:
    const nlohmann::json *catalogue = nullptr;
    Range length, size, swing;
    Hardware hardware;
    std::map<std::string, CharmDef> defs;
    const CharmDef *worn = nullptr;
    Options options;
    std::string fit_key;
    std::unique_ptr<Fit> fit;
    KnifeCharm charm;
    inline static const std::string no_mesh;

    // What the surfaces are sampled from.
    struct Surfaces {
        std::span<const float> skins, bind;
        int knife_bone;
        const std::set<int> &knife_bones;
        const MeshLookup &mesh;
        const HiltCorners &hilt_corners;
    };

    static V3 v3(const nlohmann::json &value) {
        return {value.at(0).get<double>(), value.at(1).get<double>(), value.at(2).get<double>()};
    }

    static CharmDef def_of(const std::string &id, const nlohmann::json &raw) {
        CharmDef def;
        def.id = id;
        def.mesh = raw.at("mesh");
        def.link = raw.at("link");
        def.radius = raw.at("radius");
        def.lift = raw.at("lift");
        for (const auto &b : raw.at("balls"))
            def.balls.push_back({b.at("d").get<double>(), b.at("r").get<double>()});
        if (const auto &l = raw.at("life"); l.is_object())
            def.life = {
                    life_named(l.at("kind").get<std::string>()),
                    v3(l.at("at")),
                    v3(l.at("axis")),
                    l.at("rate"),
                    l.at("amount")
            };
        return def;
    }

    static Hang hang_of(const nlohmann::json &h) {
        Hang out;
        out.bone = h.at("bone");
        out.at = v3(h.at("at"));
        if (h.at("mount").is_string()) out.mount_mesh = h.at("mount");
        for (const auto &c : h.at("colliders")) {
            HangCollider collider;
            collider.a = v3(c.at("a"));
            if (!c.at("b").is_null()) collider.b = v3(c.at("b"));
            collider.r = c.at("r");
            collider.bone = c.at("bone");
            collider.bone_b = c.at("boneB");
            collider.hand = c.at("hand");
            out.colliders.push_back(collider);
        }
        return out;
    }

    Fit make_fit(
            const nlohmann::json &entry,
            const std::string &knife,
            const std::string &hilt,
            const std::string &glove,
            const Surfaces &surfaces
    ) const {
        Fit out;
        const auto &hangs = catalogue->at("hangs");
        out.guard = hang_of(hangs.at(entry.at(0).get<size_t>()));
        if (const int pommel = entry.at(1); pommel >= 0) out.pommel = hang_of(hangs.at(size_t(pommel)));
        for (const auto &j : catalogue->at("holds").at(entry.at(2).get<size_t>()))
            out.joints.push_back({j.at("bone").get<int>(), v3(j.at("p"))});
        const auto &places = catalogue->at("places").at(knife);
        out.offers_guard = places.at("guard");
        out.offers_pommel = places.at("pommel");
        sample_surfaces(out, knife, hilt, glove, surfaces);
        return out;
    }

    // anchors.ts measure: the knife's surface and the hilt's pieces (always), the hand and the knife's moving parts at
    // rest (while the hand holds the knife as at rest).
    static void sample_surfaces(
            Fit &out, const std::string &knife, const std::string &hilt, const std::string &glove, const Surfaces &s
    ) {
        const auto *k = s.bind.data() + size_t(s.knife_bone) * 12;
        const auto to_local = rig_detail::invert(k);
        std::vector<float> solid, moving;
        if (const auto knife_mesh = s.mesh("fpknife:" + knife))
            knife_points(*knife_mesh, to_local, s.knife_bone, solid, moving);
        if (!hilt.empty()) hilt_points(s.hilt_corners(hilt, knife), to_local, solid);
        const auto rest = rig_detail::concat(s.skins.data() + size_t(s.knife_bone) * 12, k);
        const auto knife_inverse = rig_detail::invert(rest.data());
        std::vector<float> hands;
        if (const auto hand_mesh = s.mesh("hands:" + glove))
            hands = hand_points(*hand_mesh, s.skins, knife_inverse, s.knife_bones);
        hands.insert(hands.end(), moving.begin(), moving.end());
        out.solid = PointCloud(std::move(solid));
        out.hands = PointCloud(std::move(hands));
    }
};

}  // namespace native_charm
