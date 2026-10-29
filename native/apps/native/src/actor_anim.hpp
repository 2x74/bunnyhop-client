#pragma once
// Runtime Source animation evaluator. Mirrors web player/studio/{pose,animstate}.ts.
// Original decoded animations are shared; every actor keeps independent transition/feet/fire state.
#include "nlohmann/json.hpp"
#include "actor_gestures.hpp"
#include <vector>
#include <array>
#include <string>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <memory>
#include <optional>
#include <unordered_map>

namespace native_actor_anim {
using J = nlohmann::json;
using V = std::vector<float>;

inline double clamp(double v, double a, double b) {
    return std::clamp(v, a, b);
}

inline double angle(double a) {
    a = std::fmod(a, 360);
    return a > 180 ? a - 360 : a < -180 ? a + 360 : a;
}

inline void concat(const float *a, const float *b, float *out) {
    float v[12];
    for (int r = 0; r < 3; r++)
        for (int c = 0; c < 4; c++)
            v[r * 4 + c] =
                    a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c == 3 ? a[r * 4 + 3] : 0);
    std::copy(v, v + 12, out);
}

struct Data {
    J info, rig;
    V bytes, restQ, restP, inverse;
    std::vector<int> offsets, parent, map;
    size_t bones = 0;

    explicit Data(const std::string &root) {
        std::ifstream j(root + "/actor-animations.json");
        J m;
        j >> m;
        if (m.at("version") != 1) throw std::runtime_error("actor animation version");
        info = m.at("info");
        rig = m.at("rig");
        bones = info.at("bones").size();
        if (!bones || bones > 256) throw std::runtime_error("actor animation bones");
        std::ifstream b(root + "/actor-animations.bin", std::ios::binary | std::ios::ate);
        auto n = b.tellg();
        if (n < 0 || n > 64000000 || n % 4) throw std::runtime_error("actor animation data");
        bytes.resize(size_t(n) / 4);
        b.seekg(0);
        b.read((char *)bytes.data(), n);
        if (!b) throw std::runtime_error("actor animation truncated");
        offsets.resize(info["anims"].size(), -1);
        for (const auto &[k, v] : m.at("offsets").items()) {
            const int a = std::stoi(k), o = v;
            if (a < 0 || size_t(a) >= offsets.size() || o < 0
                || size_t(o) + size_t(info["anims"][a]["frames"].get<int>()) * bones * 7 > bytes.size())
                throw std::runtime_error("actor animation range");
            offsets[a] = o;
        }
        for (const auto &bone : info["bones"]) {
            parent.push_back(bone["parent"]);
            for (float x : bone["quat"])
                restQ.push_back(x);
            for (float x : bone["pos"])
                restP.push_back(x);
        }
        inverse = rig["inverse"].get<V>();
        map = rig["map"].get<std::vector<int>>();
        if (inverse.size() != map.size() * 12) throw std::runtime_error("actor rig range");
    }

    int seq(const std::string &name) const {
        auto lower = [](std::string s) {
            std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
            return s;
        };
        const auto key = lower(name);
        for (size_t i = 0; i < info["seqs"].size(); i++)
            if (lower(info["seqs"][i]["name"]) == key) return int(i);
        return -1;
    }

    int activity(const std::string &name) const {
        for (size_t i = 0; i < info["seqs"].size(); i++)
            if (info["seqs"][i]["activity"] == name) return int(i);
        return -1;
    }

    int param(const std::string &name) const {
        for (size_t i = 0; i < info["poseParams"].size(); i++)
            if (info["poseParams"][i]["name"] == name) return int(i);
        return -1;
    }
};

struct Pose {
    const Data &d;
    V q, p, params, world;

    explicit Pose(const Data &d)
        : d(d)
        , q(d.restQ)
        , p(d.restP)
        , params(d.info["poseParams"].size())
        , world(d.bones * 12) {
        for (size_t i = 0; i < params.size(); i++)
            set(i, 0);
    }

    double set(int i, double value) {
        if (i < 0) return value;
        const auto &pp = d.info["poseParams"][i];
        double start = pp["start"], end = pp["end"], loop = pp["loop"];
        if (loop) {
            const double wrap = (start + end) / 2 + loop / 2, shift = loop - wrap;
            value -= loop * std::floor((value + shift) / loop);
        }
        params[i] = clamp((value - start) / (end - start), 0, 1);
        return params[i] * (end - start) + start;
    }

