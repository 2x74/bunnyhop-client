//! Animated map props for the renderer (apps/web/src/map-props.ts): which props it poses, what the map's I/O asked
//! them to play (bunnyhop_core game/prop_anims.rs) and where every moving prop stands. Display only: nothing here
//! steps or changes the game.
use super::*;
use bunnyhop_core::studio;

/// A prop_dynamic drawn on its own (it animates, or it follows a parent), in entity order.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhAnimatedProp {
    pub entity: u32,
    pub skin: i32,
    /// `bh_studio_load` handle of its model, 0 when the model can't be loaded (it stays frozen).
    pub studio: u32,
    /// `RandomAnimation 1`: it switches between its idle sequences every MinAnimTime..MaxAnimTime seconds, drawn from
    /// `random_seed` (map-props.ts RandomAnimator).
    pub random: u32,
    pub random_seed: u32,
    pub reserved: u32,
    pub min_anim_time: f64,
    pub max_anim_time: f64,
}

/// What an animated prop plays: sequence seconds at visual time t are `base + (t - since) * rate`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhPropAnimState {
    pub entity: u32,
    /// `PROP_ANIM_HIDDEN` 1, `PROP_ANIM_REMOVED` 2.
    pub flags: u32,
    pub base: f32,
    pub since: f32,
    pub rate: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhPropTransform {
    pub entity: u32,
    pub origin: [f32; 3],
    pub angles: [f32; 3],
    pub visible: u32,
}

/// Model lookups for one prop: enough rounds for a model, its includes and their materials.
const MAX_STUDIO_FETCH_ROUNDS: usize = 64;

#[derive(Default)]
pub(super) struct PropModels {
    ready: bool,
    props: Vec<BhAnimatedProp>,
}

/// map-props.ts hashSeed: FNV-1a over the text's UTF-16 code units, mixed with `n`.
pub(super) fn hash_seed(text: &str, n: u32) -> u32 {
    const OFFSET_BASIS: u32 = 2_166_136_261;
    const PRIME: u32 = 16_777_619;
    const MIX: u32 = 0x045d_9f3b;
    let mut h = OFFSET_BASIS ^ n;
    for unit in text.encode_utf16() {
        h = (h ^ u32::from(unit)).wrapping_mul(PRIME);
    }
    (h ^ (h >> 16)).wrapping_mul(MIX)
}

/// The map's fingerprint for the random animators (render.ts): every entity's `classname|targetname|origin`, one per
/// line, as the website's entity list reads them (exact keys, the last one wins, entities without keys left out).
pub(super) fn map_seed(entities: &[bunnyhop_core::entities::Entity]) -> u32 {
    let value = |e: &bunnyhop_core::entities::Entity, key: &str| {
        e.pairs
            .iter()
            .rev()
            .find(|(k, _)| k == key)
            .map_or(String::new(), |(_, v)| v.clone())
    };
    let lines: Vec<String> = entities
        .iter()
        .filter(|e| !e.pairs.is_empty())
        .map(|e| {
            format!(
                "{}|{}|{}",
                value(e, "classname"),
                value(e, "targetname"),
                value(e, "origin")
            )
        })
        .collect();
    hash_seed(&lines.join("\n"), 0)
}

/// JavaScript's `parseInt(text, 10) || 0` is not 0.
fn js_int_set(text: &str) -> bool {
    let s = text.trim_start();
    let digits = s.strip_prefix(['+', '-']).unwrap_or(s);
    let leading: String = digits.chars().take_while(char::is_ascii_digit).collect();
    leading.parse::<u64>().is_ok_and(|n| n != 0)
}

/// JavaScript's `parseFloat(text) || 0`.
fn js_float_or_zero(text: Option<&str>) -> f64 {
    map_motion::js_parse_float(text.unwrap_or(""))
        .filter(|n| !n.is_nan())
        .unwrap_or(0.0)
}

/// Seeds every random animator with the map and the prop: map-props.ts `hashSeed(path, mapSeed ^ (entity + 1) * k)`.
const RANDOM_ENTITY_MULTIPLIER: u32 = 0x9e37_79b1;

