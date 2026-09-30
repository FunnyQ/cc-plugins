use super::{Env, parse_input, reminder};
use crate::{nudge_toggle, paths};
use serde_json::{Map, Value, json};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::PermissionsExt,
    path::Path,
    process::{Command, Stdio},
};

const MARKER_TTL_MS: i64 = 24 * 60 * 60_000;

pub struct Complexity {
    pub files: u32,
    pub lines: u64,
    pub structural: bool,
}

pub fn assess_complexity(numstat: &str, porcelain: &str) -> Complexity {
    let mut files = 0;
    let mut lines = 0;
    for line in numstat
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        files += 1;
        lines += line
            .split_whitespace()
            .take(2)
            .map(|n| n.parse::<u64>().unwrap_or(0))
            .sum::<u64>();
    }
    files += porcelain
        .lines()
        .filter(|line| line.starts_with("??"))
        .count() as u32;
    Complexity {
        files,
        lines,
        structural: files >= 3 || lines >= 80,
    }
}

pub fn decide_nudge(
    now: i64,
    current_sig: &str,
    last_sig: Option<&str>,
    last_nudge_ms: Option<i64>,
    throttle_ms: i64,
) -> bool {
    !current_sig.is_empty()
        && Some(current_sig) != last_sig
        && !last_nudge_ms.is_some_and(|last| now.saturating_sub(last) < throttle_ms)
}

pub fn build_reminder(c: &Complexity, session_id: Option<&str>, is_codex: bool) -> String {
    let cmd = match session_id.filter(|id| !id.is_empty()) {
        Some(id) => format!("/cockpit scribe --session {id}"),
        None => "/cockpit scribe".into(),
    };
    let spawn = if is_codex {
        format!(
            "spawn a background sub-agent (fork_context: true, no agent_type) with the prompt \"You are running under Codex. Run {cmd} --provider codex\""
        )
    } else {
        format!("spawn a fork (subagent_type:\"fork\") to run {cmd}")
    };
    if c.structural {
        format!(
            "📐 Sizable change ({} files, ~{} lines). If it hid a real decision/learning/caveat, {spawn} — draw it with a Mermaid `--diagram` first (flow / sequence / state / fan-out), prose only for what a picture can't carry.",
            c.files, c.lines
        )
    } else {
        format!(
            "💭 If that change hid a real decision/learning/caveat, {spawn} — prefer a Mermaid `--diagram` if it has any shape, else a terse note. Otherwise skip."
        )
    }
}

pub fn build_headless_scribe(
    claude: &str,
    skill_dir: &str,
    resume_id: &str,
    scribe_session: &str,
) -> Vec<String> {
    // The Rust port uses the shim instead of the retired Bun cockpit.ts CLI.
    let cli = format!("{skill_dir}/bin/cockpit");
    let refs = format!("{skill_dir}/references");
    let prompt = format!(
        "Scribe this session's decision log. In one turn, read {refs}/scribe.md and run `{cli} scribe --prep --session {scribe_session}`. Then follow scribe.md: the CLI is {cli}, and every call passes --session {scribe_session}. Spell each call as `{cli} scribe …`, never through a shell variable. When done, reply with one line."
    );
    // allowedTools is variadic and would swallow any following options.
    vec![
        claude.into(),
        "-p".into(),
        prompt,
        "--resume".into(),
        resume_id.into(),
        "--fork-session".into(),
        "--no-session-persistence".into(),
        "--effort".into(),
        "low".into(),
        "--output-format".into(),
        "json".into(),
        "--allowedTools".into(),
        format!("Bash({cli} scribe:*)"),
        format!("Read(/{refs}/**)"),
    ]
}

pub fn build_hook_output(reminder: &str, is_codex: bool) -> Value {
    if is_codex {
        json!({"systemMessage": reminder})
    } else {
        json!({"hookSpecificOutput": {"hookEventName": "Stop", "additionalContext": reminder}})
    }
}

