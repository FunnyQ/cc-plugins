use jiff::{Timestamp, tz::TimeZone};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// Same order as Bun's readdirSync: raw OS directory order, unsorted.
pub fn walk_files(dir: &Path, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            walk_files(&path, ext, out);
        } else if file_type.is_file() && entry.file_name().to_string_lossy().ends_with(ext) {
            out.push(path);
        }
    }
}

#[derive(Clone, Default, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupMessage {
    pub id: Option<String>,
}

#[derive(Clone, Default, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupEntry {
    pub request_id: Option<String>,
    pub uuid: Option<String>,
    pub message: Option<DedupMessage>,
}

#[derive(Clone, Default, Debug, PartialEq, Serialize, Deserialize)]
pub struct DedupUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<i64>,
}

// Claude Code persists several snapshots per API request with identical billing; requestId:messageId
// names the request, then uuid, then a per-file index so distinct unkeyed lines never collapse.
pub fn dedup_key(entry: &DedupEntry, file: &str, seen_size: usize) -> String {
    let message_id = entry
        .message
        .as_ref()
        .and_then(|message| message.id.as_deref())
        .filter(|id| !id.is_empty());
    match (
        entry.request_id.as_deref().filter(|id| !id.is_empty()),
        message_id,
    ) {
        (Some(request_id), Some(message_id)) => format!("{request_id}:{message_id}"),
        _ => entry
            .uuid
            .clone()
            .unwrap_or_else(|| format!("{file}:{seen_size}")),
    }
}

pub fn usage_token_total(usage: &DedupUsage) -> i64 {
    usage.input_tokens.unwrap_or(0)
        + usage.output_tokens.unwrap_or(0)
        + usage.cache_read_input_tokens.unwrap_or(0)
        + usage.cache_creation_input_tokens.unwrap_or(0)
}

pub fn count_claude_tool_calls(content: &serde_json::Value) -> i64 {
    let Some(parts) = content.as_array() else {
        return 0;
    };
    parts
        .iter()
        .filter(|part| part.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .count() as i64
}

#[derive(Clone, Default, Debug, PartialEq)]
pub struct BilledTokens {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
}

pub fn add_billed_tokens(target: &mut BilledTokens, usage: &DedupUsage) {
    target.input_tokens += usage.input_tokens.unwrap_or(0);
    target.output_tokens += usage.output_tokens.unwrap_or(0);
    target.cache_read += usage.cache_read_input_tokens.unwrap_or(0);
    target.cache_creation += usage.cache_creation_input_tokens.unwrap_or(0);
}

// Local hour start: the rollup stores buckets under this exact value, so every producer must agree.
pub fn hour_start_ms(ts_ms: i64) -> i64 {
    hour_start_ms_in(ts_ms, &TimeZone::system())
}

// jiff caches the system zone for minutes with no public reset, so tests pass the zone explicitly.
fn hour_start_ms_in(ts_ms: i64, tz: &TimeZone) -> i64 {
    if ts_ms == 0 {
        return 0;
    }
    let Ok(ts) = Timestamp::from_millisecond(ts_ms) else {
        return ts_ms;
    };
    let local = tz.to_datetime(ts);
    let Ok(hour) = local
        .with()
        .minute(0)
        .second(0)
        .subsec_nanosecond(0)
        .build()
    else {
        return ts_ms;
    };
    // A repeated fall-back hour resolves to its earlier instant, as JS Date's setMinutes does.
    tz.to_ambiguous_timestamp(hour)
        .compatible()
        .map_or(ts_ms, |ts| ts.as_millisecond())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hour_start_matches_bun_across_dst() {
        // Expected values from `TZ=<zone> bun -e 'hourStartMs(<ms>)'` against dedup.ts.
        let new_york = TimeZone::get("America/New_York").unwrap();
        let taipei = TimeZone::get("Asia/Taipei").unwrap();
        let cases: &[(i64, i64, i64)] = &[
            // (ts, New York, Taipei)
            (1793511000000, 1793509200000, 1793509200000), // 2026-11-01T05:30Z, 01:30 EDT
            (1793514600000, 1793509200000, 1793512800000), // 06:30Z, 01:30 EST — repeated hour
            (1793516399999, 1793509200000, 1793512800000),
            (1772951400000, 1772949600000, 1772949600000), // 2026-03-08T06:30Z, before the gap
            (1772955000000, 1772953200000, 1772953200000), // 07:30Z, 03:30 EDT after the gap
            (1790858096789, 1790856000000, 1790856000000),
        ];
        for &(ts, ny, tpe) in cases {
            assert_eq!(hour_start_ms_in(ts, &new_york), ny, "{ts} New York");
            assert_eq!(hour_start_ms_in(ts, &taipei), tpe, "{ts} Taipei");
        }
        assert_eq!(hour_start_ms(0), 0);
    }

    fn entry(value: serde_json::Value) -> DedupEntry {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn dedup_key_prefers_request_and_message_ids() {
        assert_eq!(
            dedup_key(
                &entry(json!({"requestId": "r", "uuid": "u", "message": {"id": "m"}})),
                "f",
                3
            ),
            "r:m"
        );
        assert_eq!(
            dedup_key(&entry(json!({"requestId": "r", "uuid": "u"})), "f", 3),
            "u"
        );
        assert_eq!(
            dedup_key(
                &entry(json!({"requestId": "", "message": {"id": "m"}})),
                "f",
                3
            ),
            "f:3"
        );
        assert_eq!(dedup_key(&entry(json!({"uuid": ""})), "f", 0), "");
    }

    #[test]
    fn token_totals_and_billing() {
        let usage: DedupUsage = serde_json::from_value(json!({
            "input_tokens": 1, "output_tokens": 2, "cache_read_input_tokens": 4
        }))
        .unwrap();
        assert_eq!(usage_token_total(&usage), 7);
        assert_eq!(usage_token_total(&DedupUsage::default()), 0);
        let mut billed = BilledTokens::default();
        add_billed_tokens(&mut billed, &usage);
        add_billed_tokens(&mut billed, &usage);
        assert_eq!(
            billed,
            BilledTokens {
                input_tokens: 2,
                output_tokens: 4,
                cache_read: 8,
                cache_creation: 0
            }
        );
    }

    #[test]
    fn tool_calls_counted_in_mixed_content() {
        let content = json!([
            {"type": "text", "text": "x"},
            {"type": "tool_use", "id": "a"},
            null,
            "tool_use",
            {"type": "tool_use"},
            {"type": "tool_result"}
        ]);
        assert_eq!(count_claude_tool_calls(&content), 2);
        assert_eq!(count_claude_tool_calls(&json!("tool_use")), 0);
    }

    #[test]
    fn walk_files_filters_by_extension_recursively() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("a/b")).unwrap();
        std::fs::write(dir.path().join("a/b/x.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("y.jsonl"), "").unwrap();
        std::fs::write(dir.path().join("z.json"), "").unwrap();
        let mut out = Vec::new();
        walk_files(dir.path(), ".jsonl", &mut out);
        out.sort();
        assert_eq!(
            out,
            vec![dir.path().join("a/b/x.jsonl"), dir.path().join("y.jsonl")]
        );
        let mut none = Vec::new();
        walk_files(&dir.path().join("missing"), ".jsonl", &mut none);
        assert!(none.is_empty());
    }
}