/// A RandomAnimation prop's seed, from its model path and the map's fingerprint (`map_seed`).
pub(super) fn random_animator_seed(model_path: &str, map_seed: u32, entity: u32) -> u32 {
    hash_seed(
        model_path,
        map_seed ^ (entity + 1).wrapping_mul(RANDOM_ENTITY_MULTIPLIER),
    )
}

fn studio_model_path(entity: &bunnyhop_core::entities::Entity) -> Option<String> {
    if !entity.classname().to_ascii_lowercase().starts_with("prop_dynamic") {
        return None;
    }
    let model = entity.get("model")?.replace('\\', "/").to_lowercase();
    model.ends_with(".mdl").then_some(model)
}

impl Map {
    /// Loads a studio model into the context's cache (`bh_studio_load`), fetching loose content as it goes.
    pub(super) fn load_studio(&mut self, path: &str) -> Result<u32, String> {
        let path = vfs::normalize(path);
        if let Some(i) = self.assets.models.iter().position(|model| model.path == path) {
            return Ok(i as u32 + 1);
        }
        for _ in 0..MAX_STUDIO_FETCH_ROUNDS {
            match studio::load(&self.vfs, &path) {
                studio::Load::Ready(model) => {
                    self.assets
                        .model_info
                        .push(CString::new(model.info_json()).map_err(|e| e.to_string())?);
                    self.assets.models.push(*model);
                    return Ok(self.assets.models.len() as u32);
                }
                studio::Load::Error(e) => return Err(e),
                studio::Load::Missing => {}
            }
            if !assets::fetch_pending(
                &mut self.vfs,
                self.root.as_deref(),
                &mut self.loose,
                &mut self.attempted,
            ) {
                break;
            }
        }
        Err(format!("studio content missing: {path}"))
    }

    /// The prop_dynamics with their own prop groups and their models, loaded once (on the load worker, or at the
    /// first request).
    pub(super) fn prepare_prop_models(&mut self, check: &dyn Fn() -> Result<(), String>) -> Result<(), String> {
        if self.prop_models.ready {
            return Ok(());
        }
        let mut owners: Vec<u32> = self.assets.props.dynamic_groups.iter().map(|g| g[0]).collect();
        owners.sort_unstable();
        owners.dedup();
        let mut props = Vec::new();
        let fingerprint = map_seed(&self.game.entities);
        for entity in owners {
            check()?;
            let Some(e) = self.game.entities.get(entity as usize).cloned() else {
                continue;
            };
            let Some(path) = studio_model_path(&e) else { continue };
            let studio = self.load_studio(&path).unwrap_or(0);
            let mut prop = BhAnimatedProp {
                entity,
                skin: e.int("skin") as i32,
                studio,
                ..BhAnimatedProp::default()
            };
            if js_int_set(e.get("RandomAnimation").unwrap_or("")) && studio != 0 {
                let model_path = &self.assets.models[studio as usize - 1].path;
                prop.random = 1;
                prop.random_seed = random_animator_seed(model_path, fingerprint, entity);
                prop.min_anim_time = js_float_or_zero(e.get("MinAnimTime"));
                prop.max_anim_time = js_float_or_zero(e.get("MaxAnimTime"));
            }
            props.push(prop);
        }
        self.prop_models = PropModels { ready: true, props };
        Ok(())
    }

    /// Whether a moving prop is drawn now. Animated props show by their own flags only, as the website's
    /// map-props.ts does; doors and parented props by the entity.
    fn prop_visible(&self, entity: usize, anim_flags: Option<u32>) -> bool {
        match anim_flags {
            Some(flags) => flags & (game::PROP_ANIM_HIDDEN | game::PROP_ANIM_REMOVED) == 0,
            None => self.game.overlay_state(entity) & game::OVERLAY_STATE_VISIBLE != 0,
        }
    }

    pub(super) fn prop_anim_flags(&self, entity: usize) -> Option<u32> {
        if !self.game.is_animated_prop(entity) {
            return None;
        }
        self.game
            .prop_anim_states()
            .find(|(p, ..)| p.ent as usize == entity)
            .map(|(_, flags, ..)| flags)
    }

