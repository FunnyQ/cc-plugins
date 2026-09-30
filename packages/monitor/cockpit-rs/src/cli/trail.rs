use super::{Args, provider, timestamp, upsert};
use crate::{config, find_session::find_session, log_root, paths, registry};
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
};

#[derive(Debug, PartialEq, Serialize)]
struct Facet {
    label: String,
    text: String,
}

fn facets(values: Vec<String>) -> Vec<Facet> {
    values
        .into_iter()
        .filter_map(|value| {
            let (label, text) = value.split_once(':').unwrap_or(("", &value));
            let facet = Facet {
                label: label.trim().to_owned(),
                text: text.trim().to_owned(),
            };
            (!facet.label.is_empty() || !facet.text.is_empty()).then_some(facet)
        })
        .collect()
}

#[derive(Serialize)]
struct Record<'a> {
    id: String,
    #[serde(rename = "type")]
    record_type: &'a str,
    kind: &'a str,
    source: &'a str,
    decision: &'a str,
    reason: &'a str,
    tradeoff: &'a str,
    facets: Vec<Facet>,
    needs_your_call: bool,
    options: Vec<String>,
    files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    diagram: Option<&'a str>,
    timestamp: String,
}

fn session(args: &Args, provider: crate::find_session::Provider, cwd: &Path) -> Option<String> {
    args.value("session")
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| find_session(provider, cwd))
}

fn diagram_gate(sub: &str, source: Option<&str>) -> Result<(), String> {
    let Some(source) = source else {
        return Ok(());
    };
    let script = paths::plugin_root()?.join("skills/cockpit/scripts/diagram-lint.ts");
    let Ok(mut child) = Command::new("bun")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        // TS never blocks trail writes when the Mermaid parser cannot be started.
        return Ok(());
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(source.as_bytes());
    }
    let problems = child
        .wait_with_output()
        .ok()
        .and_then(|out| serde_json::from_slice::<Vec<String>>(&out.stdout).ok())
        .unwrap_or_default();
    if problems.is_empty() {
        return Ok(());
    }
    Err(format!(
        "cockpit {sub}: --diagram failed lint — fix the Mermaid source and re-run:\n{}",
        problems
            .iter()
            .map(|p| format!("  - {p}"))
            .collect::<Vec<_>>()
            .join("\n")
    ))
}

fn recent(args: &Args, provider: crate::find_session::Provider, cwd: &Path, project: &Path) {
    let Some(id) = session(args, provider, cwd) else {
        println!("(no session resolved — pass --session <id> to name one)");
        return;
    };
    let mut candidates = vec![log_root::log_path_for(project, &id)];
    if let Some(entry) = registry::entry_for(&id) {
        let path = std::path::PathBuf::from(entry.log_path());
        if !entry.log_path().is_empty() && !candidates.contains(&path) {
            candidates.push(path);
        }
    }
    let found: Vec<_> = candidates
        .iter()
        .filter(|p| p.exists())
        .map(|path| {
            let entries: Vec<Value> = fs::read_to_string(path)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .filter(|r| {
                    r.get("type").and_then(Value::as_str) == Some("decision")
                        && r.get("source").and_then(Value::as_str) == Some("scribe")
                })
                .collect();
            (path, entries)
        })
        .collect();
    if found.is_empty() {
        println!(
            "(no decision log yet — looked in: {})",
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        );
        return;
    }
    if found
        .iter()
        .filter(|(_, entries)| !entries.is_empty())
        .count()
        > 1
    {
        println!("! this session's trail is SPLIT across several logs — showing all of them:");
        for (path, entries) in &found {
            if !entries.is_empty() {
                println!("!   {} ({})", path.display(), entries.len());
            }
        }
    }
    let mut all: Vec<_> = found.into_iter().flat_map(|(_, entries)| entries).collect();
    all.sort_by(|a, b| {
        a.get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("timestamp").and_then(Value::as_str).unwrap_or(""))
    });
    if all.is_empty() {
        println!("(no scribe entries yet)");
        return;
    }
    let n = args.recent.unwrap_or(8);
    let start = if n == 0 {
        0
    } else {
        all.len().saturating_sub(n)
    };
    for entry in &all[start..] {
        println!(
            "{} · {} · {}",
            entry
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("decision"),
            entry
                .get("decision")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("(untitled)"),
            entry
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or("undefined")
        );
    }
}

fn git_block(label: &str, argv: &[&str], cwd: &Path) {
    println!("$ {label}");
    match Command::new("git").args(argv).current_dir(cwd).output() {
        Err(error) => println!("(not available: {error})"),
        Ok(out) if !out.status.success() => {
            let message = if !out.stderr.is_empty() {
                String::from_utf8_lossy(&out.stderr).into_owned()
            } else if !out.stdout.is_empty() {
                String::from_utf8_lossy(&out.stdout).into_owned()
            } else {
                format!("exit {}", out.status.code().unwrap_or(1))
            };
            println!("(not available: {})", message.trim());
        }
        Ok(out) => {
            let text = String::from_utf8_lossy(&out.stdout);
            println!(
                "{}",
                if text.trim_end().is_empty() {
                    "(no output)"
                } else {
                    text.trim_end()
                }
            );
        }
    }
}

