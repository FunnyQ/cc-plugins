use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future inbox routes
#[derive(Default)]
pub struct InboxState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
