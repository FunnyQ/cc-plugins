use super::AppState;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use flate2::{Compression, write::GzEncoder};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

fn file_path(root: &Path, pathname: &str) -> Option<PathBuf> {
    let rel = if pathname == "/" {
        "/index.html"
    } else {
        pathname
    };
    let mut path = root.to_path_buf();
    for part in Path::new(&format!(".{rel}")).components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                path.pop();
            }
            Component::Normal(part) => path.push(part),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    let relative = path.strip_prefix(root).ok()?;
    if relative.as_os_str().is_empty() || relative.to_string_lossy().starts_with("..") {
        return None;
    }
    Some(path)
}

fn base36(mut value: u128) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize] as char);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    digits.into_iter().rev().collect()
}

fn mime(extension: &str) -> &'static str {
    match extension {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" => "image/jpeg",
        "woff2" => "font/woff2",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain;charset=utf-8")],
        "Not found",
    )
        .into_response()
}

pub async fn serve(
    State(state): State<AppState>,
    uri: Uri,
    request_headers: HeaderMap,
) -> Response {
    let root = state.plugin_root.join("skills/cockpit/dashboard/dist");
    let Some(path) = file_path(&root, uri.path()) else {
        return not_found();
    };
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return not_found();
    };
    if !metadata.is_file() {
        return not_found();
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let gzip = matches!(
        extension.as_str(),
        "html" | "js" | "mjs" | "css" | "json" | "svg"
    ) && request_headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("gzip"));
    // Integer milliseconds deliberately replace TS's fractional base-36 mtime; clients compare equality only.
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis());
    let etag = format!(
        "W/\"{}-{}{}\"",
        base36(mtime),
        base36(metadata.len().into()),
        if gzip { "-gz" } else { "" }
    );
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime(&extension)),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("generated ETag is ASCII"),
    );
    // Keep encoding headers on 304 too, as required by the server foundation contract.
    if gzip {
        headers.insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
        headers.insert(header::VARY, HeaderValue::from_static("Accept-Encoding"));
    }
    if request_headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(&etag)
    {
        return (StatusCode::NOT_MODIFIED, headers, ()).into_response();
    }
    let Ok(mut body) = tokio::fs::read(path).await else {
        return not_found();
    };
    if gzip {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::new(6));
        if encoder.write_all(&body).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let Ok(compressed) = encoder.finish() else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        body = compressed;
    }
    (headers, body).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn static_mime_and_gzip_set_preserve_file_bytes() {
        let fixture = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let root = fixture.path().join("skills/cockpit/dashboard/dist");
        std::fs::create_dir_all(&root).unwrap();
        let state = AppState {
            presence: Default::default(),
            views: Default::default(),
            log_stream: Default::default(),
            transcript: Default::default(),
            broker: Default::default(),
            inbox: Default::default(),
            permission: Default::default(),
            codex: Default::default(),
            opencode: Default::default(),
            token: "test".into(),
            plugin_root: fixture.path().into(),
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            for (extension, expected_mime, compressed) in [
                ("HTML", "text/html; charset=utf-8", true),
                ("js", "application/javascript; charset=utf-8", true),
                ("mjs", "application/javascript; charset=utf-8", true),
                ("css", "text/css; charset=utf-8", true),
                ("json", "application/json; charset=utf-8", true),
                ("svg", "image/svg+xml", true),
                ("png", "image/png", false),
                ("jpg", "image/jpeg", false),
                ("woff2", "font/woff2", false),
                ("ico", "image/x-icon", false),
                ("bin", "application/octet-stream", false),
            ] {
                let content = b"test content\x00\xff";
                std::fs::write(root.join(format!("asset.{extension}")), content).unwrap();
                for accepts_gzip in [false, true] {
                    let mut headers = HeaderMap::new();
                    if accepts_gzip {
                        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("gzip"));
                    }
                    let response = serve(
                        State(state.clone()),
                        format!("/asset.{extension}").parse().unwrap(),
                        headers,
                    )
                    .await;
                    assert_eq!(response.status(), StatusCode::OK);
                    assert_eq!(response.headers()[header::CONTENT_TYPE], expected_mime);
                    let gzip = compressed && accepts_gzip;
                    assert_eq!(
                        response.headers().contains_key(header::CONTENT_ENCODING),
                        gzip
                    );
                    assert_eq!(response.headers().contains_key(header::VARY), gzip);
                    let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .unwrap();
                    if gzip {
                        let mut decoded = Vec::new();
                        std::io::Read::read_to_end(
                            &mut flate2::read::GzDecoder::new(body.as_ref()),
                            &mut decoded,
                        )
                        .unwrap();
                        assert_eq!(decoded, content);
                    } else {
                        assert_eq!(body.as_ref(), content);
                    }
                }
            }
        });
    }

    #[test]
    fn paths_are_strictly_inside_root_without_spa_fallback() {
        let root = Path::new("/dashboard/dist");
        assert_eq!(file_path(root, "/"), Some(root.join("index.html")));
        assert_eq!(file_path(root, "/missing"), Some(root.join("missing")));
        for path in ["/..", "/../outside", "/nested/../..", "/..hidden"] {
            assert_eq!(file_path(root, path), None, "{path}");
        }
        assert_eq!(
            file_path(root, "/nested/../app.js"),
            Some(root.join("app.js"))
        );
    }

    #[test]
    fn etag_numbers_use_base36() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1295), "zz");
    }
}