    double get(int i) const {
        if (i < 0) return 0;
        const auto &v = d.info["poseParams"][i];
        return params[i] * (v["end"].get<double>() - v["start"].get<double>()) + v["start"].get<double>();
    }

    std::pair<double, int> local(const J &s, int k) const {
        const int ip = s["params"][k];
        if (ip < 0) return {0, 0};
        const auto &pp = d.info["poseParams"][ip];
        double v = params[ip], start = pp["start"], end = pp["end"];
        int gs = s["groupSize"][k];
        if (s["poseKeys"].empty()) {
            double ls = (s["paramStart"][k].get<double>() - start) / (end - start),
                   le = (s["paramEnd"][k].get<double>() - start) / (end - start), t = clamp((v - ls) / (le - ls), 0, 1);
            int index = 0;
            if (gs > 2) {
                index = int(std::floor(t * (gs - 1)));
                if (index == gs - 1) index = gs - 2;
                t = t * (gs - 1) - index;
            }
            return {t, index};
        }
        v = v * (end - start) + start;
        const int base = k ? s["groupSize"][0].get<int>() : 0;
        int index = 0;
        double t = 0;
        for (;;) {
            const double a = s["poseKeys"][base + index], b = s["poseKeys"][base + index + 1];
            t = (v - a) / (b - a);
            if (index < gs - 2 && t > 1) {
                index++;
                continue;
            }
            break;
        }
        return {clamp(t, 0, 1), index};
    }

    std::vector<std::pair<int, float>> corners(const J &s) const {
        auto [sx, ix] = local(s, 0);
        auto [sy, iy] = local(s, 1);
        int cols = s["groupSize"][0], rows = s["groupSize"][1], last = int(s["anims"].size()) - 1;
        std::vector<std::pair<int, float>> r;
        auto put = [&](int x, int y, double w) {
            if (w > .001) r.emplace_back(s["anims"][std::min(last, y * cols + x)].get<int>(), float(w));
        };
        put(ix, iy, (1 - sx) * (1 - sy));
        put(std::min(ix + 1, cols - 1), iy, sx * (1 - sy));
        put(ix, std::min(iy + 1, rows - 1), (1 - sx) * sy);
        put(std::min(ix + 1, cols - 1), std::min(iy + 1, rows - 1), sx * sy);
        return r;
    }

    double rate(int si) const {
        if (si < 0) return 0;
        double rate = 0;
        for (auto [a, w] : corners(d.info["seqs"][si])) {
            const auto &i = d.info["anims"][a];
            int f = i["frames"];
            if (f > 1) rate += i["fps"].get<double>() / (f - 1) * w;
        }
        return rate;
    }

    void init() {
        q = d.restQ;
        p = d.restP;
    }

