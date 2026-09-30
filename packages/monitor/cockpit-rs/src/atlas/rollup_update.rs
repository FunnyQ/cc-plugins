// `cockpit atlas rollup-update`: tail-parses only the bytes appended to each transcript since the last
// run, dedups billing through seen_requests, and adds token totals into usage_hourly. A truncation
// replays every transcript with the existing dedup keys, so already-billed history survives.

use super::dedup::{
    self, BilledTokens, DedupEntry, DedupMessage, DedupUsage, add_billed_tokens,
    count_claude_tool_calls, dedup_key, hour_start_ms, usage_token_total,
};
use super::jsonl::{JsonlLinesOptions, read_jsonl_lines};
use super::paths;
use super::rollup_db::{
    self, HourlyRow, IngestedFile, LEDGER_REBUILD_PENDING, LedgerFileRow, LedgerModelRow,
};
use indexmap::IndexMap;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub files_scanned: usize,
    pub rebuilt: bool,
}

pub struct UpdateOptions {
    pub rebuild: bool,
}

#[derive(Default)]
struct ParsedSlice {
    rows: IndexMap<(i64, String, String), HourlyRow>,
    request_keys: Vec<String>,
    ledger: IndexMap<String, LedgerFileRow>,
    ledger_models: IndexMap<(String, String), LedgerModelRow>,
    tool_keys: Vec<(String, String)>,
}

struct IngestContext {
    now_ms: i64,
    /// Files whose ledger rows are being re-derived from scratch this run.
    ledger_rebuild: HashSet<String>,
    /// Cross-file dedup, valid only across the files in `ledger_rebuild`.
    ledger_seen: HashSet<String>,
}

// JS truthiness, for the TS `!x` / `x &&` checks on untyped transcript fields.
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn str_field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?.get(key)?.as_str()
}

// JS Date.parse: an offset or Z is absolute, a bare date-time is local, a bare date is UTC.
fn parse_timestamp_ms(raw: &str) -> i64 {
    if let Ok(ts) = raw.parse::<jiff::Timestamp>() {
        return ts.as_millisecond();
    }
    if raw.contains('T')
        && let Ok(dt) = raw.parse::<jiff::civil::DateTime>()
    {
        return dt
            .to_zoned(jiff::tz::TimeZone::system())
            .map_or(0, |z| z.timestamp().as_millisecond());
    }
    if let Ok(date) = raw.parse::<jiff::civil::Date>() {
        return date
            .to_zoned(jiff::tz::TimeZone::UTC)
            .map_or(0, |z| z.timestamp().as_millisecond());
    }
    0
}

fn billed(usage: &DedupUsage) -> BilledTokens {
    let mut out = BilledTokens::default();
    add_billed_tokens(&mut out, usage);
    out
}

