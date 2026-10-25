#ifndef BUNNYHOP_NATIVE_H
#define BUNNYHOP_NATIVE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Initial native ABI. All calls for one context must stay on its creating thread.
 * Buffers are borrowed; mesh/material buffers last until map reload/destruction.
 * Texture bytes last until the next texture request/map reload/destruction.
 * Input pointers are borrowed only during each call. No exception crosses this ABI.
 */
typedef struct BhContext BhContext;
typedef struct BhSettings {
    float tick_interval, air_accelerate, accelerate, friction, stop_speed, gravity, max_speed;
    uint32_t autohop, physics, stamina;
} BhSettings;
typedef struct BhCmd {
    float forward, side, yaw, pitch;
    uint32_t buttons;
} BhCmd;
typedef struct BhState {
    float position[3], velocity[3], view_offset_z;
    float teleport_angles[3], angle_change[3], touch_position[3];
    uint32_t tick, grounded, crouched, on_ladder, events, touch_crouched;
} BhState;
typedef struct BhGroup {
    uint32_t model, material, first_index, index_count, sky3d;
} BhGroup;
typedef struct BhMaterial {
    int32_t texture;
    uint32_t kind, flags;
    float alpha, alpha_ref, color[3];
} BhMaterial;
typedef struct BhImage {
    const uint8_t *rgba;
    size_t byte_count;
    uint32_t width, height;
} BhImage;
typedef struct BhTransform {
    float origin[3], angles[3];
    uint32_t visible;
} BhTransform;

/* Additive run/recording ABI. BhState remains unchanged. */
typedef struct BhSnapshot {
    BhState player;
    float stamina_ms, base_velocity[3], health, gravity_scale, speed_scale;
    uint32_t weapons, active_weapon, movement_mode, water_level;
} BhSnapshot;
/* kind: 0=start, 1=end, 2=stage, 3=checkpoint. Coordinates are canonical f32. */
typedef struct BhZone {
    uint32_t kind, track, index;
    float mins[3], maxs[3];
} BhZone;
typedef struct BhRunOptions {
    float prespeed_cap;
    uint32_t cap_enabled, rules, block_prehops, strafe_keys; /* keys: 0=AD, 1=WS, 2=W */
} BhRunOptions;
typedef struct BhRunState {
    uint32_t status, track, start_tick, end_tick, last_tick; /* 0=idle, 1=running, 2=finished */
    uint32_t jumps, strafes, perfect_jumps, measured_jumps, sync_good, sync_total;
    uint32_t in_start, pending_start, update_flags, split_count;
    int32_t last_perfect_tick;
    uint32_t recording, recording_valid;
    uint64_t total_commands;
    uint32_t rolling_hash;
    double seconds, sync_percent, perf_percent;
} BhRunState;
/* update_flags: 1=started, 2=finished, 4=restarted, 8=prespeed clamped, 16=split. */
void bh_default_run_options(BhRunOptions *out);
int bh_run_configure(BhContext *ctx, const BhRunOptions *options, const BhZone *zones, size_t zone_count);
int bh_run_state(BhContext *ctx, BhRunState *out);
/* Removes native timing for a local map without zones; invalidates any active recording. */
int bh_run_clear(BhContext *ctx);
int bh_snapshot(BhContext *ctx, BhSnapshot *out);
/* Borrowed until the next call to the SAME getter or map reload/destruction. JSON is UTF-8/NUL-terminated. */
const uint8_t *bh_snapshot_bytes(BhContext *ctx, size_t *byte_count);
const char *bh_entities_json(BhContext *ctx, size_t *byte_count);
const char *bh_models_json(BhContext *ctx, size_t *byte_count);
/* Configure zones first, then reset/set restart point/names, then begin at tick 0.
 * bh_step applies native timer prehop/prespeed rules and records post-clamp states.
 * style accepts autohop, legit, scroll, wonly, sideways, hsw, lowgrav, autostrafe.
 * Native bh_step applies the style; callers supply unfiltered canonical input.
 * NULL/empty path disables JSONL evidence (normal play retains only native commands/checkpoints).
 * A supplied JSONL path uses create-new; settings/reset/position/velocity/name/map changes invalidate an active recording.
 * Recordings close invalid after 180000 commands. Files do not authorize score submission without server verification.
 */
