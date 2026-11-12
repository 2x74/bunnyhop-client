//! Map BSPs for tests. Maps aren't in Git: CI fetches the ones listed in tools/ci/fixtures.txt
//! (tools/ci/prepare-fixtures.sh) and builds tests with `--cfg ci`. The rule, everywhere: a test finds its map here; a
//! missing map fails the test under CI and skips it on a developer machine, with a line on the terminal. A test whose
//! map CI doesn't fetch (the rest of the map library) is marked `#[cfg_attr(ci, ignore = "map library")]`.
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn maps_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../maps")
}

/// `maps/<name>.bsp`, or None when it isn't there (see `present`).
pub fn map(name: &str) -> Option<PathBuf> {
    let path = maps_dir().join(format!("{name}.bsp"));
    present(&path).then_some(path)
}

/// `maps/<name>.bsp` for a loader that handles a missing file itself; checked by `present` first.
pub fn bsp(name: &str) -> PathBuf {
    let path = maps_dir().join(format!("{name}.bsp"));
    present(&path);
    path
}

/// Whether a test's fixture file is there. Missing: a panic under CI, else a SKIP line and false.
pub fn present(path: &Path) -> bool {
    if path.exists() {
        return true;
    }
    let shown = path.strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap_or(path).display();
    if std::env::var_os("CI").is_some() {
        panic!("{shown} is missing in CI: list it in tools/ci/fixtures.txt, or mark the test #[cfg_attr(ci, ignore = \"map library\")]");
    }
    // Straight to the terminal: libtest swallows a passing test's print output.
    let test = std::thread::current().name().unwrap_or("a test").to_string();
    let _ = writeln!(std::io::stderr(), "SKIP {test}: {shown} is not here");
    false
}