    void accumulate(int si, double cycle, double weight, int depth = 0) {
        if (si < 0 || weight <= 0 || depth > 6) return;
        weight = std::min(weight, 1.);
        const auto &s = d.info["seqs"][si];
        int flags = s["flags"];
        if (cycle < 0 || cycle >= 1) {
            if (flags & 1) {
                cycle -= std::trunc(cycle);
                if (cycle < 0) cycle++;
            } else
                cycle = clamp(cycle, 0, 1);
        }
        auto cs = corners(s);
        V tq(d.bones * 4), tp(d.bones * 3);
        double wsum = 0;
        int corner = 0;
        for (auto [a, w] : cs) {
            wsum += w;
            const auto &i = d.info["anims"][a];
            int frames = i["frames"];
            double f = cycle * (frames - 1), t = f - std::floor(f);
            int f0 = std::min(frames - 1, int(std::floor(f))), f1 = std::min(frames - 1, f0 + 1);
            const int off = d.offsets[a];
            for (size_t b = 0; b < d.bones; b++) {
                const double bw = s["weights"].size() == d.bones ? s["weights"][b].get<double>() : 1;
                if (bw <= 0) continue;
                float v[7];
                if (off < 0) {
                    for (int j = 0; j < 4; j++)
                        v[j] = (flags & 4) ? float(j == 3) : d.restQ[b * 4 + j];
                    for (int j = 0; j < 3; j++)
                        v[4 + j] = (flags & 4) ? 0 : d.restP[b * 3 + j];
                } else {
                    const auto *x = d.bytes.data() + off + (f0 * d.bones + b) * 7;
                    const auto *y = d.bytes.data() + off + (f1 * d.bones + b) * 7;
                    float dot = 0;
                    for (int j = 0; j < 4; j++)
                        dot += x[j] * y[j];
                    for (int j = 0; j < 7; j++)
                        v[j] = float(x[j] + ((j < 4 && dot < 0 ? -y[j] : y[j]) - x[j]) * t);
                }
                double dot = 0;
                for (int j = 0; j < 4; j++)
                    dot += tq[b * 4 + j] * v[j];
                float sign = corner && dot < 0 ? -w : w;
                for (int j = 0; j < 4; j++)
                    tq[b * 4 + j] += v[j] * sign;
                for (int j = 0; j < 3; j++)
                    tp[b * 3 + j] += v[j + 4] * w;
            }
            corner++;
        }
        for (size_t b = 0; b < d.bones; b++) {
            double bw = s["weights"].size() == d.bones ? s["weights"][b].get<double>() : 1, sw = weight * bw;
            if (sw <= 0) continue;
            size_t qo = b * 4, po = b * 3;
            double norm = 0;
            for (int j = 0; j < 4; j++)
                norm += tq[qo + j] * tq[qo + j];
            norm = std::sqrt(norm);
            if (norm == 0) norm = 1;
            for (int j = 0; j < 4; j++)
                tq[qo + j] /= norm;
            for (int j = 0; j < 3; j++)
                tp[po + j] /= wsum > 0 ? wsum : 1;
            if (flags & 4) {
                double x = tq[qo], y = tq[qo + 1], z = tq[qo + 2], w = tq[qo + 3],
                       sinom = std::min(1., std::sqrt(x * x + y * y + z * z)),
                       k = std::sin(std::asin(sinom) * sw) / (sinom + 1e-6);
                float delta[4] = {
                        float(x * k),
                        float(y * k),
                        float(z * k),
                        float((w < 0 ? -1 : 1)
                              * std::sqrt(std::max(0., 1 - std::pow(std::sin(std::asin(sinom) * sw), 2))))
                };
                const float *A = (flags & 16) ? q.data() + qo : delta, *B = (flags & 16) ? delta : q.data() + qo;
                float v[4] = {
                        A[3] * B[0] + A[0] * B[3] + A[1] * B[2] - A[2] * B[1],
                        A[3] * B[1] - A[0] * B[2] + A[1] * B[3] + A[2] * B[0],
                        A[3] * B[2] + A[0] * B[1] - A[1] * B[0] + A[2] * B[3],
                        A[3] * B[3] - A[0] * B[0] - A[1] * B[1] - A[2] * B[2]
                };
                norm = 0;
                for (auto a : v)
                    norm += a * a;
                norm = std::sqrt(norm);
                if (!norm) norm = 1;
                for (int j = 0; j < 4; j++)
                    q[qo + j] = v[j] / norm;
                for (int j = 0; j < 3; j++)
                    p[po + j] += tp[po + j] * sw;
            } else {
                double dot = 0;
                for (int j = 0; j < 4; j++)
                    dot += q[qo + j] * tq[qo + j];
                norm = 0;
                for (int j = 0; j < 4; j++) {
                    q[qo + j] = q[qo + j] * (1 - sw) + tq[qo + j] * sw * (dot < 0 ? -1 : 1);
                    norm += q[qo + j] * q[qo + j];
                }
                norm = std::sqrt(norm);
                if (!norm) norm = 1;
                for (int j = 0; j < 4; j++)
                    q[qo + j] /= norm;
                for (int j = 0; j < 3; j++)
                    p[po + j] = p[po + j] * (1 - sw) + tp[po + j] * sw;
            }
        }
        for (const auto &l : s["layers"]) {
            int lf = l["flags"];
            if (lf & 0x1000) continue;
            double lc = cycle, lw = weight, start = l["start"], end = l["end"], peak = l["peak"], tail = l["tail"];
            if (start != end) {
                double index = (lf & 0x4000) ? get(l["pose"]) : cycle;
                if (index < start || index >= end) continue;
                double sw = 1;
                if (index < peak && start != peak)
                    sw = (index - start) / (peak - start);
                else if (index > tail && end != tail)
                    sw = (end - index) / (end - tail);
                if (lf & 0x40) sw = sw * sw * (3 - 2 * sw);
                lw = (lf & 0x80) && index > tail ? (sw * weight) / (1 - weight + sw * weight)
                     : (lf & 0x200)              ? sw
                                                 : weight * sw;
                if (!(lf & 0x4000)) lc = (cycle - start) / (end - start);
            }
            accumulate(l["seq"], lc, lw, depth + 1);
        }
    }

