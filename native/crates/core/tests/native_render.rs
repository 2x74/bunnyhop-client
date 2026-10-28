use bunnyhop_core::materials::{self, Kind};
use bunnyhop_core::{content, mesh, vfs};
use std::path::PathBuf;

fn map_bytes(name: &str) -> Option<Vec<u8>> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../maps").join(format!("{name}.bsp"));
    std::fs::read(&path).map_err(|_| eprintln!("skipping {name}: {} not found", path.display())).ok()
}

/// GothQueen's unreal_space report: toolsblack is a visible opaque wall, not a nodraw tool.
#[test]
fn black_tool_walls_are_rendered() {
    assert!(!mesh::hidden_tool_material("tools/toolsblack"));
    assert!(!mesh::hidden_tool_material("tools/toolswhite"));
    assert!(mesh::hidden_tool_material("tools/toolsnodraw"));
    assert!(mesh::hidden_tool_material("tools/toolsplayerclip"));
    let Some(bytes) = map_bytes("bhop_unreal_space") else { return };
    let bsp = bunnyhop_core::parse_bsp(&bytes).unwrap();
    let m = mesh::build(&bsp);
    let material = m.materials.iter().position(|m| m.name == "tools/toolsblack").expect("map uses black walls");
    let count: u32 = m.groups.iter().filter(|g| g.material as usize == material).map(|g| g.index_count).sum();
    assert!(count > 0, "black wall faces must reach the renderer");
    let mut fs = vfs::Vfs::default();
    fs.mount(vfs::Source::from_zip("pak", content::pakfile(&bsp)));
    let mats = materials::resolve(&fs, &["tools/toolsblack".into()]);
    assert_eq!(mats.descs[0].kind, Kind::Textured);
    assert_eq!(mats.descs[0].flags & (materials::FLAG_TRANSLUCENT | materials::FLAG_ADDITIVE), 0);
}
