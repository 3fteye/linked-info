use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, atomic::Ordering};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::workspace_file::{self, WorkspaceAccessPermit, WorkspaceVaultState};

const CAPSULE_LABEL: &str = "capsule";
const STATE_CHANGED_EVENT: &str = "capsule-state-changed";
const NOTE_PENDING_EVENT: &str = "capsule-note-pending";

#[derive(Clone)]
pub(crate) struct OwnerAuthority {
    pub(crate) owner_id: String,
    pub(crate) generation: u64,
    pub(crate) permit: Option<WorkspaceAccessPermit>,
    context_id: Option<String>,
}

struct WorkspaceOwner {
    authority: OwnerAuthority,
    context_id: String,
    ready: bool,
}

#[derive(Clone, Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapsuleNoteInput {
    pub(crate) node_id: String,
    pub(crate) name: String,
    pub(crate) content: String,
    pub(crate) captured_at_ms: u64,
    pub(crate) utc_offset_minutes: i32,
}

impl CapsuleNoteInput {
    fn fingerprint(&self) -> Result<[u8; 32], String> {
        let id = uuid::Uuid::parse_str(&self.node_id)
            .map_err(|_| "capsule_invalid_input".to_owned())?;
        if id.to_string() != self.node_id
            || !matches!(self.node_id.as_bytes()[14], b'1'..=b'8')
            || !matches!(self.node_id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
            || self.name.chars().count() > 512
            || self.content.chars().count() > 100_000
            || self.name.len().saturating_add(self.content.len()) > 512 * 1024
            || self.captured_at_ms > 253_402_300_799_999
            || !(-840..=840).contains(&self.utc_offset_minutes)
        {
            return Err("capsule_invalid_input".to_owned());
        }
        let bytes = Zeroizing::new(
            serde_json::to_vec(self).map_err(|_| "capsule_invalid_input".to_owned())?,
        );
        Ok(Sha256::digest(bytes.as_slice()).into())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmissionStatus {
    Queued,
    Processing,
    Saved,
    Failed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RejectionReason {
    Busy,
    DuplicateName,
    Empty,
    Invalid,
    SaveFailed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmissionResult {
    status: SubmissionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<RejectionReason>,
}

impl SubmissionResult {
    fn unknown() -> Self {
        Self { status: SubmissionStatus::Unknown, reason: None }
    }
}

struct Submission {
    authority: OwnerAuthority,
    context_id: String,
    node_id: String,
    fingerprint: [u8; 32],
    input: Option<CapsuleNoteInput>,
    result: SubmissionResult,
    committing: bool,
}

#[derive(Default)]
struct CapsuleRuntime {
    owner: Option<WorkspaceOwner>,
    submission: Option<Submission>,
    quarantined: bool,
}

#[derive(Default)]
pub struct CapsuleState {
    runtime: Mutex<CapsuleRuntime>,
}

fn runtime(app: &AppHandle) -> tauri::State<'_, CapsuleState> {
    app.state::<CapsuleState>()
}

fn ensure_authority(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let vault = app.state::<WorkspaceVaultState>();
    if !authority_generation_matches(authority, vault.access_generation().load(Ordering::Acquire)) {
        return Err("workspace_owner_expired".to_owned());
    }
    workspace_file::ensure_workspace_access(app, &vault, authority.permit)
}

fn authority_generation_matches(authority: &OwnerAuthority, generation: u64) -> bool {
    generation != u64::MAX && generation == authority.generation
}

fn matches_owner(owner: Option<&WorkspaceOwner>, authority: &OwnerAuthority) -> bool {
    owner.is_some_and(|owner| {
        owner.authority.owner_id == authority.owner_id
            && owner.authority.generation == authority.generation
    })
}

pub(crate) fn owner_authority(app: &AppHandle, owner_id: &str) -> Result<OwnerAuthority, String> {
    let state = runtime(app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard.owner.as_ref().filter(|owner| owner.authority.owner_id == owner_id)
        .ok_or_else(|| "workspace_owner_expired".to_owned())?;
    ensure_authority(app, &owner.authority)?;
    Ok(owner.authority.clone())
}

pub(crate) fn ensure_owner(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let state = runtime(app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !matches_owner(guard.owner.as_ref(), authority) {
        return Err("workspace_owner_expired".to_owned());
    }
    ensure_authority(app, authority)
}

fn owner_context_matches(owner: Option<&WorkspaceOwner>, authority: &OwnerAuthority) -> bool {
    matches_owner(owner, authority) && owner.is_some_and(|owner| {
        owner.ready && authority.context_id.as_ref() == Some(&owner.context_id)
    })
}

pub(crate) fn ensure_owner_context(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let state = runtime(app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !owner_context_matches(guard.owner.as_ref(), authority) {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, authority)
}

fn emit_state_changed(app: &AppHandle) {
    let _ = app.emit_to(CAPSULE_LABEL, STATE_CHANGED_EVENT, ());
}

/// Revocation never waits for the filesystem operation queue. In-flight writes
/// retain only their original authority and cannot acquire a replacement owner.
pub(crate) fn revoke(app: &AppHandle) -> bool {
    let had_owner = if let Ok(mut guard) = runtime(app).runtime.lock() {
        let had_owner = guard.owner.is_some();
        guard.owner = None;
        guard.submission = None;
        had_owner
    } else { false };
    emit_state_changed(app);
    had_owner
}

pub(crate) fn quarantine(app: &AppHandle) {
    if let Ok(mut guard) = runtime(app).runtime.lock() {
        guard.quarantined = true;
        guard.owner = None;
        guard.submission = None;
    }
    emit_state_changed(app);
}

pub(crate) fn suspend_owner(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let state = runtime(app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !matches_owner(guard.owner.as_ref(), authority) {
        return Err("workspace_owner_expired".to_owned());
    }
    ensure_authority(app, authority)?;
    let owner = guard.owner.as_mut().expect("validated owner");
    owner.ready = false;
    owner.context_id = uuid::Uuid::new_v4().to_string();
    guard.submission = None;
    drop(guard);
    emit_state_changed(app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOwnerReceipt {
    owner_id: String,
}

#[tauri::command]
pub async fn open_workspace_owner(app: AppHandle) -> Result<WorkspaceOwnerReceipt, String> {
    let operation_lock = app.state::<WorkspaceVaultState>().operation_lock();
    let app_for_open = app.clone();
    let authority = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_lock.lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        let vault = app_for_open.state::<WorkspaceVaultState>();
        let permit = workspace_file::begin_workspace_access(&app_for_open, &vault)?;
        let authority = OwnerAuthority {
            owner_id: uuid::Uuid::new_v4().to_string(),
            generation: permit.map(|permit| permit.generation())
                .unwrap_or_else(|| vault.access_generation().load(Ordering::Acquire)),
            permit,
            context_id: None,
        };
        let state = runtime(&app_for_open);
        let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
        if guard.quarantined {
            return Err("workspace_owner_recovery_required".to_owned());
        }
        ensure_authority(&app_for_open, &authority)?;
        guard.owner = Some(WorkspaceOwner {
            authority: authority.clone(),
            context_id: uuid::Uuid::new_v4().to_string(),
            ready: false,
        });
        guard.submission = None;
        Ok::<_, String>(authority)
    }).await.map_err(|_| "workspace_owner_unavailable".to_owned())??;
    ensure_owner(&app, &authority)?;
    emit_state_changed(&app);
    Ok(WorkspaceOwnerReceipt { owner_id: authority.owner_id })
}

#[tauri::command]
pub fn close_workspace_owner(app: AppHandle, owner_id: String) -> Result<(), String> {
    let state = runtime(&app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if guard.owner.as_ref().is_some_and(|owner| owner.authority.owner_id == owner_id) {
        guard.owner = None;
        guard.submission = None;
    }
    drop(guard);
    emit_state_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_workspace_owner_ready(app: AppHandle, owner_id: String, ready: bool) -> Result<(), String> {
    let authority = owner_authority(&app, &owner_id)?;
    if !ready {
        return suspend_owner(&app, &authority);
    }
    let state = runtime(&app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !matches_owner(guard.owner.as_ref(), &authority) {
        return Err("workspace_owner_expired".to_owned());
    }
    ensure_authority(&app, &authority)?;
    guard.owner.as_mut().expect("validated owner").ready = true;
    drop(guard);
    emit_state_changed(&app);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapsuleStatus {
    owner_id: Option<String>,
    context_id: Option<String>,
    ready: bool,
    encrypted: bool,
}

#[tauri::command]
pub fn inspect_capsule(app: AppHandle) -> Result<CapsuleStatus, String> {
    let state = runtime(&app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard.owner.as_ref()
        .filter(|owner| ensure_authority(&app, &owner.authority).is_ok());
    Ok(CapsuleStatus {
        owner_id: owner.map(|owner| owner.authority.owner_id.clone()),
        context_id: owner.map(|owner| owner.context_id.clone()),
        ready: owner.is_some_and(|owner| owner.ready),
        encrypted: workspace_file::workspace_encryption_configured(&app),
    })
}

fn ready_context<'a>(guard: &'a CapsuleRuntime, owner_id: &str, context_id: &str) -> Option<&'a WorkspaceOwner> {
    guard.owner.as_ref().filter(|owner| {
        owner.ready && owner.authority.owner_id == owner_id && owner.context_id == context_id
    })
}

fn enqueue_note(guard: &mut CapsuleRuntime, authority: OwnerAuthority, context_id: String, input: CapsuleNoteInput) -> Result<SubmissionResult, String> {
    let fingerprint = input.fingerprint()?;
    if let Some(previous) = guard.submission.as_ref() {
        if previous.node_id == input.node_id {
            if previous.fingerprint != fingerprint {
                return Err("capsule_identity_conflict".to_owned());
            }
            if previous.result.status != SubmissionStatus::Failed {
                return Ok(previous.result.clone());
            }
        } else if matches!(previous.result.status, SubmissionStatus::Queued | SubmissionStatus::Processing | SubmissionStatus::Unknown) {
            return Ok(SubmissionResult { status: SubmissionStatus::Failed, reason: Some(RejectionReason::Busy) });
        }
    }
    let result = SubmissionResult { status: SubmissionStatus::Queued, reason: None };
    guard.submission = Some(Submission {
        authority,
        context_id,
        node_id: input.node_id.clone(),
        fingerprint,
        input: Some(input),
        result: result.clone(),
        committing: false,
    });
    Ok(result)
}

#[tauri::command]
pub fn submit_capsule_note(app: AppHandle, owner_id: String, context_id: String, input: CapsuleNoteInput) -> Result<SubmissionResult, String> {
    let state = runtime(&app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = ready_context(&guard, &owner_id, &context_id)
        .ok_or_else(|| "capsule_not_ready".to_owned())?;
    ensure_authority(&app, &owner.authority)?;
    let authority = owner.authority.clone();
    let result = enqueue_note(&mut guard, authority, context_id, input)?;
    drop(guard);
    if result.status == SubmissionStatus::Queued {
        app.state::<WorkspaceVaultState>().record_activity();
        let _ = app.emit_to("main", NOTE_PENDING_EVENT, ());
    }
    Ok(result)
}

#[tauri::command]
pub fn inspect_capsule_submission(app: AppHandle, owner_id: String, context_id: String, node_id: String) -> Result<SubmissionResult, String> {
    let state = runtime(&app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let Some(owner) = ready_context(&guard, &owner_id, &context_id) else {
        return Ok(SubmissionResult::unknown());
    };
    if ensure_authority(&app, &owner.authority).is_err() {
        return Ok(SubmissionResult::unknown());
    }
    Ok(guard.submission.as_ref()
        .filter(|submission| submission.node_id == node_id && submission.context_id == context_id)
        .map(|submission| submission.result.clone()).unwrap_or_else(SubmissionResult::unknown))
}

#[tauri::command]
pub fn capsule_record_activity(app: AppHandle, owner_id: String, context_id: String) -> Result<(), String> {
    let state = runtime(&app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = ready_context(&guard, &owner_id, &context_id)
        .ok_or_else(|| "capsule_not_ready".to_owned())?;
    ensure_authority(&app, &owner.authority)?;
    app.state::<WorkspaceVaultState>().record_activity();
    Ok(())
}

#[tauri::command]
pub fn take_capsule_note(app: AppHandle, owner_id: String) -> Result<Option<CapsuleNoteInput>, String> {
    let authority = owner_authority(&app, &owner_id)?;
    let state = runtime(&app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard.owner.as_ref().filter(|owner| owner.ready && matches_owner(Some(owner), &authority))
        .ok_or_else(|| "capsule_not_ready".to_owned())?;
    ensure_authority(&app, &authority)?;
    let context_id = owner.context_id.clone();
    let Some(submission) = guard.submission.as_mut().filter(|submission| {
        submission.context_id == context_id && submission.result.status == SubmissionStatus::Queued
    }) else { return Ok(None); };
    ensure_authority(&app, &submission.authority)?;
    submission.result.status = SubmissionStatus::Processing;
    Ok(submission.input.clone())
}

fn claim_processing_commit(submission: &mut Submission) -> Result<(), String> {
    if submission.result.status != SubmissionStatus::Processing || submission.committing {
        return Err("capsule_commit_unknown".to_owned());
    }
    submission.committing = true;
    Ok(())
}

pub(crate) fn submission_authority(app: &AppHandle, owner_id: &str, node_id: &str, claim_commit: bool) -> Result<(OwnerAuthority, CapsuleNoteInput), String> {
    let state = runtime(app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let submission = guard.submission.as_ref().filter(|submission| {
        submission.authority.owner_id == owner_id && submission.node_id == node_id
            && submission.result.status == SubmissionStatus::Processing
    }).ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if ready_context(&guard, owner_id, &submission.context_id).is_none() {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, &submission.authority)?;
    let mut authority = submission.authority.clone();
    authority.context_id = Some(submission.context_id.clone());
    let input = submission.input.clone()
        .ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if claim_commit {
        claim_processing_commit(guard.submission.as_mut().expect("validated submission"))?;
    }
    Ok((authority, input))
}

pub(crate) fn ensure_submission(app: &AppHandle, authority: &OwnerAuthority, node_id: &str) -> Result<(), String> {
    let (current, _) = submission_authority(app, &authority.owner_id, node_id, false)?;
    if current.generation != authority.generation || current.context_id != authority.context_id {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, authority)
}

fn transition_processing_submission(guard: &mut CapsuleRuntime, authority: &OwnerAuthority, node_id: &str, result: SubmissionResult) -> Result<(), String> {
    let submission = guard.submission.as_mut().filter(|submission| {
        submission.authority.owner_id == authority.owner_id
            && submission.authority.generation == authority.generation
            && submission.node_id == node_id
            && authority.context_id.as_ref().is_none_or(|context| context == &submission.context_id)
            && submission.result.status == SubmissionStatus::Processing
    }).ok_or_else(|| "capsule_submission_expired".to_owned())?;
    submission.input = None;
    submission.result = result;
    submission.committing = false;
    Ok(())
}

pub(crate) fn finish_submission(app: &AppHandle, authority: &OwnerAuthority, node_id: &str, saved: bool) {
    if let Ok(mut guard) = runtime(app).runtime.lock() {
        let _ = transition_processing_submission(&mut guard, authority, node_id, SubmissionResult {
            status: if saved { SubmissionStatus::Saved } else { SubmissionStatus::Failed },
            reason: (!saved).then_some(RejectionReason::SaveFailed),
        });
    }
    emit_state_changed(app);
}

pub(crate) fn ensure_saved_submission(app: &AppHandle, authority: &OwnerAuthority, node_id: &str) -> Result<(), String> {
    let state = runtime(app);
    let guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    let submission = guard.submission.as_ref().filter(|submission| {
        submission.authority.owner_id == authority.owner_id
            && submission.authority.generation == authority.generation
            && submission.node_id == node_id
            && authority.context_id.as_ref().is_none_or(|context| context == &submission.context_id)
            && submission.result.status == SubmissionStatus::Saved
    }).ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if ready_context(&guard, &authority.owner_id, &submission.context_id).is_none() {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, authority)
}

#[tauri::command]
pub async fn commit_capsule_note(app: AppHandle, owner_id: String, node_id: String, contents: String) -> Result<workspace_file::CapsuleCommitResult, String> {
    if let Ok(authority) = owner_authority(&app, &owner_id) {
        if ensure_saved_submission(&app, &authority, &node_id).is_ok() {
            return Ok(workspace_file::CapsuleCommitResult::already_committed());
        }
    }
    let (authority, input) = submission_authority(&app, &owner_id, &node_id, true)?;
    let result = workspace_file::commit_capsule_contents(&app, &authority, input, contents).await;
    if result.is_err() {
        finish_submission(&app, &authority, &node_id, false);
    }
    result.map_err(|_| "capsule_commit_not_saved".to_owned())
}

#[tauri::command]
pub fn reject_capsule_note(app: AppHandle, owner_id: String, node_id: String, reason: RejectionReason) -> Result<(), String> {
    let (authority, _) = submission_authority(&app, &owner_id, &node_id, false)?;
    let state = runtime(&app);
    let mut guard = state.runtime.lock().map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !matches_owner(guard.owner.as_ref(), &authority) {
        return Err("workspace_owner_expired".to_owned());
    }
    ensure_authority(&app, &authority)?;
    if guard.submission.as_ref().is_some_and(|submission| submission.committing) {
        return Err("capsule_commit_unknown".to_owned());
    }
    transition_processing_submission(&mut guard, &authority, &node_id,
        SubmissionResult { status: SubmissionStatus::Failed, reason: Some(reason) })?;
    drop(guard);
    emit_state_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_capsule_window(app: AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(CAPSULE_LABEL) {
        Some(window) => window,
        None => {
            let builder = tauri::WebviewWindowBuilder::new(&app, CAPSULE_LABEL,
                tauri::WebviewUrl::App("index.html?capsule".into()))
                .title("Linked Info")
                .inner_size(220.0, 56.0)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true);
            // The current native target is Windows. Keep the opaque fallback
            // elsewhere without opting macOS into private transparency APIs.
            #[cfg(windows)]
            let builder = builder.transparent(true);
            let window = builder.build().map_err(|_| "capsule_window_unavailable".to_owned())?;
            let handle = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = handle.hide();
                }
            });
            window
        }
    };
    window.show().map_err(|_| "capsule_window_unavailable".to_owned())?;
    window.set_focus().map_err(|_| "capsule_window_unavailable".to_owned())
}

#[tauri::command]
pub fn set_capsule_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let window = app.get_webview_window(CAPSULE_LABEL)
        .ok_or_else(|| "capsule_window_unavailable".to_owned())?;
    let (width, height) = if expanded { (420.0, 360.0) } else { (220.0, 56.0) };
    window.set_size(tauri::LogicalSize::new(width, height))
        .map_err(|_| "capsule_window_unavailable".to_owned())
}

#[tauri::command]
pub fn hide_capsule_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(CAPSULE_LABEL)
        .ok_or_else(|| "capsule_window_unavailable".to_owned())?
        .hide().map_err(|_| "capsule_window_unavailable".to_owned())
}

#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main")
        .ok_or_else(|| "capsule_main_unavailable".to_owned())?;
    window.unminimize().map_err(|_| "capsule_main_unavailable".to_owned())?;
    window.show().map_err(|_| "capsule_main_unavailable".to_owned())?;
    window.set_focus().map_err(|_| "capsule_main_unavailable".to_owned())
}

#[tauri::command]
pub fn drag_capsule_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window(CAPSULE_LABEL)
        .ok_or_else(|| "capsule_window_unavailable".to_owned())?
        .start_dragging().map_err(|_| "capsule_window_unavailable".to_owned())
}

pub(crate) fn command_allowed(window_label: &str, webview_label: &str, command: &str) -> bool {
    if window_label != webview_label {
        return false;
    }
    match window_label {
        "main" => !matches!(command,
            "submit_capsule_note" | "inspect_capsule_submission" | "set_capsule_expanded"
                | "hide_capsule_window" | "drag_capsule_window" | "capsule_record_activity"),
        CAPSULE_LABEL => matches!(command,
            "inspect_capsule" | "submit_capsule_note" | "inspect_capsule_submission"
                | "set_capsule_expanded" | "hide_capsule_window" | "focus_main_window"
                | "drag_capsule_window" | "capsule_record_activity"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> OwnerAuthority {
        OwnerAuthority { owner_id: "owner".to_owned(), generation: 3, permit: None, context_id: None }
    }

    fn input() -> CapsuleNoteInput {
        CapsuleNoteInput {
            node_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            name: String::new(), content: "test note".to_owned(),
            captured_at_ms: 1_788_400_000_000, utc_offset_minutes: 480,
        }
    }

    #[test]
    fn capsule_command_allowlist_is_bound_to_real_window_and_webview_labels() {
        for command in ["read_workspace_file", "write_workspace_file", "unlock_workspace",
            "encrypt_workspace_export", "copy_secret_to_clipboard", "exit_application", "restart_application",
            "open_workspace_owner", "commit_capsule_note", "take_capsule_note"] {
            assert!(!command_allowed("capsule", "capsule", command));
            assert!(command_allowed("main", "main", command));
        }
        assert!(command_allowed("capsule", "capsule", "submit_capsule_note"));
        assert!(!command_allowed("main", "capsule", "read_workspace_file"));
        assert!(!command_allowed("untrusted", "untrusted", "inspect_capsule"));
    }

    #[test]
    fn duplicate_triggers_and_lost_receipts_use_one_bounded_submission() {
        let mut guard = CapsuleRuntime::default();
        let result = enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        assert_eq!(result.status, SubmissionStatus::Queued);
        let duplicate = enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        assert_eq!(duplicate.status, SubmissionStatus::Queued);
        let submission = guard.submission.as_mut().unwrap();
        submission.result.status = SubmissionStatus::Saved;
        submission.input = None;
        assert_eq!(enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap().status, SubmissionStatus::Saved);
        assert!(guard.submission.as_ref().unwrap().input.is_none());
        let mut changed = input();
        changed.content.push('!');
        assert!(enqueue_note(&mut guard, authority(), "context".to_owned(), changed).is_err());
    }

    #[test]
    fn processing_request_rejects_a_second_identity_and_failed_request_can_retry() {
        let mut guard = CapsuleRuntime::default();
        enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        let mut next = input();
        next.node_id = uuid::Uuid::new_v4().to_string();
        assert_eq!(enqueue_note(&mut guard, authority(), "context".to_owned(), next).unwrap().status, SubmissionStatus::Failed);
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Failed;
        assert_eq!(enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap().status, SubmissionStatus::Queued);
    }

    #[test]
    fn input_limits_and_unknown_fields_fail_closed() {
        let mut excessive = input();
        excessive.content = "x".repeat(100_001);
        assert!(excessive.fingerprint().is_err());
        let mut value = serde_json::to_value(input()).unwrap();
        value["unexpected"] = true.into();
        assert!(serde_json::from_value::<CapsuleNoteInput>(value).is_err());
    }

    #[test]
    fn plaintext_owners_are_generation_bound_and_replaced_owners_cannot_flush() {
        let original = authority();
        assert!(original.permit.is_none());
        assert!(authority_generation_matches(&original, 3));
        assert!(!authority_generation_matches(&original, 4));
        let mut exhausted = original.clone();
        exhausted.generation = u64::MAX;
        assert!(!authority_generation_matches(&exhausted, u64::MAX));
        let mut replacement = original.clone();
        replacement.owner_id = "replacement".to_owned();
        let owner = WorkspaceOwner { authority: replacement, context_id: "new-context".to_owned(), ready: true };
        assert!(!matches_owner(Some(&owner), &original));
        assert!(!matches_owner(None, &original));
    }

    #[test]
    fn replacement_context_rejects_late_requests_and_terminal_receipts_cannot_fail() {
        let mut guard = CapsuleRuntime::default();
        guard.owner = Some(WorkspaceOwner {
            authority: authority(), context_id: "new-context".to_owned(), ready: true,
        });
        assert!(ready_context(&guard, "owner", "old-context").is_none());
        assert!(ready_context(&guard, "owner", "new-context").is_some());
        let note = input();
        enqueue_note(&mut guard, authority(), "new-context".to_owned(), note.clone()).unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        transition_processing_submission(&mut guard, &authority(), &note.node_id,
            SubmissionResult { status: SubmissionStatus::Saved, reason: None }).unwrap();
        assert!(guard.submission.as_ref().unwrap().input.is_none());
        let failed = SubmissionResult { status: SubmissionStatus::Failed, reason: Some(RejectionReason::SaveFailed) };
        assert!(transition_processing_submission(&mut guard, &authority(), &note.node_id, failed.clone()).is_err());
        assert_eq!(guard.submission.as_ref().unwrap().result.status, SubmissionStatus::Saved);
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Unknown;
        assert!(transition_processing_submission(&mut guard, &authority(), &note.node_id, failed).is_err());
    }

    #[test]
    fn only_one_commit_can_claim_a_processing_request() {
        let mut guard = CapsuleRuntime::default();
        enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        let submission = guard.submission.as_mut().unwrap();
        submission.result.status = SubmissionStatus::Processing;
        assert!(claim_processing_commit(submission).is_ok());
        assert!(claim_processing_commit(submission).is_err());
        assert!(submission.committing);
        assert!(submission.input.is_some());
    }

    #[test]
    fn old_context_completion_cannot_settle_a_new_request_with_the_same_node_id() {
        let mut guard = CapsuleRuntime::default();
        let note = input();
        enqueue_note(&mut guard, authority(), "new-context".to_owned(), note.clone()).unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        let mut old_authority = authority();
        old_authority.context_id = Some("old-context".to_owned());
        assert!(transition_processing_submission(&mut guard, &old_authority, &note.node_id,
            SubmissionResult { status: SubmissionStatus::Saved, reason: None }).is_err());
        assert_eq!(guard.submission.as_ref().unwrap().result.status, SubmissionStatus::Processing);
        assert!(guard.submission.as_ref().unwrap().input.is_some());
    }

    #[test]
    fn next_note_does_not_revoke_a_completed_commit_in_the_same_owner_context() {
        let mut guard = CapsuleRuntime::default();
        guard.owner = Some(WorkspaceOwner {
            authority: authority(), context_id: "context".to_owned(), ready: true,
        });
        let first = input();
        let mut captured = authority();
        captured.context_id = Some("context".to_owned());
        enqueue_note(&mut guard, authority(), "context".to_owned(), first.clone()).unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        transition_processing_submission(&mut guard, &captured, &first.node_id,
            SubmissionResult { status: SubmissionStatus::Saved, reason: None }).unwrap();
        let mut second = input();
        second.node_id = uuid::Uuid::new_v4().to_string();
        enqueue_note(&mut guard, authority(), "context".to_owned(), second).unwrap();
        assert!(owner_context_matches(guard.owner.as_ref(), &captured));
        guard.owner.as_mut().unwrap().context_id = "replacement".to_owned();
        assert!(!owner_context_matches(guard.owner.as_ref(), &captured));
    }
}
