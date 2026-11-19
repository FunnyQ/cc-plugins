use super::codex::{
    CodexSessionSummary, IndexRow, Summaries, Thread, collect_threads, discover_files,
    discover_threads, read_codex_session, read_thread_rows, thread_times, usage_rank,
};
use super::model::now_ms;
use super::paths;
use super::rollup_db::open_rollup_db;
use anyhow::Context;
use indexmap::IndexMap;
use rusqlite::{Connection, OpenFlags, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::process::ExitCode;

const DAY_MS: f64 = 86_400_000.0;
const USAGE: &str =
    "usage: cockpit atlas codex-archive (--older-than <days> | --thread <id>...) [--dry-run]";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArchivedThread {
    pub(super) index: Option<IndexRow>,
    pub(super) session: CodexSessionSummary,
}

pub(super) fn read_archive(db: &Connection) -> anyhow::Result<IndexMap<String, ArchivedThread>> {
    let present: bool = db.query_row(
        "SELECT count(*) > 0 FROM sqlite_master WHERE type = 'table' AND name = 'codex_thread_archive'",
        [],
        |row| row.get(0),
    )?;
    if !present {
        return Ok(IndexMap::new());
    }
    let mut stmt =
        db.prepare("SELECT thread_id, record FROM codex_thread_archive ORDER BY thread_id")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out = IndexMap::new();
    for row in rows {
        let (id, record) = row?;
        let record: ArchivedThread = serde_json::from_str(&record)
            .with_context(|| format!("codex archive row {id} is not a usage record"))?;
        out.insert(id, record);
    }
    Ok(out)
}

fn read_archive_at(path: &Path) -> anyhow::Result<IndexMap<String, ArchivedThread>> {
    if !path.exists() {
        return Ok(IndexMap::new());
    }
    let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .with_context(|| format!("opening {}", path.display()))?;
    read_archive(&db)
}

fn upsert(db: &mut Connection, writes: &[Write], now: i64) -> anyhow::Result<()> {
    if writes.is_empty() {
        return Ok(());
    }
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    {
        let mut upsert = tx.prepare(
            "INSERT INTO codex_thread_archive (thread_id, record, input_tokens, cached_input_tokens,
               output_tokens, reasoning_output_tokens, source_path, source_size, source_mtime_ms,
               captured_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(thread_id) DO UPDATE SET
               record = excluded.record,
               input_tokens = excluded.input_tokens,
               cached_input_tokens = excluded.cached_input_tokens,
               output_tokens = excluded.output_tokens,
               reasoning_output_tokens = excluded.reasoning_output_tokens,
               source_path = excluded.source_path,
               source_size = excluded.source_size,
               source_mtime_ms = excluded.source_mtime_ms,
               captured_at_ms = excluded.captured_at_ms",
        )?;
        for write in writes {
            let usage = write.record.session.token_usage.clone().unwrap_or_default();
            upsert.execute(params![
                write.id,
                serde_json::to_string(&write.record)?,
                usage.input_tokens.unwrap_or(0),
                usage.cached_input_tokens.unwrap_or(0),
                usage.output_tokens.unwrap_or(0),
                usage.reasoning_output_tokens.unwrap_or(0),
                write.source,
                write.stat.0,
                write.stat.1,
                now,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub(super) fn capture(
    db: &mut Connection,
    threads: &IndexMap<String, Thread>,
    now: i64,
) -> anyhow::Result<(IndexMap<String, ArchivedThread>, usize)> {
    let mut stored = read_archive(db)?;
    let stats: HashMap<String, Stat> = threads
        .values()
        .filter_map(|t| t.source.as_ref())
        .filter_map(|source| Some((source.clone(), stat(source)?)))
        .collect();
    let writes: Vec<Write> = threads
        .values()
        .filter_map(|t| classify(t, stored.get(&t.id), &HashSet::new(), &stats).2)
        .collect();
    upsert(db, &writes, now)?;
    for write in &writes {
        stored.insert(write.id.clone(), write.record.clone());
    }
    Ok((stored, writes.len()))
}

pub(crate) fn capture_live(db: &mut Connection) -> anyhow::Result<usize> {
    let (_, threads, _) = discover_threads();
    Ok(capture(db, &threads, now_ms())?.1)
}

type Stat = (i64, i64);

fn stat(path: &str) -> Option<Stat> {
    let meta = std::fs::metadata(path).ok()?;
    Some((
        meta.len() as i64,
        meta.mtime() * 1000 + meta.mtime_nsec() / 1_000_000,
    ))
}

fn read_cache_rows() -> HashMap<String, (Stat, String)> {
    let path = paths::codex_cache_path();
    let read = || -> rusqlite::Result<HashMap<String, (Stat, String)>> {
        let conn = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut stmt = conn.prepare("SELECT path, size, mtime_ms, summary FROM session_summary")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, ((row.get(1)?, row.get(2)?), row.get(3)?)))
        })?;
        rows.collect()
    };
    if path.exists() {
        read().unwrap_or_default()
    } else {
        HashMap::new()
    }
}

#[derive(Debug, Default)]
pub(super) struct Options {
    pub(super) dry_run: bool,
    pub(super) older_than_ms: Option<i64>,
    pub(super) threads: Vec<String>,
}

fn parse_args(args: &[String]) -> Option<Options> {
    let mut opts = Options::default();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--dry-run" => opts.dry_run = true,
            "--older-than" => {
                let days: f64 = rest.next()?.parse().ok().filter(|d: &f64| *d >= 0.0)?;
                opts.older_than_ms = Some((days * DAY_MS) as i64);
            }
            "--thread" => opts.threads.push(rest.next()?.clone()),
            _ => return None,
        }
    }
    (opts.older_than_ms.is_some() != !opts.threads.is_empty()).then_some(opts)
}