    pub(super) fn single_prop_transform(&self, entity: usize) -> Option<BhTransform> {
        let (origin, angles) = self
            .game
            .moving_prop_transforms()
            .into_iter()
            .find(|t| t.0 == entity)
            .map(|t| (t.1, t.2))
            .or_else(|| self.game.entity_transform(entity))?;
        let visible = u32::from(self.prop_visible(entity, self.prop_anim_flags(entity)));
        Some(BhTransform {
            origin,
            angles,
            visible,
        })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_animated_props(ctx: *mut BhContext, count: *mut usize) -> *const BhAnimatedProp {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let m = c.map()?;
            m.prepare_prop_models(&|| Ok(()))?;
            if !count.is_null() {
                output(count, m.prop_models.props.len())?;
            }
            if !m.prop_models.props.is_empty() {
                result = m.prop_models.props.as_ptr();
            }
            Ok(())
        })
    };
    result
}

/// Moves whenever `bh_prop_anim_states` may read differently.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_prop_anim_serial(ctx: *const BhContext) -> u32 {
    unsafe { read(ctx, 0, |c| c.map.as_ref().map_or(0, |m| m.game.prop_anim_serial())) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_prop_anim_states(
    ctx: *const BhContext,
    out: *mut BhPropAnimState,
    capacity: usize,
) -> usize {
    unsafe {
        read(ctx, 0, |c| {
            let Some(m) = &c.map else { return 0 };
            if out.is_null() {
                return 0;
            }
            let mut count = 0;
            for (prop, flags, base, since, rate) in m.game.prop_anim_states().take(capacity) {
                out.add(count).write(BhPropAnimState {
                    entity: prop.ent,
                    flags,
                    base,
                    since,
                    rate,
                });
                count += 1;
            }
            count
        })
    }
}

/// State `index`'s sequence name and DefaultAnim as `anim\0default\0` into `out`: the bytes written, 0 if they don't
/// fit or there is no such state.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_prop_anim_names(
    ctx: *const BhContext,
    index: usize,
    out: *mut c_char,
    capacity: usize,
) -> usize {
    unsafe {
        read(ctx, 0, |c| {
            let Some(m) = &c.map else { return 0 };
            let Some((prop, ..)) = m.game.prop_anim_states().nth(index) else {
                return 0;
            };
            let total = prop.anim.len() + prop.default_anim.len() + 2;
            if out.is_null() || total > capacity {
                return 0;
            }
            let bytes = out.cast::<u8>();
            ptr::copy_nonoverlapping(prop.anim.as_ptr(), bytes, prop.anim.len());
            bytes.add(prop.anim.len()).write(0);
            let second = bytes.add(prop.anim.len() + 1);
            ptr::copy_nonoverlapping(prop.default_anim.as_ptr(), second, prop.default_anim.len());
            second.add(prop.default_anim.len()).write(0);
            total
        })
    }
}

/// Every moving prop's transform in one pass (entity order), for drawing their groups each frame.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_prop_transforms(
    ctx: *const BhContext,
    out: *mut BhPropTransform,
    capacity: usize,
) -> usize {
    unsafe {
        read(ctx, 0, |c| {
            let Some(m) = &c.map else { return 0 };
            if out.is_null() {
                return 0;
            }
            // Both lists are in entity order: walk the animation states alongside.
            let mut states = m.game.prop_anim_states().peekable();
            let mut count = 0;
            for (entity, origin, angles) in m.game.moving_prop_transforms().into_iter().take(capacity) {
                while states.next_if(|(p, ..)| (p.ent as usize) < entity).is_some() {}
                let flags = states
                    .next_if(|(p, ..)| p.ent as usize == entity)
                    .map(|(_, flags, ..)| flags);
                let visible = u32::from(m.prop_visible(entity, flags));
                out.add(count).write(BhPropTransform {
                    entity: entity as u32,
                    origin,
                    angles,
                    visible,
                });
                count += 1;
            }
            count
        })
    }
}
