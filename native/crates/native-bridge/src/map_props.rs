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
        for entity in owners {
            check()?;
            let Some(e) = self.game.entities.get(entity as usize) else {
                continue;
            };
            let Some(path) = studio_model_path(e) else { continue };
            let skin = e.int("skin") as i32;
            let studio = self.load_studio(&path).unwrap_or(0);
            props.push(BhAnimatedProp { entity, skin, studio });
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
