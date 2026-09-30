use crate::{
    find_session::{self, Provider},
    paths,
};
use regex::Regex;
use serde_json::Value;
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::LazyLock,
};
use tokio::time::{Duration, Instant, sleep};

// Bound process ancestry work when wrappers form a long parent chain.
const ANCESTOR_HOPS: usize = 8;
// Allow the session-start hook to finish publishing its transcript.
const SESSION_BUDGET: Duration = Duration::from_secs(3);
// Retry without busy polling while the transcript appears.
const SESSION_POLL: Duration = Duration::from_millis(100);

fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}
fn environment_session(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| valid_uuid(value))
        .map(str::to_owned)
}
pub fn session_id_from_command(command: &str) -> Option<String> {
    static TOKENS: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?:[^\s"']+|["'][^"']*["'])+"#).expect("static argv regex"));
    let tokens: Vec<&str> = TOKENS
        .find_iter(command)
        .map(|token| {
            let token = token.as_str();
            let token = token.strip_prefix(['\'', '"']).unwrap_or(token);
            token.strip_suffix(['\'', '"']).unwrap_or(token)
        })
        .collect();
    for (index, token) in tokens.iter().enumerate() {
        if *token == "--session-id" {
            return tokens
                .get(index + 1)
                .copied()
                .filter(|value| valid_uuid(value))
                .map(str::to_owned);
        }
        let value = token.strip_prefix("--session-id=");
        if let Some(value) = value.filter(|value| valid_uuid(value)) {
            return Some(value.to_owned());
        }
    }
    None
}
fn ps(pid: i32, field: &str) -> Option<String> {
    let output = Command::new("ps")
        .args(["-o", field, "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}
fn ancestors(mut pid: i32, parent: impl Fn(i32) -> Option<i32>) -> Vec<i32> {
    let mut pids = Vec::new();
    for _ in 0..ANCESTOR_HOPS {
        if pid <= 1 {
            break;
        }
        pids.push(pid);
        let Some(next) = parent(pid).filter(|next| *next != pid) else {
            break;
        };
        pid = next;
    }
    pids
}
fn session_file(dir: &Path, pid: i32) -> Option<String> {
    let value: Value =
        serde_json::from_slice(&fs::read(dir.join(format!("{pid}.json"))).ok()?).ok()?;
    if value.get("pid")?.as_i64()? != i64::from(pid) {
        return None;
    }
    let id = value.get("sessionId")?.as_str()?;
    valid_uuid(id).then(|| id.to_owned())
}
fn resolve_initial(
    env: Option<&str>,
    pids: &[i32],
    file: impl Fn(i32) -> Option<String>,
    command: impl Fn(i32) -> Option<String>,
) -> Option<String> {
    environment_session(env)
        .or_else(|| pids.iter().find_map(|pid| file(*pid)))
        .or_else(|| {
            pids.iter()
                .find_map(|pid| command(*pid).and_then(|command| session_id_from_command(&command)))
        })
}
async fn retry_find_session(
    mut find: impl FnMut() -> Option<String>,
    budget: Duration,
) -> Option<String> {
    let deadline = Instant::now() + budget;
    while Instant::now() < deadline {
        if let Some(id) = find() {
            return Some(id);
        }
        sleep(SESSION_POLL.min(deadline.saturating_duration_since(Instant::now()))).await;
    }
    find()
}
pub async fn resolve_session_id() -> Option<String> {
    let value = env::var("CLAUDE_CODE_SESSION_ID").ok();
    if let Some(id) = environment_session(value.as_deref()) {
        return Some(id);
    }
    // getppid has no failure mode and matches the TS process.ppid starting point.
    let pids = ancestors(unsafe { libc::getppid() }, |pid| {
        ps(pid, "ppid=")?.trim().parse().ok()
    });
    let sessions = paths::claude_sessions_dir();
    if let Some(id) = resolve_initial(
        None,
        &pids,
        |pid| session_file(&sessions, pid),
        |pid| ps(pid, "command="),
    ) {
        return Some(id);
    }
    let project = env::var_os("CLAUDE_PROJECT_DIR")
        .map(PathBuf::from)
        .or_else(|| env::current_dir().ok())?;
    retry_find_session(
        || find_session::find_session(Provider::Claude, &project),
        SESSION_BUDGET,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    // Use distinct valid ids to make each precedence decision observable.
    const ENV: &str = "00000000-0000-0000-0000-000000000000";
    // Identify the session-file hit independently of the environment hit.
    const FILE: &str = "11111111-1111-1111-1111-111111111111";
    // Identify the argv hit independently of the session-file hit.
    const ARGV: &str = "22222222-2222-2222-2222-222222222222";
    #[test]
    fn command_forms_and_validation() {
        for command in [
            format!("claude --session-id {ARGV}"),
            format!("claude --session-id={ARGV}"),
            format!("claude --session-id '{ARGV}'"),
            format!("claude \"--session-id={ARGV}\""),
        ] {
            assert_eq!(session_id_from_command(&command).as_deref(), Some(ARGV));
        }
        assert_eq!(session_id_from_command("claude --session-id garbage"), None);
        assert_eq!(session_id_from_command("claude --session-id"), None);
        assert_eq!(
            session_id_from_command(&format!("claude --session-id invalid --session-id={ARGV}")),
            None
        );
        assert_eq!(
            environment_session(Some("ABCDEF00-1111-2222-3333-444455556666")),
            None
        );
    }
    #[test]
    fn ordered_chain_and_ancestor_bound() {
        let pids = [20, 10];
        let command = |_| Some(format!("claude --session-id {ARGV}"));
        assert_eq!(
            resolve_initial(
                Some(&format!(" {ENV} ")),
                &pids,
                |_| Some(FILE.into()),
                command
            )
            .as_deref(),
            Some(ENV)
        );
        assert_eq!(
            resolve_initial(Some("bad"), &pids, |_| Some(FILE.into()), command).as_deref(),
            Some(FILE)
        );
        assert_eq!(
            resolve_initial(None, &pids, |_| None, command).as_deref(),
            Some(ARGV)
        );
        assert_eq!(resolve_initial(None, &pids, |_| None, |_| None), None);
        assert_eq!(ancestors(20, |pid| Some(pid - 1)).len(), 8);
        assert_eq!(ancestors(3, |pid| Some(pid - 1)), vec![3, 2]);
        assert_eq!(ancestors(20, Some), vec![20]);
        assert_eq!(ancestors(20, |_| None), vec![20]);
    }
    #[test]
    fn session_file_requires_matching_pid_and_uuid() {
        let dir = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        for (pid, id, accepted) in [(20, FILE, true), (21, FILE, false), (20, "bad", false)] {
            fs::write(
                dir.path().join("20.json"),
                serde_json::json!({"pid":pid,"sessionId":id}).to_string(),
            )
            .unwrap();
            assert_eq!(session_file(dir.path(), 20).is_some(), accepted);
        }
    }
    #[tokio::test]
    async fn fallback_retries_and_final_call() {
        let mut attempts = 0;
        assert_eq!(
            retry_find_session(
                || {
                    attempts += 1;
                    (attempts == 2).then(|| FILE.into())
                },
                Duration::from_millis(1)
            )
            .await
            .as_deref(),
            Some(FILE)
        );
        assert_eq!(attempts, 2);
        assert_eq!(
            retry_find_session(|| Some(ARGV.into()), Duration::ZERO)
                .await
                .as_deref(),
            Some(ARGV)
        );
    }
}
