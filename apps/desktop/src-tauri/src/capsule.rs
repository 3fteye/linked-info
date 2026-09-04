use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Mutex, atomic::Ordering};
use tauri::{AppHandle, Emitter, Manager};
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

use crate::capture_archive::{self, CaptureClaim};
use crate::workspace_file::{self, WorkspaceAccessPermit, WorkspaceVaultState};

const CAPSULE_LABEL: &str = "capsule";
const STATE_CHANGED_EVENT: &str = "capsule-state-changed";

#[derive(Clone)]
pub(crate) struct OwnerAuthority {
    pub(crate) owner_id: String,
    pub(crate) generation: u64,
    pub(crate) permit: Option<WorkspaceAccessPermit>,
    context_id: Option<String>,
}

struct WorkspaceOwner {
    authority: OwnerAuthority,
    request: OwnerOpenRequest,
    context_id: String,
    ready: bool,
}

#[derive(Clone)]
struct OwnerOpenRequest {
    request_id: String,
    sequence: u64,
    access_generation: u64,
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
    pub(crate) fn fingerprint(&self) -> Result<[u8; 32], String> {
        let id =
            uuid::Uuid::parse_str(&self.node_id).map_err(|_| "capsule_invalid_input".to_owned())?;
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

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
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

struct Submission {
    authority: OwnerAuthority,
    context_id: String,
    node_id: String,
    fingerprint: [u8; 32],
    input: Option<CapsuleNoteInput>,
    result: SubmissionResult,
    committing: bool,
    claim: Option<CaptureClaim>,
    pending_rejection: Option<RejectionReason>,
}

#[derive(Default)]
struct CapsuleRuntime {
    owner: Option<WorkspaceOwner>,
    submission: Option<Submission>,
    quarantined: bool,
    latest_owner_request_sequence: u64,
    latest_owner_request_id: Option<String>,
    pending_owner_open: Option<OwnerOpenRequest>,
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
    with_owner_authority(app, owner_id, |authority| {
        ensure_authority(app, authority)?;
        Ok(authority.clone())
    })
}

/// Identity-only gate: the caller must validate the original generation and
/// permit before accepting authority. Immediate lock admission must keep its
/// closure memory-only, in capsule -> data-key lock order, with no file lock.
pub(crate) fn with_owner_authority<T>(
    app: &AppHandle,
    owner_id: &str,
    accept: impl FnOnce(&OwnerAuthority) -> Result<T, String>,
) -> Result<T, String> {
    let state = runtime(app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard
        .owner
        .as_ref()
        .filter(|owner| owner.authority.owner_id == owner_id)
        .ok_or_else(|| "workspace_owner_expired".to_owned())?;
    accept(&owner.authority)
}

/// Retain only the fixed in-flight capture alongside the lock snapshot ticket.
/// The caller's admission remains memory-only, in owner -> data-key lock order.
pub(crate) fn with_lock_snapshot_authority<T>(
    app: &AppHandle,
    owner_id: &str,
    accept: impl FnOnce(&OwnerAuthority) -> Result<T, String>,
) -> Result<(T, Option<(CaptureClaim, CapsuleNoteInput)>), String> {
    let state = runtime(app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard
        .owner
        .as_ref()
        .filter(|owner| owner.authority.owner_id == owner_id)
        .ok_or_else(|| "workspace_owner_expired".to_owned())?;
    let capture = guard.submission.as_ref().and_then(|submission| {
        (submission.authority.owner_id == owner_id
            && submission.context_id == owner.context_id
            && submission.result.status == SubmissionStatus::Processing)
            .then(|| Some((submission.claim.clone()?, submission.input.clone()?)))
            .flatten()
    });
    Ok((accept(&owner.authority)?, capture))
}

pub(crate) fn is_quarantined(app: &AppHandle) -> bool {
    runtime(app)
        .runtime
        .lock()
        .map(|guard| guard.quarantined)
        .unwrap_or(true)
}

pub(crate) fn ensure_owner(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let state = runtime(app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    if !matches_owner(guard.owner.as_ref(), authority) {
        return Err("workspace_owner_expired".to_owned());
    }
    ensure_authority(app, authority)
}

fn owner_context_matches(owner: Option<&WorkspaceOwner>, authority: &OwnerAuthority) -> bool {
    matches_owner(owner, authority)
        && owner.is_some_and(|owner| {
            owner.ready && authority.context_id.as_ref() == Some(&owner.context_id)
        })
}

pub(crate) fn ensure_owner_context(
    app: &AppHandle,
    authority: &OwnerAuthority,
) -> Result<(), String> {
    let state = runtime(app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
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
        let had_owner = guard.owner.is_some() || guard.pending_owner_open.is_some();
        guard.owner = None;
        guard.submission = None;
        guard.pending_owner_open = None;
        had_owner
    } else {
        false
    };
    emit_state_changed(app);
    had_owner
}

pub(crate) fn quarantine(app: &AppHandle) {
    if let Ok(mut guard) = runtime(app).runtime.lock() {
        guard.quarantined = true;
        guard.owner = None;
        guard.submission = None;
        guard.pending_owner_open = None;
    }
    emit_state_changed(app);
}

pub(crate) fn suspend_owner(app: &AppHandle, authority: &OwnerAuthority) -> Result<(), String> {
    let state = runtime(app);
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
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

fn parse_owner_request(request_id: &str, sequence: &str) -> Result<u64, String> {
    let id = uuid::Uuid::parse_str(request_id)
        .map_err(|_| "workspace_owner_request_invalid".to_owned())?;
    let parsed = sequence
        .parse::<u64>()
        .map_err(|_| "workspace_owner_request_invalid".to_owned())?;
    if id.to_string() != request_id || parsed == 0 || parsed.to_string() != sequence {
        return Err("workspace_owner_request_invalid".to_owned());
    }
    Ok(parsed)
}

fn admit_owner_open(
    guard: &mut CapsuleRuntime,
    request_id: String,
    sequence: u64,
    access_generation: u64,
) -> Result<OwnerOpenRequest, String> {
    if guard.quarantined {
        return Err("workspace_owner_recovery_required".to_owned());
    }
    if sequence <= guard.latest_owner_request_sequence || access_generation == u64::MAX {
        return Err("workspace_owner_request_expired".to_owned());
    }
    let request = OwnerOpenRequest {
        request_id,
        sequence,
        access_generation,
    };
    guard.latest_owner_request_sequence = sequence;
    guard.latest_owner_request_id = Some(request.request_id.clone());
    guard.pending_owner_open = Some(request.clone());
    guard.owner = None;
    guard.submission = None;
    Ok(request)
}

fn ensure_owner_open(
    guard: &CapsuleRuntime,
    request: &OwnerOpenRequest,
    current_generation: u64,
) -> Result<(), String> {
    if guard.quarantined {
        return Err("workspace_owner_recovery_required".to_owned());
    }
    if current_generation == u64::MAX
        || current_generation != request.access_generation
        || !guard.pending_owner_open.as_ref().is_some_and(|pending| {
            pending.sequence == request.sequence && pending.request_id == request.request_id
        })
    {
        return Err("workspace_owner_request_expired".to_owned());
    }
    Ok(())
}

fn cancel_owner_request(
    guard: &mut CapsuleRuntime,
    request_id: &str,
    sequence: u64,
    owner_id: Option<&str>,
) -> Result<(), String> {
    if sequence > guard.latest_owner_request_sequence {
        // Disposal can arrive before the async open command is first polled.
        guard.latest_owner_request_sequence = sequence;
        guard.latest_owner_request_id = Some(request_id.to_owned());
        guard.pending_owner_open = None;
    } else if sequence == guard.latest_owner_request_sequence {
        if guard.latest_owner_request_id.as_deref() != Some(request_id) {
            return Err("workspace_owner_request_invalid".to_owned());
        }
        guard.pending_owner_open = None;
    }
    if guard.owner.as_ref().is_some_and(|owner| {
        owner.request.sequence == sequence
            && owner.request.request_id == request_id
            && owner_id.is_none_or(|id| owner.authority.owner_id == id)
    }) {
        guard.owner = None;
        guard.submission = None;
    }
    Ok(())
}

fn install_owner_open(
    guard: &mut CapsuleRuntime,
    request: OwnerOpenRequest,
    authority: &OwnerAuthority,
    current_generation: u64,
    validate: impl FnOnce(&OwnerAuthority) -> Result<(), String>,
) -> Result<(), String> {
    ensure_owner_open(guard, &request, current_generation)?;
    validate(authority)?;
    guard.pending_owner_open = None;
    guard.owner = Some(WorkspaceOwner {
        authority: authority.clone(),
        request,
        context_id: uuid::Uuid::new_v4().to_string(),
        ready: false,
    });
    guard.submission = None;
    Ok(())
}

#[tauri::command]
pub async fn open_workspace_owner(
    app: AppHandle,
    request_id: String,
    request_sequence: String,
) -> Result<WorkspaceOwnerReceipt, String> {
    let sequence = parse_owner_request(&request_id, &request_sequence)?;
    // Admission is independent of the blocking file queue. Client order also
    // rejects an older async invocation that is first polled after a newer one.
    let request = {
        let state = runtime(&app);
        let mut guard = state
            .runtime
            .lock()
            .map_err(|_| "capsule_state_unavailable".to_owned())?;
        let generation = app
            .state::<WorkspaceVaultState>()
            .access_generation()
            .load(Ordering::Acquire);
        admit_owner_open(&mut guard, request_id, sequence, generation)?
    };
    emit_state_changed(&app);
    let operation_lock = app.state::<WorkspaceVaultState>().operation_lock();
    let app_for_open = app.clone();
    let authority = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        let vault = app_for_open.state::<WorkspaceVaultState>();
        {
            let state = runtime(&app_for_open);
            let guard = state
                .runtime
                .lock()
                .map_err(|_| "capsule_state_unavailable".to_owned())?;
            ensure_owner_open(
                &guard,
                &request,
                vault.access_generation().load(Ordering::Acquire),
            )?;
        }
        let permit = workspace_file::begin_workspace_access(&app_for_open, &vault)?;
        let authority = OwnerAuthority {
            owner_id: uuid::Uuid::new_v4().to_string(),
            generation: request.access_generation,
            permit,
            context_id: None,
        };
        // No owner may load a snapshot until a prior process's fixed capture
        // has been reconciled under the same file-operation lock as writes.
        ensure_authority(&app_for_open, &authority)?;
        if let Err(error) = workspace_file::recover_capture_archive(&app_for_open) {
            ensure_authority(&app_for_open, &authority)?;
            if error != "capture_busy" {
                quarantine(&app_for_open);
                return Err("workspace_owner_recovery_required".to_owned());
            }
            return Err(error);
        }
        let state = runtime(&app_for_open);
        let mut guard = state
            .runtime
            .lock()
            .map_err(|_| "capsule_state_unavailable".to_owned())?;
        // This also observes the pending lock-save admission barrier, while
        // holding the same short capsule mutex as snapshot admission.
        install_owner_open(
            &mut guard,
            request,
            &authority,
            vault.access_generation().load(Ordering::Acquire),
            |authority| ensure_authority(&app_for_open, authority),
        )?;
        Ok::<_, String>(authority)
    })
    .await
    .map_err(|_| "workspace_owner_unavailable".to_owned())??;
    ensure_owner(&app, &authority)?;
    emit_state_changed(&app);
    Ok(WorkspaceOwnerReceipt {
        owner_id: authority.owner_id,
    })
}

#[tauri::command]
pub fn close_workspace_owner(
    app: AppHandle,
    request_id: String,
    request_sequence: String,
    owner_id: Option<String>,
) -> Result<(), String> {
    let sequence = parse_owner_request(&request_id, &request_sequence)?;
    let state = runtime(&app);
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    cancel_owner_request(&mut guard, &request_id, sequence, owner_id.as_deref())?;
    drop(guard);
    emit_state_changed(&app);
    Ok(())
}

#[tauri::command]
pub fn set_workspace_owner_ready(
    app: AppHandle,
    owner_id: String,
    ready: bool,
) -> Result<(), String> {
    let authority = owner_authority(&app, &owner_id)?;
    if !ready {
        return suspend_owner(&app, &authority);
    }
    let state = runtime(&app);
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
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

/// Existing owner status remains main-only. No capture application command can
/// reach this runtime or receive workspace authority through the shared inbox.
#[tauri::command]
pub fn inspect_capsule(app: AppHandle) -> Result<CapsuleStatus, String> {
    let state = runtime(&app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    let owner = guard
        .owner
        .as_ref()
        .filter(|owner| ensure_authority(&app, &owner.authority).is_ok());
    Ok(CapsuleStatus {
        owner_id: owner.map(|owner| owner.authority.owner_id.clone()),
        context_id: owner.map(|owner| owner.context_id.clone()),
        ready: owner.is_some_and(|owner| owner.ready),
        encrypted: workspace_file::workspace_encryption_configured(&app),
    })
}

fn ready_context<'a>(
    guard: &'a CapsuleRuntime,
    owner_id: &str,
    context_id: &str,
) -> Option<&'a WorkspaceOwner> {
    guard.owner.as_ref().filter(|owner| {
        owner.ready && owner.authority.owner_id == owner_id && owner.context_id == context_id
    })
}

fn enqueue_note(
    guard: &mut CapsuleRuntime,
    authority: OwnerAuthority,
    context_id: String,
    input: CapsuleNoteInput,
) -> Result<SubmissionResult, String> {
    let fingerprint = input.fingerprint()?;
    if let Some(previous) = guard.submission.as_ref() {
        if previous.node_id == input.node_id {
            if previous.fingerprint != fingerprint {
                return Err("capsule_identity_conflict".to_owned());
            }
            if previous.result.status != SubmissionStatus::Failed {
                return Ok(previous.result.clone());
            }
        } else if matches!(
            previous.result.status,
            SubmissionStatus::Queued | SubmissionStatus::Processing | SubmissionStatus::Unknown
        ) {
            return Ok(SubmissionResult {
                status: SubmissionStatus::Failed,
                reason: Some(RejectionReason::Busy),
            });
        }
    }
    let result = SubmissionResult {
        status: SubmissionStatus::Queued,
        reason: None,
    };
    guard.submission = Some(Submission {
        authority,
        context_id,
        node_id: input.node_id.clone(),
        fingerprint,
        input: Some(input),
        result: result.clone(),
        committing: false,
        claim: None,
        pending_rejection: None,
    });
    Ok(result)
}

#[tauri::command]
pub async fn take_capsule_note(
    app: AppHandle,
    owner_id: String,
) -> Result<Option<CapsuleNoteInput>, String> {
    let mut authority = owner_authority(&app, &owner_id)?;
    {
        let state = runtime(&app);
        let guard = state
            .runtime
            .lock()
            .map_err(|_| "capsule_state_unavailable".to_owned())?;
        let owner = guard
            .owner
            .as_ref()
            .filter(|owner| owner.ready && matches_owner(Some(owner), &authority))
            .ok_or_else(|| "capsule_not_ready".to_owned())?;
        authority.context_id = Some(owner.context_id.clone());
    }
    let operation_lock = app.state::<WorkspaceVaultState>().operation_lock();
    let app_for_take = app.clone();
    let authority_for_take = authority.clone();
    let input = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        ensure_owner_context(&app_for_take, &authority_for_take)?;
        let pending_rejection = {
            let state = runtime(&app_for_take);
            let guard = state
                .runtime
                .lock()
                .map_err(|_| "capsule_state_unavailable".to_owned())?;
            next_rejection(&guard)
        };
        if let Some((node_id, reason)) = pending_rejection {
            let result = attempt_rejection(&app_for_take, &authority_for_take, &node_id, reason);
            return match result {
                Ok(()) => Ok(None),
                Err(error) if matches!(error.as_str(), "capture_busy" | "capture_io") => Ok(None),
                Err(error) => Err(error),
            };
        }
        {
            let state = runtime(&app_for_take);
            let guard = state
                .runtime
                .lock()
                .map_err(|_| "capsule_state_unavailable".to_owned())?;
            if guard.submission.as_ref().is_some_and(|submission| {
                matches!(
                    submission.result.status,
                    SubmissionStatus::Processing | SubmissionStatus::Unknown
                )
            }) {
                return Ok(None);
            }
        }
        // A context suspended before commit leaves its durable claim intact.
        // No worker can still write it while this file lock is held.
        if let Err(error) = workspace_file::recover_capture_archive(&app_for_take) {
            ensure_owner_context(&app_for_take, &authority_for_take)?;
            if error == "capture_busy" {
                return Ok(None);
            }
            quarantine(&app_for_take);
            workspace_file::lock_workspace_runtime(&app_for_take, "capsule_recovery_required");
            return Err(error);
        }
        let claimed = capture_archive::with_inbox(&app_for_take, |inbox| {
            inbox.claim_next().map_err(capture_archive::inbox_error)
        })?;
        let Some(claimed) = claimed else {
            return Ok(None);
        };
        let (claim, input) = capture_archive::claimed_input(&claimed)?;
        let accepted = (|| {
            let state = runtime(&app_for_take);
            let mut guard = state
                .runtime
                .lock()
                .map_err(|_| "capsule_state_unavailable".to_owned())?;
            if !owner_context_matches(guard.owner.as_ref(), &authority_for_take) {
                return Err("capsule_submission_expired".to_owned());
            }
            ensure_authority(&app_for_take, &authority_for_take)?;
            guard.submission = None;
            enqueue_note(
                &mut guard,
                authority_for_take.clone(),
                authority_for_take
                    .context_id
                    .clone()
                    .expect("ready context"),
                input.clone(),
            )?;
            let submission = guard.submission.as_mut().expect("enqueued capture");
            submission.claim = Some(claim.clone());
            submission.result.status = SubmissionStatus::Processing;
            Ok(Some(input))
        })();
        if accepted.is_err() {
            let _ = capture_archive::with_inbox(&app_for_take, |inbox| {
                inbox
                    .release_claim(&claim.id, claim.revision, &claim.claim_id)
                    .map_err(capture_archive::inbox_error)
            });
        }
        accepted
    })
    .await
    .map_err(|_| "capsule_state_unavailable".to_owned())??;
    ensure_owner_context(&app, &authority)?;
    Ok(input)
}

fn claim_processing_commit(submission: &mut Submission) -> Result<(), String> {
    if submission.result.status != SubmissionStatus::Processing
        || submission.committing
        || submission.pending_rejection.is_some()
    {
        return Err("capsule_commit_unknown".to_owned());
    }
    submission.committing = true;
    Ok(())
}

pub(crate) fn submission_authority(
    app: &AppHandle,
    owner_id: &str,
    node_id: &str,
    claim_commit: bool,
) -> Result<(OwnerAuthority, CapsuleNoteInput, CaptureClaim), String> {
    let state = runtime(app);
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    let submission = guard
        .submission
        .as_ref()
        .filter(|submission| {
            submission.authority.owner_id == owner_id
                && submission.node_id == node_id
                && submission.result.status == SubmissionStatus::Processing
        })
        .ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if ready_context(&guard, owner_id, &submission.context_id).is_none() {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, &submission.authority)?;
    let mut authority = submission.authority.clone();
    authority.context_id = Some(submission.context_id.clone());
    let input = submission
        .input
        .clone()
        .ok_or_else(|| "capsule_submission_expired".to_owned())?;
    let claim = submission
        .claim
        .clone()
        .ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if claim_commit {
        claim_processing_commit(guard.submission.as_mut().expect("validated submission"))?;
    }
    Ok((authority, input, claim))
}

pub(crate) fn ensure_submission(
    app: &AppHandle,
    authority: &OwnerAuthority,
    node_id: &str,
) -> Result<(), String> {
    let (current, _, _) = submission_authority(app, &authority.owner_id, node_id, false)?;
    if current.generation != authority.generation || current.context_id != authority.context_id {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, authority)
}

fn processing_submission<'a>(
    guard: &'a mut CapsuleRuntime,
    authority: &OwnerAuthority,
    node_id: &str,
) -> Result<&'a mut Submission, String> {
    guard
        .submission
        .as_mut()
        .filter(|submission| {
            submission.authority.owner_id == authority.owner_id
                && submission.authority.generation == authority.generation
                && submission.node_id == node_id
                && authority
                    .context_id
                    .as_ref()
                    .is_none_or(|context| context == &submission.context_id)
                && submission.result.status == SubmissionStatus::Processing
        })
        .ok_or_else(|| "capsule_submission_expired".to_owned())
}

