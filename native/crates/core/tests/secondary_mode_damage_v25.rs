//! Physics v25: CS:S's Secondary_Mode bullet overrides (FX_FireBullets, server.dylib / cs_fx_shared): a Glock burst round
//! does 18 damage with range modifier 0.9 (script 25, 0.75), a silenced M4A1 falls off at 0.95 (script 0.97), a silenced
//! USP does 30 (script 34). Before v25 every shot uses its weapon script, as it always did.
//!
//! The damage is pinned through the real fire path: bhop_eazy's platform `*3` becomes (in memory) a func_breakable with
//! health 1 and `minhealthdmg` just under or just over the damage the shot should do at its distance (`CBreakable`
//! ignores smaller hits), the player stands on it and fires straight down; it breaks only when the shot did at least
//! that much. A first shot at an unbreakable copy measures the distance.
//! Needs maps/bhop_eazy.bsp (gitignored); skips when absent.

use bunnyhop_core::game::{IN_ATTACK, IN_ATTACK2, IN_GIVE_SHIFT, PHYSICS_V24, PHYSICS_V25, USP_SILENCER_TIME};
use bunnyhop_core::{Cmd, Game, Settings};

const GLOCK: u32 = 2;
const USP: u32 = 3;
const M4A1: u32 = 18;
const PLATFORM: &str = "*3";

fn map_bytes() -> Option<Vec<u8>> {
    let path = bunnyhop_core::test_maps::bsp("bhop_eazy");
    let bytes = std::fs::read(&path).ok();
    if bytes.is_none() {
        eprintln!("skipping: {} not found", path.display());
    }
    bytes
}

/// The map with the platform turned into a breakable (health 1, `minhealthdmg`); the entity lump moved to the end.
fn with_breakable(bsp: &[u8], version: u32, min_damage: f32) -> Game {
    let lump = |i: usize| u32::from_le_bytes(bsp[i..i + 4].try_into().unwrap()) as usize;
    let (off, len) = (lump(8), lump(12));
    let text = String::from_utf8_lossy(&bsp[off..off + len]).trim_end_matches('\0').to_string();
    let key = format!("\"model\" \"{PLATFORM}\"");
    let at = text.find(&key).expect("platform");
    let open = text[..at].rfind('{').unwrap();
    let close = at + text[at..].find('}').unwrap();
    // (The door's own spawnflags and health would mean other things on a breakable: spawnflags bit 1 is "only break on
    // trigger", a door's health 0 is "not damageable".)
    let door_only = ["\"spawnflags\"", "\"health\"", "\"minhealthdmg\""];
    let block: String = text[open..close]
        .replace("\"func_door\"", "\"func_breakable\"")
        .lines()
        .filter(|l| !door_only.iter().any(|k| l.starts_with(k)))
        .map(|l| format!("{l}\n"))
        .collect();
    let block = format!("{block}\"health\" \"1\"\n\"minhealthdmg\" \"{min_damage}\"\n");
    let text = format!("{}{}{}\0", &text[..open], block, &text[close..]);
    let mut bytes = bsp.to_vec();
    let start = bytes.len() as u32;
    bytes.extend_from_slice(text.as_bytes());
    bytes[8..12].copy_from_slice(&start.to_le_bytes());
    bytes[12..16].copy_from_slice(&(text.len() as u32).to_le_bytes());
    let parsed = bunnyhop_core::parse_bsp(&bytes).expect("bsp parses");
    let mut game = Game::load(&parsed).expect("game loads");
    game.set_settings(Settings { physics_version: version, ..Settings::css_bhop() });
    game.reset();
    game
}

fn step(game: &mut Game, buttons: u32) {
    game.step(Cmd { forward: 0.0, side: 0.0, yaw: 0.0, pitch: 89.0, buttons }).unwrap();
}

fn idle(game: &mut Game, ticks: u32) {
    for _ in 0..ticks {
        step(game, 0);
    }
}

