use super::AppState;
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::PathBuf};

mod design;
pub(crate) mod session_title;
mod sessions;
pub(crate) mod subagents;

#[derive(Default)]
pub struct ViewsState {}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions", any(sessions))
        .route("/api/projects", any(projects))
        .route("/api/project-info", any(project_info))
        .route("/api/design-system", any(design_system))
}

fn response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [
            ("content-type", "application/json; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        body.to_string(),
    )
        .into_response()
}

async fn sessions(State(state): State<AppState>) -> Response {
    match sessions::build_sessions(&state) {
        Ok(sessions) => response(StatusCode::OK, json!({"sessions": sessions})),
        Err(error) => response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
    }
}

async fn projects(State(state): State<AppState>) -> Response {
    match sessions::build_projects(&state) {
        Ok(projects) => response(StatusCode::OK, json!({"projects": projects})),
        Err(error) => response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
    }
}

fn known_project(requested: &str) -> Option<PathBuf> {
    let known = crate::registry::read_registry()
        .iter()
        .map(|entry| entry.project().to_owned())
        .collect::<Vec<_>>();
    crate::log_root::resolve_known_project(requested, &known)
}

async fn project_info(Query(query): Query<HashMap<String, String>>) -> Response {
    let Some(project) = known_project(query.get("project").map(String::as_str).unwrap_or(""))
    else {
        return response(StatusCode::BAD_REQUEST, json!({"error": "unknown project"}));
    };
    response(StatusCode::OK, design::build_project_info(&project))
}

async fn design_system(Query(query): Query<HashMap<String, String>>) -> Response {
    let Some(requested) = query.get("project").filter(|value| !value.is_empty()) else {
        return response(StatusCode::NOT_FOUND, json!({"error": "project required"}));
    };
    let Some(project) = known_project(requested) else {
        return response(StatusCode::NOT_FOUND, json!({"error": "unknown project"}));
    };
    match design::read_project_design_system(&project) {
        Ok(design) => response(StatusCode::OK, design),
        Err(error) => {
            let status = if error.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            response(status, json!({"error": error}))
        }
    }
}