pub fn run(args: &[String]) -> ExitCode {
    let Some(opts) = parse_args(args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match archive(
        &opts,
        &paths::rollup_db_path(),
        now_ms(),
        read_codex_session,
    ) {
        Ok(report) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&report).expect("a Value always serializes")
            );
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("codex-archive: {err:#}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Archived,
    WouldArchive,
    Unchanged,
    Unstable,
    Incomplete,
    Unresolved,
}

struct Outcome {
    id: String,
    status: Status,
    reason: &'static str,
    paths: Vec<String>,
    session: Option<CodexSessionSummary>,
}

struct Write {
    id: String,
    record: ArchivedThread,
    source: String,
    stat: Stat,
}

fn classify(
    thread: &Thread,
    stored: Option<&ArchivedThread>,
    unstable: &HashSet<String>,
    stats: &HashMap<String, Stat>,
) -> (Status, &'static str, Option<Write>) {
    if thread.files.iter().any(|file| unstable.contains(file)) {
        return (Status::Unstable, "rollout changed while it was read", None);
    }
    let session_id = thread.session.as_ref().and_then(|s| s.id.as_deref());
    if thread.row_id.is_none() && session_id.is_none() {
        return (
            Status::Unresolved,
            "no thread id in the index or the rollout",
            None,
        );
    }
    if let (Some(row_id), Some(session_id)) = (thread.row_id.as_deref(), session_id)
        && row_id != session_id
    {
        return (Status::Unresolved, "index id and rollout id differ", None);
    }
    if thread_times(thread.index.as_ref(), thread.session.as_ref()).0 == 0 {
        return (Status::Unresolved, "no timestamp", None);
    }
    let (Some(session), Some(source)) = (
        thread.session.as_ref().filter(|s| s.token_usage.is_some()),
        thread.source.as_ref(),
    ) else {
        return match stored {
            Some(_) => (
                Status::Unchanged,
                "already archived; no readable usage live",
                None,
            ),
            None if thread.session.is_none() => (
                Status::Incomplete,
                "rollout missing or unreadable; only the index estimate remains",
                None,
            ),
            None => (Status::Incomplete, "rollout has no token_count usage", None),
        };
    };
    let Some(&stat) = stats.get(source) else {
        return (Status::Unstable, "rollout vanished while it was read", None);
    };
    let record = ArchivedThread {
        index: thread
            .index
            .clone()
            .or_else(|| stored.and_then(|s| s.index.clone())),
        session: session.clone(),
    };
    if let Some(stored) = stored {
        if usage_rank(Some(&stored.session)) > usage_rank(Some(session)) {
            return (Status::Unchanged, "archive already holds more usage", None);
        }
        if *stored == record {
            return (Status::Unchanged, "archive matches the rollout", None);
        }
    }
    let reason = if stored.is_some() {
        "usage grew since the last capture"
    } else {
        "new"
    };
    let write = Write {
        id: thread.id.clone(),
        record,
        source: source.clone(),
        stat,
    };
    (Status::Archived, reason, Some(write))
}

pub(super) fn archive(
    opts: &Options,
    archive_path: &Path,
    now: i64,
    read: impl Fn(&Path) -> Option<CodexSessionSummary>,
) -> anyhow::Result<Value> {
    let rows = read_thread_rows();
    let (files, _) = discover_files(&rows);
    let cache = read_cache_rows();
    let mut unstable = HashSet::new();
    let mut stats = HashMap::new();
    let mut summaries = Summaries::new();
    for file in &files {
        let before = stat(file);
        let cached = cache
            .get(file)
            .filter(|(stat, _)| Some(*stat) == before)
            .and_then(|(_, text)| serde_json::from_str::<Option<CodexSessionSummary>>(text).ok());
        let summary = cached.unwrap_or_else(|| read(Path::new(file)));
        let after = stat(file);
        if after != before {
            unstable.insert(file.clone());
        }
        if let Some(after) = after {
            stats.insert(file.clone(), after);
        }
        summaries.insert(file.clone(), summary);
    }
    let threads = collect_threads(&rows, &files, &summaries);
    let stored = read_archive_at(archive_path)?;

    let wanted = |id: &str| opts.threads.is_empty() || opts.threads.iter().any(|t| t == id);
    let old_enough = |updated_ms: i64| opts.older_than_ms.is_none_or(|age| updated_ms <= now - age);
    let mut outcomes = Vec::new();
    let mut writes = Vec::new();
    for thread in threads.values() {
        let (_, updated_ms) = thread_times(thread.index.as_ref(), thread.session.as_ref());
        let last_event_ms = thread
            .session
            .as_ref()
            .and_then(|s| s.token_events.last())
            .map_or(0, |event| event.timestamp_ms);
        if !wanted(&thread.id) || !old_enough(updated_ms.max(last_event_ms)) {
            continue;
        }
        let (mut status, reason, write) =
            classify(thread, stored.get(&thread.id), &unstable, &stats);
        if let Some(write) = write {
            if opts.dry_run {
                status = Status::WouldArchive;
            }
            writes.push(write);
        }
        outcomes.push(Outcome {
            id: thread.id.clone(),
            status,
            reason,
            paths: thread.files.clone(),
            session: thread.session.clone(),
        });
    }
    let mut seen: HashSet<String> = threads.keys().cloned().collect();
    for row in rows
        .iter()
        .filter(|row| row.rollout_path.as_deref().unwrap_or("").is_empty())
    {
        let Some(id) = row.id.as_deref().filter(|id| seen.insert((*id).to_owned())) else {
            continue;
        };
        let updated_ms = thread_times(Some(&row.index), None).1;
        if !wanted(id) || !old_enough(updated_ms) {
            continue;
        }
        let (status, reason) = if stored.contains_key(id) {
            (
                Status::Unchanged,
                "already archived; index row has no rollout",
            )
        } else {
            (
                Status::Incomplete,
                "index row has no rollout; only tokens_used remains",
            )
        };
        outcomes.push(Outcome {
            id: id.to_owned(),
            status,
            reason,
            paths: Vec::new(),
            session: None,
        });
    }
    for id in &opts.threads {
        if !seen.insert(id.clone()) {
            continue;
        }
        let (status, reason, session) = match stored.get(id) {
            Some(record) => (
                Status::Unchanged,
                "archived; no live source",
                Some(record.session.clone()),
            ),
            None => (Status::Unresolved, "unknown thread id", None),
        };
        outcomes.push(Outcome {
            id: id.clone(),
            status,
            reason,
            paths: Vec::new(),
            session,
        });
    }

    if !opts.dry_run && !writes.is_empty() {
        upsert(&mut open_rollup_db(archive_path)?, &writes, now)?;
    }

    let mut counts: IndexMap<Status, usize> = IndexMap::new();
    for outcome in &outcomes {
        *counts.entry(outcome.status).or_insert(0) += 1;
    }
    let verified = outcomes
        .iter()
        .filter(|o| matches!(o.status, Status::Archived | Status::Unchanged))
        .count();
    Ok(json!({
        "dryRun": opts.dry_run,
        "archive": archive_path.display().to_string(),
        "verified": verified,
        "counts": counts,
        "threads": outcomes.iter().map(|o| {
            let usage = o.session.as_ref().and_then(|s| s.token_usage.clone()).unwrap_or_default();
            json!({
                "threadId": o.id,
                "status": o.status,
                "reason": o.reason,
                "paths": o.paths,
                "inputTokens": usage.input_tokens.unwrap_or(0),
                "cachedInputTokens": usage.cached_input_tokens.unwrap_or(0),
                "outputTokens": usage.output_tokens.unwrap_or(0),
                "reasoningOutputTokens": usage.reasoning_output_tokens.unwrap_or(0),
            })
        }).collect::<Vec<_>>(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::codex::tests::{
        create_threads, ctx, insert_thread, rollout, totals, write_lines,
    };
    use crate::atlas::codex::{CodexSource, load};
    use crate::atlas::model::InternalLedgerRow;
    use crate::paths::tests::TestEnv;
    use std::path::PathBuf;

    const NOW: i64 = 1_790_870_400_000;

    struct Fx {
        env: TestEnv,
        t1: PathBuf,
        t2: PathBuf,
    }

    impl Fx {
        fn home(&self) -> &Path {
            self.env.dir.path()
        }
        fn state(&self) -> Connection {
            Connection::open(self.home().join(".codex/state_5.sqlite")).unwrap()
        }
        fn drop_row(&self, id: &str) {
            self.state()
                .execute("DELETE FROM threads WHERE id = ?", [id])
                .unwrap();
        }
    }

    fn fixture() -> Fx {
        let env = TestEnv::new();
        let sessions = env.dir.path().join(".codex/sessions/2026/09");
        let t1 = sessions.join("rollout-t1.jsonl");
        write_lines(
            &t1,
            &rollout(
                "t1",
                "/w/a",
                "gpt-rollout",
                "2026-09-27T10:00:00.000Z",
                &[
                    (
                        "2026-09-27T10:05:00.000Z",
                        json!(totals(8000, 5000, 900, 300)),
                    ),
                    (
                        "2026-09-27T11:20:00.000Z",
                        json!(totals(15000, 11000, 2100, 700)),
                    ),
                ],
            ),
        );
        let t2 = sessions.join("rollout-t2.jsonl");
        write_lines(
            &t2,
            &rollout(
                "t2",
                "/w/c",
                "gpt-mini",
                "2026-09-28T16:00:00.000Z",
                &[(
                    "2026-09-28T16:10:00.000Z",
                    json!(totals(4000, 1000, 500, 120)),
                )],
            ),
        );
        let db = create_threads(&env.dir.path().join(".codex/state_5.sqlite"));
        let (p1, p2) = (t1.to_string_lossy(), t2.to_string_lossy());
        insert_thread(
            &db,
            (
                "t1",
                &p1,
                1_790_503_200,
                1_790_508_000,
                "/w/a",
                Some("gpt-5.1-codex"),
                17100,
            ),
        );
        insert_thread(
            &db,
            ("t2", &p2, 1_790_611_200, 1_790_611_800, "/w/c", None, 4500),
        );
        insert_thread(
            &db,
            (
                "t3",
                "",
                1_790_300_000,
                0,
                "/w/b",
                Some("gpt-5.1-codex"),
                5000,
            ),
        );
        Fx { env, t1, t2 }
    }

    fn fx_home_rollout_without_row() -> String {
        let path = paths::codex_sessions_dir().join("2026/08/rollout-t5.jsonl");
        write_lines(
            &path,
            &rollout(
                "t5",
                "/w/e",
                "gpt-x",
                "2026-08-01T10:00:00.000Z",
                &[("2026-09-29T00:00:00.000Z", json!(totals(10, 0, 1, 0)))],
            ),
        );
        "t5".into()
    }

    fn opts(dry_run: bool) -> Options {
        Options {
            dry_run,
            older_than_ms: Some(0),
            threads: Vec::new(),
        }
    }

    fn run_at(opts: &Options, now: i64) -> Value {
        archive(opts, &paths::rollup_db_path(), now, read_codex_session).unwrap()
    }

    fn statuses(report: &Value) -> Vec<(String, String)> {
        report["threads"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                (
                    t["threadId"].as_str().unwrap().to_owned(),
                    t["status"].as_str().unwrap().to_owned(),
                )
            })
            .collect()
    }

    fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
        list.iter()
            .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
            .collect()
    }

    type View = (
        crate::atlas::model::ProviderUsage,
        IndexMap<String, crate::atlas::codex::CodexProjectActivity>,
        IndexMap<String, crate::atlas::codex::CodexDailyActivity>,
        [[i64; 24]; 7],
        IndexMap<String, [i64; 24]>,
        (usize, i64, i64),
        Vec<InternalLedgerRow>,
    );

    fn view(src: CodexSource) -> View {
        let mut ledger = src.ledger;
        ledger.sort_by(|a, b| a.id.cmp(&b.id));
        (
            src.usage,
            src.project_activity,
            src.daily_activity,
            src.week_hour_matrix,
            src.daily_hour_counts,
            (
                src.total_threads,
                src.total_interactions,
                src.total_tool_calls,
            ),
            ledger,
        )
    }

    fn report() -> View {
        view(load(&ctx()).unwrap())
    }

    fn cache_paths() -> Vec<String> {
        let db = Connection::open(paths::codex_cache_path()).unwrap();
        let mut stmt = db
            .prepare("SELECT path FROM session_summary ORDER BY path")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn report_survives_deleting_the_rollout_and_its_index_row() {
        let fx = fixture();
        let before = report();
        let rep = run_at(&opts(true), NOW);
        assert_eq!(
            statuses(&rep),
            pairs(&[
                ("t1", "unchanged"),
                ("t2", "unchanged"),
                ("t3", "incomplete")
            ])
        );
        assert_eq!(rep["verified"], json!(2));

        std::fs::remove_file(&fx.t1).unwrap();
        fx.drop_row("t1");
        std::fs::remove_file(&fx.t2).unwrap();
        assert_eq!(report(), before);
        assert!(!cache_paths().contains(&fx.t1.to_string_lossy().into_owned()));
        assert_eq!(report(), before);

        let t1 = before.6.iter().find(|row| row.id == "codex:t1").unwrap();
        assert_eq!(
            (t1.model.as_str(), t1.tokens),
            ("codex:gpt-5.1-codex", 17100)
        );
        let t2 = before.6.iter().find(|row| row.id == "codex:t2").unwrap();
        assert_eq!(t2.model, "codex:gpt-mini");
        assert_eq!(t2.cost_basis, crate::atlas::model::LedgerCostBasis::Usage);
    }

    #[test]
    fn dry_run_writes_nothing_and_a_rerun_writes_nothing_new() {
        let _fx = fixture();
        let dry = run_at(&opts(true), NOW);
        assert_eq!(
            statuses(&dry),
            pairs(&[
                ("t1", "would-archive"),
                ("t2", "would-archive"),
                ("t3", "incomplete")
            ])
        );
        assert!(!paths::rollup_db_path().exists());

        run_at(&opts(false), NOW);
        let rerun = run_at(&opts(false), NOW + 1);
        assert_eq!(
            statuses(&rerun),
            pairs(&[
                ("t1", "unchanged"),
                ("t2", "unchanged"),
                ("t3", "incomplete")
            ])
        );
        let db = Connection::open(paths::rollup_db_path()).unwrap();
        let stamps: Vec<i64> = db
            .prepare("SELECT captured_at_ms FROM codex_thread_archive")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(stamps, [NOW, NOW]);
    }

    #[test]
    fn scope_selects_by_age_and_by_thread_id() {
        let _fx = fixture();
        let day = DAY_MS as i64;
        let old = Options {
            dry_run: true,
            older_than_ms: Some(NOW - 1_790_510_000_000),
            threads: Vec::new(),
        };
        assert_eq!(
            statuses(&run_at(&old, NOW)),
            pairs(&[("t1", "would-archive"), ("t3", "incomplete")])
        );
        let named = Options {
            dry_run: true,
            older_than_ms: None,
            threads: vec!["t2".into(), "nope".into()],
        };
        let recent = fx_home_rollout_without_row();
        assert!(
            !statuses(&run_at(&opts(true), 1_790_600_000_000))
                .iter()
                .any(|(id, _)| id == &recent)
        );
        assert_eq!(
            statuses(&run_at(&named, NOW)),
            pairs(&[("t2", "would-archive"), ("nope", "unresolved")])
        );
        assert_eq!(
            parse_args(&["--older-than".into(), "2".into()])
                .unwrap()
                .older_than_ms,
            Some(2 * day)
        );
        assert!(parse_args(&["--dry-run".into()]).is_none());
        assert!(
            parse_args(&[
                "--older-than".into(),
                "1".into(),
                "--thread".into(),
                "t".into()
            ])
            .is_none()
        );
        assert!(parse_args(&["--older-than".into(), "-1".into()]).is_none());
    }

    #[test]
    fn a_valid_cache_row_is_reused_and_a_stale_one_reparsed() {
        let fx = fixture();
        report();
        let cache = Connection::open(paths::codex_cache_path()).unwrap();
        let key = fx.t1.to_string_lossy().into_owned();
        let mut summary: CodexSessionSummary = serde_json::from_str(
            &cache
                .query_row(
                    "SELECT summary FROM session_summary WHERE path = ?",
                    [&key],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
        )
        .unwrap();
        summary.token_usage = Some(totals(15001, 11000, 2100, 700));
        cache
            .execute(
                "UPDATE session_summary SET summary = ? WHERE path = ?",
                params![serde_json::to_string(&Some(&summary)).unwrap(), key],
            )
            .unwrap();
        let reused = run_at(&opts(false), NOW);
        assert_eq!(reused["threads"][0]["inputTokens"], json!(15001));

        let mut body = std::fs::read_to_string(&fx.t1).unwrap();
        body.push_str(&format!(
            "{}\n",
            json!({"timestamp": "2026-09-27T12:00:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": totals(20000, 12000, 3000, 900)}}})
        ));
        std::fs::write(&fx.t1, body).unwrap();
        let reparsed = run_at(&opts(false), NOW);
        assert_eq!(reparsed["threads"][0]["status"], json!("archived"));
        assert_eq!(reparsed["threads"][0]["inputTokens"], json!(20000));
    }

    #[test]
    fn a_rollout_restored_under_another_path_counts_once_with_its_index_fields() {
        let fx = fixture();
        let before = report();
        run_at(&opts(false), NOW);
        let restored = fx.home().join(".codex/sessions/restored/elsewhere.jsonl");
        std::fs::create_dir_all(restored.parent().unwrap()).unwrap();
        std::fs::rename(&fx.t1, &restored).unwrap();
        fx.drop_row("t1");
        assert_eq!(report(), before);

        let copy = fx.home().join(".codex/sessions/copy/t2-again.jsonl");
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::copy(&fx.t2, &copy).unwrap();
        assert_eq!(report(), before);
    }

    #[test]
    fn a_resumed_thread_reports_its_new_usage_and_rearchives() {
        let fx = fixture();
        run_at(&opts(false), NOW);
        let original = std::fs::read_to_string(&fx.t1).unwrap();
        let grown = format!(
            "{original}{}\n",
            json!({"timestamp": "2026-09-30T09:00:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": totals(20000, 12000, 3000, 900)}}})
        );
        std::fs::write(&fx.t1, &grown).unwrap();
        let live = report();
        assert_eq!(
            live.0.model_usage["codex:gpt-5.1-codex"].input_tokens,
            8000 + 5000
        );
        assert_eq!(live.6.iter().filter(|row| row.id == "codex:t1").count(), 1);

        let rep = run_at(&opts(true), NOW);
        assert_eq!(statuses(&rep)[0], ("t1".into(), "unchanged".into()));

        std::fs::write(&fx.t1, &original).unwrap();
        let smaller = run_at(&opts(false), NOW);
        assert_eq!(statuses(&smaller)[0], ("t1".into(), "unchanged".into()));
        assert_eq!(
            report().0.model_usage["codex:gpt-5.1-codex"].input_tokens,
            8000 + 5000
        );
    }

    #[test]
    fn a_usageless_rollout_found_away_from_its_indexed_path_keeps_its_counts() {
        let env = TestEnv::new();
        let db = create_threads(&env.dir.path().join(".codex/state_5.sqlite"));
        let gone = env.dir.path().join(".codex/sessions/gone.jsonl");
        insert_thread(
            &db,
            (
                "t6",
                &gone.to_string_lossy(),
                1_790_503_200,
                1_790_508_000,
                "",
                None,
                0,
            ),
        );
        write_lines(
            &env.dir.path().join(".codex/sessions/moved/t6.jsonl"),
            &rollout("t6", "/w/f", "gpt-y", "2026-09-27T10:00:00.000Z", &[]),
        );
        let src = load(&ctx()).unwrap();
        assert_eq!(src.ledger.len(), 1);
        assert_eq!(src.ledger[0].model, "codex:gpt-y");
        assert_eq!(src.ledger[0].project_path, "/w/f");
        assert_eq!(src.total_threads, 1);
    }

    #[test]
    fn unidentified_usageless_and_moving_rollouts_are_never_archived() {
        let fx = fixture();
        let sessions = fx.home().join(".codex/sessions/2026/10");
        write_lines(
            &sessions.join("no-id.jsonl"),
            &[
                json!({"timestamp": "2026-09-27T10:00:00.000Z", "type": "event_msg", "payload": {"type": "token_count", "info": {"total_token_usage": totals(1, 0, 1, 0)}}}),
            ],
        );
        write_lines(
            &sessions.join("no-usage.jsonl"),
            &rollout("t4", "/w/d", "gpt-x", "2026-09-27T10:00:00.000Z", &[]),
        );
        let rep = run_at(&opts(true), NOW);
        let got = statuses(&rep);
        assert!(got.contains(&("t4".into(), "incomplete".into())));
        assert!(got.iter().any(|(_, status)| status == "unresolved"));

        let touch = |path: &Path| {
            let mut body = std::fs::read_to_string(path).unwrap_or_default();
            body.push('\n');
            let _ = std::fs::write(path, body);
            read_codex_session(path)
        };
        let rep = archive(&opts(false), &paths::rollup_db_path(), NOW, touch).unwrap();
        let got = statuses(&rep);
        assert!(got.contains(&("t1".into(), "unstable".into())));
        assert!(got.contains(&("t2".into(), "unstable".into())));
        assert_eq!(rep["verified"], json!(0));
        assert!(!paths::rollup_db_path().exists());
    }
}
