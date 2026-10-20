use super::dedup::{
    self, BilledTokens, DedupEntry, DedupMessage, DedupUsage, add_billed_tokens,
    count_claude_tool_calls, dedup_key, hour_start_ms, usage_token_total,
};
use super::jsonl::{JsonlLinesOptions, read_jsonl_lines};
use super::model::js_date_parse;
use super::paths;
use super::rollup_db::{
    self, BILLING_CORRECTION_PENDING, BilledRequest, HourlyRow, IngestedFile,
    LEDGER_REBUILD_PENDING, LedgerFileRow, LedgerModelRow, Seen,
};
use crate::server::opencode::js_truthy;
use indexmap::IndexMap;
use rusqlite::{Connection, TransactionBehavior};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::UNIX_EPOCH;

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
    billed: Vec<(String, BilledRequest)>,
    ledger: IndexMap<String, LedgerFileRow>,
    ledger_models: IndexMap<(String, String), LedgerModelRow>,
    tool_keys: Vec<(String, String)>,
}

struct IngestContext {
    now_ms: i64,
    ledger_rebuild: HashSet<String>,
    ledger_seen: HashMap<String, BilledTokens>,
    legacy: Option<LegacyFix>,
}

// v3 billed a request's first snapshot. The fix bills up to each field's largest snapshot on
// disk across every file, which is what a fresh v4 ingest bills, so no later replay finds more to
// add. The baseline is the first snapshot in the file seen_requests recorded as the biller; a key
// whose file is gone stays legacy, because what it billed can no longer be read.
#[derive(Clone, Default)]
struct LegacyFix {
    owners: HashMap<String, String>,
    first: HashMap<String, BilledRequest>,
    largest: HashMap<String, BilledTokens>,
}

struct Request {
    session_key: String,
    first_tokens: BilledTokens,
    snapshot: BilledRequest,
}

fn str_field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value?.get(key)?.as_str()
}

fn timestamp_ms(entry: &Value) -> i64 {
    str_field(Some(entry), "timestamp")
        .filter(|t| !t.is_empty())
        .and_then(js_date_parse)
        .unwrap_or(0)
}

fn billable(entry: &Value) -> Option<(&str, BilledTokens)> {
    let message = entry.get("message");
    let model = str_field(message, "model").filter(|m| !m.is_empty())?;
    let usage = message?.get("usage")?;
    if str_field(Some(entry), "type") != Some("assistant") || !js_truthy(usage) {
        return None;
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
        return None;
    }
    let mut tokens = BilledTokens::default();
    add_billed_tokens(&mut tokens, &usage);
    Some((model, tokens))
}

fn request_key(entry: &Value, file: &str, seen_size: usize) -> String {
    let entry = Some(entry);
    dedup_key(
        &DedupEntry {
            request_id: str_field(entry, "requestId").map(str::to_string),
            uuid: str_field(entry, "uuid").map(str::to_string),
            message: Some(DedupMessage {
                id: str_field(entry.and_then(|e| e.get("message")), "id").map(str::to_string),
            }),
        },
        file,
        seen_size,
    )
}

fn max_into(target: &mut BilledTokens, other: &BilledTokens) {
    target.input_tokens = target.input_tokens.max(other.input_tokens);
    target.output_tokens = target.output_tokens.max(other.output_tokens);
    target.cache_read = target.cache_read.max(other.cache_read);
    target.cache_creation = target.cache_creation.max(other.cache_creation);
}

fn excess(snapshot: &BilledTokens, billed: &BilledTokens) -> BilledTokens {
    BilledTokens {
        input_tokens: (snapshot.input_tokens - billed.input_tokens).max(0),
        output_tokens: (snapshot.output_tokens - billed.output_tokens).max(0),
        cache_read: (snapshot.cache_read - billed.cache_read).max(0),
        cache_creation: (snapshot.cache_creation - billed.cache_creation).max(0),
    }
}

fn hourly_row(bucket: &BilledRequest, tokens: &BilledTokens, message_count: i64) -> HourlyRow {
    HourlyRow {
        hour_ms: bucket.hour_ms,
        project: bucket.project.clone(),
        model: bucket.model.clone(),
        input_tokens: tokens.input_tokens,
        output_tokens: tokens.output_tokens,
        cache_read: tokens.cache_read,
        cache_creation: tokens.cache_creation,
        reasoning: 0,
        message_count,
    }
}