fn transition_processing_submission(
    guard: &mut CapsuleRuntime,
    authority: &OwnerAuthority,
    node_id: &str,
    result: SubmissionResult,
) -> Result<(), String> {
    let submission = processing_submission(guard, authority, node_id)?;
    submission.input = None;
    submission.result = result;
    submission.committing = false;
    submission.pending_rejection = None;
    Ok(())
}

fn retain_failed_commit_for_rejection(
    guard: &mut CapsuleRuntime,
    authority: &OwnerAuthority,
    node_id: &str,
) -> Result<(), String> {
    let submission = processing_submission(guard, authority, node_id)?;
    submission.committing = false;
    submission.pending_rejection = Some(RejectionReason::SaveFailed);
    Ok(())
}

fn reserve_rejection(submission: &mut Submission, reason: RejectionReason) -> Result<(), String> {
    if submission.committing
        || submission.result.status != SubmissionStatus::Processing
        || submission
            .pending_rejection
            .is_some_and(|pending| pending != reason)
    {
        return Err("capsule_commit_unknown".to_owned());
    }
    submission.pending_rejection = Some(reason);
    submission.committing = true;
    Ok(())
}

fn next_rejection(guard: &CapsuleRuntime) -> Option<(String, RejectionReason)> {
    guard.submission.as_ref().and_then(|submission| {
        submission
            .pending_rejection
            .map(|reason| (submission.node_id.clone(), reason))
    })
}