    const V &build() {
        for (size_t i = 0; i < d.bones; i++) {
            double x = q[i * 4], y = q[i * 4 + 1], z = q[i * 4 + 2], w = q[i * 4 + 3];
            float m[12] = {
                    float(1 - 2 * y * y - 2 * z * z),
                    float(2 * x * y - 2 * w * z),
                    float(2 * x * z + 2 * w * y),
                    p[i * 3],
                    float(2 * x * y + 2 * w * z),
                    float(1 - 2 * x * x - 2 * z * z),
                    float(2 * y * z - 2 * w * x),
                    p[i * 3 + 1],
                    float(2 * x * z - 2 * w * y),
                    float(2 * y * z + 2 * w * x),
                    float(1 - 2 * x * x - 2 * y * y),
                    p[i * 3 + 2]
            };
            if (d.parent[i] < 0)
                std::copy(m, m + 12, world.data() + i * 12);
            else
                concat(world.data() + d.parent[i] * 12, m, world.data() + i * 12);
        }
        return world;
    }
};

struct Blend {
    int seq = -1;
    double cycle = 0, rate = 1, time = 0, fade = 0, weight = 1;
};

struct Transition {
    std::vector<Blend> queue;

    void check(const Data &d, int seq, bool force) {
        if (queue.empty()) queue.emplace_back();
        if (queue.back().time && (queue.back().seq != seq || force)) {
            const auto &next = d.info["seqs"][seq];
            if (next["flags"].get<int>() & 2)
                queue.clear();
            else
                queue.back().fade = std::min(
                        d.info["seqs"][queue.back().seq]["fadeOut"].get<double>(), next["fadeIn"].get<double>()
                );
            queue.emplace_back();
        }
        queue.back().seq = -1;
        queue.back().time = queue.back().fade = 0;
    }

    void update(int seq, double cycle, double rate, double now) {
        if (queue.empty()) queue.emplace_back();
        auto &cur = queue.back();
        cur.seq = seq;
        cur.time = now;
        cur.cycle = cycle;
        cur.rate = rate;
        cur.weight = 1;
        for (size_t i = 0; i + 1 < queue.size();) {
            auto &b = queue[i];
            double s = b.fade <= 0 ? 0 : 1 - (now - b.time) / b.fade;
            if (s > 0 && s <= 1)
                s = 3 * s * s - 2 * s * s * s;
            else if (s > 1)
                s = 1;
            if (s > 0) {
                b.weight = s;
                i++;
            } else
                queue.erase(queue.begin() + i);
        }
    }
};

struct Input {
    std::array<float, 3> position{}, velocity{};
    double yaw = 0, pitch = 0;
    bool ducking = false, grounded = true, jumped = false;
};

// Acting for the onboarding scenes and avatar pictures, in degrees. Gameplay callers leave it null.
struct Acting {
    double chestPitch = 0, chestYaw = 0, chestRoll = 0, headPitch = 0, headYaw = 0, headRoll = 0, earL = 0, earR = 0;
    native_gestures::Gesture gesture;
};

struct Ear {
    int bone = -1;
    double side = 1;
    std::array<double, 3> base{}, mid{}, dir{}, p{}, v{}, wb{};
    bool has = false;
};

