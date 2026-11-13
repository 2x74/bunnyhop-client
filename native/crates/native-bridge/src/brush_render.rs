//! What the renderer needs from the VMTs and the entity lump to draw brush entities' render keys as CS:S does (the
//! website's brush-render.ts `dynamicRenderEntities` and vmt.ts `baseAlphaIsMask` / `builtInTextureColor`). The keys
//! themselves and their per-frame effects are read in C++ (brush_render.hpp). Render only.
use super::*;
use bunnyhop_core::materials::{FLAG_HAS_VMT, Kind, MaterialDesc};
use map_motion::{Vmt, js_parse_float};

/// Per material, what a blended brush and the built-in textures need.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhMaterialBlend {
    /// The base texture's alpha is a mask for something else, so it is no part of the opacity once the surface blends.
    pub base_alpha_mask: u32,
    /// `$basetexture "white"` with no VTF on a one-texture shader: solid white times `$color` (the core calls it
    /// missing).
    pub builtin_white: u32,
}

/// vmt.ts vmtFlag: a number other than 0.
fn flag(vmt: &Vmt, key: &str) -> bool {
    vmt.params
        .get(key)
        .and_then(|v| js_parse_float(v.trim()))
        .is_some_and(|n| n.is_finite() && n != 0.0)
}

/// vmt.ts baseAlphaIsMask: SDK 2013's pixel shaders multiply the base texture's alpha into the blend unless it masks
/// the envmap, the self-illumination or (model shaders) the tint. UnlitGeneric drops `$selfillum`.
pub(super) fn base_alpha_is_mask(vmt: &Vmt) -> bool {
    if flag(vmt, "$basealphaenvmapmask") {
        return true;
    }
    let model_shader = vmt.shader == "unlitgeneric" || vmt.shader == "vertexlitgeneric";
    if model_shader && flag(vmt, "$blendtintbybasealpha") {
        return true;
    }
    vmt.shader != "unlitgeneric" && flag(vmt, "$selfillum")
}

/// vmt.ts builtInTextureColor for "white", the one built-in texture the website draws.
pub(super) fn builtin_white(vmt: &Vmt) -> bool {
    let name = vmt
        .params
        .get("$basetexture")
        .map(|v| v.trim().to_lowercase().replace('\\', "/"))
        .unwrap_or_default();
    name.strip_suffix(".vtf").unwrap_or(&name) == "white"
}

pub(super) fn material_blend(vmt: Option<&Vmt>, desc: Option<&MaterialDesc>) -> BhMaterialBlend {
    let Some(vmt) = vmt else {
        return BhMaterialBlend::default();
    };
    // (One-texture shaders only: an UnlitTwoTexture's look is mostly its second texture.)
    let one_texture = desc.is_some_and(|d| {
        d.kind == Kind::Missing
            && d.flags & FLAG_HAS_VMT != 0
            && ["unlitgeneric", "vertexlitgeneric", "lightmappedgeneric"]
                .contains(&d.shader.to_lowercase().as_str())
    });
    BhMaterialBlend {
        base_alpha_mask: u32::from(base_alpha_is_mask(vmt)),
        builtin_white: u32::from(one_texture && builtin_white(vmt)),
    }
}

/// brush-render.ts dynamicRenderEntities: indices of the entities whose render keys an output changes while the map
/// runs (`Alpha`, `Color`, or `AddOutput` of a render key), by name (a trailing `*` matches a prefix), by classname, or
/// the entity firing at `!self` / `!caller`.
pub(super) fn dynamic_render_entities(entities: &[Vec<(String, String)>]) -> Vec<u32> {
    let mut names: Vec<String> = Vec::new();
    let mut out: Vec<u32> = Vec::new();
    for (index, pairs) in entities.iter().enumerate() {
        for (_, value) in pairs {
            let separator = if value.contains('\u{1b}') {
                '\u{1b}'
            } else {
                ','
            };
            let fields: Vec<&str> = value.split(separator).collect();
            if fields.len() < 4 {
                continue;
            }
            let input = fields[1].trim().to_lowercase();
            let render_output = input == "addoutput" && renders_key(fields[2]);
            if input != "alpha" && input != "color" && !render_output {
                continue;
            }
            let target = fields[0].trim().to_lowercase();
            if target == "!self" || target == "!caller" {
                out.push(index as u32);
            } else if !target.is_empty() && !names.contains(&target) {
                names.push(target);
            }
        }
    }
    if !names.is_empty() {
        let named = |value: &str| {
            let name = value.to_lowercase();
            !name.is_empty()
                && names.iter().any(|t| match t.strip_suffix('*') {
                    Some(prefix) => name.starts_with(prefix),
                    None => *t == name,
                })
        };
        for (index, pairs) in entities.iter().enumerate() {
            let hit = pairs.iter().any(|(k, v)| {
                (k.eq_ignore_ascii_case("targetname") || k.eq_ignore_ascii_case("classname"))
                    && named(v)
            });
            if hit {
                out.push(index as u32);
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

/// `/^\s*render(mode|amt|color|fx)\b/i`.
fn renders_key(text: &str) -> bool {
    let lower = text.trim_start().to_lowercase();
    ["rendermode", "renderamt", "rendercolor", "renderfx"]
        .iter()
        .any(|key| {
            lower.strip_prefix(key).is_some_and(|rest| {
                !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
            })
        })
}

impl Map {
    fn dynamic_render(&mut self) -> &[u32] {
        if self.motion.dynamic_render.is_none() {
            let pairs: Vec<Vec<(String, String)>> =
                self.game.entities.iter().map(|e| e.pairs.clone()).collect();
            self.motion.dynamic_render = Some(dynamic_render_entities(&pairs));
        }
        self.motion.dynamic_render.as_deref().unwrap_or_default()
    }
}

/// Material `material`'s blend facts into `out`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_blend(
    ctx: *mut BhContext,
    material: u32,
    out: *mut BhMaterialBlend,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            output(out, BhMaterialBlend::default())?;
            let map = c.map()?;
            map.alpha_programs()?;
            output(
                out,
                map.motion
                    .blend
                    .get(material as usize)
                    .copied()
                    .unwrap_or_default(),
            )
        })
    }
}

