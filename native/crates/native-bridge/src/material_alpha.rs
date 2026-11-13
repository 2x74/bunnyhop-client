//! Material proxies that drive `$alpha`, a port of the website's apps/web/src/material-alpha.ts: surfaces that fade
//! with the player's distance (PlayerProximity: bhop_angst's floors, the badges maps' neon blocks, HL2's combine
//! shield) or pulse over time (Sine). The core resolves materials without proxies, so the chain is read from the VMT
//! and the renderer runs it for each brush entity wearing the material (brush_fades.hpp). Render only.
//!
//! As in Source (SDK 2013 functionproxy.cpp, mathproxy.cpp, proxyplayer.cpp, proxyentity.cpp), the proxies run in
//! file order on every bind, each writing one variable, and variables keep their values between binds: a proxy that
//! reads a variable written further down the list sees the last run's value (bhop_tesquo_v2). The caller keeps each
//! entity's variables. Floats throughout, as the website.
use super::*;
use map_motion::{Proxy, Vmt, js_number};

/// What a run reads from the game (material-alpha.ts AlphaInputs). `gaussian` draws the next normal number.
pub(super) struct AlphaInputs<'a> {
    pub distance: f64,
    pub time: f64,
    pub random: f64,
    pub gaussian: &'a mut dyn FnMut() -> f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Operand {
    Slot(usize),
    Value(f64),
}

#[derive(Clone, Debug, PartialEq)]
enum Op {
    Add(usize, Operand, Operand),
    Subtract(usize, Operand, Operand),
    Multiply(usize, Operand, Operand),
    Divide(usize, Operand, Operand),
    Equals(usize, Operand),
    Clamp {
        out: usize,
        value: Operand,
        min: Operand,
        max: Operand,
    },
    Sine {
        out: usize,
        period: Operand,
        min: Operand,
        max: Operand,
        offset: Operand,
    },
    Gaussian {
        out: usize,
        mean: Operand,
        deviation: Operand,
        min: Operand,
        max: Operand,
    },
    Proximity {
        out: usize,
        scale: Operand,
    },
    Random {
        out: usize,
        scale: Operand,
    },
}

/// A material's `$alpha` chain.
#[derive(Clone, Debug, PartialEq)]
pub(super) struct AlphaProgram {
    ops: Vec<Op>,
    initial: Vec<f64>,
    alpha: usize,
    /// Reads the player's distance or the entity's random number: differs per entity, and needs one.
    pub per_entity: bool,
}

const SUPPORTED: [&str; 10] = [
    "add",
    "subtract",
    "multiply",
    "divide",
    "equals",
    "clamp",
    "sine",
    "gaussiannoise",
    "playerproximity",
    "entityrandom",
];
/// Proxy keys that may name a variable `$alpha` depends on.
const INPUT_KEYS: [&str; 13] = [
    "srcvar1",
    "srcvar2",
    "min",
    "max",
    "sinemin",
    "sinemax",
    "sineperiod",
    "timeoffset",
    "mean",
    "halfwidth",
    "minval",
    "maxval",
    "scale",
];

/// JavaScript's `Number(text.trim())` when finite.
fn finite_number(text: &str) -> Option<f64> {
    let trimmed = text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    if trimmed.chars().any(char::is_whitespace) {
        return None;
    }
    js_number(trimmed).filter(|n| n.is_finite())
}

/// `$name` or `$name[i]`, lower case, as material-alpha.ts `varName`.
fn var_name(raw: &str) -> Option<String> {
    let text = raw.trim();
    if !text.starts_with('$') {
        return None;
    }
    let end = text
        .find(|c: char| c.is_whitespace() || c == '[' || c == ']')
        .unwrap_or(text.len());
    let (name, rest) = text.split_at(end);
    if name.len() < 2 {
        return None;
    }
    let rest = rest.trim();
    if rest.is_empty() {
        return Some(name.to_lowercase());
    }
    let index = rest.strip_prefix('[')?.strip_suffix(']')?.trim();
    if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let index: u64 = index.parse().ok()?;
    Some(format!("{}[{index}]", name.to_lowercase()))
}