// `ledger_duplicate` is a second gate, separate from seen_requests: a file whose ledger rows
// were just cleared must ignore seen_requests to re-derive them, while every other read honours
// it — including the first read of a brand-new file, whose requests a sibling may already hold.
fn parse_slice(
    db: &Connection,
    lines: impl Iterator<Item = String>,
    file: &str,
    ledger_rebuild: bool,
    ledger_seen: &mut HashSet<String>,
) -> rusqlite::Result<ParsedSlice> {
    let mut out = ParsedSlice::default();
    let mut seen_run: HashSet<String> = HashSet::new();
    let mut tool_seen_run: HashSet<String> = HashSet::new();
    let fallback_session = file.rsplit('/').next().unwrap_or(file);

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry = Some(&entry);
        let message = entry.and_then(|e| e.get("message"));

        // Every line feeds the ledger, not just billed assistant turns.
        let session_key = str_field(entry, "sessionId")
            .unwrap_or(fallback_session)
            .to_string();
        let timestamp_ms = str_field(entry, "timestamp")
            .filter(|t| !t.is_empty())
            .map_or(0, parse_timestamp_ms);
        let cwd = str_field(entry, "cwd");
        let kind = str_field(entry, "type");
        let row = out
            .ledger
            .entry(session_key.clone())
            .or_insert_with(|| LedgerFileRow {
                path: file.to_string(),
                session_key: session_key.clone(),
                ..Default::default()
            });
        if timestamp_ms > row.last_ts_ms {
            row.last_ts_ms = timestamp_ms;
        }
        // Earliest cwd wins within this file; add_ledger_row's upsert applies it across files.
        if let Some(cwd) = cwd.filter(|c| !c.is_empty())
            && (row.project.is_empty()
                || (timestamp_ms > 0
                    && (row.project_ts_ms == 0 || timestamp_ms < row.project_ts_ms)))
        {
            row.project = cwd.to_string();
            row.project_ts_ms = timestamp_ms;
        }
        if kind == Some("user") && !truthy(entry.and_then(|e| e.get("isMeta"))) {
            row.interactions += 1;
        }
        let content = message.and_then(|m| m.get("content"));
        let tool_calls = count_claude_tool_calls(content.unwrap_or(&Value::Null));
        if tool_calls > 0 {
            let tool_key = str_field(message, "id")
                .or_else(|| str_field(entry, "uuid"))
                .map_or_else(|| format!("{file}:{timestamp_ms}"), str::to_string);
            // In-run set first — the table is only written at the end of the slice.
            let seen = !tool_seen_run.insert(format!("{session_key}\0{tool_key}"))
                || rollup_db::has_seen_tool_call(db, &session_key, &tool_key)?;
            if !seen {
                row.tool_calls += tool_calls;
                out.tool_keys.push((session_key.clone(), tool_key));
            }
        }

        let Some(model) = str_field(message, "model").filter(|m| !m.is_empty()) else {
            continue;
        };
        let Some(usage) = message.and_then(|m| m.get("usage")) else {
            continue;
        };
        if kind != Some("assistant") || !truthy(Some(usage)) {
            continue;
        }
        let usage = DedupUsage {
            input_tokens: usage.get("input_tokens").and_then(Value::as_i64),
            output_tokens: usage.get("output_tokens").and_then(Value::as_i64),
            cache_read_input_tokens: usage.get("cache_read_input_tokens").and_then(Value::as_i64),
            cache_creation_input_tokens: usage
                .get("cache_creation_input_tokens")
                .and_then(Value::as_i64),
        };
        if model == "<synthetic>" || usage_token_total(&usage) == 0 {
            continue;
        }

        let dedup_entry = DedupEntry {
            request_id: str_field(entry, "requestId").map(str::to_string),
            uuid: str_field(entry, "uuid").map(str::to_string),
            message: Some(DedupMessage {
                id: str_field(message, "id").map(str::to_string),
            }),
        };
        let key = dedup_key(&dedup_entry, file, seen_run.len());
        // First snapshot wins, exactly as the TS; the golden files record that choice.
        if !seen_run.insert(key.clone()) {
            continue;
        }
        let billed_before = rollup_db::has_seen_request(db, &key)?;
        let tokens = billed(&usage);

        // One request can sit in both a parent transcript and its subagent's, so a rebuild dedups
        // across files against its own set, not seen_requests.
        let ledger_duplicate = if ledger_rebuild {
            !ledger_seen.insert(key.clone())
        } else {
            billed_before
        };
        if !ledger_duplicate {
            let m = out
                .ledger_models
                .entry((session_key.clone(), model.to_string()))
                .or_insert_with(|| LedgerModelRow {
                    path: file.to_string(),
                    session_key: session_key.clone(),
                    model: model.to_string(),
                    ..Default::default()
                });
            m.input_tokens += tokens.input_tokens;
            m.output_tokens += tokens.output_tokens;
            m.cache_read += tokens.cache_read;
            m.cache_creation += tokens.cache_creation;
        }

        if billed_before {
            continue;
        }
        out.request_keys.push(key);

        let hour_ms = hour_start_ms(timestamp_ms);
        let project = cwd.unwrap_or("").to_string();
        let bucket = out
            .rows
            .entry((hour_ms, project.clone(), model.to_string()))
            .or_insert_with(|| HourlyRow {
                hour_ms,
                project,
                model: model.to_string(),
                ..Default::default()
            });
        bucket.input_tokens += tokens.input_tokens;
        bucket.output_tokens += tokens.output_tokens;
        bucket.cache_read += tokens.cache_read;
        bucket.cache_creation += tokens.cache_creation;
        bucket.message_count += 1;
    }
    Ok(out)
}

