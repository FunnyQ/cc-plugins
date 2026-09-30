use regex::Regex;
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

fn pattern(source: &str) -> Regex {
    Regex::new(source).expect("fixed design pattern")
}

fn frontmatter(markdown: &str) -> Result<Value, String> {
    let captures = pattern(r"^---\n([\s\S]*?)\n---")
        .captures(markdown)
        .ok_or("DESIGN.md frontmatter not found")?;
    let value: Value = serde_norway::from_str(&captures[1]).map_err(|e| e.to_string())?;
    if !value.is_object() && !value.is_array() {
        return Err("DESIGN.md frontmatter invalid".into());
    }
    Ok(value)
}

fn entries(value: &Value) -> Vec<(String, &Value)> {
    match value {
        Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        Value::Array(array) => array
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => Vec::new(),
    }
}

fn scalar(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn titleize(key: &str) -> String {
    let spaced = pattern("[-_]+").replace_all(key, " ");
    pattern(r"(?-u:\b\w)")
        .replace_all(&spaced, |caps: &regex::Captures<'_>| {
            caps[0].to_ascii_uppercase()
        })
        .into_owned()
}

fn token_list(source: &Value) -> Value {
    Value::Array(
        entries(source)
            .into_iter()
            .filter_map(|(key, raw)| {
                let value = scalar(raw).filter(|s| !s.is_empty())?;
                Some(json!({"key": key, "name": titleize(&key), "value": value}))
            })
            .collect(),
    )
}

fn spec_list(source: &Value, typography: bool) -> Value {
    Value::Array(
        entries(source)
            .into_iter()
            .map(|(key, spec)| {
                let mut item = Map::new();
                item.insert("key".into(), key.clone().into());
                item.insert("name".into(), titleize(&key).into());
                let fields: &[&str] = if typography {
                    item.insert(
                        "value".into(),
                        scalar(&spec["fontFamily"]).unwrap_or_default().into(),
                    );
                    &["fontSize", "fontWeight", "lineHeight", "letterSpacing"]
                } else {
                    &[
                        "backgroundColor",
                        "textColor",
                        "rounded",
                        "padding",
                        "height",
                        "note",
                    ]
                };
                for field in fields {
                    if let Some(value) = scalar(&spec[*field]) {
                        item.insert((*field).into(), value.into());
                    }
                }
                Value::Object(item)
            })
            .collect(),
    )
}

fn extract_rules(markdown: &str) -> Value {
    // Scan body boundaries because regex does not support the TS lookahead.
    let header = pattern(r"\*\*(The [^*]+?Rule)\.\*\*");
    let next_rule = pattern(r"\n\n\*\*The [^*]+?Rule");
    let mut rules = Vec::new();
    let mut offset = 0;
    while let Some(caps) = header.captures(&markdown[offset..]) {
        let matched = caps.get(0).expect("matched header");
        let start = offset + matched.end();
        let remaining = markdown[start..].trim_start();
        let start = markdown.len() - remaining.len();
        let end = [
            next_rule.find(remaining).map(|m| m.start()),
            remaining.find("\n## "),
            remaining.find("\n### "),
        ]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(remaining.len());
        rules.push(json!({"name": &caps[1], "body": pattern(r"\s+").replace_all(&remaining[..end], " ").trim()}));
        offset = start + end;
        if offset >= markdown.len() {
            break;
        }
    }
    Value::Array(rules)
}

pub fn parse_cockpit_design_system(markdown: &str) -> Result<Value, String> {
    let fm = frontmatter(markdown)?;
    Ok(json!({
        "name": scalar(&fm["name"]).filter(|s| !s.is_empty()).unwrap_or_else(|| "Design System".into()),
        "description": scalar(&fm["description"]).unwrap_or_default(),
        "colors": token_list(&fm["colors"]),
        "typography": spec_list(&fm["typography"], true),
        "rounded": token_list(&fm["rounded"]),
        "spacing": token_list(&fm["spacing"]),
        "components": spec_list(&fm["components"], false),
        "rules": extract_rules(markdown),
    }))
}

fn read_root_markdown(project: &Path, filename: &str) -> Option<String> {
    let root = fs::canonicalize(project).ok()?;
    let file = fs::canonicalize(project.join(filename)).ok()?;
    if file != root.join(filename) {
        return None;
    }
    fs::read(file)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

pub fn read_project_design_system(project: &Path) -> Result<Value, String> {
    for filename in ["DESIGN.md", "design.md"] {
        let Ok(root) = fs::canonicalize(project) else {
            break;
        };
        let Ok(file) = fs::canonicalize(project.join(filename)) else {
            continue;
        };
        if file != root.join(filename) {
            continue;
        }
        let bytes = fs::read(file).map_err(|e| e.to_string())?;
        return parse_cockpit_design_system(&String::from_utf8_lossy(&bytes));
    }
    Err("DESIGN.md not found".into())
}

fn find_color(colors: &[(String, String)], prefer: &str, reject: &str) -> Option<String> {
    let prefer = pattern(&format!("(?i){prefer}"));
    let reject = pattern(&format!("(?i){reject}"));
    colors
        .iter()
        .find(|(key, _)| prefer.is_match(key) && !reject.is_match(key))
        .map(|(_, v)| v.clone())
}

fn hex_channels(value: &str, short: bool) -> Option<[f64; 3]> {
    let source = if short {
        r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})(?-u:\b)"
    } else {
        r"^#([0-9a-fA-F]{6})(?-u:\b)"
    };
    let caps = pattern(source).captures(value.trim())?;
    let hex = if caps[1].len() == 3 {
        caps[1].chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        caps[1].to_owned()
    };
    Some([
        u8::from_str_radix(&hex[..2], 16).ok()? as f64,
        u8::from_str_radix(&hex[2..4], 16).ok()? as f64,
        u8::from_str_radix(&hex[4..], 16).ok()? as f64,
    ])
}

