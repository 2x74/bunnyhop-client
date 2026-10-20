//! Read-only audio surface grid, matching apps/web/src/audio/surfaces.ts.
use super::*;
const CELL: f64 = 192.0;
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct BhSurfaceProbe {
    pub surface: i32,
    pub material: i32,
    pub ground_z: f32,
    pub water_z: f32,
}
impl Default for BhSurfaceProbe {
    fn default() -> Self {
        Self {
            surface: -1,
            material: -1,
            ground_z: f32::NAN,
            water_z: f32::NAN,
        }
    }
}
struct Triangle {
    p: [[f64; 3]; 3],
    surface: i32,
    material: i32,
}
#[derive(Default)]
pub struct Grid {
    tris: Vec<Triangle>,
    cells: HashMap<(i32, i32), Vec<usize>>,
    water: HashMap<(i32, i32), Vec<usize>>,
}
fn classify(name: &str) -> i32 {
    let n = name.to_lowercase();
    if n.starts_with("tools/")
        || ["nodraw", "skybox", "toolsclip", "trigger"]
            .iter()
            .any(|s| n.contains(s))
    {
        return -1;
    }
    for (id, words) in [
        (
            1,
            &[
                "metal",
                "grate",
                "grating",
                "steel",
                "iron",
                "chainlink",
                "duct",
                "vent",
                "pipe",
                "tin",
                "alum",
                "diamond",
                "plate",
                "rust",
                "catwalk",
            ][..],
        ),
        (
            2,
            &[
                "wood", "plank", "crate", "board", "parquet", "bamboo", "barrel",
            ][..],
        ),
        (
            3,
            &[
                "grass", "dirt", "mud", "sand", "gravel", "snow", "nature", "ground", "leaves",
                "soil", "moss", "hay", "carpet", "rug", "fabric", "cloth",
            ][..],
        ),
        (
            4,
            &[
                "tile",
                "ceramic",
                "marble",
                "glass",
                "porcelain",
                "bathroom",
                "mosaic",
            ][..],
        ),
        (5, &["water", "liquid"][..]),
    ] {
        if words.iter().any(|s| n.contains(s)) {
            return id;
        }
    }
    0
}
impl Grid {
    pub fn build(mesh: &mesh::Mesh, materials: &materials::Materials) -> Self {
        let mut grid = Self::default();
        for g in mesh.groups.iter().filter(|g| g.model == 0) {
            let surface = if materials
                .descs
                .get(g.material as usize)
                .is_some_and(|m| m.kind == materials::Kind::Water)
            {
                5
            } else {
                classify(&mesh.materials[g.material as usize].name)
            };
            if surface < 0 {
                continue;
            }
            for t in mesh.indices[g.first_index as usize..(g.first_index + g.index_count) as usize]
                .chunks_exact(3)
            {
                let p: [[_; 3]; 3] = std::array::from_fn(|i| {
                    std::array::from_fn(|j| f64::from(mesh.vertices[t[i] as usize * 10 + j]))
                });
                if !p.iter().flatten().all(|x| x.is_finite()) {
                    continue;
                }
                let u = std::array::from_fn::<_, 3, _>(|i| p[1][i] - p[0][i]);
                let w = std::array::from_fn::<_, 3, _>(|i| p[2][i] - p[0][i]);
                let (nx, ny, nz) = (
                    u[1] * w[2] - u[2] * w[1],
                    u[2] * w[0] - u[0] * w[2],
                    u[0] * w[1] - u[1] * w[0],
                );
                let len = nx.hypot(ny).hypot(nz);
                if len < 1e-6
                    || if surface == 5 {
                        (nz / len).abs() < 0.6
                    } else {
                        nz / len < 0.6
                    }
                {
                    continue;
                }
                let at = grid.tris.len();
                grid.tris.push(Triangle {
                    p,
                    surface,
                    material: g.material as i32,
                });
                let x0 =
                    (p.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min) / CELL).floor() as i32;
                let x1 = (p.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max) / CELL).floor()
                    as i32;
                let y0 =
                    (p.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min) / CELL).floor() as i32;
                let y1 = (p.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max) / CELL).floor()
                    as i32;
                if (i64::from(x1) - i64::from(x0) + 1) * (i64::from(y1) - i64::from(y0) + 1) > 2048
                {
                    continue;
                }
                let cells = if surface == 5 {
                    &mut grid.water
                } else {
                    &mut grid.cells
                };
                for x in x0..=x1 {
                    for y in y0..=y1 {
                        cells.entry((x, y)).or_default().push(at);
                    }
                }
            }
        }
        grid
    }
    fn height(&self, t: usize, x: f64, y: f64) -> f64 {
        let [a, b, c] = self.tris[t].p;
        let (v0x, v0y, v1x, v1y, v2x, v2y) = (
            c[0] - a[0],
            c[1] - a[1],
            b[0] - a[0],
            b[1] - a[1],
            x - a[0],
            y - a[1],
        );
        let (d00, d01, d02, d11, d12) = (
            v0x * v0x + v0y * v0y,
            v0x * v1x + v0y * v1y,
            v0x * v2x + v0y * v2y,
            v1x * v1x + v1y * v1y,
            v1x * v2x + v1y * v2y,
        );
        let den = d00 * d11 - d01 * d01;
        if den.abs() < 1e-9 {
            return f64::NAN;
        }
        let (u, v) = ((d11 * d02 - d01 * d12) / den, (d00 * d12 - d01 * d02) / den);
        if u < -0.01 || v < -0.01 || u + v > 1.02 {
            return f64::NAN;
        }
        a[2] + u * (c[2] - a[2]) + v * (b[2] - a[2])
    }
    pub fn at(&self, p: [f32; 3]) -> BhSurfaceProbe {
        let [x, y, z] = p.map(f64::from);
        let cell = ((x / CELL).floor() as i32, (y / CELL).floor() as i32);
        let mut out = BhSurfaceProbe::default();
        let mut best = f64::NEG_INFINITY;
        for &t in self.cells.get(&cell).into_iter().flatten() {
            let h = self.height(t, x, y);
            if !h.is_finite() || h > z + 4.0 || h < z - 24.0 || h <= best {
                continue;
            }
            best = h;
            out.surface = self.tris[t].surface;
            out.material = self.tris[t].material;
            out.ground_z = h as f32;
        }
        let mut water = f64::NAN;
        for &t in self.water.get(&cell).into_iter().flatten() {
            let h = self.height(t, x, y);
            if !h.is_finite() || h < z - 2.0 || h > z + 2000.0 {
                continue;
            }
            if !(h >= water) {
                water = h;
            }
        }
        out.water_z = water as f32;
        out
    }
}
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_surface_at(
    ctx: *mut BhContext,
    x: f32,
    y: f32,
    z: f32,
    out: *mut BhSurfaceProbe,
) -> c_int {
    unsafe {
        call(ctx, |c| {
            finite(&[x, y, z])?;
            output(out, c.map()?.assets.surfaces.at([x, y, z]))
        })
    }
}