// Returns false when a truncation was detected and the caller must run a deduplicated replay.
fn ingest_file(db: &mut Connection, file: &str, ctx: &mut IngestContext) -> anyhow::Result<bool> {
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(true);
    };
    let size = meta.len() as i64;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64);

    let prior = rollup_db::get_ingested_file(db, file)?;
    let start = prior.as_ref().map_or(0, |p| p.bytes_parsed);
    if prior.is_some_and(|p| size < p.bytes_parsed) {
        return Ok(false);
    }

    // Not the same question as `start == 0`: a brand-new file also starts at zero, but its
    // requests may already sit in a sibling's ledger rows, so it stays gated on seen_requests.
    let ledger_rebuild = ctx.ledger_rebuild.contains(file);
    // Every exit drops the stale rows, not just the one that rewrites them — a transcript
    // truncated to empty never reaches the apply below.
    let drop_stale_ledger = |db: &mut Connection| -> rusqlite::Result<()> {
        if ledger_rebuild {
            let tx = db.transaction()?;
            rollup_db::clear_ledger_for_file(&tx, file)?;
            tx.commit()?;
        }
        Ok(())
    };

    if size <= start {
        drop_stale_ledger(db)?;
        return Ok(true);
    }

    // Streamed from `start`, never read whole: on a cold start the tail is the entire file.
    let mut lines = read_jsonl_lines(
        Path::new(file),
        JsonlLinesOptions {
            start: start as u64,
            emit_partial: false,
            ..Default::default()
        },
    );
    let slice = parse_slice(db, &mut lines, file, ledger_rebuild, &mut ctx.ledger_seen)?;
    let boundary = lines.bytes_consumed() as i64;

    if boundary <= start {
        // Grew, but no new complete line yet; an unreadable file lands here too.
        drop_stale_ledger(db)?;
        rollup_db::upsert_ingested_file(
            db,
            &IngestedFile {
                path: file.to_string(),
                bytes_parsed: start,
                mtime_ms,
            },
            ctx.now_ms,
        )?;
        return Ok(true);
    }

    let tx = db.transaction()?;
    for row in slice.rows.values() {
        rollup_db::add_hourly_row(&tx, row)?;
    }
    for key in &slice.request_keys {
        rollup_db::mark_seen_request(&tx, key, file)?;
    }
    // Without the clear, a rebuild would double interactions and tool_calls.
    if ledger_rebuild {
        rollup_db::clear_ledger_for_file(&tx, file)?;
    }
    for row in slice.ledger.values() {
        rollup_db::add_ledger_row(&tx, row)?;
    }
    for row in slice.ledger_models.values() {
        rollup_db::add_ledger_model_row(&tx, row)?;
    }
    for (session_key, key) in &slice.tool_keys {
        rollup_db::mark_seen_tool_call(&tx, session_key, key)?;
    }
    rollup_db::upsert_ingested_file(
        &tx,
        &IngestedFile {
            path: file.to_string(),
            bytes_parsed: boundary,
            mtime_ms,
        },
        ctx.now_ms,
    )?;
    tx.commit()?;
    Ok(true)
}

fn rewind(db: &mut Connection) -> rusqlite::Result<()> {
    let tx = db.transaction()?;
    rollup_db::rewind_rollup(&tx)?;
    tx.commit()
}