/// A VMT value as a number: a plain number, or component `i` of a vector (material-alpha.ts `declared`). NaN otherwise.
fn declared(vmt: &Vmt, name: &str) -> f64 {
    let (base, index) = match name.find('[') {
        Some(at) => (
            &name[..at],
            name[at + 1..name.len() - 1].parse::<usize>().ok(),
        ),
        None => (name, None),
    };
    let Some(raw) = vmt.params.get(base) else {
        return if index.is_none() && base == "$alpha" {
            1.0
        } else {
            f64::NAN
        };
    };
    let cleaned = raw.replace(['[', ']', '{', '}'], " ");
    let trimmed = cleaned.trim();
    let parts: Vec<&str> = if trimmed.is_empty() {
        vec![""]
    } else {
        trimmed.split_whitespace().collect()
    };
    let part = match index {
        None if parts.len() == 1 => parts[0],
        None => return f64::NAN,
        Some(i) => match parts.get(i) {
            Some(part) => part,
            None => return f64::NAN,
        },
    };
    js_number(part).unwrap_or(f64::NAN)
}

fn result_of(proxy: &Proxy) -> Option<String> {
    proxy.params.get("resultvar").and_then(|v| var_name(v))
}

/// The variables `$alpha` depends on, through any proxy (values carry over between runs, so order doesn't matter).
/// "?" stands for an input that is neither a number nor a variable.
fn needed_variables(vmt: &Vmt) -> Vec<String> {
    let mut needed = vec!["$alpha".to_string()];
    loop {
        let mut grew = false;
        for proxy in &vmt.proxies {
            let Some(result) = result_of(proxy) else {
                continue;
            };
            if !needed.contains(&result) {
                continue;
            }
            for key in INPUT_KEYS {
                let Some(raw) = proxy.params.get(key) else {
                    continue;
                };
                if finite_number(raw).is_some() {
                    continue;
                }
                let name = var_name(raw).unwrap_or_else(|| "?".into());
                if !needed.contains(&name) {
                    needed.push(name);
                    grew = true;
                }
            }
        }
        if !grew {
            return needed;
        }
    }
}

/// The chain that ends in `$alpha`, or None when nothing writes `$alpha`, or it comes from something not run here
/// (the view direction, the player's team, a texture's frame): the material keeps its VMT alpha.
pub(super) fn alpha_program(vmt: &Vmt) -> Option<AlphaProgram> {
    if !vmt
        .proxies
        .iter()
        .any(|p| result_of(p).as_deref() == Some("$alpha"))
    {
        return None;
    }
    let names = needed_variables(vmt);
    let chain: Vec<&Proxy> = vmt
        .proxies
        .iter()
        .filter(|p| result_of(p).is_some_and(|r| names.contains(&r)))
        .collect();
    if names.iter().any(|n| n == "?") || chain.iter().any(|p| !SUPPORTED.contains(&p.name.as_str()))
    {
        return None;
    }
    let initial: Vec<f64> = names.iter().map(|n| declared(vmt, n)).collect();
    let written: Vec<String> = chain.iter().filter_map(|p| result_of(p)).collect();
    // A variable nothing sets has no value in Source either (the proxy reading it fails to load).
    if names
        .iter()
        .zip(&initial)
        .any(|(n, v)| v.is_nan() && !written.contains(n))
    {
        return None;
    }
    let slot = |name: &str| names.iter().position(|n| n == name);
    let operand = |raw: Option<&String>, fallback: f64| -> Operand {
        match raw {
            None => Operand::Value(fallback),
            Some(raw) => match finite_number(raw) {
                Some(n) => Operand::Value(n),
                None => Operand::Slot(var_name(raw).and_then(|n| slot(&n)).unwrap_or(0)),
            },
        }
    };
    let mut ops = Vec::new();
    for proxy in &chain {
        let out = slot(&result_of(proxy).unwrap_or_default()).unwrap_or(0);
        let p = &proxy.params;
        let (a, b) = (
            operand(p.get("srcvar1"), 0.0),
            operand(p.get("srcvar2"), 0.0),
        );
        ops.push(match proxy.name.as_str() {
            "add" => Op::Add(out, a, b),
            "subtract" => Op::Subtract(out, a, b),
            "multiply" => Op::Multiply(out, a, b),
            "divide" => Op::Divide(out, a, b),
            "equals" => Op::Equals(out, a),
            "clamp" => Op::Clamp {
                out,
                value: a,
                min: operand(p.get("min"), 0.0),
                max: operand(p.get("max"), 1.0),
            },
            "sine" => Op::Sine {
                out,
                period: operand(p.get("sineperiod"), 1.0),
                min: operand(p.get("sinemin"), 0.0),
                max: operand(p.get("sinemax"), 1.0),
                offset: operand(p.get("timeoffset"), 0.0),
            },
            "gaussiannoise" => Op::Gaussian {
                out,
                mean: operand(p.get("mean"), 0.0),
                deviation: operand(p.get("halfwidth"), 1.0),
                min: operand(p.get("minval"), f64::NEG_INFINITY),
                max: operand(p.get("maxval"), f64::INFINITY),
            },
            "playerproximity" => Op::Proximity {
                out,
                scale: operand(p.get("scale"), 0.002),
            },
            _ => Op::Random {
                out,
                scale: operand(p.get("scale"), 1.0),
            },
        });
    }
    let per_entity = chain
        .iter()
        .any(|p| p.name == "playerproximity" || p.name == "entityrandom");
    Some(AlphaProgram {
        ops,
        initial,
        alpha: slot("$alpha").unwrap_or(0),
        per_entity,
    })
}

