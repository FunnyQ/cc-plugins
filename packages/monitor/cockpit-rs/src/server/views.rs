use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future views routes
#[derive(Default)]
pub struct ViewsState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