pub fn update_rollup(
    db: &mut Connection,
    projects_dir: &Path,
    opts: UpdateOptions,
) -> anyhow::Result<UpdateResult> {
    let mut walked: Vec<PathBuf> = Vec::new();
    dedup::walk_files(projects_dir, ".jsonl", &mut walked);
    let files: Vec<String> = walked
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect();

    // Prune before ingesting: a departing file can take counts its session's surviving files
    // still provide, and those survivors must be re-derived in this same run.
    let mut ledger_rebuild = prune_missing_files(db, &files)?;

    let mut rebuilt = false;
    if opts.rebuild {
        rewind(db)?;
        rebuilt = true;
        ledger_rebuild.extend(files.iter().cloned());
    } else if rollup_db::get_meta(db, LEDGER_REBUILD_PENDING)?.as_deref() == Some("1") {
        // A migration already rewound the cursors; it could not mark the files.
        rebuilt = true;
        ledger_rebuild.extend(files.iter().cloned());
    }

    // Real clock: the TS stamps updated_at with Date.now(), which TOKEN_ATLAS_NOW_MS never pins.
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    let mut ctx = IngestContext {
        now_ms,
        ledger_rebuild,
        ledger_seen: HashSet::new(),
    };
    for file in &files {
        if ingest_file(db, file, &mut ctx)? {
            continue;
        }
        rewind(db)?;
        rebuilt = true;
        ctx.ledger_rebuild.extend(files.iter().cloned());
        ctx.ledger_seen.clear();
        for f in &files {
            ingest_file(db, f, &mut ctx)?;
        }
        break;
    }

    rollup_db::set_meta(db, LEDGER_REBUILD_PENDING, "0")?;
    Ok(UpdateResult {
        files_scanned: files.len(),
        rebuilt,
    })
}