impl AlphaProgram {
    /// Fresh variables, as the VMT sets them.
    pub fn vars(&self) -> Vec<f64> {
        self.initial
            .iter()
            .map(|v| if v.is_nan() { 0.0 } else { *v })
            .collect()
    }

    pub fn var_count(&self) -> usize {
        self.initial.len()
    }

    /// One run: the alpha (0..1); `vars` keeps the variables for the next run.
    pub fn run(&self, vars: &mut [f64], inputs: &mut AlphaInputs) -> f64 {
        if vars.len() != self.initial.len() {
            return 1.0;
        }
        for op in &self.ops {
            let read = |o: Operand, v: &[f64]| match o {
                Operand::Slot(s) => v[s],
                Operand::Value(n) => n,
            };
            match *op {
                Op::Add(out, a, b) => vars[out] = read(a, vars) + read(b, vars),
                Op::Subtract(out, a, b) => vars[out] = read(a, vars) - read(b, vars),
                Op::Multiply(out, a, b) => vars[out] = read(a, vars) * read(b, vars),
                // CDivideProxy: dividing by zero gives the first operand.
                Op::Divide(out, a, b) => {
                    let (x, y) = (read(a, vars), read(b, vars));
                    vars[out] = if y != 0.0 { x / y } else { x };
                }
                Op::Equals(out, a) => vars[out] = read(a, vars),
                Op::Clamp {
                    out,
                    value,
                    min,
                    max,
                } => {
                    let (lo, hi) = js_order(read(min, vars), read(max, vars));
                    vars[out] = js_min(hi, js_max(lo, read(value, vars)));
                }
                Op::Sine {
                    out,
                    period,
                    min,
                    max,
                    offset,
                } => {
                    let phase = std::f64::consts::TAU * (inputs.time - read(offset, vars))
                        / read(period, vars);
                    let s = phase.sin() * 0.5 + 0.5;
                    vars[out] = (read(max, vars) - read(min, vars)) * s + read(min, vars);
                }
                Op::Gaussian {
                    out,
                    mean,
                    deviation,
                    min,
                    max,
                } => {
                    let (lo, hi) = js_order(read(min, vars), read(max, vars));
                    let value = read(mean, vars) + read(deviation, vars) * (inputs.gaussian)();
                    vars[out] = js_min(hi, js_max(lo, value));
                }
                Op::Proximity { out, scale } => vars[out] = inputs.distance * read(scale, vars),
                Op::Random { out, scale } => vars[out] = inputs.random * read(scale, vars),
            }
        }
        let a = vars[self.alpha];
        if a >= 1.0 {
            1.0
        } else if a > 0.0 {
            a
        } else {
            0.0
        }
    }
}

/// JavaScript's Math.min / Math.max: NaN wins.
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.min(b)
    }
}

fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else {
        a.max(b)
    }
}

fn js_order(a: f64, b: f64) -> (f64, f64) {
    (js_min(a, b), js_max(a, b))
}