fn settle_rejection_attempt(
    guard: &mut CapsuleRuntime,
    authority: &OwnerAuthority,
    node_id: &str,
    reason: RejectionReason,
    result: &Result<(), String>,
) -> Result<(), String> {
    let submission = processing_submission(guard, authority, node_id)?;
    submission.committing = false;
    if result.is_ok() {
        transition_processing_submission(
            guard,
            authority,
            node_id,
            SubmissionResult {
                status: SubmissionStatus::Failed,
                reason: Some(reason),
            },
        )?;
    }
    Ok(())
}

/// Caller holds the workspace file-operation lock. Reserving and releasing the
/// broker takes only short mutex sections; SQLite I/O never delays revocation.
fn attempt_rejection(
    app: &AppHandle,
    authority: &OwnerAuthority,
    node_id: &str,
    reason: RejectionReason,
) -> Result<(), String> {
    let (input, claim) = {
        let state = runtime(app);
        let mut guard = state
            .runtime
            .lock()
            .map_err(|_| "capsule_state_unavailable".to_owned())?;
        if !owner_context_matches(guard.owner.as_ref(), authority) {
            return Err("capsule_submission_expired".to_owned());
        }
        ensure_authority(app, authority)?;
        let submission = processing_submission(&mut guard, authority, node_id)?;
        let input = submission
            .input
            .clone()
            .ok_or_else(|| "capsule_submission_expired".to_owned())?;
        let claim = submission
            .claim
            .clone()
            .ok_or_else(|| "capsule_submission_expired".to_owned())?;
        reserve_rejection(submission, reason)?;
        (input, claim)
    };
    let result = workspace_file::reject_capture_input(app, &claim, &input, reason);
    if let Ok(mut guard) = runtime(app).runtime.lock() {
        let _ = settle_rejection_attempt(&mut guard, authority, node_id, reason, &result);
    }
    if result
        .as_ref()
        .is_err_and(|error| !matches!(error.as_str(), "capture_busy" | "capture_io"))
    {
        quarantine(app);
        workspace_file::lock_workspace_runtime(app, "capsule_recovery_required");
    }
    result
}

