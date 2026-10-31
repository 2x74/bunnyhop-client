#pragma once

struct RenderProfile {
    using ProfileClock = std::chrono::steady_clock;

    struct FrameProfile {
        double lightmapRefresh = 0, lightmapUpload = 0, sky = 0, buildCull = 0, sort = 0, submit = 0, presentation = 0,
               hdrFinish = 0, waterReflection = 0;
        double floorReport = 0, floorDraw = 0, actorDraw = 0, presentationBuild = 0, presentationWaterUniforms = 0,
               presentationSubmit = 0, viewmodel = 0;
        uint64_t groups = 0, survivors = 0, drawCalls = 0, triangles = 0, atlasUpdateBytes = 0, floorCount = 0;
        bool hdrAuthored = false, hdrEffective = false;
        size_t waterVolumes = 0;
    } frameProfile;

    bool profiling = false;

    ProfileClock::time_point profile_now() const {
        return profiling ? ProfileClock::now() : ProfileClock::time_point{};
    }

    void profile_elapsed(double &value, ProfileClock::time_point start) {
        if (profiling) value += std::chrono::duration<double, std::milli>(ProfileClock::now() - start).count();
    }
};