/// Uniform 0..1 from two integers (material-alpha.ts hash01, Math.imul's 32-bit wrap).
pub(super) fn hash01(a: i64, b: i64) -> f64 {
    let (a, b) = (a as u32, (b + 1) as u32);
    let mut h = (a ^ b.wrapping_mul(0x9e37_79b9)).wrapping_mul(0x85eb_ca6b);
    h = (h ^ (h >> 16)).wrapping_mul(0xc2b2_ae35);
    f64::from(h ^ (h >> 16)) / 4_294_967_296.0
}

/// Noise changes this often (GaussianNoise draws a new number on every bind): brush-fades.ts NOISE_HZ.
const NOISE_HZ: f64 = 100.0;

/// One run for brush entity `seed` (its model number) at map time `time`, as brush-fades.ts feeds the chain: the
/// entity's random number is hash01(seed, 7), and the noise is hashed from the moment, `noise` counting the draws made
/// for this entity this frame, so a replay or an export flickers the same each time.
pub(super) fn run_for_entity(
    program: &AlphaProgram,
    vars: &mut [f64],
    distance: f64,
    time: f64,
    seed: u32,
    noise: &mut u32,
) -> f64 {
    let tick = (time * NOISE_HZ).floor() as i64;
    let seed = i64::from(seed);
    let mut draw = || {
        let at = tick * 64 + i64::from(*noise);
        *noise += 1;
        hash01(seed, at)
    };
    let mut gaussian = || {
        let u = draw().max(1e-12);
        let v = draw();
        (-2.0 * u.ln()).sqrt() * (std::f64::consts::TAU * v).cos()
    };
    let mut inputs = AlphaInputs {
        distance,
        time,
        random: hash01(seed, 7),
        gaussian: &mut gaussian,
    };
    program.run(vars, &mut inputs)
}

/// A material's `$alpha` chain as the renderer sees it.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct BhAlphaProgram {
    /// Variables the chain keeps between runs (each entity keeps its own).
    pub vars: u32,
    /// The chain reads the player's distance or the entity's random number: run it for brush entities only.
    pub per_entity: u32,
}

impl Map {
    /// Every material's `$alpha` chain, read once from the VMTs.
    fn alpha_programs(&mut self) -> Result<&[Option<AlphaProgram>], String> {
        if self.motion.alpha.is_none() {
            let names: Vec<String> = serde_json::from_slice(self.assets.material_names.to_bytes())
                .map_err(|e| e.to_string())?;
            let programs = names
                .iter()
                .map(|name| {
                    let vmt = map_motion::load_vmt(
                        &mut |path| self.content(path).ok(),
                        &map_motion::vmt_path(name),
                        0,
                    )?;
                    alpha_program(&vmt)
                })
                .collect();
            self.motion.alpha = Some(programs);
        }
        Ok(self.motion.alpha.as_deref().unwrap_or_default())
    }

    fn alpha_program(&mut self, material: u32) -> Result<Option<&AlphaProgram>, String> {
        Ok(self
            .alpha_programs()?
            .get(material as usize)
            .and_then(Option::as_ref))
    }
}

/// Material `material`'s `$alpha` chain into `out`: 1 when it has one, 0 when it keeps its VMT alpha.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_alpha(
    ctx: *mut BhContext,
    material: u32,
    out: *mut BhAlphaProgram,
) -> c_int {
    let mut found = 0;
    let ok = unsafe {
        call(ctx, |c| {
            output(out, BhAlphaProgram::default())?;
            if let Some(program) = c.map()?.alpha_program(material)? {
                found = 1;
                let info = BhAlphaProgram {
                    vars: program.var_count() as u32,
                    per_entity: u32::from(program.per_entity),
                };
                output(out, info)?;
            }
            Ok(())
        })
    };
    ok & found
}

/// The chain's starting variables into `vars` (`count` must be the chain's `vars`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_alpha_vars(
    ctx: *mut BhContext,
    material: u32,
    vars: *mut f64,
    count: usize,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let program = c.map()?.alpha_program(material)?.ok_or("no alpha chain")?;
            if vars.is_null() || count != program.var_count() {
                return Err("alpha variables size".into());
            }
            std::slice::from_raw_parts_mut(vars, count).copy_from_slice(&program.vars());
            Ok(())
        })
    }
}