pub(crate) fn finish_saved_submission(app: &AppHandle, authority: &OwnerAuthority, node_id: &str) {
    if let Ok(mut guard) = runtime(app).runtime.lock() {
        let _ = transition_processing_submission(
            &mut guard,
            authority,
            node_id,
            SubmissionResult {
                status: SubmissionStatus::Saved,
                reason: None,
            },
        );
    }
    emit_state_changed(app);
}

pub(crate) fn ensure_saved_submission(
    app: &AppHandle,
    authority: &OwnerAuthority,
    node_id: &str,
) -> Result<(), String> {
    let state = runtime(app);
    let guard = state
        .runtime
        .lock()
        .map_err(|_| "capsule_state_unavailable".to_owned())?;
    let submission = guard
        .submission
        .as_ref()
        .filter(|submission| {
            submission.authority.owner_id == authority.owner_id
                && submission.authority.generation == authority.generation
                && submission.node_id == node_id
                && authority
                    .context_id
                    .as_ref()
                    .is_none_or(|context| context == &submission.context_id)
                && submission.result.status == SubmissionStatus::Saved
        })
        .ok_or_else(|| "capsule_submission_expired".to_owned())?;
    if ready_context(&guard, &authority.owner_id, &submission.context_id).is_none() {
        return Err("capsule_submission_expired".to_owned());
    }
    ensure_authority(app, authority)
}

