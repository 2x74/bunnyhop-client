//! Measurements, ignored by default: the replay viewer's load, step and seek on a real map and replay, and what an open
//! recording costs in memory. Run them in release with `--ignored --nocapture`:
//!   BH_REPLAY_BENCH=/path/map.bsp:/path/run.bhr cargo test --release -p bunnyhop-native-bridge replay_bench
//!   BH_RECORD_BENCH_TICKS=2880000 cargo test --release -p bunnyhop-native-bridge recording_memory_bench
use super::*;
use std::mem::size_of;
use std::time::Instant;

#[test]
#[ignore]
fn replay_bench() {
    let spec = std::env::var("BH_REPLAY_BENCH").expect("BH_REPLAY_BENCH=map.bsp:replay.bhr");
    let (map, replay) = spec.split_once(':').unwrap();
    let map = CString::new(map).unwrap();
    let replay = CString::new(replay).unwrap();
    let error = |c| unsafe { std::ffi::CStr::from_ptr(bh_last_error(c)).to_string_lossy().into_owned() };
    unsafe {
        let c = bh_create();
        let started = Instant::now();
        assert_eq!(bh_load_map(c, map.as_ptr(), ptr::null()), 1, "{}", error(c));
        eprintln!("map load {:?}", started.elapsed());
        let started = Instant::now();
        assert_eq!(bh_replay_load(c, replay.as_ptr()), 1, "{}", error(c));
        let playback = || (*c).map.as_ref().unwrap().playback.as_ref().unwrap();
        let ticks = playback().data.commands.len() as u32;
        let checkpoints = playback().data.checkpoints.len();
        eprintln!("replay load {:?}: {ticks} ticks, {checkpoints} checkpoints", started.elapsed());
        // Positions from playing the whole replay once, to check every seek against.
        let mut out = BhSnapshot::default();
        assert_eq!(bh_replay_seek(c, 0, &mut out), 1);
        let mut positions = vec![out.player.position];
        let started = Instant::now();
        for _ in 0..ticks {
            assert_eq!(bh_replay_step(c, &mut out), 1, "{}", error(c));
            positions.push(out.player.position);
        }
        let elapsed = started.elapsed();
        eprintln!(
            "played {ticks} ticks in {elapsed:?} ({:.2} us/tick); keyframes {} every {} ticks, {} MiB",
            elapsed.as_secs_f64() * 1e6 / ticks as f64,
            playback().keyframes.len(),
            playback().keyframes.interval(),
            playback().keyframes.bytes() >> 20
        );
        // Again with every keyframe already kept: the simulation alone.
        assert_eq!(bh_replay_seek(c, 0, &mut out), 1);
        let started = Instant::now();
        for _ in 0..ticks {
            assert_eq!(bh_replay_step(c, &mut out), 1);
        }
        eprintln!("replayed in {:?}", started.elapsed());
        let mut slowest = std::time::Duration::ZERO;
        let mut total = std::time::Duration::ZERO;
        let mut seed = 0x2545_f491_u32;
        let seeks = 200;
        for _ in 0..seeks {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            let tick = seed % (ticks + 1);
            let started = Instant::now();
            assert_eq!(bh_replay_seek(c, tick, &mut out), 1, "{}", error(c));
            let elapsed = started.elapsed();
            slowest = slowest.max(elapsed);
            total += elapsed;
            let expected = positions[tick as usize];
            assert!(out.player.position.iter().zip(expected).all(|(a, b)| a.to_bits() == b.to_bits()), "tick {tick}");
        }
        eprintln!("{seeks} random seeks: mean {:?}, slowest {slowest:?}", total / seeks);
        // Seeks onto keyframes: the restore alone.
        let interval = playback().keyframes.interval();
        let started = Instant::now();
        for i in 0..20 {
            assert_eq!(bh_replay_seek(c, interval * (1 + (i * 7) % (ticks / interval - 1)), &mut out), 1);
        }
        eprintln!("restore {:?}", started.elapsed() / 20);
        bh_destroy(c);
    }
}

