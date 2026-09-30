use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future log_stream routes
#[derive(Default)]
pub struct LogStreamState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
