//! Entity lump parsing.

use std::collections::HashSet;
use std::sync::Arc;

#[derive(Clone, Debug, Default)]
pub struct Entity {
    pub pairs: Vec<(String, String)>,
}

impl Entity {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.pairs.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
    }

    pub fn classname(&self) -> &str {
        self.get("classname").unwrap_or("")
    }

    pub fn vec3(&self, key: &str) -> Option<[f32; 3]> {
        let mut it = self.get(key)?.split_whitespace().map(|s| s.parse::<f32>().ok());
        Some([it.next()??, it.next()??, it.next()??])
    }

    pub fn origin(&self) -> [f32; 3] {
        self.vec3("origin").unwrap_or([0.0; 3])
    }

    pub fn angles(&self) -> [f32; 3] {
        self.vec3("angles").unwrap_or([0.0; 3])
    }

    pub fn int(&self, key: &str) -> i64 {
        self.get(key).and_then(|v| v.trim().parse::<f64>().ok()).map(|v| v as i64).unwrap_or(0)
    }

    pub fn float(&self, key: &str) -> Option<f32> {
        self.get(key).and_then(|v| v.trim().parse().ok())
    }

    /// Brush model index for `"model" "*N"`.
    pub fn brush_model(&self) -> Option<usize> {
        self.get("model")?.strip_prefix('*')?.parse().ok()
    }

    /// Entity I/O connections (`"OnTrigger" "target,input,param,delay,times"`), in lump order.
    pub fn outputs(&self) -> Vec<Output> {
        self.outputs_interned(&mut Interner::default())
    }

    /// `outputs`, sharing equal strings through `strings` (one interner per map load).
    pub fn outputs_interned(&self, strings: &mut Interner) -> Vec<Output> {
        self.pairs.iter().filter_map(|(k, v)| Output::parse_with(k, v, strings)).collect()
    }
}

/// Shares equal strings between outputs: maps with hundreds of thousands of outputs (bhop_miku_v2: 416k on four
/// logic_relays) repeat a handful of events, targets, inputs and parameters, and the server-side verifier runs in a
/// 128 MB isolate.
#[derive(Default)]
pub struct Interner(HashSet<Arc<str>>);

impl Interner {
    pub fn get(&mut self, s: &str) -> Arc<str> {
        if let Some(a) = self.0.get(s) {
            return a.clone();
        }
        let a: Arc<str> = Arc::from(s);
        self.0.insert(a.clone());
        a
    }
}

/// One entity I/O connection. Field separator is `,` (older compilers) or ESC (0x1b, newer).
#[derive(Clone, Debug, PartialEq)]
pub struct Output {
    /// Lower-cased output name, e.g. `ontrigger`.
    pub event: Arc<str>,
    pub target: Arc<str>,
    pub input: Arc<str>,
    pub param: Arc<str>,
    pub delay: f32,
    /// Remaining fire count; -1 = unlimited.
    pub times: i32,
}

impl Output {
    pub fn parse(key: &str, value: &str) -> Option<Self> {
        Self::parse_with(key, value, &mut Interner::default())
    }

    pub fn parse_with(key: &str, value: &str, strings: &mut Interner) -> Option<Self> {
        if (key.len() < 3 || !key[..2].eq_ignore_ascii_case("on")) && !is_named_output(key) {
            return None;
        }
        let sep = if value.contains('\x1b') { '\x1b' } else { ',' };
        Self::from_fields(key, value, sep, strings)
    }

    /// `AddOutput "OnTrigger target:input:param:delay:times"` form.
    pub fn parse_add_output(spec: &str) -> Option<Self> {
        let (key, value) = spec.trim().split_once(char::is_whitespace)?;
        if key.len() < 3 || !key[..2].eq_ignore_ascii_case("on") {
            return None;
        }
        Self::from_fields(key, value.trim(), ':', &mut Interner::default())
    }

    fn from_fields(key: &str, value: &str, sep: char, strings: &mut Interner) -> Option<Self> {
        let fields: Vec<&str> = value.split(sep).collect();
        if fields.len() < 2 {
            return None;
        }
        let field = |i: usize| fields.get(i).map(|s| s.trim()).unwrap_or("");
        Some(Self {
            event: strings.get(&key.to_ascii_lowercase()),
            target: strings.get(field(0)),
            input: strings.get(field(1)),
            param: strings.get(field(2)),
            delay: field(3).parse().unwrap_or(0.0f32).max(0.0),
            times: field(4).parse::<f32>().map(|t| t as i32).unwrap_or(-1),
        })
    }
}