fn throttle(env: &Env) -> f64 {
    env.get("COCKPIT_NUDGE_THROTTLE_MS")
        .and_then(|value| value.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(480_000.0)
}

fn write_marker(path: &Path, mut marker: Map<String, Value>, now: i64) {
    marker.retain(|_, entry| {
        !entry
            .get("lastNudgeMs")
            .and_then(Value::as_f64)
            .is_some_and(|last| now as f64 - last > MARKER_TTL_MS as f64)
    });
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_vec(&marker) {
        let _ = fs::write(path, raw);
    }
}

fn git(cwd: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

pub fn run() -> io::Result<()> {
    let Some(input) = parse_input(io::stdin().lock()) else {
        return Ok(());
    };
    let env: Env = std::env::vars().collect();
    let now = crate::registry::now_ms();
    if reminder::should_skip(&env, &input, now) {
        return Ok(());
    }
    let cwd = input
        .cwd
        .as_ref()
        .filter(|cwd| !cwd.is_empty())
        .map(std::path::PathBuf::from)
        .map(Ok)
        .unwrap_or_else(std::env::current_dir)?;
    let key = input
        .session_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| cwd.to_string_lossy().into_owned());
    let path = paths::cockpit_home().join("scribe-nudge.json");
    let mut marker = fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Map<String, Value>>(&raw).ok())
        .unwrap_or_default();
    let prev = marker.get(&key);
    let last = prev
        .and_then(|entry| entry.get("lastNudgeMs"))
        .and_then(Value::as_f64);
    let window = throttle(&env);
    // Throttle before config: its project scope probes git even on guaranteed no-op turns.
    if last.is_some_and(|last| now as f64 - last < window) {
        return Ok(());
    }
    if !nudge_toggle::nudge_enabled_for(input.session_id.as_deref(), &cwd, now) {
        return Ok(());
    }
    let Some(head) = git(&cwd, &["rev-parse", "HEAD"]) else {
        return Ok(());
    };
    let numstat = git(&cwd, &["diff", "HEAD", "--numstat"]).unwrap_or_default();
    let porcelain = git(&cwd, &["status", "--porcelain"]).unwrap_or_default();
    let sig = sha1_smol::Sha1::from(format!("{head} {numstat} {porcelain}"))
        .digest()
        .to_string();
    let last_sig = prev
        .and_then(|entry| entry.get("lastSig"))
        .and_then(Value::as_str);
    // The early gate preserves fractional Number windows; only signature gating remains here.
    if !decide_nudge(now, &sig, last_sig, None, 0) {
        return Ok(());
    }
    let is_codex = reminder::is_codex(&env);
    let session = reminder::resolve_parent_session(&env, &input);
    marker.insert(key, json!({"lastNudgeMs": now, "lastSig": sig}));
    write_marker(&path, marker, now);
    if reminder::is_claude_code(&env, &input)
        && let Some(resume) = input.session_id.as_deref().filter(|id| !id.is_empty())
        && let Some(session) = session.as_deref()
        && let Some(claude) = env.get("PATH").and_then(|path| {
            std::env::split_paths(path)
                .map(|dir| dir.join("claude"))
                .find(|path| {
                    fs::metadata(path)
                        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
                })
        })
    {
        let skill = paths::plugin_root()
            .map_err(io::Error::other)?
            .join("skills/cockpit");
        let argv = build_headless_scribe(
            &claude.to_string_lossy(),
            &skill.to_string_lossy(),
            resume,
            session,
        );
        let dir = Path::new("/tmp/q-lab/monitor/cockpit");
        fs::create_dir_all(dir)?;
        let out = fs::File::create(dir.join(format!("scribe-{now}.json")))?;
        let mut command = Command::new(&argv[0]);
        command
            .args(&argv[1..])
            .current_dir(&cwd)
            .env("RELAY_DELEGATED", "1")
            .stdin(Stdio::null())
            .stderr(out.try_clone()?)
            .stdout(out);
        crate::process_alive::detach(&mut command).spawn()?;
        return Ok(());
    }
    let text = build_reminder(
        &assess_complexity(&numstat, &porcelain),
        session.as_deref(),
        is_codex,
    );
    io::stdout()
        .lock()
        .write_all(build_hook_output(&text, is_codex).to_string().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn complexity_counts_binary_untracked_and_thresholds() {
        let c = assess_complexity(" \n-\t-\tbinary\ninvalid 2 file\n", " M tracked\n?? new\n");
        assert_eq!((c.files, c.lines, c.structural), (3, 2, true));
        assert!(!assess_complexity("79 0 f", "").structural);
        assert!(assess_complexity("40 40 f", "").structural);
        assert!(!assess_complexity("", "?? a\n?? b").structural);
        assert!(assess_complexity("", "?? a\n?? b\n?? c").structural);
    }

    #[test]
    fn nudge_branches_and_boundary() {
        assert!(!decide_nudge(100, "", None, None, 10));
        assert!(!decide_nudge(100, "sig", Some("sig"), None, 10));
        assert!(!decide_nudge(100, "sig", None, Some(91), 10));
        assert!(decide_nudge(100, "sig", Some("old"), Some(90), 10));
        assert!(decide_nudge(100, "sig", None, None, 10));
    }

    #[test]
    fn reminders_all_variants_and_output_order() {
        for (codex, spawn) in [
            (false, "spawn a fork (subagent_type:\"fork\") to run CMD"),
            (
                true,
                "spawn a background sub-agent (fork_context: true, no agent_type) with the prompt \"You are running under Codex. Run CMD --provider codex\"",
            ),
        ] {
            for (id, cmd) in [
                (None, "/cockpit scribe"),
                (Some("parent"), "/cockpit scribe --session parent"),
            ] {
                let spawn = spawn.replace("CMD", cmd);
                for structural in [false, true] {
                    let c = Complexity {
                        files: 3,
                        lines: 80,
                        structural,
                    };
                    let expected = if structural {
                        format!(
                            "📐 Sizable change (3 files, ~80 lines). If it hid a real decision/learning/caveat, {spawn} — draw it with a Mermaid `--diagram` first (flow / sequence / state / fan-out), prose only for what a picture can't carry."
                        )
                    } else {
                        format!(
                            "💭 If that change hid a real decision/learning/caveat, {spawn} — prefer a Mermaid `--diagram` if it has any shape, else a terse note. Otherwise skip."
                        )
                    };
                    assert_eq!(build_reminder(&c, id, codex), expected);
                }
            }
        }
        assert_eq!(
            build_hook_output("text", false).to_string(),
            r#"{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"text"}}"#
        );
        assert_eq!(
            build_hook_output("text", true).to_string(),
            r#"{"systemMessage":"text"}"#
        );
    }

    #[test]
    fn headless_builder_keeps_variadic_tools_last() {
        let argv = build_headless_scribe("/bin/claude", "/skill", "resume", "parent");
        assert_eq!(
            &argv[3..],
            [
                "--resume",
                "resume",
                "--fork-session",
                "--no-session-persistence",
                "--effort",
                "low",
                "--output-format",
                "json",
                "--allowedTools",
                "Bash(/skill/bin/cockpit scribe:*)",
                "Read(//skill/references/**)"
            ]
        );
        assert_eq!(argv[0], "/bin/claude");
        assert_eq!(argv[1], "-p");
        assert_eq!(
            argv[2],
            "Scribe this session's decision log. In one turn, read /skill/references/scribe.md and run `/skill/bin/cockpit scribe --prep --session parent`. Then follow scribe.md: the CLI is /skill/bin/cockpit, and every call passes --session parent. Spell each call as `/skill/bin/cockpit scribe …`, never through a shell variable. When done, reply with one line."
        );
    }

    #[test]
    fn marker_prunes_only_older_than_ttl_and_swallows_write_errors() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let path = dir.path().join("home/scribe-nudge.json");
        write_marker(
            &path,
            serde_json::from_value(
                json!({"stale":{"lastNudgeMs":0}, "boundary":{"lastNudgeMs":1}}),
            )
            .unwrap(),
            MARKER_TTL_MS + 1,
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"boundary":{"lastNudgeMs":1}}"#
        );
        write_marker(&path.join("blocked"), Map::new(), 0);
        for value in ["0", "garbage", "NaN", "inf", ""] {
            assert_eq!(
                throttle(&Env::from([(
                    "COCKPIT_NUDGE_THROTTLE_MS".into(),
                    value.into()
                )])),
                480_000.0
            );
        }
        assert_eq!(
            throttle(&Env::from([(
                "COCKPIT_NUDGE_THROTTLE_MS".into(),
                "0.5".into()
            )])),
            0.5
        );
    }
}