/// Indices (into bh_entities_json) of the entities whose render keys the map changes while it runs, ascending.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_dynamic_render_entities(
    ctx: *mut BhContext,
    count: *mut usize,
) -> *const u32 {
    let mut result = ptr::null();
    let _ = unsafe { output(count, 0) };
    unsafe {
        call(ctx, |c| {
            let list = c.map()?.dynamic_render();
            output(count, list.len())?;
            if !list.is_empty() {
                result = list.as_ptr();
            }
            Ok(())
        })
    };
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vmt(text: &str) -> Vmt {
        map_motion::load_vmt(
            &mut |_| Some(text.as_bytes().to_vec()),
            "materials/a.vmt",
            0,
        )
        .unwrap()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    // The website's test/brush-render.test.ts and test/prop-unlit.test.ts cases.
    #[test]
    fn finds_the_entities_whose_render_keys_the_map_changes() {
        let hit = dynamic_render_entities(&[
            pairs(&[
                ("classname", "func_brush"),
                ("targetname", "Wall_A"),
                ("model", "*1"),
            ]),
            pairs(&[
                ("classname", "func_brush"),
                ("targetname", "plat_3"),
                ("model", "*2"),
            ]),
            pairs(&[
                ("classname", "func_brush"),
                ("targetname", "other"),
                ("model", "*3"),
            ]),
            pairs(&[
                ("classname", "func_button"),
                ("model", "*4"),
                ("OnPressed", "!self,Color,255 0 0,0,-1"),
            ]),
            pairs(&[("classname", "func_wall_toggle"), ("model", "*5")]),
            pairs(&[
                ("classname", "trigger_once"),
                ("OnStartTouch", "wall_a,Alpha,0,0,-1"),
                (
                    "OnStartTouch",
                    "plat_*\u{1b}AddOutput\u{1b}rendermode 10\u{1b}0\u{1b}-1",
                ),
                ("OnStartTouch", "func_wall_toggle,Alpha,100,1,-1"),
            ]),
            pairs(&[
                ("classname", "logic_relay"),
                ("OnTrigger", "other,AddOutput,targetname gone,0,-1"),
                ("OnTrigger", "other,Enable,,0,-1"),
                ("OnTrigger", "!activator,Alpha,0,0,-1"),
            ]),
        ]);
        assert_eq!(hit, vec![0, 1, 3, 4]);
        let none = dynamic_render_entities(&[pairs(&[
            ("classname", "func_brush"),
            ("targetname", "a"),
            ("rendercolor", "1,2,3,4,5"),
            ("OnUser1", "a,Kill,,0,-1"),
        ])]);
        assert!(none.is_empty());
    }

    #[test]
    fn reads_the_built_in_white() {
        assert!(builtin_white(&vmt(
            r#""UnlitGeneric" { "$basetexture" "white" "$model" 1 }"#
        )));
        assert!(builtin_white(&vmt(
            r#"UnlitGeneric { $basetexture " White.vtf" }"#
        )));
        assert!(!builtin_white(&vmt(
            r#"UnlitGeneric { $basetexture "cs_havana/white" }"#
        )));
        assert!(!builtin_white(&vmt(
            r#"UnlitGeneric { $basetexture "tools/toolsblack" }"#
        )));
        assert!(!builtin_white(&vmt("UnlitGeneric { $basetexture black }")));
        assert!(!builtin_white(&vmt(r#"UnlitGeneric { $color "[1 0 0]" }"#)));
    }

    #[test]
    fn counts_texture_alpha_unless_the_shader_uses_it_as_a_mask() {
        let mask = |text: &str| base_alpha_is_mask(&vmt(text));
        assert!(!mask(
            r#""UnlitGeneric" { "$basetexture" "kz_shrubhop/shrbhp_bhop_01_sid" "%keywords" "bhop" "$nodecal" 1 "$nolod" 1 }"#
        ));
        assert!(!mask("LightmappedGeneric { $basetexture a }"));
        assert!(!mask(
            "LightmappedGeneric { $basetexture a $translucent 1 }"
        ));
        assert!(!mask("LightmappedGeneric { $basetexture a $alphatest 1 }"));
        assert!(mask(
            "LightmappedGeneric { $basetexture a $envmap env_cubemap $basealphaenvmapmask 1 }"
        ));
        assert!(mask(
            "UnlitGeneric { $basetexture a $basealphaenvmapmask 1 }"
        ));
        assert!(mask("LightmappedGeneric { $basetexture a $selfillum 1 }"));
        assert!(mask(
            "WorldVertexTransition { $basetexture a $selfillum 1 }"
        ));
        assert!(mask("VertexLitGeneric { $basetexture a $selfillum 1 }"));
        assert!(mask(
            "VertexLitGeneric { $basetexture a $blendtintbybasealpha 1 }"
        ));
        assert!(mask(
            "UnlitGeneric { $basetexture a $blendtintbybasealpha 1 }"
        ));
        assert!(!mask(
            "LightmappedGeneric { $basetexture a $selfillum 0 $basealphaenvmapmask 0 }"
        ));
        assert!(!mask("UnlitGeneric { $basetexture a $selfillum 1 }"));
        assert!(!mask(
            "LightmappedGeneric { $basetexture a $blendtintbybasealpha 1 }"
        ));
    }
}
