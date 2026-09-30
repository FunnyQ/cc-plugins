use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future transcript routes
#[derive(Default)]
pub struct TranscriptState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