#[tauri::command]
pub async fn commit_capsule_note(
    app: AppHandle,
    owner_id: String,
    node_id: String,
    contents: String,
) -> Result<workspace_file::CapsuleCommitResult, String> {
    if let Ok(authority) = owner_authority(&app, &owner_id) {
        if ensure_saved_submission(&app, &authority, &node_id).is_ok() {
            return Ok(workspace_file::CapsuleCommitResult::already_committed());
        }
    }
    let (authority, input, claim) = submission_authority(&app, &owner_id, &node_id, true)?;
    let result =
        workspace_file::commit_capsule_contents(&app, &authority, input, claim, contents).await;
    if result.is_err() {
        if let Ok(mut guard) = runtime(&app).runtime.lock() {
            let _ = retain_failed_commit_for_rejection(&mut guard, &authority, &node_id);
        }
        // Do not publish a terminal in-memory failure before the fixed inbox
        // revision has a durable failure. Polling retries Busy/IO rejection.
        let _ =
            reject_capsule_note(app.clone(), owner_id, node_id, RejectionReason::SaveFailed).await;
    }
    result.map_err(|_| "capsule_commit_not_saved".to_owned())
}

#[tauri::command]
pub async fn reject_capsule_note(
    app: AppHandle,
    owner_id: String,
    node_id: String,
    reason: RejectionReason,
) -> Result<(), String> {
    let (authority, _, _) = submission_authority(&app, &owner_id, &node_id, false)?;
    let operation_lock = app.state::<WorkspaceVaultState>().operation_lock();
    let app_for_reject = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _operation = operation_lock
            .lock()
            .map_err(|_| "workspace_vault_operation_unavailable".to_owned())?;
        attempt_rejection(&app_for_reject, &authority, &node_id, reason)
    })
    .await;
    match result {
        Ok(result) => result?,
        Err(_) => {
            quarantine(&app);
            workspace_file::lock_workspace_runtime(&app, "capsule_recovery_required");
            return Err("capture_recovery_required".to_owned());
        }
    }
    emit_state_changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn open_capsule_window() -> Result<(), String> {
    let executable = std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .ok_or_else(|| "capsule_window_unavailable".to_owned())?
        .join(if cfg!(windows) {
            "linked-info-capture.exe"
        } else {
            "linked-info-capture"
        });
    // No shell, caller-provided path, workspace argument or parent-exit kill
    // handle. The independent application's single-instance plugin focuses it.
    let mut command = std::process::Command::new(executable);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console helper.
    }
    let mut child = command
        .spawn()
        .map_err(|_| "capsule_window_unavailable".to_owned())?;
    // Reap on Unix while the main process lives, without coupling exits: this
    // detached thread is neither joined nor used to terminate the capture app.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
