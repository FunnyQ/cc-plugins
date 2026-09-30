use super::{AppState, json_response};
use axum::{
    Router,
    extract::{Query, State},
    http::StatusCode,
    response::Response,
    routing::any,
};
use serde_json::json;
use std::{collections::HashMap, path::PathBuf};

mod design;
pub(crate) mod session_title;
mod sessions;
pub(crate) mod subagents;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions", any(sessions))
        .route("/api/projects", any(projects))
        .route("/api/project-info", any(project_info))
        .route("/api/design-system", any(design_system))
}

// Off the single runtime thread: a build reads every decision log and several SQLite files, stalling open streams.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

async fn sessions(State(state): State<AppState>) -> Response {
    match blocking(move || sessions::build_sessions(&state)).await {
        Ok(sessions) => json_response(StatusCode::OK, json!({"sessions": sessions})),
        Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
    }
}

async fn projects(State(state): State<AppState>) -> Response {
    match blocking(move || sessions::build_projects(&state)).await {
        Ok(projects) => json_response(StatusCode::OK, json!({"projects": projects})),
        Err(error) => json_response(StatusCode::INTERNAL_SERVER_ERROR, json!({"error": error})),
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
        return json_response(StatusCode::BAD_REQUEST, json!({"error": "unknown project"}));
    };
    json_response(StatusCode::OK, design::build_project_info(&project))
}

async fn design_system(Query(query): Query<HashMap<String, String>>) -> Response {
    let Some(requested) = query.get("project").filter(|value| !value.is_empty()) else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "project required"}));
    };
    let Some(project) = known_project(requested) else {
        return json_response(StatusCode::NOT_FOUND, json!({"error": "unknown project"}));
    };
    match design::read_project_design_system(&project) {
        Ok(design) => json_response(StatusCode::OK, design),
        Err(error) => {
            let status = if error.contains("not found") {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
            json_response(status, json!({"error": error}))
        }
    }
}
