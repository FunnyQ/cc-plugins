// Port of shared/scripts/jsonl-lines.ts: transcripts reach 2.4 GB, so never read a whole file.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

const DEFAULT_CHUNK: usize = 1 << 20;

pub struct JsonlLinesOptions {
    /// Must sit on a line boundary.
    pub start: u64,
    pub chunk_size: usize,
    /// The rollup ingest passes `false` so a half-written line waits for the next run.
    pub emit_partial: bool,
}

impl Default for JsonlLinesOptions {
    fn default() -> Self {
        Self {
            start: 0,
            chunk_size: DEFAULT_CHUNK,
            emit_partial: true,
        }
    }
}

pub struct JsonlLines {
    file: Option<File>,
    chunk: Vec<u8>,
    chunk_len: usize,
    from: usize,
    carry: Vec<u8>,
    consumed: u64,
    emit_partial: bool,
}

impl JsonlLines {
    /// Byte offset consumed through the last complete line (`LineCursor.bytesConsumed`).
    pub fn bytes_consumed(&self) -> u64 {
        self.consumed
    }
}

/// A missing or unreadable file yields nothing.
pub fn read_jsonl_lines(path: &Path, opts: JsonlLinesOptions) -> JsonlLines {
    let file = File::open(path)
        .ok()
        .and_then(|mut file| file.seek(SeekFrom::Start(opts.start)).ok().map(|_| file));
    JsonlLines {
        file,
        chunk: vec![0; opts.chunk_size.max(1)],
        chunk_len: 0,
        from: 0,
        carry: Vec::new(),
        consumed: opts.start,
        emit_partial: opts.emit_partial,
    }
}

// Split on 0x0a before decoding: it never occurs inside a UTF-8 sequence, so a character
// straddling a chunk edge survives intact.
fn decode(bytes: &[u8]) -> String {
    let line = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(line).into_owned()
}

impl Iterator for JsonlLines {
    type Item = String;

    fn next(&mut self) -> Option<String> {
        loop {
            let view = &self.chunk[self.from..self.chunk_len];
            if let Some(nl) = view.iter().position(|&b| b == b'\n') {
                let line = if self.carry.is_empty() {
                    decode(&view[..nl])
                } else {
                    self.carry.extend_from_slice(&view[..nl]);
                    let line = decode(&self.carry);
                    self.consumed += self.carry.len() as u64 - nl as u64;
                    self.carry.clear();
                    line
                };
                self.consumed += nl as u64 + 1;
                self.from += nl + 1;
                return Some(line);
            }
            self.carry.extend_from_slice(view);
            self.from = 0;
            self.chunk_len = 0;
            let read = match self.file.as_mut() {
                Some(file) => file.read(&mut self.chunk).unwrap_or(0),
                None => 0,
            };
            if read == 0 {
                self.file = None;
                if self.carry.is_empty() || !self.emit_partial {
                    return None;
                }
                let line = decode(&self.carry);
                self.consumed += self.carry.len() as u64;
                self.carry.clear();
                return Some(line);
            }
            self.chunk_len = read;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, body: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        std::fs::write(&path, body).unwrap();
        path
    }

    fn collect(path: &Path, opts: JsonlLinesOptions) -> (Vec<String>, u64) {
        let mut lines = read_jsonl_lines(path, opts);
        let out: Vec<String> = lines.by_ref().collect();
        (out, lines.bytes_consumed())
    }

    fn chunk(chunk_size: usize) -> JsonlLinesOptions {
        JsonlLinesOptions {
            chunk_size,
            ..Default::default()
        }
    }

    fn no_partial() -> JsonlLinesOptions {
        JsonlLinesOptions {
            emit_partial: false,
            ..Default::default()
        }
    }

    #[test]
    fn lines_without_newlines() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "basic.jsonl", b"a\nbb\nccc\n");
        assert_eq!(collect(&path, Default::default()).0, ["a", "bb", "ccc"]);
    }

    #[test]
    fn multibyte_straddling_chunk_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "utf8.jsonl", "中文\n中\n文中文\n".as_bytes());
        assert_eq!(collect(&path, chunk(4)).0, ["中文", "中", "文中文"]);
    }

    #[test]
    fn line_longer_than_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let long = "x".repeat(5000);
        let path = write(&dir, "long.jsonl", format!("{long}\nshort\n").as_bytes());
        assert_eq!(collect(&path, chunk(64)).0, [long.as_str(), "short"]);
    }

    #[test]
    fn crlf_is_one_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "crlf.jsonl", b"a\r\nb\r\n");
        assert_eq!(collect(&path, Default::default()).0, ["a", "b"]);
    }

    #[test]
    fn blank_lines_kept() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "blank.jsonl", b"a\n\nb\n");
        assert_eq!(collect(&path, Default::default()).0, ["a", "", "b"]);
    }

    #[test]
    fn partial_last_line_both_modes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "partial.jsonl", b"a\nb");
        assert_eq!(
            collect(&path, Default::default()),
            (vec!["a".into(), "b".into()], 3)
        );
        assert_eq!(collect(&path, no_partial()), (vec!["a".into()], 2));
    }

    #[test]
    fn empty_and_missing_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "empty.jsonl", b"");
        assert!(collect(&path, Default::default()).0.is_empty());
        assert!(collect(&path, no_partial()).0.is_empty());
        let missing = dir.path().join("nope.jsonl");
        assert_eq!(collect(&missing, Default::default()), (vec![], 0));
    }

    #[test]
    fn start_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "offset.jsonl", b"aaa\nbbb\nccc\n");
        let opts = JsonlLinesOptions {
            start: 4,
            ..Default::default()
        };
        assert_eq!(collect(&path, opts).0, ["bbb", "ccc"]);
    }

    #[test]
    fn bytes_consumed_is_after_last_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "c1.jsonl", b"aaa\nbbb\nccc\n");
        assert_eq!(collect(&path, no_partial()).1, 12);
        let path = write(&dir, "c2.jsonl", b"aaa\nbbb\npartial");
        assert_eq!(collect(&path, no_partial()).1, 8);
    }

    #[test]
    fn bytes_consumed_stays_at_start_without_complete_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "c3.jsonl", b"aaaa\nno-newline-yet");
        let opts = JsonlLinesOptions {
            start: 5,
            emit_partial: false,
            ..Default::default()
        };
        assert_eq!(collect(&path, opts), (vec![], 5));
    }

    #[test]
    fn bytes_consumed_is_absolute_after_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "c4.jsonl", b"aaa\nbbb\nccc\n");
        let opts = JsonlLinesOptions {
            start: 4,
            emit_partial: false,
            ..Default::default()
        };
        assert_eq!(collect(&path, opts).1, 12);
    }

    #[test]
    fn bytes_consumed_counts_bytes_across_multibyte_chunks() {
        let dir = tempfile::tempdir().unwrap();
        let body = "中文\n中\n";
        let path = write(&dir, "c5.jsonl", body.as_bytes());
        let opts = JsonlLinesOptions {
            chunk_size: 4,
            emit_partial: false,
            ..Default::default()
        };
        assert_eq!(collect(&path, opts).1, body.len() as u64);
    }

    #[test]
    fn multibyte_partial_tail_straddling_chunk() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(&dir, "c6.jsonl", "中\n文中".as_bytes());
        let opts = JsonlLinesOptions {
            chunk_size: 4,
            emit_partial: false,
            ..Default::default()
        };
        assert_eq!(collect(&path, opts), (vec!["中".into()], 4));
        assert_eq!(
            collect(&path, chunk(4)),
            (vec!["中".into(), "文中".into()], 10)
        );
    }
}