// Survivors are re-derived because cross-file dedup credited shared counts to whichever file was
// read first, and a survivor's unmoved cursor would never re-add them.
fn prune_missing_files(db: &mut Connection, files: &[String]) -> anyhow::Result<HashSet<String>> {
    let present: HashSet<&str> = files.iter().map(String::as_str).collect();
    let known: Vec<String> = db
        .prepare("SELECT path FROM ingested_files")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<_>>()?;
    let missing: Vec<String> = known
        .into_iter()
        .filter(|p| !present.contains(p.as_str()))
        .collect();
    if missing.is_empty() {
        return Ok(HashSet::new());
    }

    let mut sessions_by_path: Vec<Vec<String>> = Vec::with_capacity(missing.len());
    let mut disturbed: HashSet<String> = HashSet::new();
    {
        let mut sessions_of =
            db.prepare("SELECT DISTINCT session_key FROM session_ledger WHERE path = ?")?;
        for path in &missing {
            let keys: Vec<String> = sessions_of
                .query_map([path], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            disturbed.extend(keys.iter().cloned());
            sessions_by_path.push(keys);
        }
    }

    let tx = db.transaction()?;
    for path in &missing {
        rollup_db::clear_ingested_file(&tx, path)?;
        rollup_db::clear_ledger_for_file(&tx, path)?;
    }
    tx.commit()?;

    let mut survivors: HashSet<String> = HashSet::new();
    let mut living: HashSet<String> = HashSet::new();
    {
        let mut files_of =
            db.prepare("SELECT DISTINCT path FROM session_ledger WHERE session_key = ?")?;
        for session in &disturbed {
            let paths: Vec<String> = files_of
                .query_map([session], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<_>>()?;
            if paths.is_empty() {
                continue;
            }
            living.insert(session.clone());
            survivors.extend(paths);
        }
    }

    let tx = db.transaction()?;
    // A departing file's billing keys go only once nothing else holds them: dropping them while a
    // sibling still carries the request would let the rewind bill usage_hourly a second time.
    for (path, sessions) in missing.iter().zip(&sessions_by_path) {
        if !sessions.iter().any(|k| living.contains(k)) {
            rollup_db::clear_seen_requests_for_file(&tx, path)?;
        }
    }
    for session in &living {
        tx.execute(
            "DELETE FROM seen_tool_calls WHERE session_key = ?",
            [session],
        )?;
    }
    for path in &survivors {
        rollup_db::clear_ledger_for_file(&tx, path)?;
        tx.execute(
            "UPDATE ingested_files SET bytes_parsed = 0 WHERE path = ?",
            [path],
        )?;
    }
    tx.commit()?;

    // After the ledger rows go, so a fully-deleted session drops its tool keys too.
    rollup_db::prune_seen_tool_calls(db)?;
    Ok(survivors)
}

// Bun on macOS links the system SQLite, which keeps -wal/-shm after close; without them a
// read-only reader (the golden dump, `sqlite3 -readonly`) cannot open a WAL database at all.
fn persist_wal(db: &Connection) {
    let mut on: std::ffi::c_int = 1;
    // SAFETY: the handle is live for `db`'s lifetime, and this opcode reads one c_int.
    unsafe {
        rusqlite::ffi::sqlite3_file_control(
            db.handle(),
            c"main".as_ptr(),
            rusqlite::ffi::SQLITE_FCNTL_PERSIST_WAL,
            (&raw mut on).cast(),
        );
    }
}

// A refused version drops open_rollup_db's connection before persist_wal can reach it, so an
// existing DB stays held open here to keep that close from being the last one.
fn hold_wal(path: &Path) -> Option<Connection> {
    let conn =
        Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).ok()?;
    persist_wal(&conn);
    conn.query_row("PRAGMA schema_version", [], |_| Ok(()))
        .ok()?;
    Some(conn)
}

fn run_update(db_path: &Path, rebuild: bool) -> anyhow::Result<String> {
    // Declared first so it drops last.
    let _holder = hold_wal(db_path);
    let mut db = rollup_db::open_rollup_db(db_path)?;
    persist_wal(&db);
    let result = update_rollup(&mut db, &paths::projects_dir(), UpdateOptions { rebuild })?;
    let rows: i64 = db.query_row("SELECT COUNT(*) FROM usage_hourly", [], |r| r.get(0))?;
    let mut out = serde_json::to_value(result)?;
    if let Value::Object(map) = &mut out {
        map.insert("usageHourlyRows".into(), rows.into());
    }
    Ok(serde_json::to_string_pretty(&out)?)
}

pub fn run(args: &[String]) -> ExitCode {
    let rebuild = args.iter().any(|a| a == "--rebuild");
    // A trailing `--db` with no value falls back to the default, as `args[i + 1]` does in TS.
    let db_path = args
        .iter()
        .position(|a| a == "--db")
        .and_then(|i| args.get(i + 1))
        .map_or_else(paths::rollup_db_path, PathBuf::from);
    match run_update(&db_path, rebuild) {
        Ok(text) => {
            println!("{text}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("{err:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;
    use serde_json::json;
    use std::io::Write;

    struct Fixture {
        dir: tempfile::TempDir,
        db: Connection,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(dir.path().join("projects")).unwrap();
            let db = rollup_db::open_rollup_db(&dir.path().join("rollup.db")).unwrap();
            Fixture { dir, db }
        }

        fn path(&self, rel: &str) -> PathBuf {
            self.dir.path().join("projects").join(rel)
        }

        fn write(&self, rel: &str, lines: &[Value]) -> String {
            let path = self.path(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, body(lines)).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn update(&mut self, rebuild: bool) -> UpdateResult {
            let projects = self.dir.path().join("projects");
            update_rollup(&mut self.db, &projects, UpdateOptions { rebuild }).unwrap()
        }

        fn hourly(&self) -> Vec<HourlyRow> {
            let mut rows = rollup_db::all_hourly_rows(&self.db).unwrap();
            rows.sort_by(|a, b| {
                (a.hour_ms, &a.project, &a.model).cmp(&(b.hour_ms, &b.project, &b.model))
            });
            rows
        }

        fn ledger(&self) -> Vec<LedgerFileRow> {
            let mut rows = rollup_db::all_ledger_rows(&self.db).unwrap();
            rows.sort_by(|a, b| (&a.path, &a.session_key).cmp(&(&b.path, &b.session_key)));
            rows
        }

        fn models(&self) -> Vec<LedgerModelRow> {
            let mut rows = rollup_db::all_ledger_model_rows(&self.db).unwrap();
            rows.sort_by(|a, b| {
                (&a.path, &a.session_key, &a.model).cmp(&(&b.path, &b.session_key, &b.model))
            });
            rows
        }

        fn tool_calls(&self, session: &str) -> i64 {
            self.ledger()
                .iter()
                .filter(|r| r.session_key == session)
                .map(|r| r.tool_calls)
                .sum()
        }

        fn bytes_parsed(&self, path: &str) -> i64 {
            rollup_db::get_ingested_file(&self.db, path)
                .unwrap()
                .unwrap()
                .bytes_parsed
        }

        fn seen_tool_sessions(&self) -> Vec<String> {
            self.db
                .prepare("SELECT DISTINCT session_key FROM seen_tool_calls ORDER BY 1")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        }
    }

    fn body(lines: &[Value]) -> String {
        lines.iter().map(|l| format!("{l}\n")).collect()
    }

    fn assistant(
        session: &str,
        req: &str,
        msg: &str,
        minute: u32,
        input: i64,
        tool: bool,
    ) -> Value {
        let content = if tool {
            json!([{"type": "tool_use", "id": format!("tu_{msg}")}])
        } else {
            json!([{"type": "text", "text": "x"}])
        };
        json!({
            "type": "assistant",
            "sessionId": session,
            "requestId": req,
            "uuid": format!("u_{req}_{minute}"),
            "timestamp": format!("2026-09-28T15:{minute:02}:00.000Z"),
            "cwd": "/work/proj",
            "message": {
                "id": msg,
                "model": "claude-opus-4-7",
                "usage": {"input_tokens": input, "output_tokens": 2},
                "content": content,
            },
        })
    }

    fn user(session: &str, minute: u32) -> Value {
        json!({
            "type": "user",
            "sessionId": session,
            "timestamp": format!("2026-09-28T15:{minute:02}:00.000Z"),
            "cwd": "/work/proj",
            "message": {"content": "hi"},
        })
    }

    fn model_input(f: &Fixture, path: &str) -> i64 {
        f.models()
            .iter()
            .filter(|r| r.path == path)
            .map(|r| r.input_tokens)
            .sum()
    }

    #[test]
    fn timestamps_parse_like_js_date_parse() {
        // Expected values from `bun -e 'Date.parse(s)'`.
        assert_eq!(
            parse_timestamp_ms("2026-09-28T15:10:00.000Z"),
            1790608200000
        );
        assert_eq!(
            parse_timestamp_ms("2026-09-28T23:10:00+08:00"),
            1790608200000
        );
        assert_eq!(
            parse_timestamp_ms("2026-09-28T15:10:00.123456Z"),
            1790608200123
        );
        assert_eq!(parse_timestamp_ms("2026-09-28"), 1790553600000);
        assert_eq!(parse_timestamp_ms("1969-12-31T23:59:59.999Z"), -1);
        assert_eq!(parse_timestamp_ms("nope"), 0);
    }

    #[test]
    fn repeated_snapshots_bill_the_first_occurrence() {
        let mut f = Fixture::new();
        let path = f.write(
            "p/s.jsonl",
            &[
                assistant("S", "r1", "m1", 10, 10, false),
                assistant("S", "r1", "m1", 11, 99, false),
            ],
        );
        f.update(false);
        let hourly = f.hourly();
        assert_eq!(hourly.len(), 1);
        assert_eq!((hourly[0].input_tokens, hourly[0].message_count), (10, 1));
        assert_eq!(model_input(&f, &path), 10);
    }

    #[test]
    fn rebuild_rederives_ledger_and_leaves_hourly() {
        let mut f = Fixture::new();
        f.write(
            "p/S.jsonl",
            &[user("S", 1), assistant("S", "rA", "mA", 2, 5, true)],
        );
        f.write(
            "p/S/subagents/agent.jsonl",
            &[
                assistant("S", "rA", "mA", 2, 5, true),
                assistant("S", "rB", "mB", 3, 7, false),
            ],
        );
        f.write(
            "q/T.jsonl",
            &[user("T", 4), assistant("T", "rC", "mC", 5, 11, true)],
        );
        f.update(false);
        let (hourly, ledger, models) = (f.hourly(), f.ledger(), f.models());

        // A fresh DB over the same transcripts, so paths match row for row.
        let mut fresh = Fixture::new();
        let projects = f.dir.path().join("projects");
        update_rollup(&mut fresh.db, &projects, UpdateOptions { rebuild: false }).unwrap();

        let result = f.update(true);
        assert!(result.rebuilt);
        assert_eq!(result.files_scanned, 3);
        assert_eq!(f.hourly(), hourly);
        assert_eq!(f.ledger(), ledger);
        assert_eq!(f.models(), models);
        assert_eq!(fresh.ledger(), ledger);
        assert_eq!(fresh.models(), models);
        assert_eq!(f.tool_calls("S"), 1);
    }

    #[test]
    fn pending_migration_replays_rewound_file() {
        let mut f = Fixture::new();
        let path = f.write(
            "p/S.jsonl",
            &[user("S", 1), assistant("S", "rA", "mA", 2, 5, true)],
        );
        f.update(false);
        let (hourly, ledger, models) = (f.hourly(), f.ledger(), f.models());
        rollup_db::rewind_rollup(&f.db).unwrap();
        rollup_db::set_meta(&f.db, LEDGER_REBUILD_PENDING, "1").unwrap();

        assert!(f.update(false).rebuilt);
        assert_eq!(
            (f.hourly(), f.ledger(), f.models()),
            (hourly, ledger, models)
        );
        assert_eq!(
            rollup_db::get_meta(&f.db, LEDGER_REBUILD_PENDING)
                .unwrap()
                .as_deref(),
            Some("0")
        );
        assert!(f.bytes_parsed(&path) > 0);
    }

    #[test]
    fn shrink_below_cursor_rewinds_everything() {
        let mut f = Fixture::new();
        let first = assistant("S", "r1", "m1", 1, 5, false);
        let path = f.write(
            "p/S.jsonl",
            &[first.clone(), assistant("S", "r2", "m2", 2, 7, false)],
        );
        f.update(false);
        let hourly = f.hourly();

        let shrunk = [first];
        f.write("p/S.jsonl", &shrunk);
        let result = f.update(false);
        assert!(result.rebuilt);
        assert_eq!(f.hourly(), hourly);
        assert_eq!(f.bytes_parsed(&path), body(&shrunk).len() as i64);
        assert_eq!(model_input(&f, &path), 5);

        f.write("p/S.jsonl", &[]);
        assert!(f.update(false).rebuilt);
        assert!(
            f.ledger().is_empty(),
            "a transcript truncated to empty keeps no ledger row"
        );
        assert_eq!(f.hourly(), hourly);
    }

    #[test]
    fn tool_calls_dedup_per_session_across_files() {
        let mut f = Fixture::new();
        f.write("p/S.jsonl", &[assistant("S", "r1", "tool1", 1, 5, true)]);
        f.write(
            "p/S/subagents/agent.jsonl",
            &[assistant("S", "r9", "tool1", 1, 5, true)],
        );
        f.write("q/T.jsonl", &[assistant("T", "r2", "tool1", 1, 5, true)]);
        f.update(false);
        assert_eq!(f.tool_calls("S"), 1);
        assert_eq!(f.tool_calls("T"), 1);
        assert_eq!(f.seen_tool_sessions(), ["S", "T"]);
    }

    #[test]
    fn deleted_transcript_keeps_tokens_and_sibling_held_requests() {
        let mut f = Fixture::new();
        let parent = f.write(
            "p/S.jsonl",
            &[user("S", 1), assistant("S", "rA", "mA", 2, 5, true)],
        );
        let sibling = f.write(
            "p/S/subagents/agent.jsonl",
            &[
                assistant("S", "rA", "mA", 2, 5, true),
                assistant("S", "rB", "mB", 3, 7, false),
            ],
        );
        let lone = f.write("q/U.jsonl", &[assistant("U", "rC", "mC", 4, 11, true)]);
        f.update(false);
        let hourly = f.hourly();

        std::fs::remove_file(&parent).unwrap();
        f.update(false);
        assert_eq!(f.hourly(), hourly);
        assert!(f.ledger().iter().all(|r| r.path != parent));
        assert!(f.models().iter().all(|r| r.path != parent));
        assert!(rollup_db::has_seen_request(&f.db, "rA:mA").unwrap());
        // The survivor now carries the shared request its departed sibling had been credited with.
        assert_eq!(model_input(&f, &sibling), 12);
        assert_eq!(f.tool_calls("S"), 1);

        std::fs::remove_file(&lone).unwrap();
        f.update(false);
        assert_eq!(f.hourly(), hourly);
        assert!(!rollup_db::has_seen_request(&f.db, "rC:mC").unwrap());
        assert_eq!(f.seen_tool_sessions(), ["S"]);
    }

    #[test]
    fn partial_trailing_line_waits_for_its_newline() {
        let mut f = Fixture::new();
        let complete = format!("{}\n", assistant("S", "r1", "m1", 1, 5, false));
        let pending = assistant("S", "r2", "m2", 2, 7, false).to_string();
        let path = f.path("p/S.jsonl");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, format!("{complete}{}", &pending[..20])).unwrap();
        let file = path.to_string_lossy().into_owned();

        f.update(false);
        assert_eq!(f.bytes_parsed(&file), complete.len() as i64);
        assert_eq!(f.hourly()[0].message_count, 1);

        let mut handle = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(handle, "{}", &pending[20..]).unwrap();
        drop(handle);
        f.update(false);
        assert_eq!(
            f.bytes_parsed(&file),
            std::fs::metadata(&path).unwrap().len() as i64
        );
        assert_eq!(f.hourly().iter().map(|r| r.input_tokens).sum::<i64>(), 12);
    }

    #[test]
    fn updated_at_reads_the_wall_clock_and_cli_json_keeps_key_order() {
        let env = TestEnv::new();
        TestEnv::set("TOKEN_ATLAS_NOW_MS", "1000");
        let projects = env.dir.path().join("projects");
        std::fs::create_dir_all(projects.join("p")).unwrap();
        std::fs::write(
            projects.join("p/S.jsonl"),
            body(&[assistant("S", "r1", "m1", 1, 5, false)]),
        )
        .unwrap();
        TestEnv::set("TOKEN_ATLAS_PROJECTS_DIR", &projects);
        let db_path = env.dir.path().join("rollup.db");

        let out = run_update(&db_path, true).unwrap();
        let keys: Vec<String> = serde_json::from_str::<serde_json::Map<String, Value>>(&out)
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["filesScanned", "rebuilt", "usageHourlyRows"]);
        assert!(out.contains("\"rebuilt\": true"));

        let db = Connection::open(&db_path).unwrap();
        let updated_at: i64 = db
            .query_row("SELECT updated_at FROM ingested_files", [], |r| r.get(0))
            .unwrap();
        let wall = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            (wall - updated_at).abs() < 10_000,
            "updated_at {updated_at} vs wall {wall}"
        );
    }
}