fn parse_slice(
    db: &Connection,
    lines: impl Iterator<Item = String>,
    file: &str,
    ledger_rebuild: bool,
    ledger_seen: &mut HashMap<String, BilledTokens>,
    mut legacy: Option<&mut LegacyFix>,
) -> rusqlite::Result<ParsedSlice> {
    let mut out = ParsedSlice::default();
    let mut requests: IndexMap<String, Request> = IndexMap::new();
    let mut tool_seen_run: HashSet<String> = HashSet::new();
    let fallback_session = file.rsplit('/').next().unwrap_or(file);

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let entry = Some(&value);
        let message = entry.and_then(|e| e.get("message"));

        let session_key = str_field(entry, "sessionId")
            .unwrap_or(fallback_session)
            .to_string();
        let timestamp_ms = timestamp_ms(&value);
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
        if let Some(cwd) = cwd.filter(|c| !c.is_empty())
            && (row.project.is_empty()
                || (timestamp_ms > 0
                    && (row.project_ts_ms == 0 || timestamp_ms < row.project_ts_ms)))
        {
            row.project = cwd.to_string();
            row.project_ts_ms = timestamp_ms;
        }
        if kind == Some("user") && !entry.and_then(|e| e.get("isMeta")).is_some_and(js_truthy) {
            row.interactions += 1;
        }
        let content = message.and_then(|m| m.get("content"));
        let tool_calls = count_claude_tool_calls(content.unwrap_or(&Value::Null));
        if tool_calls > 0 {
            let tool_key = str_field(message, "id")
                .or_else(|| str_field(entry, "uuid"))
                .map_or_else(|| format!("{file}:{timestamp_ms}"), str::to_string);
            let seen = !tool_seen_run.insert(format!("{session_key}\0{tool_key}"))
                || rollup_db::has_seen_tool_call(db, &session_key, &tool_key)?;
            if !seen {
                row.tool_calls += tool_calls;
                out.tool_keys.push((session_key.clone(), tool_key));
            }
        }

        let Some((model, tokens)) = billable(&value) else {
            continue;
        };
        let key = request_key(&value, file, requests.len());
        // A request's snapshots fill in as it streams, so each field's largest is the bill; the
        // bucket stays on the first snapshot, where the request began.
        match requests.entry(key) {
            indexmap::map::Entry::Occupied(mut e) => {
                max_into(&mut e.get_mut().snapshot.tokens, &tokens);
            }
            indexmap::map::Entry::Vacant(e) => {
                e.insert(Request {
                    session_key: session_key.clone(),
                    first_tokens: tokens.clone(),
                    snapshot: BilledRequest {
                        tokens,
                        hour_ms: hour_start_ms(timestamp_ms),
                        project: cwd.unwrap_or("").to_string(),
                        model: model.to_string(),
                    },
                });
            }
        }
    }

    for (key, request) in requests {
        let seen = rollup_db::seen_request(db, &key)?;
        let tokens = &request.snapshot.tokens;
        let ledger_tokens = if ledger_rebuild {
            let run = ledger_seen.entry(key.clone()).or_default();
            let unbilled = excess(tokens, run);
            max_into(run, tokens);
            unbilled
        } else {
            match &seen {
                Seen::Unseen => tokens.clone(),
                Seen::Legacy => BilledTokens::default(),
                Seen::Billed(billed) => excess(tokens, &billed.tokens),
            }
        };
        if ledger_tokens != BilledTokens::default() {
            let m = out
                .ledger_models
                .entry((request.session_key.clone(), request.snapshot.model.clone()))
                .or_insert_with(|| LedgerModelRow {
                    path: file.to_string(),
                    session_key: request.session_key.clone(),
                    model: request.snapshot.model.clone(),
                    ..Default::default()
                });
            m.input_tokens += ledger_tokens.input_tokens;
            m.output_tokens += ledger_tokens.output_tokens;
            m.cache_read += ledger_tokens.cache_read;
            m.cache_creation += ledger_tokens.cache_creation;
        }

        let (billed, unbilled, messages) = match seen {
            Seen::Legacy => {
                if let Some(fix) = legacy.as_deref_mut()
                    && let Some(owned) = fix.owners.get(&key).map(|owner| owner == file)
                {
                    max_into(fix.largest.entry(key.clone()).or_default(), tokens);
                    if owned && !fix.first.contains_key(&key) {
                        fix.first.insert(
                            key,
                            BilledRequest {
                                tokens: request.first_tokens,
                                ..request.snapshot
                            },
                        );
                    }
                }
                continue;
            }
            Seen::Unseen => {
                let unbilled = request.snapshot.tokens.clone();
                (request.snapshot, unbilled, 1)
            }
            Seen::Billed(mut billed) => {
                let unbilled = excess(&request.snapshot.tokens, &billed.tokens);
                if unbilled == BilledTokens::default() {
                    continue;
                }
                max_into(&mut billed.tokens, &request.snapshot.tokens);
                (billed, unbilled, 0)
            }
        };
        let add = hourly_row(&billed, &unbilled, messages);
        let bucket = out
            .rows
            .entry((add.hour_ms, add.project.clone(), add.model.clone()))
            .or_insert_with(|| HourlyRow {
                hour_ms: add.hour_ms,
                project: add.project.clone(),
                model: add.model.clone(),
                ..Default::default()
            });
        bucket.input_tokens += add.input_tokens;
        bucket.output_tokens += add.output_tokens;
        bucket.cache_read += add.cache_read;
        bucket.cache_creation += add.cache_creation;
        bucket.message_count += add.message_count;
        out.billed.push((key, billed));
    }
    Ok(out)
}