int bh_record_begin(BhContext *ctx, const char *path, const char *style, const char *player, uint32_t checkpoint_interval);
int bh_record_end(BhContext *ctx);
/* Optional presentation trailers: events at the current recording state tick, capped at 20000 each.
 * kind is stored as u8. Inspect kinds: start1,next2,held3,released4. No simulation/verification effect.
 * Packed loadout is existing loadout.ts packLoadout text (<=255 UTF-8 bytes); empty removes it.
 */
int bh_record_cosmetic(BhContext *ctx, uint32_t kind);
int bh_record_inspect(BhContext *ctx, uint32_t kind);
int bh_record_loadout(BhContext *ctx, const char *packed_loadout);
/* Persistent clientBuild identity; call before beginning a recording. UTF-8, 1..255 bytes. */
int bh_record_identity(BhContext *ctx, const char *client_build);
/* Writes a new gzip .bhr from retained native commands/checkpoints. Requires an ended, valid, finished run. */
int bh_record_write_bhr(BhContext *ctx, const char *path);
/* FNV-1a fold of canonical commands [from_index,to_index), as shared run-hash.ts. */
int bh_record_fold(BhContext *ctx, uint32_t hash, size_t from_index, size_t to_index, uint32_t *out_hash);
/* Last recording summary JSON; available after end/invalidation. */
const char *bh_record_summary_json(BhContext *ctx, size_t *byte_count);
/* SHA-256 lowercase hex, 64 characters plus NUL. NULL bytes permitted only for zero length. */
int bh_sha256(const uint8_t *bytes, size_t byte_count, char out_hex[65]);

uint32_t bh_abi_version(void);
BhContext *bh_create(void);
void bh_destroy(BhContext *ctx);
/* Error string is context-owned, valid until another mutating call. */
const char *bh_last_error(const BhContext *ctx);
void bh_default_settings(BhSettings *out);
/* content_root may be NULL; uses the existing cached physics-content loader.
 * A provided root is a loose Source content directory (materials/, models/, ...).
 * Returns 1 on success, 0 on failure; failure must not leave a partially usable map.
 */
int bh_load_map(BhContext *ctx, const char *path, const char *content_root);
int bh_set_settings(BhContext *ctx, const BhSettings *settings);
int bh_reset(BhContext *ctx);
int bh_set_position(BhContext *ctx, float x, float y, float z, float yaw);
int bh_set_velocity(BhContext *ctx, float x, float y, float z);
int bh_set_restart_names(BhContext *ctx, const char *targetname, const char *classname);
int bh_step(BhContext *ctx, const BhCmd *cmd, BhState *out);
int bh_state(BhContext *ctx, BhState *out);
/* Vertices: ten floats each, Source coordinates (Z up):
 * position xyz, normal xyz, base UV, lightmap UV. Counts below are scalar counts.
 */
const float *bh_vertices(const BhContext *ctx, size_t *float_count);
const uint32_t *bh_indices(const BhContext *ctx, size_t *index_count);
const BhGroup *bh_groups(const BhContext *ctx, size_t *group_count);
const BhMaterial *bh_materials(const BhContext *ctx, size_t *material_count);
int bh_lightmap(BhContext *ctx, BhImage *out);
/* Atlas RGB scale applied before sRGB encoding; divide sampled linear RGB by this. */
float bh_lightmap_scale(void);
int bh_texture(BhContext *ctx, uint32_t index, BhImage *out);
int bh_model_transform(BhContext *ctx, uint32_t model, BhTransform *out);
int bh_spawn(BhContext *ctx, float origin[3], float angles[3]);