/// Runs material `material`'s chain for brush entity `seed` once: the alpha (0..1) into `alpha`. `distance` is from
/// the entity's middle to the player's middle; `noise` counts the entity's noise draws this frame (start each frame
/// at 0 and pass the same counter for every material of the entity).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_material_alpha_run(
    ctx: *mut BhContext,
    material: u32,
    vars: *mut f64,
    count: usize,
    distance: f64,
    time: f64,
    seed: u32,
    noise: *mut u32,
    alpha: *mut f64,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let program = c.map()?.alpha_program(material)?.ok_or("no alpha chain")?;
            if vars.is_null() || noise.is_null() || count != program.var_count() {
                return Err("alpha variables size".into());
            }
            let vars = std::slice::from_raw_parts_mut(vars, count);
            output(
                alpha,
                run_for_entity(program, vars, distance, time, seed, &mut *noise),
            )
        })
    }
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

    fn run(
        p: &AlphaProgram,
        vars: &mut [f64],
        distance: f64,
        time: f64,
        random: f64,
        noise: f64,
    ) -> f64 {
        let mut gaussian = || noise;
        p.run(
            vars,
            &mut AlphaInputs {
                distance,
                time,
                random,
                gaussian: &mut gaussian,
            },
        )
    }

    fn at(p: &AlphaProgram, distance: f64) -> f64 {
        run(p, &mut p.vars(), distance, 0.0, 0.0, 0.0)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-6
    }

    // The website's test/material-alpha.test.ts cases, with the same VMT text.
    const FADE_NEAR: &str = r#"UnlitGeneric
{
    $basetexture "tools/toolsblack"
    $distance 0.0
    $distMax  3300.0
    $distMin  1200.0
    $distDiff 0.0
    Proxies
    {
        Subtract { srcVar1 $distMax srcVar2 $distMin resultVar $distDiff }
        PlayerProximity { scale 1.0 resultVar $distance }
        Subtract { srcVar1 $distance srcVar2 $distMin resultVar $distance }
        Clamp { min 0.0 max $distDiff srcVar1 $distance resultVar $distance }
        Divide { srcVar1 $distance srcVar2 $distDiff resultVar $distance }
        Equals { srcVar1 $distance resultVar "$alpha" }
    }
}"#;

    #[test]
    fn fades_bhop_angsts_floor_between_its_distances() {
        let p = alpha_program(&vmt(FADE_NEAR)).unwrap();
        assert!(p.per_entity);
        let mut vars = p.vars();
        assert_eq!(run(&p, &mut vars, 855.0, 0.0, 0.0, 0.0), 0.0);
        assert_eq!(run(&p, &mut vars, 1200.0, 0.0, 0.0, 0.0), 0.0);
        assert!(close(run(&p, &mut vars, 2250.0, 0.0, 0.0, 0.0), 0.5));
        assert_eq!(run(&p, &mut vars, 3300.0, 0.0, 0.0, 0.0), 1.0);
        assert_eq!(run(&p, &mut vars, 9000.0, 0.0, 0.0, 0.0), 1.0);
    }

    #[test]
    fn runs_the_badges_neon_blocks() {
        let p = alpha_program(&vmt(r#"UnlitGeneric
{
  "$basetexture" "badges/orange_neon"
  "$fade_start" 225.0
  "$var" 1.0
  "$var2" 0.3
  "$var3" 1000.0
  "$distance" 0.0
  "$temp" 0.0
  "$temp_clamped" 0.0
  "$temp2" 0.0
  "$temp3" 0.0
  "$alpha_unclamped" 0.0
  "$offset" 0.0
  "Proxies"
  {
    "PlayerProximity" { "scale" 1.0 "resultVar" "$distance" }
    "EntityRandom" { "scale" 1 "resultVar" "$offset" }
    "Divide" { "srcVar1" "$distance" "srcVar2" "$fade_start" "resultVar" "$temp" }
    "Clamp" { "min" 0.0 "max" "$var3" "srcVar1" "$temp" "resultVar" "$temp_clamped" }
    "Divide" { "srcVar1" "$var" "srcVar2" "$temp_clamped" "resultVar" "$temp2" }
    "Subtract" { "srcVar1" "$temp2" "srcVar2" "$var2" "resultVar" "$temp3" }
    "Subtract" { "srcVar1" "$temp3" "srcVar2" "$offset" "resultVar" "$alpha_unclamped" }
    "Clamp" { "min" 0.0 "max" 1.0 "srcVar1" "$alpha_unclamped" "resultVar" "$alpha" }
  }
}"#))
        .unwrap();
        assert_eq!(at(&p, 100.0), 1.0);
        assert!(close(at(&p, 450.0), 0.2));
        assert_eq!(at(&p, 750.0), 0.0);
        assert!(close(run(&p, &mut p.vars(), 450.0, 0.0, 0.1, 0.0), 0.1));
        // Dividing by zero gives the first operand: 1 / (0 / 225) -> 1, less 0.3.
        assert!(close(at(&p, 0.0), 0.7));
    }

    #[test]
    fn runs_hl2s_combine_shield() {
        let p = alpha_program(&vmt(r#""Unlittwotexture"
{
	"$basetexture" "Effects/Combineshield/comshieldwall"
	"$translucent" "1"
	"$envmaptint" "[1 1 1]"
	"$gnoise" "1"
	"$playerdistance" "0"
	"$smallamount" ".1"
	"$alpharesultmin" "1"
	"$alpharesultmax" "1"
	"$hundred" "100"
	"$largeamount" "1"
	"$playerdistance2" "1"
	"$ten" "24"
	"$frameminusten" "1"
	"Proxies"
	{
		"PlayerProximity" { "resultVar" "$playerdistance2" "scale"  .2 }
		"Subtract" { "srcVar1" "$playerdistance2" "srcVar2" "$ten" "resultVar" "$frameminusten" }
		"Clamp" { "srcVar1" "$frameminusten" "min" "0" "max" "30" "resultVar" "$frame" }
		"PlayerProximity" { "resultVar" "$playerdistance" "scale" 0.0009 }
		"GaussianNoise" { "minVal" .8 "maxVal" 1 "mean" .7 "halfwidth" .3 "resultVar" "$gnoise" }
		"Subtract" { "srcVar1" "$gnoise" "srcVar2" "$playerdistance" "resultVar" "$alpharesultmin" }
		"Multiply" { "srcVar1" "$hundred" "srcVar2" "$playerdistance" "resultVar" "$largeamount" }
		"Equals" { "srcVar1" "$playerdistance" "resultVar" "$envmaptint[1]" }
		"Add" { "srcVar1" "$alpharesultmin" "srcVar2" "$smallamount" "resultVar" "$alpharesultmax" }
		"Sine" { "sineperiod" 1.08 "sinemin" "$alpharesultmin" "sinemax" "$alpharesultmax" "resultVar" "$alpha" }
		"TextureScroll" { "texturescrollvar" "$texture2transform" "texturescrollrate" .1 "texturescrollangle" -45 }
	}
}"#))
        .unwrap();
        assert!(close(at(&p, 0.0), 0.85));
        assert!(close(at(&p, 500.0), 0.4));
        assert_eq!(at(&p, 1000.0), 0.0);
        assert_eq!(run(&p, &mut p.vars(), 0.0, 0.0, 0.0, 5.0), 1.0);
        assert!(close(run(&p, &mut p.vars(), 500.0, 0.27, 0.0, 0.0), 0.45));
    }

    #[test]
    fn reads_a_distance_written_later_one_run_late() {
        let p = alpha_program(&vmt(r#"LightmappedGeneric
{
	"$basetexture" "a"
	"$playerdistance" 0
	"$clampvar" 0
	"$distsub" 1.4
	"Proxies"
	{
		"Subtract" { "srcVar1" "$playerdistance" "srcVar2" "$distsub" "resultVar" "$clampvar" }
		"Clamp" { "srcVar1" "$clampvar" "min" 0 "max" 1 "resultVar" "$alpha" }
		"PlayerProximity" { "resultVar" "$playerdistance" "scale" 0.01 }
	}
}"#))
        .unwrap();
        let mut vars = p.vars();
        assert_eq!(run(&p, &mut vars, 190.0, 0.0, 0.0, 0.0), 0.0);
        assert!(close(run(&p, &mut vars, 190.0, 0.0, 0.0, 0.0), 0.5));
        assert!(close(run(&p, &mut vars, 400.0, 0.0, 0.0, 0.0), 0.5));
        assert_eq!(run(&p, &mut vars, 400.0, 0.0, 0.0, 0.0), 1.0);
    }

    #[test]
    fn pulses_with_sine_alone() {
        let p = alpha_program(&vmt(
            "UnlitGeneric { $basetexture z/booster $translucent 1 Proxies {
      TextureScroll { texturescrollvar $baseTextureTransform texturescrollrate 12 texturescrollangle -90 }
      Sine { sineperiod 0.05 sinemin 0.5 sinemax 1.0 resultVar $alpha } } }",
        ))
        .unwrap();
        assert!(!p.per_entity);
        assert!(close(run(&p, &mut p.vars(), 0.0, 0.0, 0.0, 0.0), 0.75));
        assert!(close(run(&p, &mut p.vars(), 0.0, 0.0125, 0.0, 0.0), 1.0));
        assert!(close(run(&p, &mut p.vars(), 900.0, 0.0375, 0.0, 0.0), 0.5));
    }

    #[test]
    fn keeps_the_vmt_alpha_when_the_chain_is_not_run_here() {
        let none = |text: &str| alpha_program(&vmt(text)).is_none();
        assert!(none(
            "UnlitGeneric { $basetexture a Proxies { TextureScroll { texturescrollvar $basetexturetransform } } }"
        ));
        assert!(none(
            "UnlitGeneric { $basetexture a $d 0.0 Proxies { PlayerProximity { resultVar $d } } }"
        ));
        assert!(none(
            "UnlitGeneric { $basetexture a $v 0.0 Proxies { PlayerView { scale 1 resultVar $v } Clamp { srcVar1 $v resultVar $alpha } } }"
        ));
        assert!(none(
            "UnlitGeneric { $basetexture a Proxies { Equals { srcVar1 $nowhere resultVar $alpha } } }"
        ));
    }

    #[test]
    fn reads_vector_components_and_refuses_a_vector_as_a_number() {
        let component = |i: usize| {
            let text = format!(
                "UnlitGeneric {{ $basetexture a $v \"[0.25 3 -2]\" Proxies {{ Equals {{ srcVar1 \"$v[{i}]\" resultVar $alpha }} }} }}"
            );
            at(&alpha_program(&vmt(&text)).unwrap(), 0.0)
        };
        assert_eq!(component(0), 0.25);
        assert_eq!(component(1), 1.0);
        assert_eq!(component(2), 0.0);
        let whole = "UnlitGeneric { $basetexture a $v \"[1 1 1]\" Proxies { Equals { srcVar1 $v resultVar $alpha } } }";
        assert!(alpha_program(&vmt(whole)).is_none());
    }

    #[test]
    fn draws_the_websites_noise_for_an_entity_and_a_moment() {
        // brush-fades.ts for brush 12 at 1.234 s: two noise draws in a frame, then the entity's random number.
        let p = alpha_program(&vmt(
            "UnlitGeneric { $basetexture a $n 0 Proxies { GaussianNoise { mean 0.5 halfwidth 0.1 resultVar $alpha } } }",
        ))
        .unwrap();
        let (mut vars, mut noise) = (p.vars(), 0);
        assert_eq!(
            run_for_entity(&p, &mut vars, 0.0, 1.234, 12, &mut noise),
            0.456_894_894_159_637_6
        );
        assert_eq!(
            run_for_entity(&p, &mut vars, 0.0, 1.234, 12, &mut noise),
            0.436_655_798_282_162_1
        );
        assert_eq!(noise, 4);
        let random = alpha_program(&vmt(
            "UnlitGeneric { $basetexture a $r 0 Proxies { EntityRandom { scale 1 resultVar $alpha } } }",
        ))
        .unwrap();
        assert_eq!(
            run_for_entity(&random, &mut random.vars(), 0.0, 0.0, 12, &mut 0),
            0.230_838_894_611_224_53
        );
    }

    #[test]
    fn hashes_like_the_website() {
        // material-alpha.ts hash01 on the same integers, the last past Math.imul's 32-bit wrap.
        assert_eq!(hash01(183, 7), 0.339_179_243_659_600_6);
        assert_eq!(hash01(0, 0), 0.059_309_925_651_177_764);
        assert_eq!(hash01(181, 64 * 120 + 3), 0.886_044_659_418_985_2);
        assert_eq!(hash01(5, (1 << 31) + 9), 0.822_134_387_912_228_7);
    }
}