// Immediate, so a second process replaying the same pending state waits here, then finds the
// flag cleared and every key already resolved instead of adding the same delta again.
fn apply_legacy_fix(db: &mut Connection, fix: LegacyFix) -> anyhow::Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if rollup_db::get_meta(&tx, BILLING_CORRECTION_PENDING)?.as_deref() != Some("1") {
        return Ok(());
    }
    for (key, mut billed) in fix.first {
        if rollup_db::seen_request(&tx, &key)? != Seen::Legacy {
            continue;
        }
        let largest = &fix.largest[&key];
        let unbilled = excess(largest, &billed.tokens);
        if unbilled != BilledTokens::default() {
            rollup_db::add_hourly_row(&tx, &hourly_row(&billed, &unbilled, 0))?;
        }
        max_into(&mut billed.tokens, largest);
        rollup_db::record_billed(&tx, &key, &fix.owners[&key], &billed)?;
    }
    rollup_db::set_meta(&tx, BILLING_CORRECTION_PENDING, "0")?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Ingest {
    Ingested,
    Truncated,
}

fn ingest_file(db: &mut Connection, file: &str, ctx: &mut IngestContext) -> anyhow::Result<Ingest> {
    let Ok(meta) = std::fs::metadata(file) else {
        return Ok(Ingest::Ingested);
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
        return Ok(Ingest::Truncated);
    }

    let ledger_rebuild = ctx.ledger_rebuild.contains(file);
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
        return Ok(Ingest::Ingested);
    }

    let mut lines = read_jsonl_lines(
        Path::new(file),
        JsonlLinesOptions {
            start: start as u64,
            emit_partial: false,
            ..Default::default()
        },
    );
    let slice = parse_slice(
        db,
        &mut lines,
        file,
        ledger_rebuild,
        &mut ctx.ledger_seen,
        ctx.legacy.as_mut(),
    )?;
    let boundary = lines.bytes_consumed() as i64;

    if boundary <= start {
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
        return Ok(Ingest::Ingested);
    }

    let tx = db.transaction()?;
    for row in slice.rows.values() {
        rollup_db::add_hourly_row(&tx, row)?;
    }
    for (key, billed) in &slice.billed {
        rollup_db::record_billed(&tx, key, file, billed)?;
    }
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
    Ok(Ingest::Ingested)
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

    // Read before the prune, which raises the flag for its own survivors' replay.
    let replay_pending = rollup_db::get_meta(db, LEDGER_REBUILD_PENDING)?.as_deref() == Some("1");
    let correction_pending =
        rollup_db::get_meta(db, BILLING_CORRECTION_PENDING)?.as_deref() == Some("1");
    let mut ledger_rebuild = prune_missing_files(db, &files)?;
    let legacy = if correction_pending {
        Some(LegacyFix {
            owners: rollup_db::legacy_requests(db)?.into_iter().collect(),
            ..Default::default()
        })
    } else {
        None
    };

    // A pending replay may have died after committing some files, so it restarts from byte 0:
    // resuming would find those files' cursors at their end and drop their ledger rows.
    let mut rebuilt = opts.rebuild || replay_pending || correction_pending;
    if rebuilt {
        rewind(db)?;
        ledger_rebuild.extend(files.iter().cloned());
    }

    let now_ms = jiff::Timestamp::now().as_millisecond();
    let mut ctx = IngestContext {
        now_ms,
        ledger_rebuild,
        ledger_seen: HashMap::new(),
        legacy,
    };
    for file in &files {
        if ingest_file(db, file, &mut ctx)? == Ingest::Ingested {
            continue;
        }
        rewind(db)?;
        rebuilt = true;
        ctx.ledger_rebuild.extend(files.iter().cloned());
        ctx.ledger_seen.clear();
        if let Some(fix) = &mut ctx.legacy {
            fix.first.clear();
            fix.largest.clear();
        }
        for f in &files {
            ingest_file(db, f, &mut ctx)?;
        }
        break;
    }

    if let Some(fix) = ctx.legacy.take() {
        apply_legacy_fix(db, fix)?;
    }
    rollup_db::set_meta(db, LEDGER_REBUILD_PENDING, "0")?;
    Ok(UpdateResult {
        files_scanned: files.len(),
        rebuilt,
    })
}

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
    if !survivors.is_empty() {
        rollup_db::set_meta(&tx, LEDGER_REBUILD_PENDING, "1")?;
    }
    for path in &survivors {
        rollup_db::clear_ledger_for_file(&tx, path)?;
        tx.execute(
            "UPDATE ingested_files SET bytes_parsed = 0 WHERE path = ?",
            [path],
        )?;
    }
    tx.commit()?;

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

    fn snap(session: &str, req: &str, at: &str, input: i64, output: i64) -> Value {
        json!({
            "type": "assistant",
            "sessionId": session,
            "requestId": req,
            "uuid": format!("u_{req}_{at}_{output}"),
            "timestamp": format!("2026-09-28T{at}:00.000Z"),
            "cwd": "/work/proj",
            "message": {
                "id": format!("m_{req}"),
                "model": "claude-opus-4-7",
                "usage": {"input_tokens": input, "output_tokens": output},
                "content": [{"type": "text", "text": "x"}],
            },
        })
    }

    fn hourly_totals(f: &Fixture) -> [i64; 4] {
        f.hourly().iter().fold([0; 4], |t, r| {
            [
                t[0] + r.input_tokens,
                t[1] + r.output_tokens,
                t[2] + r.cache_read,
                t[3] + r.cache_creation,
            ]
        })
    }

    fn model_totals(f: &Fixture) -> [i64; 4] {
        f.models().iter().fold([0; 4], |t, r| {
            [
                t[0] + r.input_tokens,
                t[1] + r.output_tokens,
                t[2] + r.cache_read,
                t[3] + r.cache_creation,
            ]
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
            js_date_parse("2026-09-28T15:10:00.000Z"),
            Some(1790608200000)
        );
        assert_eq!(
            js_date_parse("2026-09-28T23:10:00+08:00"),
            Some(1790608200000)
        );
        assert_eq!(
            js_date_parse("2026-09-28T15:10:00.123456Z"),
            Some(1790608200123)
        );
        assert_eq!(js_date_parse("2026-09-28"), Some(1790553600000));
        assert_eq!(js_date_parse("1969-12-31T23:59:59.999Z"), Some(-1));
        assert_eq!(js_date_parse("nope"), None);
    }

    #[test]
    fn repeated_snapshots_bill_the_last_occurrence() {
        let mut f = Fixture::new();
        let path = f.write(
            "p/s.jsonl",
            &[
                snap("S", "r1", "15:10", 10, 2),
                snap("S", "r1", "15:11", 10, 50),
            ],
        );
        f.update(false);
        let hourly = f.hourly();
        assert_eq!(hourly.len(), 1);
        assert_eq!(
            (
                hourly[0].input_tokens,
                hourly[0].output_tokens,
                hourly[0].message_count
            ),
            (10, 50, 1)
        );
        assert_eq!(model_input(&f, &path), 10);
        assert_eq!(model_totals(&f), hourly_totals(&f));
    }

    #[test]
    fn snapshot_split_across_runs_bills_only_the_missing_tokens() {
        let mut f = Fixture::new();
        let first = snap("S", "r1", "15:10", 10, 2);
        f.write("p/S.jsonl", std::slice::from_ref(&first));
        f.update(false);
        f.write("p/S.jsonl", &[first, snap("S", "r1", "15:11", 10, 50)]);
        f.update(false);
        f.update(false);
        let hourly = f.hourly();
        assert_eq!(hourly.len(), 1);
        assert_eq!(
            (
                hourly[0].input_tokens,
                hourly[0].output_tokens,
                hourly[0].message_count
            ),
            (10, 50, 1)
        );
        assert_eq!(model_totals(&f), hourly_totals(&f));
    }

    #[test]
    fn a_later_smaller_field_bills_no_negative_delta() {
        let mut f = Fixture::new();
        let first = snap("S", "r1", "15:10", 10, 50);
        f.write("p/S.jsonl", std::slice::from_ref(&first));
        f.update(false);
        f.write("p/S.jsonl", &[first, snap("S", "r1", "15:11", 30, 5)]);
        f.update(false);
        assert_eq!(hourly_totals(&f), [30, 50, 0, 0]);
        assert_eq!(model_totals(&f), [30, 50, 0, 0]);
    }

    #[test]
    fn a_snapshot_past_the_hour_stays_in_the_first_snapshots_hour() {
        let mut f = Fixture::new();
        let first = snap("S", "r1", "15:20", 10, 2);
        f.write(
            "p/S.jsonl",
            &[
                first.clone(),
                snap("S", "r2", "15:21", 1, 1),
                snap("S", "r2", "16:21", 1, 9),
            ],
        );
        f.update(false);
        f.write(
            "p/S.jsonl",
            &[
                first,
                snap("S", "r2", "15:21", 1, 1),
                snap("S", "r2", "16:21", 1, 9),
                snap("S", "r1", "16:20", 10, 50),
            ],
        );
        f.update(false);
        let hour = hour_start_ms(js_date_parse("2026-09-28T15:20:00.000Z").unwrap());
        let rows: Vec<(i64, i64, i64)> = f
            .hourly()
            .iter()
            .map(|r| (r.hour_ms, r.output_tokens, r.message_count))
            .collect();
        assert_eq!(rows, [(hour, 59, 2)]);
    }

    #[test]
    fn ledger_replay_agrees_with_hourly_after_split_and_cross_file_snapshots() {
        let mut f = Fixture::new();
        let a1 = snap("S", "rA", "15:10", 5, 2);
        f.write("p/S.jsonl", std::slice::from_ref(&a1));
        f.update(false);
        f.write(
            "p/S.jsonl",
            &[
                a1,
                snap("S", "rA", "15:11", 5, 40),
                snap("S", "rB", "15:12", 7, 3),
            ],
        );
        f.write(
            "p/S/subagents/agent.jsonl",
            &[
                snap("S", "rA", "15:13", 5, 90),
                snap("S", "rB", "15:12", 7, 3),
            ],
        );
        f.update(false);
        let hourly = f.hourly();
        assert_eq!(hourly_totals(&f), [12, 93, 0, 0]);
        assert_eq!(model_totals(&f), hourly_totals(&f));

        let mut fresh = Fixture::new();
        let projects = f.dir.path().join("projects");
        update_rollup(&mut fresh.db, &projects, UpdateOptions { rebuild: false }).unwrap();
        assert_eq!(fresh.hourly(), hourly);

        f.update(true);
        assert_eq!(f.hourly(), hourly);
        assert_eq!(model_totals(&f), hourly_totals(&f));
        assert_eq!(model_totals(&fresh), model_totals(&f));
    }

    // Writes the v3 shape by hand: seen_requests loses its billed columns and every key is legacy.
    fn downgrade_to_v3(f: &mut Fixture) {
        f.db.execute_batch(
            "UPDATE meta SET value = '3' WHERE key = 'schema_version';
             CREATE TABLE v3_seen AS SELECT request_key, path FROM seen_requests;
             DROP TABLE seen_requests;
             CREATE TABLE seen_requests (request_key TEXT PRIMARY KEY, path TEXT NOT NULL);
             CREATE INDEX idx_seen_requests_path ON seen_requests (path);
             INSERT INTO seen_requests SELECT request_key, path FROM v3_seen;
             DROP TABLE v3_seen;
             INSERT INTO seen_requests VALUES ('gone:key', '/gone.jsonl');",
        )
        .unwrap();
    }

    fn reopen(f: &mut Fixture) {
        f.db = Connection::open_in_memory().unwrap();
        f.db = rollup_db::open_rollup_db(&f.dir.path().join("rollup.db")).unwrap();
    }

    fn billed_output(f: &Fixture, key: &str) -> Option<i64> {
        f.db.query_row(
            "SELECT output_tokens FROM seen_requests WHERE request_key = ?",
            [key],
            |r| r.get(0),
        )
        .unwrap()
    }

    #[test]
    fn v3_migration_corrects_legacy_keys_to_the_largest_snapshot_on_disk_once() {
        let mut f = Fixture::new();
        let mut a1 = snap("S", "rA", "15:10", 5, 2);
        a1["message"]["content"] = json!([{"type": "tool_use", "id": "tu_A"}]);
        f.write("p/S/subagents/agent.jsonl", &[user("S", 1), a1.clone()]);
        f.update(false);
        downgrade_to_v3(&mut f);
        f.write(
            "p/S/subagents/agent.jsonl",
            &[user("S", 1), a1, snap("S", "rA", "16:11", 5, 40)],
        );
        f.write("p/S.jsonl", &[snap("S", "rA", "17:12", 5, 90)]);

        reopen(&mut f);
        assert!(f.dir.path().join("rollup.db.v3.bak").exists());
        f.update(false);
        let hour = hour_start_ms(js_date_parse("2026-09-28T15:10:00.000Z").unwrap());
        let rows: Vec<(i64, i64, i64)> = f
            .hourly()
            .iter()
            .map(|r| (r.hour_ms, r.output_tokens, r.message_count))
            .collect();
        assert_eq!(rows, [(hour, 90, 1)]);
        assert_eq!(model_totals(&f), hourly_totals(&f));
        assert_eq!(f.tool_calls("S"), 1);
        assert_eq!(billed_output(&f, "rA:m_rA"), Some(90));
        assert_eq!(billed_output(&f, "gone:key"), None);
        assert_eq!(
            rollup_db::get_meta(&f.db, rollup_db::BILLING_CORRECTION_PENDING)
                .unwrap()
                .as_deref(),
            Some("0")
        );

        let (hourly, ledger, models) = (f.hourly(), f.ledger(), f.models());
        reopen(&mut f);
        f.update(false);
        f.update(true);
        assert_eq!(
            (f.hourly(), f.ledger(), f.models()),
            (hourly, ledger, models)
        );
    }

    #[test]
    fn hourly_rows_bucket_by_hour_start_ms_and_a_missing_timestamp_lands_in_hour_zero() {
        let mut f = Fixture::new();
        let mut untimed = assistant("S", "r2", "m2", 0, 3, false);
        untimed.as_object_mut().unwrap().remove("timestamp");
        f.write(
            "p/S.jsonl",
            &[assistant("S", "r1", "m1", 10, 5, false), untimed],
        );
        f.update(false);
        let ts = js_date_parse("2026-09-28T15:10:00.000Z").unwrap();
        let hours: Vec<(i64, i64)> = f
            .hourly()
            .iter()
            .map(|r| (r.hour_ms, r.input_tokens))
            .collect();
        assert_eq!(hours, [(0, 3), (hour_start_ms(ts), 5)]);
        assert_ne!(hour_start_ms(ts), ts);
    }

    #[test]
    fn new_file_holding_a_request_a_sibling_billed_adds_no_ledger_model_rows() {
        let mut f = Fixture::new();
        f.write("p/S.jsonl", &[assistant("S", "rA", "mA", 2, 5, false)]);
        f.update(false);
        let sibling = f.write(
            "p/S/subagents/agent.jsonl",
            &[
                assistant("S", "rA", "mA", 2, 5, false),
                assistant("S", "rB", "mB", 3, 7, false),
            ],
        );
        f.update(false);
        assert_eq!(model_input(&f, &sibling), 7);
        assert_eq!(f.hourly().iter().map(|r| r.input_tokens).sum::<i64>(), 12);
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

    fn two_sessions(f: &Fixture) -> (String, String) {
        let s = f.write(
            "p/S.jsonl",
            &[user("S", 1), assistant("S", "rA", "mA", 2, 5, true)],
        );
        let t = f.write(
            "q/T.jsonl",
            &[user("T", 3), assistant("T", "rB", "mB", 4, 7, true)],
        );
        (s, t)
    }

    #[test]
    fn a_replay_that_dies_after_one_file_resumes_without_losing_that_files_ledger() {
        let mut f = Fixture::new();
        let (s, t) = two_sessions(&f);
        f.update(false);
        let before = (f.hourly(), f.ledger(), f.models());

        rollup_db::rewind_rollup(&f.db).unwrap();
        rollup_db::set_meta(&f.db, LEDGER_REBUILD_PENDING, "1").unwrap();
        let mut ctx = IngestContext {
            now_ms: 0,
            ledger_rebuild: HashSet::from([s.clone(), t]),
            ledger_seen: HashMap::new(),
            legacy: None,
        };
        ingest_file(&mut f.db, &s, &mut ctx).unwrap();
        drop(ctx);

        f.update(false);
        assert_eq!((f.hourly(), f.ledger(), f.models()), before);
    }

    #[test]
    fn a_rebuild_that_dies_after_its_rewind_does_not_double_the_next_ledger() {
        let mut f = Fixture::new();
        two_sessions(&f);
        f.update(false);
        let before = (f.hourly(), f.ledger(), f.models());

        let tx = f.db.transaction().unwrap();
        rollup_db::rewind_rollup(&tx).unwrap();
        tx.commit().unwrap();

        f.update(false);
        assert_eq!((f.hourly(), f.ledger(), f.models()), before);
    }

    #[test]
    fn a_correction_applied_twice_from_the_same_pending_state_bills_one_delta() {
        let mut f = Fixture::new();
        let path = f.write("p/S.jsonl", &[snap("S", "rA", "15:10", 5, 2)]);
        f.update(false);
        downgrade_to_v3(&mut f);
        reopen(&mut f);
        let key = "rA:m_rA".to_string();
        let fix = LegacyFix {
            owners: HashMap::from([(key.clone(), path)]),
            first: HashMap::from([(
                key.clone(),
                BilledRequest {
                    tokens: BilledTokens {
                        input_tokens: 5,
                        output_tokens: 2,
                        ..Default::default()
                    },
                    hour_ms: hour_start_ms(js_date_parse("2026-09-28T15:10:00.000Z").unwrap()),
                    project: "/work/proj".into(),
                    model: "claude-opus-4-7".into(),
                },
            )]),
            largest: HashMap::from([(
                key,
                BilledTokens {
                    input_tokens: 5,
                    output_tokens: 90,
                    ..Default::default()
                },
            )]),
        };
        apply_legacy_fix(&mut f.db, fix.clone()).unwrap();
        apply_legacy_fix(&mut f.db, fix.clone()).unwrap();
        assert_eq!(hourly_totals(&f), [5, 90, 0, 0]);

        rollup_db::set_meta(&f.db, BILLING_CORRECTION_PENDING, "1").unwrap();
        apply_legacy_fix(&mut f.db, fix).unwrap();
        assert_eq!(hourly_totals(&f), [5, 90, 0, 0]);
    }

    #[test]
    fn a_run_that_dies_after_pruning_still_replays_the_survivors_ledger() {
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
        f.update(false);
        std::fs::remove_file(&parent).unwrap();
        prune_missing_files(&mut f.db, std::slice::from_ref(&sibling)).unwrap();

        f.update(false);
        assert_eq!(model_input(&f, &sibling), 12);
        assert_eq!(f.tool_calls("S"), 1);
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
        assert!(rollup_db::seen_request(&f.db, "rA:mA").unwrap() != Seen::Unseen);
        assert_eq!(model_input(&f, &sibling), 12);
        assert_eq!(f.tool_calls("S"), 1);

        std::fs::remove_file(&lone).unwrap();
        f.update(false);
        assert_eq!(f.hourly(), hourly);
        assert_eq!(
            rollup_db::seen_request(&f.db, "rC:mC").unwrap(),
            Seen::Unseen
        );
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
        env.set("TOKEN_ATLAS_NOW_MS", "1000");
        let projects = env.dir.path().join("projects");
        std::fs::create_dir_all(projects.join("p")).unwrap();
        std::fs::write(
            projects.join("p/S.jsonl"),
            body(&[assistant("S", "r1", "m1", 1, 5, false)]),
        )
        .unwrap();
        env.set("TOKEN_ATLAS_PROJECTS_DIR", &projects);
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
        let wall = std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!(
            (wall - updated_at).abs() < 10_000,
            "updated_at {updated_at} vs wall {wall}"
        );
    }
}