typedef struct BhSkyInfo {
    float origin[3], scale;
    uint32_t area, fog_enable, fog_blend;
    float fog_color[3], fog_color2[3], fog_dir[3], fog_start, fog_end, fog_max_density;
} BhSkyInfo;
typedef struct BhMaterialExtra {
    int32_t texture2, detail;
    float detail_scale, detail_blend, fog_start, fog_end;
    uint32_t above_water;
} BhMaterialExtra;
typedef struct BhPropGroup {
    uint32_t material, first_index, index_count, sky3d;
    int32_t entity; /* -1 = baked world geometry; otherwise model-space moving entity geometry. */
} BhPropGroup;
const float *bh_blend(const BhContext *ctx, size_t *float_count);
const float *bh_sky_vertices(const BhContext *ctx, size_t *float_count);
const uint32_t *bh_sky_indices(const BhContext *ctx, size_t *index_count);
const BhGroup *bh_sky_groups(const BhContext *ctx, size_t *group_count);
int bh_sky_info(BhContext *ctx, BhSkyInfo *out);
const char *bh_sky_name(BhContext *ctx, size_t *byte_count);
/* Sky faces in Source +X,-X,+Y,-Y,+Z,-Z order; values index the shared global material buffer. */
const int32_t *bh_sky_materials(const BhContext *ctx, size_t *count);
const BhMaterialExtra *bh_material_extras(const BhContext *ctx, size_t *count);
const char *bh_material_names_json(BhContext *ctx, size_t *byte_count);
/* Prop vertices are pos3/normal3/uv2; prop groups share bh_materials and bh_texture indices. */
const float *bh_prop_vertices(const BhContext *ctx, size_t *float_count);
const uint32_t *bh_prop_indices(const BhContext *ctx, size_t *index_count);
const BhPropGroup *bh_prop_groups(const BhContext *ctx, size_t *count);
int bh_prop_transform(BhContext *ctx, uint32_t entity, BhTransform *out);
/* Water geometry JSON: volumes [minx,miny,minz,maxx,maxy,maxz] and convex plane lists [nx,ny,nz,d]. */
const char *bh_water_json(BhContext *ctx, size_t *byte_count);
/* Read/decode Source content with pakfile precedence; buffers last until next request of same kind. */
const uint8_t *bh_content_read(BhContext *ctx, const char *path, size_t *byte_count);
int bh_texture_path(BhContext *ctx, const char *path, BhImage *out);

/* All shared styles; selecting a style applies canonical settings and resets the loaded game/timer. */
int bh_style_settings(const char *style, BhSettings *out);
int bh_style_set(BhContext *ctx, const char *style);
int bh_last_command(BhContext *ctx, BhCmd *out); /* exact filtered command stepped/recorded */
typedef struct BhLookSample {
    double base, k;
    int32_t count;
    uint32_t epoch, kind, frames, events, reports;
} BhLookSample;
/* Real native mouse telemetry only. Missing samples retain existing uncounted replay encoding. */
int bh_step_look(BhContext *ctx, const BhCmd *cmd, const BhLookSample *look, BhState *out);
/* Additive ABI: the original 40-byte BhLookSample and bh_step_look remain unchanged.
 * Fractional counts retain real mouse provenance in v10 recordings with manual turns. */
typedef struct BhLookSampleV2 {
    double base, k, count;
    uint32_t epoch, kind, frames, events, reports;
} BhLookSampleV2;
int bh_step_look_v2(BhContext *ctx, const BhCmd *cmd, const BhLookSampleV2 *look, BhState *out);
typedef struct BhWeaponReport {
    uint32_t flags, active, primary, secondary, knife, clip, clip_size, reload_ticks, burst, floor_changed, silencer, silencer_ticks;
} BhWeaponReport;
typedef struct BhAttackReport {
    uint32_t weapon, mode, hit;
    float start[3], end[3], normal[3];
    int32_t entity;
} BhAttackReport;
int bh_weapon_report(BhContext *ctx, BhWeaponReport *out);
int bh_attack_report(BhContext *ctx, BhAttackReport *out); /* 0 if no attack this tick */
typedef struct BhFloorWeapon {uint32_t entity, weapon, flags; float position[3], angles[3];} BhFloorWeapon;
/* Per-item FLOOR flags: present1,picked2,spawned4,dropped8,removed16,moved32; consumes change marks. */
const BhFloorWeapon *bh_floor_weapons(BhContext *ctx, size_t *count);
/* Studio handles are context/map owned, >=1. Vertices:18 floats; metadata includes bones/groups/material paths. */
uint32_t bh_studio_load(BhContext *ctx, const char *path);
const char *bh_studio_info(BhContext *ctx, uint32_t handle, size_t *byte_count);
const float *bh_studio_vertices(BhContext *ctx, uint32_t handle, size_t *float_count);
const uint32_t *bh_studio_indices(BhContext *ctx, uint32_t handle, size_t *index_count);
/* Animation samples: frames*bones*7 floats (quaternion xyzw, position xyz), valid until next anim request. */
const float *bh_studio_animation(BhContext *ctx, uint32_t handle, uint32_t animation, size_t *float_count);

/* Native BHR playback uses a map-loaded context and verifies the BSP hash. Dedicated contexts
 * may be used for replay views. Playback applies recorded settings/styles/timer rules, never records.
 * Seek re-simulates deterministically; checkpoint mismatches return failure.
 */
