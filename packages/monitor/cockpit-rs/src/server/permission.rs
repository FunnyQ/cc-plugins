use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future permission routes
#[derive(Default)]
pub struct PermissionState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