/// Gives `gun`, puts it in its secondary mode if asked (silencer on / burst), stands on the platform, fires straight
/// down twice (a second shot 60 ticks later). Returns the shots' distance and whether the platform broke.
fn shoot(bsp: &[u8], version: u32, gun: u32, secondary: bool, min_damage: f32) -> (f32, bool) {
    let mut g = with_breakable(bsp, version, min_damage);
    let platform = g.entities.iter().position(|e| e.get("model") == Some(PLATFORM)).expect("platform") as i32;
    step(&mut g, gun << IN_GIVE_SHIFT);
    idle(&mut g, 120);
    if secondary {
        step(&mut g, IN_ATTACK2);
        idle(&mut g, if gun == GLOCK { 40 } else { (USP_SILENCER_TIME / 0.01) as u32 + 20 });
        let r = g.weapon_report();
        assert_eq!(if gun == GLOCK { r[8] } else { r[10] }, 1.0, "gun {gun} in its secondary mode");
    }
    let o = &g.entities[platform as usize];
    let origin: Vec<f32> = o.get("origin").expect("origin").split(' ').map(|v| v.parse().unwrap()).collect();
    g.place_player([origin[0], origin[1], origin[2] + 120.0]);
    idle(&mut g, 80);
    assert!(g.state.ground.is_some(), "standing on the platform");
    let mut hits = Vec::new();
    let mut distance = None;
    for t in 0..120u32 {
        step(&mut g, if t == 0 || t == 60 { IN_ATTACK } else { 0 });
        if g.events & bunnyhop_core::game::EVENT_ATTACK != 0 {
            let a = g.attack.expect("attack");
            assert_eq!(a.weapon as u32, gun);
            if distance.is_none() {
                assert_eq!(a.entity, platform, "the first shot hits the platform");
                let d = [0, 1, 2].map(|k| a.end[k] - a.start[k]);
                distance = Some((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt());
            }
            hits.push(a.entity);
        }
    }
    assert!(hits.len() >= 2, "two shots or more ({hits:?})");
    (distance.expect("a shot"), hits[1..].iter().any(|&e| e != platform))
}

/// The pinned damage: base * modifier ^ (distance / 500), CS:S values written out here (not the core's table).
fn expect_breaks_at(version: u32, gun: u32, secondary: bool, base: f32, modifier: f32) {
    let Some(bsp) = map_bytes() else { return };
    let (distance, broke) = shoot(&bsp, version, gun, secondary, 1e9);
    assert!(!broke, "an unbreakable copy holds");
    assert!(distance > 30.0 && distance < 200.0, "distance {distance}");
    let damage = base * modifier.powf(distance / 500.0);
    let label = format!("gun {gun} physics {version} secondary {secondary}: {damage:.3} at {distance:.1} u");
    assert!(shoot(&bsp, version, gun, secondary, damage - 0.05).1, "{label}: breaks with minhealthdmg just under");
    assert!(!shoot(&bsp, version, gun, secondary, damage + 0.05).1, "{label}: holds with minhealthdmg just over");
}

#[test]
fn a_glock_burst_round_does_18_at_0_9_from_v25() {
    expect_breaks_at(PHYSICS_V25, GLOCK, true, 18.0, 0.9);
    // Single shots and older versions: the script's 25 at 0.75.
    expect_breaks_at(PHYSICS_V25, GLOCK, false, 25.0, 0.75);
    expect_breaks_at(PHYSICS_V24, GLOCK, true, 25.0, 0.75);
}

#[test]
fn a_silenced_m4a1_falls_off_at_0_95_from_v25() {
    expect_breaks_at(PHYSICS_V25, M4A1, true, 33.0, 0.95);
    expect_breaks_at(PHYSICS_V25, M4A1, false, 33.0, 0.97);
}

#[test]
fn a_silenced_usp_does_30_from_v25() {
    expect_breaks_at(PHYSICS_V25, USP, true, 30.0, 0.79);
    expect_breaks_at(PHYSICS_V25, USP, false, 34.0, 0.79);
    expect_breaks_at(PHYSICS_V24, USP, true, 34.0, 0.79);
}