pub fn run(sub: &str, args: &Args, cwd: &Path) -> Result<(), String> {
    let provider = provider(args)?;
    let project = log_root::log_root(cwd, log_root::git_root_of);
    if sub == "prep" {
        let id = session(args, provider, cwd)
            .ok_or("cockpit prep: could not auto-resolve the current session")?;
        println!(
            "Session id:\n{id}\n\nDecision-log language:\n{}",
            config::get_language()
        );
        return Ok(());
    }
    let kind = args.value("type").filter(|s| !s.is_empty());
    if sub == "scribe" && kind.is_none() {
        if args.flag("prep") {
            println!(
                "Decision-log language:\n{}\n\nRecent scribe entries:",
                config::get_language()
            );
            recent(args, provider, cwd, &project);
            println!("\nGit change context:");
            git_block("git diff", &["diff"], cwd);
            println!();
            git_block("git diff --staged", &["diff", "--staged"], cwd);
            println!();
            git_block("git log --oneline -5", &["log", "--oneline", "-5"], cwd);
            return Ok(());
        }
        if args.flag("recent") {
            recent(args, provider, cwd, &project);
            return Ok(());
        }
        return Err(
            "cockpit scribe: --type <kind> is required (or use --recent to list recent entries)"
                .into(),
        );
    }
    let kind = if sub == "log" {
        "decision"
    } else {
        kind.unwrap_or("")
    };
    if sub == "scribe" {
        if !["decision", "rationale", "learning", "caveat"].contains(&kind) {
            return Err(format!(
                "cockpit scribe: invalid --type \"{kind}\" — must be one of: decision, rationale, learning, caveat"
            ));
        }
        if args.value("text").is_none_or(|s| s.is_empty()) {
            return Err("cockpit scribe: --text <body> is required".into());
        }
    }
    let id = session(args, provider, cwd).ok_or_else(|| {
        format!(
            "cockpit {sub}: --session <id> is required (could not auto-resolve the current session)"
        )
    })?;
    diagram_gate(sub, args.value("diagram"))?;
    let scribe = sub == "scribe";
    let record = Record {
        id: uuid::Uuid::new_v4().to_string(),
        record_type: "decision",
        kind,
        source: if scribe { "scribe" } else { "agent" },
        decision: args
            .value(if scribe { "title" } else { "decision" })
            .unwrap_or(""),
        reason: args
            .value(if scribe { "text" } else { "reason" })
            .unwrap_or(""),
        tradeoff: if scribe {
            ""
        } else {
            args.value("tradeoff").unwrap_or("")
        },
        facets: if scribe {
            vec![]
        } else {
            facets(args.list("facet"))
        },
        needs_your_call: !scribe && args.flag("needs-call"),
        options: if scribe { vec![] } else { args.list("option") },
        files: args.list("file"),
        diagram: args.value("diagram"),
        timestamp: timestamp(),
    };
    let path = log_root::log_path_for(&project, &id);
    if scribe {
        upsert(provider, &project, &id, &path).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(project.join(".cockpit/logs")).map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| file.write_all(format!("{line}\n").as_bytes()))
        .map_err(|e| e.to_string())?;
    let contents = fs::read_to_string(&path).unwrap_or_default();
    let confirmed = if scribe {
        contents
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .any(|r| r.get("id").and_then(Value::as_str) == Some(&record.id))
    } else {
        contents.lines().rfind(|line| !line.trim().is_empty()) == Some(line.as_str())
    };
    if !confirmed {
        return Err(format!(
            "cockpit {sub}: entry did not persist to {}",
            path.display()
        ));
    }
    if !scribe {
        upsert(provider, &project, &id, &path).map_err(|e| e.to_string())?;
    }
    if scribe {
        println!("cockpit: scribed {kind} for {id}");
    } else {
        println!("cockpit: logged decision for {id}");
        if record.needs_your_call {
            println!("  call:  {}", record.id);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn facets_split_first_colon_trim_and_drop_empty() {
        assert_eq!(
            facets(
                [" A : body: tail ", " plain ", " : ", "", " label: "]
                    .map(String::from)
                    .to_vec()
            ),
            vec![
                Facet {
                    label: "A".into(),
                    text: "body: tail".into()
                },
                Facet {
                    label: "".into(),
                    text: "plain".into()
                },
                Facet {
                    label: "label".into(),
                    text: "".into()
                }
            ]
        );
    }
}