pub fn focus_main_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "capsule_main_unavailable".to_owned())?;
    window
        .unminimize()
        .map_err(|_| "capsule_main_unavailable".to_owned())?;
    window
        .show()
        .map_err(|_| "capsule_main_unavailable".to_owned())?;
    window
        .set_focus()
        .map_err(|_| "capsule_main_unavailable".to_owned())
}

pub(crate) fn command_allowed(window_label: &str, webview_label: &str, command: &str) -> bool {
    if window_label != webview_label {
        return false;
    }
    window_label == "main"
        && !matches!(
            command,
            "submit_capsule_note"
                | "inspect_capsule_submission"
                | "set_capsule_expanded"
                | "hide_capsule_window"
                | "drag_capsule_window"
                | "capsule_record_activity"
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authority() -> OwnerAuthority {
        OwnerAuthority {
            owner_id: "owner".to_owned(),
            generation: 3,
            permit: None,
            context_id: None,
        }
    }

    fn open_request(sequence: u64, access_generation: u64) -> OwnerOpenRequest {
        OwnerOpenRequest {
            request_id: format!("00000000-0000-4000-8000-{sequence:012}"),
            sequence,
            access_generation,
        }
    }

    fn input() -> CapsuleNoteInput {
        CapsuleNoteInput {
            node_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            name: String::new(),
            content: "test note".to_owned(),
            captured_at_ms: 1_788_400_000_000,
            utc_offset_minutes: 480,
        }
    }

    #[test]
    fn capsule_command_allowlist_is_bound_to_real_window_and_webview_labels() {
        for command in [
            "read_workspace_file",
            "write_workspace_file",
            "unlock_workspace",
            "encrypt_workspace_export",
            "copy_secret_to_clipboard",
            "exit_application",
            "restart_application",
            "open_workspace_owner",
            "commit_capsule_note",
            "take_capsule_note",
        ] {
            assert!(!command_allowed("capsule", "capsule", command));
            assert!(command_allowed("main", "main", command));
        }
        assert!(!command_allowed(
            "capsule",
            "capsule",
            "submit_capsule_note"
        ));
        assert!(!command_allowed("main", "capsule", "read_workspace_file"));
        assert!(!command_allowed(
            "untrusted",
            "untrusted",
            "inspect_capsule"
        ));
    }

    #[test]
    fn duplicate_triggers_and_lost_receipts_use_one_bounded_submission() {
        let mut guard = CapsuleRuntime::default();
        let result = enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        assert_eq!(result.status, SubmissionStatus::Queued);
        let duplicate =
            enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        assert_eq!(duplicate.status, SubmissionStatus::Queued);
        let submission = guard.submission.as_mut().unwrap();
        submission.result.status = SubmissionStatus::Saved;
        submission.input = None;
        assert_eq!(
            enqueue_note(&mut guard, authority(), "context".to_owned(), input())
                .unwrap()
                .status,
            SubmissionStatus::Saved
        );
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
        assert_eq!(
            enqueue_note(&mut guard, authority(), "context".to_owned(), next)
                .unwrap()
                .status,
            SubmissionStatus::Failed
        );
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Failed;
        assert_eq!(
            enqueue_note(&mut guard, authority(), "context".to_owned(), input())
                .unwrap()
                .status,
            SubmissionStatus::Queued
        );
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
        let owner = WorkspaceOwner {
            authority: replacement,
            request: open_request(1, 3),
            context_id: "new-context".to_owned(),
            ready: true,
        };
        assert!(!matches_owner(Some(&owner), &original));
        assert!(!matches_owner(None, &original));
    }

    #[test]
    fn replacement_context_rejects_late_requests_and_terminal_receipts_cannot_fail() {
        let mut guard = CapsuleRuntime::default();
        guard.owner = Some(WorkspaceOwner {
            authority: authority(),
            request: open_request(1, 3),
            context_id: "new-context".to_owned(),
            ready: true,
        });
        assert!(ready_context(&guard, "owner", "old-context").is_none());
        assert!(ready_context(&guard, "owner", "new-context").is_some());
        let note = input();
        enqueue_note(
            &mut guard,
            authority(),
            "new-context".to_owned(),
            note.clone(),
        )
        .unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        transition_processing_submission(
            &mut guard,
            &authority(),
            &note.node_id,
            SubmissionResult {
                status: SubmissionStatus::Saved,
                reason: None,
            },
        )
        .unwrap();
        assert!(guard.submission.as_ref().unwrap().input.is_none());
        let failed = SubmissionResult {
            status: SubmissionStatus::Failed,
            reason: Some(RejectionReason::SaveFailed),
        };
        assert!(
            transition_processing_submission(
                &mut guard,
                &authority(),
                &note.node_id,
                failed.clone()
            )
            .is_err()
        );
        assert_eq!(
            guard.submission.as_ref().unwrap().result.status,
            SubmissionStatus::Saved
        );
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Unknown;
        assert!(
            transition_processing_submission(&mut guard, &authority(), &note.node_id, failed)
                .is_err()
        );
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
    fn known_unsaved_commit_keeps_input_until_its_durable_rejection() {
        let mut guard = CapsuleRuntime::default();
        let note = input();
        enqueue_note(&mut guard, authority(), "context".to_owned(), note.clone()).unwrap();
        let submission = guard.submission.as_mut().unwrap();
        submission.result.status = SubmissionStatus::Processing;
        claim_processing_commit(submission).unwrap();

        retain_failed_commit_for_rejection(&mut guard, &authority(), &note.node_id).unwrap();
        let submission = guard.submission.as_mut().unwrap();
        assert_eq!(submission.result.status, SubmissionStatus::Processing);
        assert!(submission.input.is_some());
        assert!(!submission.committing);
        assert!(claim_processing_commit(submission).is_err());
        assert_eq!(
            next_rejection(&guard),
            Some((note.node_id.clone(), RejectionReason::SaveFailed))
        );

        reserve_rejection(
            guard.submission.as_mut().unwrap(),
            RejectionReason::SaveFailed,
        )
        .unwrap();
        settle_rejection_attempt(
            &mut guard,
            &authority(),
            &note.node_id,
            RejectionReason::SaveFailed,
            &Ok(()),
        )
        .unwrap();
        assert_eq!(
            guard.submission.as_ref().unwrap().result.status,
            SubmissionStatus::Failed
        );
        assert!(guard.submission.as_ref().unwrap().input.is_none());
        assert!(next_rejection(&guard).is_none());
    }

    #[test]
    fn busy_rejection_unreserves_the_slot_and_polling_retries_the_same_reason() {
        for reason in [RejectionReason::DuplicateName, RejectionReason::Busy] {
            let mut guard = CapsuleRuntime::default();
            let note = input();
            enqueue_note(&mut guard, authority(), "context".to_owned(), note.clone()).unwrap();
            guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
            reserve_rejection(guard.submission.as_mut().unwrap(), reason).unwrap();
            settle_rejection_attempt(
                &mut guard,
                &authority(),
                &note.node_id,
                reason,
                &Err("capture_busy".to_owned()),
            )
            .unwrap();

            let submission = guard.submission.as_mut().unwrap();
            assert!(!submission.committing);
            assert!(submission.input.is_some());
            assert!(claim_processing_commit(submission).is_err());
            assert_eq!(next_rejection(&guard), Some((note.node_id.clone(), reason)));

            reserve_rejection(guard.submission.as_mut().unwrap(), reason).unwrap();
            settle_rejection_attempt(&mut guard, &authority(), &note.node_id, reason, &Ok(()))
                .unwrap();
            assert!(next_rejection(&guard).is_none());
            assert_eq!(
                guard.submission.as_ref().unwrap().result.status,
                SubmissionStatus::Failed
            );
        }
    }

    #[test]
    fn late_rejection_failure_cannot_unreserve_a_new_owner_context() {
        let mut guard = CapsuleRuntime::default();
        let note = input();
        enqueue_note(
            &mut guard,
            authority(),
            "new-context".to_owned(),
            note.clone(),
        )
        .unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        reserve_rejection(guard.submission.as_mut().unwrap(), RejectionReason::Empty).unwrap();
        let mut old = authority();
        old.context_id = Some("old-context".to_owned());
        assert!(
            settle_rejection_attempt(
                &mut guard,
                &old,
                &note.node_id,
                RejectionReason::Empty,
                &Err("capture_busy".to_owned()),
            )
            .is_err()
        );
        assert!(guard.submission.as_ref().unwrap().committing);
        assert_eq!(
            guard.submission.as_ref().unwrap().pending_rejection,
            Some(RejectionReason::Empty)
        );
    }

    #[test]
    fn old_context_completion_cannot_settle_a_new_request_with_the_same_node_id() {
        let mut guard = CapsuleRuntime::default();
        let note = input();
        enqueue_note(
            &mut guard,
            authority(),
            "new-context".to_owned(),
            note.clone(),
        )
        .unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        let mut old_authority = authority();
        old_authority.context_id = Some("old-context".to_owned());
        assert!(
            transition_processing_submission(
                &mut guard,
                &old_authority,
                &note.node_id,
                SubmissionResult {
                    status: SubmissionStatus::Saved,
                    reason: None
                }
            )
            .is_err()
        );
        assert_eq!(
            guard.submission.as_ref().unwrap().result.status,
            SubmissionStatus::Processing
        );
        assert!(guard.submission.as_ref().unwrap().input.is_some());
    }

    #[test]
    fn next_note_does_not_revoke_a_completed_commit_in_the_same_owner_context() {
        let mut guard = CapsuleRuntime::default();
        guard.owner = Some(WorkspaceOwner {
            authority: authority(),
            request: open_request(1, 3),
            context_id: "context".to_owned(),
            ready: true,
        });
        let first = input();
        let mut captured = authority();
        captured.context_id = Some("context".to_owned());
        enqueue_note(&mut guard, authority(), "context".to_owned(), first.clone()).unwrap();
        guard.submission.as_mut().unwrap().result.status = SubmissionStatus::Processing;
        transition_processing_submission(
            &mut guard,
            &captured,
            &first.node_id,
            SubmissionResult {
                status: SubmissionStatus::Saved,
                reason: None,
            },
        )
        .unwrap();
        let mut second = input();
        second.node_id = uuid::Uuid::new_v4().to_string();
        enqueue_note(&mut guard, authority(), "context".to_owned(), second).unwrap();
        assert!(owner_context_matches(guard.owner.as_ref(), &captured));
        guard.owner.as_mut().unwrap().context_id = "replacement".to_owned();
        assert!(!owner_context_matches(guard.owner.as_ref(), &captured));
    }

    #[test]
    fn reverse_blocking_open_completion_cannot_replace_the_new_owner() {
        let mut guard = CapsuleRuntime::default();
        let first = open_request(1, 3);
        let second = open_request(2, 3);
        let first = admit_owner_open(&mut guard, first.request_id, first.sequence, 3).unwrap();
        let second = admit_owner_open(&mut guard, second.request_id, second.sequence, 3).unwrap();
        let mut replacement = authority();
        replacement.owner_id = "new-owner".to_owned();
        install_owner_open(&mut guard, second, &replacement, 3, |_| Ok(())).unwrap();

        assert!(install_owner_open(&mut guard, first, &authority(), 3, |_| Ok(())).is_err());
        assert_eq!(
            guard.owner.as_ref().unwrap().authority.owner_id,
            "new-owner"
        );
    }

    #[test]
    fn admitting_a_new_request_immediately_revokes_the_previous_owner_and_broker() {
        let mut guard = CapsuleRuntime::default();
        let first = open_request(1, 3);
        let first = admit_owner_open(&mut guard, first.request_id, first.sequence, 3).unwrap();
        install_owner_open(&mut guard, first, &authority(), 3, |_| Ok(())).unwrap();
        enqueue_note(&mut guard, authority(), "context".to_owned(), input()).unwrap();
        let second = open_request(2, 3);
        let second = admit_owner_open(&mut guard, second.request_id, second.sequence, 3).unwrap();

        assert!(guard.owner.is_none());
        assert!(guard.submission.is_none());
        assert!(ensure_owner_open(&guard, &second, 3).is_ok());
        let stale = open_request(1, 3);
        assert!(admit_owner_open(&mut guard, stale.request_id, stale.sequence, 3).is_err());
        assert!(ensure_owner_open(&guard, &second, 3).is_ok());
    }

    #[test]
    fn late_async_admission_and_cancel_before_admission_are_rejected() {
        let mut guard = CapsuleRuntime::default();
        let newer = open_request(2, 3);
        admit_owner_open(&mut guard, newer.request_id.clone(), newer.sequence, 3).unwrap();
        let older = open_request(1, 3);
        assert!(admit_owner_open(&mut guard, older.request_id, older.sequence, 3).is_err());

        let cancelled = open_request(3, 3);
        cancel_owner_request(&mut guard, &cancelled.request_id, cancelled.sequence, None).unwrap();
        assert!(admit_owner_open(&mut guard, cancelled.request_id, cancelled.sequence, 3).is_err());
        assert!(ensure_owner_open(&guard, &newer, 3).is_err());
        assert!(guard.owner.is_none());
    }

    #[test]
    fn disposing_an_old_request_does_not_cancel_a_new_pending_or_active_owner() {
        let mut guard = CapsuleRuntime::default();
        let old = open_request(1, 3);
        let new = open_request(2, 3);
        admit_owner_open(&mut guard, old.request_id.clone(), old.sequence, 3).unwrap();
        let new = admit_owner_open(&mut guard, new.request_id, new.sequence, 3).unwrap();
        cancel_owner_request(&mut guard, &old.request_id, old.sequence, None).unwrap();
        assert!(ensure_owner_open(&guard, &new, 3).is_ok());
        install_owner_open(&mut guard, new, &authority(), 3, |_| Ok(())).unwrap();
        cancel_owner_request(&mut guard, &old.request_id, old.sequence, Some("owner")).unwrap();
        assert!(guard.owner.is_some());
    }

    #[test]
    fn queued_open_cannot_acquire_a_post_lock_generation_or_ignore_pending_save() {
        let mut guard = CapsuleRuntime::default();
        let request = open_request(1, 3);
        let request =
            admit_owner_open(&mut guard, request.request_id, request.sequence, 3).unwrap();
        let validated = std::cell::Cell::new(false);
        assert!(
            install_owner_open(&mut guard, request.clone(), &authority(), 5, |_| {
                validated.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!validated.get());
        assert!(guard.owner.is_none());
        assert!(
            install_owner_open(&mut guard, request, &authority(), 3, |_| {
                Err("workspace_vault_lock_save_pending".to_owned())
            })
            .is_err()
        );
        assert!(guard.owner.is_none());
    }

    #[test]
    fn owner_request_identity_and_ordering_are_strictly_validated() {
        let request = open_request(1, 3);
        assert_eq!(parse_owner_request(&request.request_id, "1").unwrap(), 1);
        for sequence in ["0", "01", "-1", "18446744073709551616"] {
            assert!(parse_owner_request(&request.request_id, sequence).is_err());
        }
        assert!(parse_owner_request("not-an-identity", "1").is_err());
    }
}