/// Outputs whose names don't start with "On": game_ui's (CGameUI DEFINE_OUTPUT "PressedForward", "PlayerOn", ...).
fn is_named_output(key: &str) -> bool {
    const NAMES: [&str; 14] = [
        "pressedforward",
        "pressedback",
        "pressedmoveleft",
        "pressedmoveright",
        "pressedattack",
        "pressedattack2",
        "unpressedforward",
        "unpressedback",
        "unpressedmoveleft",
        "unpressedmoveright",
        "unpressedattack",
        "unpressedattack2",
        "playeron",
        "playeroff",
    ];
    NAMES.iter().any(|n| n.eq_ignore_ascii_case(key))
}

/// Source `NameMatches`: case-insensitive, `*` as a trailing wildcard.
pub fn name_matches(pattern: &str, name: &str) -> bool {
    if pattern.is_empty() {
        return false;
    }
    match pattern.strip_suffix('*') {
        Some(prefix) => name.len() >= prefix.len() && name[..prefix.len()].eq_ignore_ascii_case(prefix),
        None => pattern.eq_ignore_ascii_case(name),
    }
}

pub fn parse(text: &str) -> Vec<Entity> {
    parse_inner(text, None).entities
}

/// A parsed entity lump with each entity's I/O connections (`outputs[i]` = `entities[i].outputs()`, strings shared
/// across the map through one `Interner`).
pub struct EntityList {
    pub entities: Vec<Entity>,
    pub outputs: Vec<Vec<Output>>,
}

/// `parse`, with the outputs parsed as they're read. `keep_output_pairs`: also keep them as key/value pairs (what
/// `Entity::get` / the client's entity list see); the headless verifier passes false, which drops a String pair per
/// output from the parsed entities (bhop_miku_v2: 416k outputs, 16 MB of entity lump).
pub fn parse_with_outputs(text: &str, keep_output_pairs: bool) -> EntityList {
    parse_inner(text, Some((&mut Interner::default(), keep_output_pairs)))
}

fn parse_inner(text: &str, mut outputs: Option<(&mut Interner, bool)>) -> EntityList {
    let mut entities = Vec::new();
    let mut all_outputs = Vec::new();
    let mut current: Option<Entity> = None;
    let mut current_outputs: Vec<Output> = Vec::new();
    let mut key: Option<String> = None;
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => {
                current = Some(Entity::default());
                current_outputs = Vec::new();
                key = None;
                i += 1;
            }
            b'}' => {
                if let Some(e) = current.take() {
                    entities.push(e);
                    if outputs.is_some() {
                        all_outputs.push(std::mem::take(&mut current_outputs));
                    }
                }
                i += 1;
            }
            b'"' => {
                let start = i + 1;
                let mut end = start;
                while end < bytes.len() && bytes[end] != b'"' {
                    end += 1;
                }
                let s = String::from_utf8_lossy(&bytes[start..end]).into_owned();
                i = end + 1;
                if let Some(e) = current.as_mut() {
                    match key.take() {
                        None => key = Some(s),
                        Some(k) => match outputs.as_mut() {
                            None => e.pairs.push((k, s)),
                            Some((strings, keep)) => match Output::parse_with(&k, &s, strings) {
                                Some(o) => {
                                    current_outputs.push(o);
                                    if *keep {
                                        e.pairs.push((k, s));
                                    }
                                }
                                None => e.pairs.push((k, s)),
                            },
                        },
                    }
                }
            }
            _ => i += 1,
        }
    }
    EntityList { entities, outputs: all_outputs }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_outputs_with_both_separators() {
        let o = Output::parse("OnTrigger", "!activator,AddOutput,targetname default,0.1,-1").unwrap();
        assert_eq!((&*o.event, &*o.target, &*o.input), ("ontrigger", "!activator", "AddOutput"));
        assert_eq!((&*o.param, o.delay, o.times), ("targetname default", 0.1, -1));
        let o = Output::parse("OnStartTouch", "door\x1bOpen\x1b\x1b2\x1b1").unwrap();
        assert_eq!(
            (&*o.target, &*o.input, &*o.param, o.delay, o.times),
            ("door", "Open", "", 2.0, 1)
        );
        assert!(Output::parse("origin", "1 2 3").is_none());
        let o = Output::parse_add_output("OnTrigger !self:Kill::0:1").unwrap();
        assert_eq!((&*o.target, &*o.input, o.times), ("!self", "Kill", 1));
    }

    #[test]
    fn wildcard_names() {
        assert!(name_matches("Door*", "door_12"));
        assert!(name_matches("teleport", "TELEPORT"));
        assert!(!name_matches("teleport", "teleport2"));
        assert!(!name_matches("", ""));
    }
}