/* Bounded raw/gzip decode for file libraries; works without a loaded map and changes no Game.
 * Same info JSON shape as bh_replay_info. Buffer lasts until next bh_replay_header/context destruction.
 */
const char *bh_replay_header(BhContext *ctx, const char *path, size_t *byte_count);
int bh_replay_load(BhContext *ctx, const char *path);
const char *bh_replay_info(BhContext *ctx, size_t *byte_count);
int bh_replay_step(BhContext *ctx, BhSnapshot *out);
int bh_replay_seek(BhContext *ctx, uint32_t tick, BhSnapshot *out);
/* Stop replay mode; current game state/settings remain available for a normal restart. */
int bh_replay_stop(BhContext *ctx);
typedef struct BhReplayEvents {uint32_t cosmetic, inspect_signal, inspect_held;} BhReplayEvents;
/* Presentation over state ticks (from,to]; inspect_held is held at to, including a backwards seek.
 * Replay/ghost info JSON includes packedLoadout and optional trailer event counts.
 */
int bh_replay_events(BhContext *ctx, uint32_t from, uint32_t to, BhReplayEvents *out);
typedef struct BhGhostFrame {
    float position[3], velocity[3], yaw, pitch, view_offset_z;
    uint32_t tick, flags, weapon; /* flags: crouched1, grounded2, ladder4; actual weapon id */
} BhGhostFrame;
/* Builds immutable ghost frames, restoring the live game's exact state/timer/filter afterwards.
 * No live simulation or recorder is advanced by ghost playback. Handles >=1; at most four ghosts per map.
 */
uint32_t bh_ghost_load(BhContext *ctx, const char *path);
const char *bh_ghost_info(BhContext *ctx, uint32_t handle, size_t *byte_count);
int bh_ghost_frame(BhContext *ctx, uint32_t handle, uint32_t tick, BhGhostFrame *out);
int bh_ghost_free(BhContext *ctx, uint32_t handle);
int bh_ghost_events(BhContext *ctx, uint32_t handle, uint32_t from, uint32_t to, BhReplayEvents *out);

/* Trigger/clip overlay volumes in native entity/model coordinates, read-only and safe during runs.
 * JSON array: {kind,entity,model,flags,planes:[[nx,ny,nz,d],...]}; nullable entity/model = world.
 * kinds teleport0,push1,gravity2,other3,clip4,wall5; flags1=only while entity hidden.
 * Entity states: active1,visible2. Getter buffers last until next same getter/map reload.
 */
const char *bh_overlay_json(BhContext *ctx, size_t *byte_count);
const uint32_t *bh_overlay_states(BhContext *ctx, size_t *count);

/* Audio surface query matches shared surfaces.ts world-mesh grid. surface: concrete0,metal1,wood2,
 * grass3,tile4,water5; -1 absent. material indexes bh_material_names_json; missing heights are NaN.
 * Ground within [z-24,z+4]; nearest overhead water within [z-2,z+2000]. Read-only.
 */
typedef struct BhSurfaceProbe {int32_t surface,material;float ground_z,water_z;} BhSurfaceProbe;
int bh_surface_at(BhContext *ctx, float x, float y, float z, BhSurfaceProbe *out);

/* Practice only: restore/noclip invalidate an active recording. Checkpoints retain GameState,
 * native timer/style/settings and the view. Handles map-owned; max100 /128MiB; free old handles.
 * No recording command stream can represent these mutations. Restart normally before a ranked attempt.
 */
typedef struct BhNoclipState {double position[3], velocity[3];} BhNoclipState;
int bh_noclip_move(BhNoclipState *state, const BhCmd *cmd, double dt);
int bh_practice_noclip_tick(BhContext *ctx, const BhNoclipState *state, BhSnapshot *out);
/* returns1 standing,2 crouched,0 stuck/error. */
uint32_t bh_practice_noclip_exit(BhContext *ctx, const BhNoclipState *state, float yaw, float pitch, BhSnapshot *out);
uint32_t bh_practice_save(BhContext *ctx, float yaw, float pitch);
int bh_practice_restore(BhContext *ctx, uint32_t handle, BhCmd *out_view, BhSnapshot *out);
int bh_practice_free(BhContext *ctx, uint32_t handle);
/* Camera collision: clear fraction [0,1] across current world/props/brushes, ignores player clips. */
int bh_trace_camera(BhContext *ctx, const float start[3], const float end[3], float radius, float *out_fraction);

#ifdef __cplusplus
}
#endif
#endif
