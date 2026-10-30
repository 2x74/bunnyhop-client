//! Prepare an isolated map on a worker; the owning context only receives it after preparation ends.
use super::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};

pub(super) struct PreparedTexture {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn prepare_textures(map: &mut Map, check: &impl Fn() -> Result<(), String>) -> Result<(), String> {
    const MAX_PREPARED_BYTES: usize = 512 * 1024 * 1024;
    let mut total = 0;
    for index in 0..map.materials.textures.len() {
        check()?;
        let path = map.materials.textures[index].clone();
        let Ok(image) = map.texture(index as u32) else {
            continue;
        };
        total += image.byte_count;
        if total > MAX_PREPARED_BYTES {
            break;
        }
        let prepared = PreparedTexture {
            rgba: std::mem::take(&mut map.texture),
            width: image.width,
            height: image.height,
        };
        map.prepared_textures.insert(path, prepared);
    }
    let names: Vec<String> =
        serde_json::from_slice(map.assets.material_names.to_bytes()).map_err(|e| e.to_string())?;
    for name in names {
        check()?;
        let bump = loop {
            let value = materials::material_param(&map.vfs, &name, "$bumpmap");
            if !assets::fetch_pending(
                &mut map.vfs,
                map.root.as_deref(),
                &mut map.loose,
                &mut map.attempted,
            ) {
                break value;
            }
        };
        let Some(bump) = bump else { continue };
        let path = materials::vtf_path(&bump);
        // Fetch loose normals on the worker even if the optional decoded-image budget is spent.
        if map.content(&path).is_err() || map.prepared_textures.contains_key(&path) {
            continue;
        }
        if total >= MAX_PREPARED_BYTES {
            continue;
        }
        let Ok(image) = map.texture_path(&path) else {
            continue;
        };
        total += image.byte_count;
        if total > MAX_PREPARED_BYTES {
            continue;
        }
        map.prepared_textures.insert(
            path,
            PreparedTexture {
                rgba: std::mem::take(&mut map.texture),
                width: image.width,
                height: image.height,
            },
        );
    }
    Ok(())
}

struct LoadedMap(Map);
// Every Rc in this graph is created inside Map::load_cancellable. No reference escapes the worker before
// send, and the worker never touches the graph afterwards. Only this whole, isolated graph may cross threads.
unsafe impl Send for LoadedMap {}

pub(super) struct MapLoad {
    result: mpsc::Receiver<Result<LoadedMap, String>>,
    cancel: Arc<AtomicBool>,
}

impl Drop for MapLoad {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

impl MapLoad {
    fn start(path: PathBuf, root: Option<PathBuf>, settings: BhSettings) -> Result<Self, String> {
        let (send, result) = mpsc::sync_channel(1);
        let cancel = Arc::new(AtomicBool::new(false));
        let token = cancel.clone();
        thread::Builder::new()
            .name("native-map-load".into())
            .spawn(move || {
                let loaded = catch_unwind(AssertUnwindSafe(|| {
                    let check = || {
                        if token.load(Ordering::Relaxed) {
                            Err("map load cancelled".into())
                        } else {
                            Ok(())
                        }
                    };
                    let mut map = Map::load_cancellable(&path, root.as_deref(), settings, &check)?;
                    prepare_textures(&mut map, &check)?;
                    Ok(LoadedMap(map))
                }))
                .unwrap_or_else(|_| Err("Rust panic preparing map".into()));
                // If cancelled, the receiver is gone and the isolated graph is dropped on this worker.
                let _ = send.send(loaded);
            })
            .map_err(|e| e.to_string())?;
        Ok(Self { result, cancel })
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_load_map_begin(
    ctx: *mut BhContext,
    path: *const c_char,
    content_root: *const c_char,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            let path = PathBuf::from(string(path)?);
            let root = if content_root.is_null() {
                None
            } else {
                Some(PathBuf::from(string(content_root)?))
            };
            c.loading = Some(MapLoad::start(path, root, c.settings)?);
            Ok(())
        })
    }
}

/// Zero while pending, one after installation, minus one on failure. Never waits for the worker.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_load_map_poll(ctx: *mut BhContext) -> c_int {
    let mut ready = 0;
    let ok = unsafe {
        call(ctx, |c| {
            let result = c
                .loading
                .as_ref()
                .ok_or("no pending map load")?
                .result
                .try_recv();
            let result = match result {
                Err(mpsc::TryRecvError::Empty) => return Ok(()),
                Err(mpsc::TryRecvError::Disconnected) => Err("map worker disconnected".into()),
                Ok(result) => result,
            };
            c.loading = None;
            let LoadedMap(mut map) = result?;
            map.game.set_settings(c.settings.checked()?);
            map.game.reset();
            map.filter = styles::Filter::new(&c.style_id, c.settings.physics);
            if let Some(mut old) = c.map.take() {
                old.finish_record(false, "map_reload")?;
            }
            c.map = Some(map);
            ready = 1;
            Ok(())
        })
    };
    if ok == 0 { -1 } else { ready }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_load_map_cancel(ctx: *mut BhContext) -> c_int {
    unsafe {
        call(ctx, |c| {
            c.loading = None;
            Ok(())
        })
    }
}