inline void
swing(const std::array<double, 3> &a,
      const std::array<double, 3> &b,
      const std::array<double, 3> &pivot,
      double frac,
      float *out) {
    double x = a[1] * b[2] - a[2] * b[1], y = a[2] * b[0] - a[0] * b[2], z = a[0] * b[1] - a[1] * b[0],
           len = std::sqrt(x * x + y * y + z * z), angle = std::atan2(len, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    if (len < 1e-6) {
        x = 1;
        y = z = angle = 0;
    } else {
        x /= len;
        y /= len;
        z /= len;
    }
    angle = std::min(angle, 1.1) * frac;
    double c = std::cos(angle), sn = std::sin(angle), t = 1 - c;
    float r[9] = {
            float(t * x * x + c),
            float(t * x * y - sn * z),
            float(t * x * z + sn * y),
            float(t * x * y + sn * z),
            float(t * y * y + c),
            float(t * y * z - sn * x),
            float(t * x * z - sn * y),
            float(t * y * z + sn * x),
            float(t * z * z + c)
    };
    for (int row = 0; row < 3; row++) {
        double p = 0;
        for (int k = 0; k < 3; k++) {
            out[row * 4 + k] = r[row * 3 + k];
            p += r[row * 3 + k] * pivot[k];
        }
        out[row * 4 + 3] = float(pivot[row] - p);
    }
}

struct State {
    std::vector<std::pair<double, float>> velocityHistory;
    double lastJump = -1;
    bool wasGrounded = true;
    std::array<Ear, 2> ears;
    double earTwitch = 3;
    unsigned randomState = 0x12345678;
    const Data &d;
    Pose bs;
    double now = 0, cycle = 0, feetYaw = 0, goalFeetYaw = 0, bodyYaw = 0, gaitYaw = 0, eyeYaw = 0, eyePitch = 0,
           maxSpeed = 0, speed = 0, vx = 0, vy = 0, groundTime = 0, jumpStart = 0, lastTurnTime = 0, fireCycle = 0,
           last = -1;
    int seq = -1, parity = 0, prevParity = 0, fireSeq = -1;
    std::string activity = "ACT_IDLE";
    bool jumping = false, firstJump = false, feetInit = false;
    Transition main, idle, run;
    std::array<Blend, 4> layers;
    std::optional<native_gestures::Rig> gestureRig;
    int px, py, pYaw, pPitch;

    explicit State(const Data &d)
        : d(d)
        , bs(d)
        , px(d.param("move_x"))
        , py(d.param("move_y"))
        , pYaw(d.param("body_yaw"))
        , pPitch(d.param("body_pitch")) {
        if (d.rig.contains("bind")) {
            const auto bind = d.rig["bind"].get<V>();
            for (int side = 0; side < 2; side++) {
                auto &e = ears[side];
                e.side = side ? -1 : 1;
                const std::string name = side ? "bunny.EarR" : "bunny.EarL";
                for (size_t i = 0; i < d.rig["names"].size(); i++)
                    if (d.rig["names"][i] == name) e.bone = int(i);
                if (e.bone < 0) continue;
                e.dir = {.27 * e.side, .36, .893};
                for (int k = 0; k < 3; k++) {
                    e.base[k] = bind[e.bone * 12 + k * 4 + 3];
                    e.mid[k] = e.base[k] + e.dir[k] * 4.4;
                }
            }
        }
    }

    void reset(double time) {
        now = time;
        groundTime = cycle = 0;
        fireSeq = seq = -1;
        feetInit = jumping = firstJump = false;
        main.queue.clear();
        idle.queue.clear();
        run.queue.clear();
    }

    void airborne(double elapsed) {
        int hop = d.activity("ACT_HOP");
        if (hop < 0) return;
        jumping = true;
        firstJump = false;
        jumpStart = now - elapsed;
        seq = hop;
        activity = "ACT_HOP";
        cycle = clamp(elapsed * bs.rate(hop), 0, 1);
    }

    void fire() {
        std::string n = activity == "ACT_RUN"          ? "Run"
                        : activity == "ACT_WALK"       ? "Walk"
                        : activity == "ACT_CROUCHIDLE" ? "Crouch_Idle"
                        : activity == "ACT_RUN_CROUCH" ? "Crouch_Walk"
                                                       : "Idle";
        fireSeq = d.seq(n + "_Shoot_KNIFE");
        fireCycle = 0;
    }

    double movement() const { return speed <= .5 ? 1 : maxSpeed < .001 ? .01 : clamp(speed / maxSpeed, .01, 10); }

    int aim(bool force) {
        std::string n = force                   ? (activity == "ACT_CROUCHIDLE" ? "Crouch_Idle" : "Idle")
                        : activity == "ACT_RUN" ? "Run"
                        : activity == "ACT_WALK" || activity == "ACT_RUNTOIDLE" || activity == "ACT_IDLETORUN" ? "Walk"
                        : activity == "ACT_CROUCHIDLE" ? "Crouch_Idle"
                        : activity == "ACT_RUN_CROUCH" ? "Crouch_Walk"
                                                       : "Idle";
        return d.seq(n + "_Upper_KNIFE");
    }

    void aimLayers(int first, bool force, Transition &t, double scale) {
        int s = aim(force);
        if (s < 0) s = 0;
        t.check(d, s, false);
        t.update(s, cycle, 1, now);
        auto &a = layers[first];
        auto &b = layers[first + 1];
        a.seq = t.queue[0].seq;
        a.weight = t.queue.size() == 1 ? 1 : t.queue[0].weight;
        if (t.queue.size() > 1) b.seq = t.queue[1].seq;
        b.weight = t.queue.size() == 1 ? 0 : 1 - a.weight;
        a.weight = clamp(a.weight * scale, 0, 1);
        b.weight = clamp(b.weight * scale, 0, 1);
        a.cycle = b.cycle = cycle;
    }

    void update(double dt, const Input &s, bool sampled = false, double sampleTime = 0) {
        now += dt;
        vx = s.velocity[0];
        vy = s.velocity[1];
        speed = std::hypot(vx, vy);
        groundTime = s.grounded ? groundTime + dt : 0;
        if (s.jumped) {
            jumping = firstJump = true;
            jumpStart = now;
        }
        eyeYaw = angle(s.yaw);
        eyePitch = angle(s.pitch);
        if (jumping) {
            if (firstJump) {
                firstJump = false;
                if (activity == "ACT_HOP") parity++;
                cycle = 0;
            }
            if (now - jumpStart > .2 && s.grounded && groundTime >= .025) {
                jumping = false;
                cycle = 0;
            }
        }
        activity = jumping      ? "ACT_HOP"
                   : s.ducking  ? (speed > .5 ? "ACT_RUN_CROUCH" : "ACT_CROUCHIDLE")
                   : speed > .5 ? (speed > 175 ? "ACT_RUN" : "ACT_WALK")
                                : "ACT_IDLE";
        int want = d.activity(activity);
        if (want < 0) want = 0;
        if (seq < 0 || d.info["seqs"][seq]["activity"] != d.info["seqs"][want]["activity"]) {
            bool changed = want != seq;
            seq = want;
            if (changed || !(d.info["seqs"][want]["flags"].get<int>() & 1)) parity++;
        }
        const std::string act = d.info["seqs"][seq]["activity"];
        maxSpeed = act == "ACT_WALK" || act == "ACT_IDLE" ? 100
                   : act == "ACT_RUN"                     ? 250
                   : act == "ACT_RUN_CROUCH"              ? 85
                                                          : 0;
        bs.set(pPitch, clamp(eyePitch, -90, 90));
        if (!feetInit) {
            feetInit = true;
            goalFeetYaw = feetYaw = eyeYaw;
            lastTurnTime = 0;
        } else if (speed > .5 || now - lastTurnTime > 3)
            goalFeetYaw = eyeYaw;
        else {
            double diff = angle(goalFeetYaw - eyeYaw);
            if (std::abs(diff) > 90) goalFeetYaw += diff > 0 ? -90 : 90;
        }
        goalFeetYaw = angle(goalFeetYaw);
        if (feetYaw != goalFeetYaw) {
            double diff = angle(goalFeetYaw - feetYaw), abs = std::abs(diff),
                   scale = abs <= 45 ? clamp(abs / 45, .01, 1) : 1, maxmove = 720 * dt * scale;
            if (abs > 90) maxmove = abs - 90;
            if (abs < maxmove)
                feetYaw = goalFeetYaw;
            else
                feetYaw += diff > 0 ? maxmove : -maxmove;
            feetYaw = angle(feetYaw);
            lastTurnTime = now;
        }
        bodyYaw = bs.set(pYaw, angle(eyeYaw - feetYaw));
        if (speed > .5) gaitYaw = angle(std::atan2(vy, vx) * 180 / 3.141592653589793);
        double yaw = -(eyeYaw - gaitYaw);
        yaw -= std::trunc(yaw / 360) * 360;
        if (yaw < -180)
            yaw += 360;
        else if (yaw > 180)
            yaw -= 360;
        bs.set(px, speed > .5 ? std::cos(yaw * 3.141592653589793 / 180) * movement() : 0);
        bs.set(py, speed > .5 ? -std::sin(yaw * 3.141592653589793 / 180) * movement() : 0);
        bool loop = d.info["seqs"][seq]["flags"].get<int>() & 1;
        double c = sampled && s.grounded && loop ? sampleTime * bs.rate(seq) : cycle + dt * bs.rate(seq);
        if (c < 0 || c >= 1) c = loop ? c - std::floor(c) : clamp(c, 0, 1);
        cycle = c;
        main.check(d, seq, parity != prevParity);
        prevParity = parity;
        main.update(seq, cycle, 1, now);
        for (auto &l : layers)
            l.weight = 0;
        aimLayers(0, true, idle, 1);
        if ((activity == "ACT_RUN" || activity == "ACT_WALK" || activity == "ACT_RUNTOIDLE"
             || activity == "ACT_RUN_CROUCH")
            && speed > .5)
            aimLayers(2, false, run, movement());
        double total = 0;
        for (int i = 1; i < 4; i++)
            if (layers[i].weight > 0) total += layers[i].weight;
        if (layers[0].weight > 0) layers[0].weight = std::max(0., 1 - total);
        int final = -1;
        for (int i = 0; i < 4; i++)
            if (layers[i].weight > .99) final = i;
        for (int i = final - 1; i >= 0; i--)
            layers[i].weight = 0;
        if (fireSeq >= 0) {
            fireCycle += dt * bs.rate(fireSeq);
            if (fireCycle > 1) fireSeq = -1;
        }
    }

    void apply() {
        bs.init();
        bs.accumulate(seq, cycle, 1);
        for (int i = int(main.queue.size()) - 2; i >= 0; i--) {
            const auto &b = main.queue[i];
            if (b.seq < 0) continue;
            double c = b.cycle + (now - b.time) * b.rate * bs.rate(b.seq);
            bool loop = d.info["seqs"][b.seq]["flags"].get<int>() & 1;
            if (c < 0 || c >= 1) c = loop ? c - std::floor(c) : clamp(c, 0, 1);
            bs.accumulate(b.seq, c, b.weight);
        }
        for (const auto &l : layers)
            if (l.weight > 0 && l.seq >= 0) bs.accumulate(l.seq, l.cycle, l.weight);
        if (fireSeq >= 0) bs.accumulate(fireSeq, fireCycle, 1);
    }

    void actingPose(const Acting &a, V &out) {
        if (!gestureRig) gestureRig.emplace(d.rig);
        const auto &rig = *gestureRig;
        if (!rig.valid()) return;
        const double lookYaw = eyeYaw - feetYaw;
        native_gestures::square_chest(rig, a.gesture.square, lookYaw, out);
        native_gestures::turn_about(rig, rig.chest, a.chestPitch, a.chestYaw, a.chestRoll, rig.chest_subtree, out);
        native_gestures::turn_about(rig, rig.head, a.headPitch, a.headYaw, a.headRoll, rig.head_subtree, out);
        native_gestures::pose_arms(rig, a.gesture, lookYaw, out);
    }

    void earPose(const Input &s, double dt, bool snap, V &out, const Acting *acting = nullptr) {
        int head = -1;
        for (size_t i = 0; i < d.rig["names"].size(); i++)
            if (d.rig["names"][i] == "ValveBiped.Bip01_Head1") head = int(i);
        if (head < 0) return;
        const float *H = out.data() + head * 12;
        const double cy = std::cos(feetYaw * 3.141592653589793 / 180), sy = std::sin(feetYaw * 3.141592653589793 / 180);
        earTwitch -= dt;
        double twitch = 0;
        auto random = [&]() {
            randomState = 1664525 * randomState + 1013904223;
            return double(randomState) / 4294967296.;
        };
        if (earTwitch < 0) {
            earTwitch = 2.5 + random() * 4.5;
            if (speed < 40) twitch = random() < .5 ? 1 : -1;
        }
        for (auto &e : ears) {
            if (e.bone < 0) continue;
            std::array<double, 3> mb{}, md{}, wb{}, wd{}, target{}, bv{}, want = e.dir;
            const double perk = acting ? (e.side > 0 ? acting->earL : acting->earR) : 0;
            if (perk) {
                std::array<double, 3> to =
                        perk > 0 ? std::array<double, 3>{.08, .06, 1} : std::array<double, 3>{.32, .95, -.02};
                double l = std::hypot(std::hypot(to[0], to[1]), to[2]);
                for (auto &v : to)
                    v /= l;
                to[0] *= e.side;
                for (int k = 0; k < 3; k++)
                    want[k] += (to[k] - want[k]) * std::min(1., std::abs(perk));
                l = std::hypot(std::hypot(want[0], want[1]), want[2]);
                for (auto &v : want)
                    v /= l;
            }
            for (int k = 0; k < 3; k++) {
                mb[k] = H[k * 4 + 3];
                for (int j = 0; j < 3; j++) {
                    mb[k] += H[k * 4 + j] * e.base[j];
                    md[k] += H[k * 4 + j] * want[j];
                }
            }
            wb = {s.position[0] + cy * mb[0] - sy * mb[1],
                  s.position[1] + sy * mb[0] + cy * mb[1],
                  s.position[2] + mb[2]};
            wd = {cy * md[0] - sy * md[1], sy * md[0] + cy * md[1], md[2]};
            for (int k = 0; k < 3; k++) {
                target[k] = wb[k] + wd[k] * 6.5;
                if (e.has && dt > 0 && !snap) bv[k] = (wb[k] - e.wb[k]) / dt;
            }
            if (snap || !e.has) {
                e.p = target;
                e.v = bv;
            } else {
                int steps = std::max(1, int(std::ceil(dt * 120)));
                double h = dt / steps;
                if (twitch) {
                    e.v[0] += -wd[1] * 70 * twitch * e.side;
                    e.v[1] += wd[0] * 70 * twitch * e.side;
                }
                for (int it = 0; it < steps; it++)
                    for (int k = 0; k < 3; k++) {
                        double a = 320 * (target[k] - e.p[k]) - 21 * (e.v[k] - bv[k]) - e.v[k] - (k == 2 ? 30 : 0);
                        e.v[k] += a * h;
                        e.p[k] += e.v[k] * h;
                    }
            }
            double dx = e.p[0] - wb[0], dy = e.p[1] - wb[1], dz = e.p[2] - wb[2],
                   len = std::sqrt(dx * dx + dy * dy + dz * dz);
            if (!len) len = 1;
            dx /= len;
            dy /= len;
            dz /= len;
            double direction[3] = {dx, dy, dz};
            for (int k = 0; k < 3; k++) {
                e.p[k] = wb[k] + direction[k] * 6.5;
                e.wb[k] = wb[k];
            }
            e.has = true;
            double mx = cy * dx + sy * dy, my = -sy * dx + cy * dy;
            std::array<double, 3> bd = {
                    H[0] * mx + H[4] * my + H[8] * dz,
                    H[1] * mx + H[5] * my + H[9] * dz,
                    H[2] * mx + H[6] * my + H[10] * dz
            };
            float m[12];
            swing(e.dir, bd, e.base, 1, m);
            concat(H, m, out.data() + e.bone * 12);
            swing(e.dir, bd, e.mid, .5, m);
            concat(out.data() + e.bone * 12, m, out.data() + (e.bone + 1) * 12);
        }
    }

    bool pose(const Input &s, double seconds, bool snap, bool shot, V &out, const Acting *acting = nullptr) {
        if (!std::isfinite(seconds)) return false;
        const bool resetNow = snap || last < 0 || seconds < last;
        double dt = resetNow ? 0 : clamp(seconds - last, 0, .1);
        last = seconds;
        if (resetNow) {
            reset(seconds);
            if (!s.grounded) {
                double elapsed = (301.993 - s.velocity[2]) / 800;
                if (elapsed >= 0 && elapsed < 2) airborne(elapsed);
            }
        }
        Input input = s;
        if (resetNow) {
            velocityHistory.clear();
            lastJump = -1;
            wasGrounded = s.grounded;
        }
        velocityHistory.emplace_back(seconds, s.velocity[2]);
        while (velocityHistory.size() > 2 && seconds - velocityHistory.front().first > .08)
            velocityHistory.erase(velocityHistory.begin());
        float minVz = s.velocity[2];
        for (const auto &entry : velocityHistory)
            minVz = std::min(minVz, entry.second);
        if (!resetNow && s.velocity[2] >= 120 && (lastJump < 0 || seconds - lastJump >= .2)
            && (s.velocity[2] - minVz > 220 || (wasGrounded && !s.grounded && s.velocity[2] > 150))) {
            input.jumped = true;
            lastJump = seconds;
        }
        wasGrounded = s.grounded;
        if (shot) fire();
        update(dt, input, resetNow, seconds);
        apply();
        const auto &w = bs.build();
        out.assign(d.map.size() * 12, 0);
        int count = d.rig["csBones"];
        auto parents = d.rig["parent"].get<std::vector<int>>();
        for (size_t i = 0; i < d.map.size(); i++) {
            if (int(i) < count && d.map[i] >= 0)
                concat(w.data() + d.map[i] * 12, d.inverse.data() + i * 12, out.data() + i * 12);
            else if (parents[i] >= 0)
                std::copy_n(out.data() + parents[i] * 12, 12, out.data() + i * 12);
            else {
                out[i * 12] = out[i * 12 + 5] = out[i * 12 + 10] = 1;
            }
        }
        if (acting) {
            actingPose(*acting, out);
            for (size_t i = 0; i < d.map.size(); i++)
                if (d.rig["names"][i] == "bunny.Knife" && parents[i] >= 0)
                    std::copy_n(out.data() + parents[i] * 12, 12, out.data() + i * 12);
        }
        earPose(s, dt, resetNow, out, acting);
        return true;
    }
};
}  // namespace native_actor_anim
