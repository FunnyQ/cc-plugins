use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future opencode routes
#[derive(Default)]
pub struct OpencodeState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
