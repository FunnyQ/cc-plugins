use serde_json::Value;
use std::collections::HashSet;

pub fn latest_open_call_in(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    latest_open_call_id(std::fs::read_to_string(path).ok()?.lines())
}

pub fn latest_open_call_id<'a, I>(lines: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
    I::IntoIter: DoubleEndedIterator,
{
    let mut answered_calls = HashSet::new();
    let mut saw_legacy_response = false;
    for line in lines.into_iter().rev() {
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(call) = record.get("call").and_then(Value::as_str) {
                answered_calls.insert(call.to_owned());
            } else {
                saw_legacy_response = true;
            }
            continue;
        }
        if record.get("type").and_then(Value::as_str) == Some("decision")
            && record.get("needs_your_call").and_then(Value::as_bool) == Some(true)
        {
            let id = record.get("id").and_then(Value::as_str);
            if saw_legacy_response || id.is_some_and(|id| answered_calls.contains(id)) {
                return None;
            }
            return id.map(str::to_owned);
        }
    }
    None
}

pub fn call_matches(a: Option<&str>, b: Option<&str>) -> bool {
    a.is_none() || b.is_none() || a == b
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOAL: &str = r#"{"type":"goal","session_goal":"g"}"#;
    const C1: &str = r#"{"type":"decision","id":"c1","needs_your_call":true}"#;
    const C2: &str = r#"{"type":"decision","id":"c2","needs_your_call":true}"#;
    const R1: &str = r#"{"type":"response","call":"c1","answer":"ok"}"#;
    const R2: &str = r#"{"type":"response","call":"c2","answer":"ok"}"#;

    #[test]
    fn empty_and_goal_only_logs_have_no_open_call() {
        assert_eq!(latest_open_call_id([]), None);
        assert_eq!(latest_open_call_id([GOAL]), None);
    }

    #[test]
    fn returns_the_open_call_id() {
        assert_eq!(latest_open_call_id([GOAL, C1]).as_deref(), Some("c1"));
    }

    #[test]
    fn plain_decisions_are_not_calls() {
        assert_eq!(
            latest_open_call_id([
                GOAL,
                r#"{"type":"decision","id":"d1","needs_your_call":false}"#
            ]),
            None
        );
    }

    #[test]
    fn response_closes_its_call() {
        assert_eq!(latest_open_call_id([GOAL, C1, R1]), None);
    }

    #[test]
    fn latest_call_is_open_after_earlier_answer() {
        assert_eq!(
            latest_open_call_id([GOAL, C1, R1, C2]).as_deref(),
            Some("c2")
        );
    }

    #[test]
    fn most_recent_response_closes_latest_call() {
        assert_eq!(latest_open_call_id([GOAL, C1, C2, R2]), None);
    }

    #[test]
    fn answering_older_call_leaves_latest_open() {
        assert_eq!(
            latest_open_call_id([GOAL, C1, C2, R1]).as_deref(),
            Some("c2")
        );
    }

    #[test]
    fn answering_latest_never_reopens_superseded_call() {
        assert_eq!(latest_open_call_id([GOAL, C1, C2, R2]), None);
    }

    #[test]
    fn legacy_responses_close_latest_call() {
        for response in [
            r#"{"type":"response","call":null,"answer":"ok"}"#,
            r#"{"type":"response"}"#,
            r#"{"type":"response","call":42}"#,
        ] {
            assert_eq!(latest_open_call_id([GOAL, C1, C2, response]), None);
        }
    }

    #[test]
    fn blank_malformed_and_nonobject_lines_are_skipped() {
        assert_eq!(
            latest_open_call_id(["", "  ", "not json", C1]).as_deref(),
            Some("c1")
        );
        assert_eq!(
            latest_open_call_id([C1, "\n", "{", "null", "42", "[]", "true", r#""text""#])
                .as_deref(),
            Some("c1")
        );
    }

    #[test]
    fn invalid_latest_call_id_does_not_reopen_older_call() {
        for call in [
            r#"{"type":"decision","needs_your_call":true}"#,
            r#"{"type":"decision","needs_your_call":true,"id":null}"#,
            r#"{"type":"decision","needs_your_call":true,"id":42}"#,
        ] {
            assert_eq!(latest_open_call_id([C1, call]), None);
        }
    }

    #[test]
    fn only_boolean_true_marks_a_call_and_empty_ids_are_strings() {
        assert_eq!(
            latest_open_call_id([
                C1,
                r#"{"type":"decision","id":"c2","needs_your_call":"true"}"#
            ])
            .as_deref(),
            Some("c1")
        );
        assert_eq!(
            latest_open_call_id([r#"{"type":"decision","id":"","needs_your_call":true}"#])
                .as_deref(),
            Some("")
        );
        assert_eq!(latest_open_call_id([R1, C1]).as_deref(), Some("c1"));
    }

    #[test]
    fn equal_ids_match() {
        assert!(call_matches(Some("c1"), Some("c1")));
    }

    #[test]
    fn different_ids_do_not_match() {
        assert!(!call_matches(Some("c1"), Some("c2")));
    }

    #[test]
    fn absent_ids_on_either_side_match() {
        assert!(call_matches(None, Some("c1")));
        assert!(call_matches(Some("c1"), None));
        assert!(call_matches(None, None));
    }
}
