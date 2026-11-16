//! Timing policy 2 against the website's public-run vectors (v0.0.42 timing lane): every finish by a trigger_teleport
//! is timed where the player first touched it, to the same end fraction, method, units and milliseconds as the web
//! and the verifier. The replays, maps and content are large, so the test reads them from BH_TIMING_VECTORS (the
//! vectors JSON), BH_TIMING_REPLAYS (<run>.bhr), BH_TIMING_MAPS (<sha256>/<map>.bsp with content/ beside it) and
//! BH_TIMING_ZONES (<map>.zones.json: the verifier times every run with the map's current zones, not the ones the
//! replay was recorded with), and skips without them.
use super::*;
use serde_json::json;
use std::ffi::CString;

struct Paths {
    vectors: PathBuf,
    replays: PathBuf,
    maps: PathBuf,
    zones: PathBuf,
}

fn paths() -> Option<Paths> {
    let var = |name| std::env::var_os(name).map(PathBuf::from);
    Some(Paths {
        vectors: var("BH_TIMING_VECTORS")?,
        replays: var("BH_TIMING_REPLAYS")?,
        maps: var("BH_TIMING_MAPS")?,
        zones: var("BH_TIMING_ZONES")?,
    })
}

/// A website zone file (zones.ts ZoneSet) as the bridge's zones.
fn map_zones(path: &Path) -> Vec<BhZone> {
    const KINDS: [&str; 5] = ["start", "end", "stage", "checkpoint", "anti-skip"];
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let corner = |v: &serde_json::Value| std::array::from_fn(|axis| v[axis].as_f64().unwrap() as f32);
    file["zones"]
        .as_array()
        .unwrap()
        .iter()
        .map(|zone| BhZone {
            kind: KINDS.iter().position(|kind| zone["kind"] == *kind).unwrap() as u32,
            track: zone["track"].as_u64().unwrap_or(0) as u32,
            index: zone["index"].as_u64().unwrap_or(0) as u32,
            mins: corner(&zone["mins"]),
            maxs: corner(&zone["maxs"]),
        })
        .collect()
}

fn c_path(path: &Path) -> CString {
    CString::new(path.to_str().unwrap()).unwrap()
}

/// The finished run's timing JSON after playing the replay to its end tick.
unsafe fn replay_timing(paths: &Paths, vector: &serde_json::Value) -> Result<serde_json::Value, String> {
    let sha = vector["mapSha256"].as_str().unwrap();
    let map = vector["map"].as_str().unwrap();
    let directory = paths.maps.join(sha);
    let replay = paths.replays.join(format!("{}.bhr", vector["run"].as_str().unwrap()));
    unsafe {
        let c = bh_create();
        let error = || CStr::from_ptr(bh_last_error(c)).to_string_lossy().into_owned();
        let result = (|| {
            let bsp = c_path(&directory.join(format!("{map}.bsp")));
            if bh_load_map(c, bsp.as_ptr(), c_path(&directory.join("content")).as_ptr()) != 1 {
                return Err(format!("load: {}", error()));
            }
            if crate::replay::bh_replay_load(c, c_path(&replay).as_ptr()) != 1 {
                return Err(format!("replay: {}", error()));
            }
            let m = (*c).map.as_mut().ok_or("no map")?;
            let data = &m.playback.as_ref().ok_or("no replay")?.data;
            let zones = map_zones(&paths.zones.join(format!("{map}.zones.json")));
            m.timer = Some(run::Timer::new(zones, data.options, data.settings.tick_interval));
            let mut snapshot = BhSnapshot::default();
            let end = vector["endTick"].as_u64().unwrap() as u32;
            if crate::replay::bh_replay_seek(c, end, &mut snapshot) != 1 {
                return Err(format!("seek: {}", error()));
            }
            let timer = (*c).map.as_ref().and_then(|m| m.timer.as_ref()).ok_or("no timer")?;
            Ok(timer.timing())
        })();
        bh_destroy(c);
        result
    }
}

/// Runs whose start native times differently from the web, for a reason outside timing policy 2: their end is still
/// checked. KHxtOy19uiCaMQJj (timer rules 1, physics 3): native starts 7 ticks later, at a measured zone exit.
const START_DIFFERS: [&str; 1] = ["KHxtOy19uiCaMQJj"];

#[test]
fn teleport_finishes_match_the_web_vectors() {
    let Some(paths) = paths() else {
        eprintln!("skipping the timing policy 2 vectors: set BH_TIMING_VECTORS, BH_TIMING_REPLAYS and BH_TIMING_MAPS");
        return;
    };
    let file: serde_json::Value = serde_json::from_slice(&std::fs::read(&paths.vectors).unwrap()).unwrap();
    let vectors = file["vectors"].as_array().unwrap();
    let mut failures = Vec::new();
    for vector in vectors {
        let run = vector["run"].as_str().unwrap();
        let timing = match unsafe { replay_timing(&paths, vector) } {
            Ok(timing) => timing,
            Err(error) => {
                failures.push(format!("{run}: {error}"));
                continue;
            }
        };
        let end = json!({"fraction": vector["end"][0], "method": vector["end"][1]});
        let start = json!({"fraction": vector["start"][0], "method": vector["start"][1]});
        let same_end = timing["policy"] == 2 && timing["endTick"] == vector["endTick"] && timing["end"] == end;
        let same = if START_DIFFERS.contains(&run) {
            same_end
        } else {
            same_end
                && timing["startTick"] == vector["startTick"]
                && timing["start"] == start
                && timing["units"] == vector["units"]
                && timing["ms"] == vector["policy2Ms"]
        };
        if !same {
            failures.push(format!("{run}: native {timing}, web end {end} units {} ms {}", vector["units"], vector["policy2Ms"]));
        }
    }
    eprintln!(
        "timing policy 2: {} of {} vectors match ({} on the end only)",
        vectors.len() - failures.len(),
        vectors.len(),
        START_DIFFERS.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
