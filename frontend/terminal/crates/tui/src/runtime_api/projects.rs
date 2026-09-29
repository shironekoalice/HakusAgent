//! Runtime project registry used by the embedded Android client.
//!
//! Desktop clients keep using the Python server's project registry. Android
//! runs only the Rust Runtime API, so it needs the same small CRUD contract.
//! The registry stores the real local workspace path; Android's SAF URI is
//! retained only as metadata for the native sync bridge.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Json;
use axum::extract::{Path as AxumPath, State};
use axum::http::StatusCode;
use serde::{Deserialize, Serialize};

use super::{ApiError, RuntimeApiState};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRecord {
    pub id: String,
    pub name: String,
    pub path: String,
    pub pinned: bool,
    pub created_at: i64,
    pub last_used_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_uri: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectRequest {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub source_uri: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct UpdateProjectRequest {
    pub name: Option<String>,
    pub pinned: Option<bool>,
}

fn registry_path(state: &RuntimeApiState) -> PathBuf {
    state
        .workspace
        .parent()
        .unwrap_or(&state.workspace)
        .join("projects.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or_default()
}

fn load(state: &RuntimeApiState) -> Result<Vec<ProjectRecord>, ApiError> {
    let path = registry_path(state);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(ApiError::internal(format!(
                "read project registry: {error}"
            )));
        }
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw)
        .map_err(|error| ApiError::internal(format!("parse project registry: {error}")))
}

fn save(state: &RuntimeApiState, projects: &[ProjectRecord]) -> Result<(), ApiError> {
    let path = registry_path(state);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            ApiError::internal(format!("create project registry directory: {error}"))
        })?;
    }
    let body = serde_json::to_vec_pretty(projects)
        .map_err(|error| ApiError::internal(format!("serialize project registry: {error}")))?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, body)
        .map_err(|error| ApiError::internal(format!("write project registry: {error}")))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| ApiError::internal(format!("replace project registry: {error}")))?;
    Ok(())
}

fn canonical_project_path(state: &RuntimeApiState, raw: &str) -> Result<PathBuf, ApiError> {
    let path = PathBuf::from(raw.trim());
    if !path.is_absolute() {
        return Err(ApiError::bad_request("project path must be absolute"));
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| ApiError::bad_request(format!("resolve project path: {error}")))?;
    if !canonical.is_dir() {
        return Err(ApiError::bad_request("project path is not a directory"));
    }
    let workspace_root = state
        .workspace
        .canonicalize()
        .map_err(|error| ApiError::internal(format!("resolve runtime workspace: {error}")))?;
    // Desktop can work on any folder selected through the native picker.
    // Android must stay inside the app-managed workspace because its SAF
    // mirror is the only filesystem boundary available to the runtime.
    if state.mobile_enabled && !canonical.starts_with(&workspace_root) {
        return Err(ApiError::forbidden(
            "project path must stay inside the application workspace",
        ));
    }
    Ok(canonical)
}

fn sorted(mut projects: Vec<ProjectRecord>) -> Vec<ProjectRecord> {
    projects.sort_by(|left, right| {
        right
            .pinned
            .cmp(&left.pinned)
            .then_with(|| right.last_used_at.cmp(&left.last_used_at))
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    projects
}

pub(super) fn project_records(state: &RuntimeApiState) -> Result<Vec<ProjectRecord>, ApiError> {
    Ok(sorted(load(state)?))
}

pub async fn list_projects(
    State(state): State<RuntimeApiState>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let projects = sorted(load(&state)?);
    Ok(Json(serde_json::json!({ "projects": projects })))
}

pub async fn create_project(
    State(state): State<RuntimeApiState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<(StatusCode, Json<ProjectRecord>), ApiError> {
    let path = canonical_project_path(&state, &request.path)?;
    let path_string = path.to_string_lossy().into_owned();
    let mut projects = load(&state)?;
    if let Some(index) = projects
        .iter()
        .position(|project| project.path == path_string)
    {
        projects[index].last_used_at = now_ms();
        if projects[index].source_uri.is_none() {
            projects[index].source_uri = request.source_uri.clone();
        }
        let existing = projects[index].clone();
        save(&state, &projects)?;
        return Ok((StatusCode::OK, Json(existing)));
    }

    let timestamp = now_ms();
    let project = ProjectRecord {
        id: format!("proj_android_{timestamp}"),
        name: if request.name.trim().is_empty() {
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Untitled")
                .to_string()
        } else {
            request.name.trim().to_string()
        },
        path: path_string,
        pinned: request.pinned,
        created_at: timestamp,
        last_used_at: timestamp,
        source_uri: request.source_uri.filter(|uri| !uri.trim().is_empty()),
    };
    projects.push(project.clone());
    save(&state, &projects)?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn update_project(
    State(state): State<RuntimeApiState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<UpdateProjectRequest>,
) -> Result<Json<ProjectRecord>, ApiError> {
    let mut projects = load(&state)?;
    let project = projects
        .iter_mut()
        .find(|project| project.id == id)
        .ok_or_else(|| ApiError::not_found("project not found"))?;
    if let Some(name) = request.name {
        if !name.trim().is_empty() {
            project.name = name.trim().to_string();
        }
    }
    if let Some(pinned) = request.pinned {
        project.pinned = pinned;
    }
    let updated = project.clone();
    save(&state, &projects)?;
    Ok(Json(updated))
}

pub async fn delete_project(
    State(state): State<RuntimeApiState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    let mut projects = load(&state)?;
    let before = projects.len();
    projects.retain(|project| project.id != id);
    if projects.len() == before {
        return Err(ApiError::not_found("project not found"));
    }
    // Removing a project only removes its registry entry. The selected folder
    // and Android mirror stay untouched so the user cannot lose source files
    // by cleaning up the picker.
    save(&state, &projects)?;
    Ok(StatusCode::NO_CONTENT)
}
