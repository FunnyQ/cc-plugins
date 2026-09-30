use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future codex routes
#[derive(Default)]
pub struct CodexState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