#[test]
#[ignore]
fn recording_tick_sizes() {
    eprintln!(
        "BhCmd {} Option<Look> {} Checkpoint {} segments Tick {}",
        size_of::<BhCmd>(),
        size_of::<Option<crate::BhLookSampleV2>>(),
        size_of::<crate::recording::Checkpoint>(),
        size_of::<(BhCmd, Option<crate::BhLookSampleV2>, Option<crate::recording::Checkpoint>)>()
    );
}

fn resident_kib() -> u64 {
    let pid = std::process::id().to_string();
    let out = std::process::Command::new("ps").args(["-o", "rss=", "-p", &pid]).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().parse().unwrap()
}

/// `BH_RECORD_BENCH_TICKS` ticks of an open recording, and the process growth they cost.
#[test]
#[ignore]
fn recording_memory_bench() {
    let ticks: u64 = std::env::var("BH_RECORD_BENCH_TICKS").map_or(2_880_000, |v| v.parse().unwrap());
    let fixture = Fixture::new();
    let path = fixture.file("map.bsp", &bsp(&[]));
    let zones = timer_zones();
    unsafe {
        let c = bh_create();
        assert_eq!(bh_load_map(c, path.as_ptr(), ptr::null()), 1);
        let options = BhRunOptions { rules: 1, ..BhRunOptions::default() };
        assert_eq!(bh_run_configure(c, &options, zones.as_ptr(), 2), 1);
        assert_eq!(bh_record_begin(c, ptr::null(), c"autohop".as_ptr(), c"test".as_ptr(), 100), 1);
        let before = resident_kib();
        let started = Instant::now();
        let mut s = BhState::default();
        let mut slowest = std::time::Duration::ZERO;
        for tick in 0..ticks {
            // Changing values, so the memory compressor can't fold the history into zero pages.
            let cmd = BhCmd { yaw: (tick % 36_000) as f32 * 0.01, buttons: (tick % 7) as u32, ..BhCmd::default() };
            let look = crate::BhLookSampleV2 {
                base: tick as f64 * 0.5,
                k: 0.022,
                count: (tick % 9_999) as f64,
                epoch: tick as u32,
                kind: 1,
                frames: (tick % 3) as u32,
                events: (tick % 5) as u32,
                reports: 1,
            };
            let tick_started = Instant::now();
            assert_eq!(bh_step_look_v2(c, &cmd, &look, &mut s), 1);
            slowest = slowest.max(tick_started.elapsed());
        }
        let after = resident_kib();
        let mut run = BhRunState::default();
        assert_eq!(bh_run_state(c, &mut run), 1);
        assert_eq!((run.recording, run.recording_valid, run.total_commands), (1, 1, ticks));
        let data = &(*c).map.as_ref().unwrap().recorder.as_ref().unwrap().data;
        let held = data.commands.len() * size_of::<BhCmd>()
            + data.looks.len() * size_of::<Option<crate::BhLookSampleV2>>()
            + data.checkpoints.len() * size_of::<crate::recording::Checkpoint>();
        let reserved = data.commands.capacity() * size_of::<BhCmd>()
            + data.looks.capacity() * size_of::<Option<crate::BhLookSampleV2>>()
            + data.checkpoints.capacity() * size_of::<crate::recording::Checkpoint>();
        eprintln!(
            "held {} MiB ({:.1} B/tick), reserved {} MiB, looks stored {}",
            held >> 20,
            held as f64 / ticks as f64,
            reserved >> 20,
            data.looks.iter().filter(|l| l.is_some()).count()
        );
        // macOS compresses idle pages, so its resident size undercounts; `footprint` includes them.
        if let Ok(out) = std::process::Command::new("footprint").args(["-p", &std::process::id().to_string()]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines().filter(|l| l.contains("phys_footprint")).for_each(|l| eprintln!("{}", l.trim()));
        }
        eprintln!(
            "{ticks} ticks in {:?}: resident +{} MiB ({:.1} B/tick), slowest tick {slowest:?}",
            started.elapsed(),
            (after - before) / 1024,
            (after - before) as f64 * 1024.0 / ticks as f64
        );
        bh_destroy(c);
    }
}