fn lightness(value: &str) -> Option<f64> {
    if let Some(caps) = pattern(r"(?i)oklch\(\s*([\d.]+)%").captures(value.trim()) {
        return caps[1].parse().ok();
    }
    let [r, g, b] = hex_channels(value, true)?;
    Some((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0 * 100.0)
}

fn extreme(colors: &[(String, String)], light: bool) -> Option<String> {
    let mut best = if light { -1.0 } else { 101.0 };
    let mut result = None;
    for (_, color) in colors {
        if let Some(l) = lightness(color)
            && ((light && l > best) || (!light && l < best))
        {
            best = l;
            result = Some(color.clone());
        }
    }
    result
}

fn saturated(colors: &[(String, String)]) -> Option<String> {
    let mut best = -1.0;
    let mut result = None;
    for (_, color) in colors {
        let chroma = if let Some(caps) =
            pattern(r"(?i)oklch\(\s*[\d.]+%\s+([\d.]+)").captures(color.trim())
        {
            caps[1].parse::<f64>().unwrap_or(f64::NAN)
        } else if let Some([r, g, b]) = hex_channels(color, false) {
            (r.max(g).max(b) - r.min(g).min(b)) / 255.0
        } else {
            0.0
        };
        if chroma > best {
            best = chroma;
            result = Some(color.clone());
        }
    }
    result
}

fn parse_design_tokens(markdown: &str) -> Option<Value> {
    let fm = frontmatter(markdown).ok()?;
    let colors: Vec<_> = entries(&fm["colors"])
        .into_iter()
        .filter_map(|(k, v)| v.as_str().map(|v| (k, v.to_owned())))
        .collect();
    let mut tokens = Map::new();
    let values = [
        (
            "colorBg",
            find_color(
                &colors,
                "paper|cream|bg|background|canvas|^base|surface|well",
                "soft|alpha|sink|-2$",
            )
            .or_else(|| extreme(&colors, true)),
        ),
        (
            "colorSurface",
            find_color(&colors, "surface|ash|card|panel|paper-2|cream-2", "alpha"),
        ),
        (
            "colorFg",
            find_color(
                &colors,
                "ink|fg|foreground|text|black",
                "soft|muted|faint|alpha",
            )
            .or_else(|| extreme(&colors, false)),
        ),
        (
            "colorMuted",
            find_color(&colors, "muted|faint|secondary|ink-soft", "alpha"),
        ),
        (
            "colorBorder",
            find_color(&colors, "border|edge|rule|divider|line", "strong|alpha")
                .or_else(|| find_color(&colors, "border|edge|rule", "alpha")),
        ),
        (
            "accent",
            find_color(&colors, "accent|primary|brand|highlight", "soft|alpha")
                .or_else(|| {
                    find_color(
                        &colors,
                        "gold|coral|oxblood|teal|azure|violet|magenta|amber|sky",
                        "soft|alpha",
                    )
                })
                .or_else(|| saturated(&colors)),
        ),
    ];
    for (key, value) in values {
        if let Some(value) = value.filter(|v| !v.is_empty()) {
            tokens.insert(key.into(), value.into());
        }
    }
    let typography = &fm["typography"];
    let rounded = &fm["rounded"];
    let sans = ["body", "title", "display"]
        .into_iter()
        .map(|role| &typography[role]["fontFamily"])
        .find(|v| !v.is_null());
    let mono = entries(typography)
        .into_iter()
        .map(|(_, role)| &role["fontFamily"])
        .find(|v| {
            v.as_str()
                .is_some_and(|s| s.to_lowercase().contains("mono"))
        });
    for (key, value) in [
        ("fontSans", sans),
        ("fontMono", mono),
        (
            "radius",
            ["md", "lg", "sm", "base"]
                .into_iter()
                .map(|k| &rounded[k])
                .find(|v| !v.is_null()),
        ),
        (
            "radiusSm",
            ["sm", "xs", "md"]
                .into_iter()
                .map(|k| &rounded[k])
                .find(|v| !v.is_null()),
        ),
    ] {
        if let Some(value) = value.filter(|v| v.as_str() != Some("")) {
            tokens.insert(key.into(), value.clone());
        }
    }
    if tokens.is_empty() {
        None
    } else {
        Some(Value::Object(tokens))
    }
}

pub fn build_project_info(project: &Path) -> Value {
    let tokens = fs::read(project.join("DESIGN.md"))
        .ok()
        .and_then(|bytes| parse_design_tokens(&String::from_utf8_lossy(&bytes)));
    json!({"claudeMd": read_root_markdown(project, "CLAUDE.md"), "agentsMd": read_root_markdown(project, "AGENTS.md"), "tokens": tokens})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn named_rule_from_typescript_fixture() {
        let parsed = parse_cockpit_design_system("---\nname: Night Flight\ntypography:\n  body:\n    fontWeight: 400\n---\n\n## 2. Colors\n\n**The Cold/Warm Rule.** Cool means autopilot. Warm means your turn.\n").unwrap();
        assert_eq!(parsed["rules"][0]["name"], "The Cold/Warm Rule");
        assert_eq!(
            parsed["rules"][0]["body"],
            "Cool means autopilot. Warm means your turn."
        );
        assert_eq!(parsed["typography"][0]["fontWeight"], "400");
    }

    #[test]
    fn rules_stop_at_next_rule_or_heading() {
        assert_eq!(
            extract_rules(
                "**The First Rule.** One\nline.\n\n**The Second Rule.** Two.\n### Stop\nignore\n**The Third Rule.** Three.\n## Stop\nignore"
            ),
            json!([{"name":"The First Rule","body":"One line."},{"name":"The Second Rule","body":"Two."},{"name":"The Third Rule","body":"Three."}])
        );
    }

    #[test]
    fn empty_rule_body_consumes_greedy_whitespace_like_typescript() {
        assert_eq!(
            extract_rules("**The First Rule.**\n\n**The Second Rule.** Two."),
            json!([{"name":"The First Rule","body":"**The Second Rule.** Two."}])
        );
        assert_eq!(
            extract_rules("**The First Rule.**\n## Heading\n**The Second Rule.** Two."),
            json!([{"name":"The First Rule","body":"## Heading **The Second Rule.** Two."}])
        );
    }

    #[test]
    fn missing_frontmatter_is_rejected() {
        assert_eq!(
            parse_cockpit_design_system("# Design only").unwrap_err(),
            "DESIGN.md frontmatter not found"
        );
        assert!(parse_design_tokens("# Just prose").is_none());
        assert!(parse_design_tokens("---\n{}\n---").is_none());
    }

    #[test]
    fn semantic_color_and_font_heuristics() {
        let parsed = parse_design_tokens("---\ncolors:\n  cream: '#f4efe6'\n  ink: '#1a1a1a'\n  ink-soft: '#2a2622'\n  worn-gold: '#b8960c'\n  rule: '#1a1a1a1f'\ntypography:\n  body:\n    fontFamily: Noto Sans TC\n  label:\n    fontFamily: DM Mono\nrounded:\n  sm: 6px\n  md: 8px\n---").unwrap();
        assert_eq!(
            parsed,
            json!({"colorBg":"#f4efe6", "colorFg":"#1a1a1a", "colorMuted":"#2a2622", "colorBorder":"#1a1a1a1f", "accent":"#b8960c", "fontSans":"Noto Sans TC", "fontMono":"DM Mono", "radius":"8px", "radiusSm":"6px"})
        );
    }

    #[test]
    fn fallback_lightness_chroma_and_empty_slots() {
        let parsed = parse_design_tokens("---\ncolors:\n  a: '#000'\n  b: '#fff'\n  c: 'oklch(60% 0.3 200)'\nrounded:\n  md: ''\n  lg: 9px\n---").unwrap();
        assert_eq!(parsed["colorBg"], "#fff");
        assert_eq!(parsed["colorFg"], "#000");
        assert_eq!(parsed["accent"], "oklch(60% 0.3 200)");
        assert!(parsed.get("radius").is_none());
    }

    #[test]
    fn lowercase_design_fallback_and_markdown_confinement() {
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "private").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            project.path().join("CLAUDE.md"),
        )
        .unwrap();
        fs::write(project.path().join("other.md"), "not root").unwrap();
        std::os::unix::fs::symlink(
            project.path().join("other.md"),
            project.path().join("AGENTS.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.md"),
            project.path().join("DESIGN.md"),
        )
        .unwrap();
        assert_eq!(
            read_project_design_system(project.path()).unwrap_err(),
            "DESIGN.md not found"
        );
        fs::remove_file(project.path().join("DESIGN.md")).unwrap();
        fs::write(
            project.path().join("design.md"),
            "---\nname: Lowercase\n---",
        )
        .unwrap();
        assert_eq!(
            read_project_design_system(project.path()).unwrap()["name"],
            "Lowercase"
        );
        assert_eq!(
            build_project_info(project.path()),
            json!({"claudeMd":null,"agentsMd":null,"tokens":null})
        );
    }
}
