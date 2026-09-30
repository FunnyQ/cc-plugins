pub fn env_int(name: &str, fallback: u64) -> u64 {
    let raw = std::env::var(name).unwrap_or_default();
    let raw = raw.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let raw = raw.strip_prefix('+').unwrap_or(raw);
    let end = raw.bytes().take_while(u8::is_ascii_digit).count();
    // Values outside u64 cannot be represented by this interface.
    raw[..end]
        .parse::<u64>()
        .ok()
        .filter(|v| *v > 0)
        .unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::tests::TestEnv;

    #[test]
    fn leading_integer_and_positive_only() {
        let _env = TestEnv::new();
        assert_eq!(env_int("COCKPIT_WAIT_TIMEOUT_MS", 17), 17);
        for (raw, expected) in [
            ("250abc", 250),
            ("abc", 17),
            ("0", 17),
            ("-5", 17),
            ("", 17),
            (" +42ms", 42),
            ("1.5", 1),
            ("1e3", 1),
            ("0x10", 17),
            ("+ 3", 17),
            ("00025", 25),
            ("\u{feff}50", 50),
            ("999999999999999999999999999", 17),
        ] {
            TestEnv::set("COCKPIT_WAIT_TIMEOUT_MS", raw);
            assert_eq!(env_int("COCKPIT_WAIT_TIMEOUT_MS", 17), expected, "{raw}");
        }
    }
}
