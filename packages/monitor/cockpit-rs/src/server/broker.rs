use super::AppState;
use axum::Router;

#[allow(dead_code)] // callers are the future broker routes
#[derive(Default)]
pub struct BrokerState {}

pub fn router() -> Router<AppState> {
    Router::new()
}
