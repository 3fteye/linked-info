//! The shared plaintext inbox is input, never evidence that a workspace write
//! occurred. Only this bounded main-directory journal plus the primary file's
//! bytes and fixed capture contents can settle an interrupted archive.

use linked_info_capture_inbox::{ClaimedCapture, CommitIntent, FailureCode, Inbox};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::capsule::{CapsuleNoteInput, RejectionReason};
use crate::workspace_file::{AtomicWriteStatus, write_atomically_commit_aware};

const JOURNAL_FILE: &str = "workspace.capture-archive.v1.json";
const RECOVERY_REQUIRED: &str = "workspace_owner_recovery_required";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CaptureClaim {
    pub(crate) id: String,
    pub(crate) revision: u64,
    pub(crate) claim_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ArchiveJournal {
    version: u32,
    phase: JournalPhase,
    claim: CaptureClaim,
    before_sha256: Option<String>,
    after_sha256: String,
    input_sha256: String,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Serialize)]
enum JournalPhase {
    Prepared,
    NotCommitted,
    Committed,
}

impl ArchiveJournal {
    fn intent(&self) -> CommitIntent {
        CommitIntent {
            id: self.claim.id.clone(),
            revision: self.claim.revision,
            claim_id: self.claim.claim_id.clone(),
            before_sha256: self.before_sha256.clone(),
            after_sha256: self.after_sha256.clone(),
        }
    }

    fn matches_intent(&self, intent: &CommitIntent) -> bool {
        self.claim.id == intent.id
            && self.claim.revision == intent.revision
            && self.claim.claim_id == intent.claim_id
            && self.before_sha256 == intent.before_sha256
            && self.after_sha256 == intent.after_sha256
    }

    fn validate(&self) -> Result<(), String> {
        let valid_uuid =
            |value: &str| uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value);
        if self.version != 1
            || !valid_uuid(&self.claim.id)
            || !valid_uuid(&self.claim.claim_id)
            || !(1..=linked_info_capture_inbox::MAX_REVISION).contains(&self.claim.revision)
            || !valid_hash(&self.after_sha256)
            || !valid_hash(&self.input_sha256)
            || self
                .before_sha256
                .as_ref()
                .is_some_and(|hash| !valid_hash(hash))
            || self.before_sha256.as_ref() == Some(&self.after_sha256)
        {
            return Err(RECOVERY_REQUIRED.to_owned());
        }
        Ok(())
    }
}

pub(crate) fn inbox_error(error: linked_info_capture_inbox::InboxError) -> String {
    // The shared adapter has already removed SQLite paths and values. Preserve
    // its bounded Busy code so ordinary cross-process contention can be retried.
    error.code().to_owned()
}

#[derive(Default)]
pub(crate) struct CaptureArchiveState {
    inbox: Mutex<Option<Inbox>>,
}

pub(crate) fn with_inbox<T>(
    app: &AppHandle,
    operation: impl FnOnce(&mut Inbox) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<CaptureArchiveState>();
    let mut guard = state
        .inbox
        .lock()
        .map_err(|_| "capture_inbox_unavailable".to_owned())?;
    if guard.is_none() {
        let directory = app
            .path()
            .data_dir()
            .map_err(|_| "capture_inbox_unavailable".to_owned())?
            .join(linked_info_capture_inbox::APPLICATION_DIRECTORY);
        *guard = Some(Inbox::open(directory).map_err(inbox_error)?);
    }
    operation(guard.as_mut().expect("initialized inbox"))
}

pub(crate) fn claimed_input(
    claimed: &ClaimedCapture,
) -> Result<(CaptureClaim, CapsuleNoteInput), String> {
    let record = &claimed.record;
    let input = CapsuleNoteInput {
        node_id: record.id.clone(),
        name: record.name.clone(),
        content: record.content.clone(),
        captured_at_ms: record
            .captured_at_ms
            .ok_or_else(|| "capsule_invalid_input".to_owned())?,
        utc_offset_minutes: record
            .utc_offset_minutes
            .ok_or_else(|| "capsule_invalid_input".to_owned())?,
    };
    input.fingerprint()?;
    Ok((
        CaptureClaim {
            id: record.id.clone(),
            revision: record.revision,
            claim_id: claimed.claim_id.clone(),
        },
        input,
    ))
}

pub(crate) fn failure_code(reason: RejectionReason) -> FailureCode {
    match reason {
        RejectionReason::Busy => FailureCode::Invalid,
        RejectionReason::DuplicateName => FailureCode::DuplicateName,
        RejectionReason::Empty => FailureCode::Empty,
        RejectionReason::Invalid => FailureCode::Invalid,
        RejectionReason::SaveFailed => FailureCode::SaveFailed,
    }
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn input_digest(input: &CapsuleNoteInput) -> Result<String, String> {
    let mut encoded = String::with_capacity(64);
    for byte in input.fingerprint()? {
        encoded.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        encoded.push(char::from(b"0123456789abcdef"[usize::from(byte & 15)]));
    }
    Ok(encoded)
}

fn primary_digest(path: &Path) -> Result<Option<String>, String> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RECOVERY_REQUIRED.to_owned()),
    };
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| RECOVERY_REQUIRED.to_owned())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(Some(format!("{:x}", hasher.finalize())))
}

fn read_journal(base_directory: &Path) -> Result<Option<ArchiveJournal>, String> {
    let file = match File::open(base_directory.join(JOURNAL_FILE)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(RECOVERY_REQUIRED.to_owned()),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| RECOVERY_REQUIRED.to_owned())?;
    if bytes.len() > 4096 {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    let journal: ArchiveJournal =
        serde_json::from_slice(&bytes).map_err(|_| RECOVERY_REQUIRED.to_owned())?;
    journal.validate()?;
    Ok(Some(journal))
}

fn clear_journal(base_directory: &Path) -> Result<(), String> {
    fs::remove_file(base_directory.join(JOURNAL_FILE)).map_err(|_| RECOVERY_REQUIRED.to_owned())?;
    crate::workspace_file::sync_parent_directory(base_directory)
        .map_err(|_| RECOVERY_REQUIRED.to_owned())
}

fn persist_journal(base_directory: &Path, journal: &ArchiveJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec(journal).map_err(|_| RECOVERY_REQUIRED.to_owned())?;
    if write_atomically_commit_aware(&base_directory.join(JOURNAL_FILE), &bytes)
        .map_err(|_| RECOVERY_REQUIRED.to_owned())?
        != AtomicWriteStatus::Committed
    {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    Ok(())
}

/// Caller holds the primary workspace operation lock. This writes no workspace
/// plaintext: the journal contains only fixed identity and SHA-256 digests.
pub(crate) fn prepare(
    base_directory: &Path,
    primary: &Path,
    inbox: &mut Inbox,
    claim: &CaptureClaim,
    input: &CapsuleNoteInput,
    serialized: &[u8],
) -> Result<ArchiveJournal, String> {
    if read_journal(base_directory)?.is_some() {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    let outstanding = inbox
        .outstanding()
        .map_err(inbox_error)?
        .ok_or_else(|| RECOVERY_REQUIRED.to_owned())?;
    let (stored_claim, stored_input) = claimed_input(&outstanding.claimed)?;
    if stored_claim != *claim
        || stored_input.fingerprint()? != input.fingerprint()?
        || outstanding.intent.is_some()
    {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    let journal = ArchiveJournal {
        version: 1,
        phase: JournalPhase::Prepared,
        claim: claim.clone(),
        before_sha256: primary_digest(primary)?,
        after_sha256: hex_digest(serialized),
        input_sha256: input_digest(input)?,
    };
    journal.validate()?;
    persist_journal(base_directory, &journal)?;
    let intent = inbox
        .prepare_commit(
            &claim.id,
            claim.revision,
            &claim.claim_id,
            journal.before_sha256.clone(),
            journal.after_sha256.clone(),
        )
        .map_err(inbox_error)?;
    if !journal.matches_intent(&intent) {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    Ok(journal)
}

/// Called only after the main file's commit-aware writer confirmed durability.
pub(crate) fn confirm(
    base_directory: &Path,
    inbox: &mut Inbox,
    journal: &ArchiveJournal,
) -> Result<(), String> {
    let mut committed = journal.clone();
    committed.phase = JournalPhase::Committed;
    persist_journal(base_directory, &committed)?;
    inbox
        .confirm_archived(&journal.intent())
        .map_err(inbox_error)?;
    clear_journal(base_directory)
}

pub(crate) fn mark_uncertain(inbox: &mut Inbox, journal: &ArchiveJournal) {
    let _ = inbox.mark_uncertain(&journal.intent());
}

/// Resolve an interrupted operation before exposing a primary snapshot. The
/// supplied validator decrypts only inside the main process and checks the
/// exact fixed node and original capture time. It returns no data to SQLite.
pub(crate) fn recover(
    base_directory: &Path,
    primary: &Path,
    inbox: &mut Inbox,
    validate_primary: impl FnOnce(&CapsuleNoteInput) -> Result<(), String>,
) -> Result<(), String> {
    let journal = read_journal(base_directory)?;
    let outstanding = inbox.outstanding().map_err(inbox_error)?;
    let Some(mut journal) = journal else {
        if let Some(outstanding) = outstanding {
            if outstanding.intent.is_some() {
                return Err(RECOVERY_REQUIRED.to_owned());
            }
            let (claim, _) = claimed_input(&outstanding.claimed)?;
            inbox
                .release_claim(&claim.id, claim.revision, &claim.claim_id)
                .map_err(inbox_error)?;
        }
        return Ok(());
    };
    if journal.phase == JournalPhase::NotCommitted {
        if let Some(outstanding) = outstanding {
            let (claim, _) = claimed_input(&outstanding.claimed)?;
            if claim != journal.claim {
                return Err(RECOVERY_REQUIRED.to_owned());
            }
            if let Some(intent) = outstanding.intent {
                if !journal.matches_intent(&intent) {
                    return Err(RECOVERY_REQUIRED.to_owned());
                }
                inbox.recover_before_commit(&intent).map_err(inbox_error)?;
            } else {
                inbox
                    .release_claim(&claim.id, claim.revision, &claim.claim_id)
                    .map_err(inbox_error)?;
            }
        }
        return clear_journal(base_directory);
    }
    let Some(outstanding) = outstanding else {
        // A local committed phase is written only after main-file durability.
        // It remains valid even if a user later deletes the node or restores an
        // older backup. A shared receipt by itself is never sufficient.
        if journal.phase != JournalPhase::Committed
            || inbox
                .archived_revision(&journal.claim.id)
                .map_err(inbox_error)?
                != Some(journal.claim.revision)
        {
            return Err(RECOVERY_REQUIRED.to_owned());
        }
        return clear_journal(base_directory);
    };
    let (claim, input) = claimed_input(&outstanding.claimed)?;
    if claim != journal.claim || input_digest(&input)? != journal.input_sha256 {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    if let Some(intent) = outstanding.intent.as_ref() {
        if !journal.matches_intent(intent) {
            return Err(RECOVERY_REQUIRED.to_owned());
        }
        if journal.phase == JournalPhase::Committed {
            return confirm(base_directory, inbox, &journal);
        }
        let current = primary_digest(primary)?;
        if current.as_ref() == Some(&journal.after_sha256) {
            validate_primary(&input)?;
            return confirm(base_directory, inbox, &journal);
        }
        if current == journal.before_sha256 {
            journal.phase = JournalPhase::NotCommitted;
            persist_journal(base_directory, &journal)?;
            inbox.recover_before_commit(intent).map_err(inbox_error)?;
            return clear_journal(base_directory);
        }
        mark_uncertain(inbox, &journal);
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    // Crash between main-journal persistence and shared prepare_commit. No
    // file replacement is permitted at this stage, so only before is safe.
    if journal.phase != JournalPhase::Prepared || primary_digest(primary)? != journal.before_sha256
    {
        return Err(RECOVERY_REQUIRED.to_owned());
    }
    journal.phase = JournalPhase::NotCommitted;
    persist_journal(base_directory, &journal)?;
    inbox
        .release_claim(&claim.id, claim.revision, &claim.claim_id)
        .map_err(inbox_error)?;
    clear_journal(base_directory)
}

#[cfg(test)]
mod tests {
    use super::*;
    use linked_info_capture_inbox::CaptureState;
    use std::cell::Cell;
    use std::path::PathBuf;

    struct Fixture {
        directory: PathBuf,
        primary: PathBuf,
        inbox: Inbox,
        claim: CaptureClaim,
        input: CapsuleNoteInput,
    }

    impl Fixture {
        fn new() -> Self {
            let directory = std::env::temp_dir()
                .join(format!("linked-info-archive-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            let primary = directory.join("primary.json");
            fs::write(&primary, b"before").unwrap();
            let mut inbox = Inbox::open(directory.join("capture")).unwrap();
            let draft = inbox
                .create_draft(String::new(), "synthetic note".to_owned())
                .unwrap();
            inbox
                .submit(&draft.id, draft.revision, 1_788_400_000_000, 480)
                .unwrap();
            let claimed = inbox.claim_next().unwrap().unwrap();
            let (claim, input) = claimed_input(&claimed).unwrap();
            Self {
                directory,
                primary,
                inbox,
                claim,
                input,
            }
        }

        fn prepare(&mut self) -> ArchiveJournal {
            prepare(
                &self.directory,
                &self.primary,
                &mut self.inbox,
                &self.claim,
                &self.input,
                b"after",
            )
            .unwrap()
        }

        fn reopen(&mut self) {
            self.inbox = Inbox::open(self.directory.join("capture")).unwrap();
        }

        fn recover(
            &mut self,
            validate: impl FnOnce(&CapsuleNoteInput) -> Result<(), String>,
        ) -> Result<(), String> {
            recover(&self.directory, &self.primary, &mut self.inbox, validate)
        }

        fn cleanup(self) {
            drop(self.inbox);
            fs::remove_dir_all(self.directory).unwrap();
        }
    }

    #[test]
    fn restart_before_intent_reclaims_the_same_revision_and_original_time() {
        let mut fixture = Fixture::new();
        fixture.reopen();
        fixture
            .recover(|_| panic!("no primary proof needed before intent"))
            .unwrap();
        let claimed = fixture.inbox.claim_next().unwrap().unwrap();
        let (claim, input) = claimed_input(&claimed).unwrap();
        assert_eq!(claim.id, fixture.claim.id);
        assert_eq!(claim.revision, fixture.claim.revision);
        assert_ne!(claim.claim_id, fixture.claim.claim_id);
        assert_eq!(input.captured_at_ms, fixture.input.captured_at_ms);
        assert_eq!(input.utc_offset_minutes, 480);
        assert_eq!(input.content, "synthetic note");
        fixture.cleanup();
    }

    #[test]
    fn unchanged_before_image_releases_intent_without_removing_body() {
        let mut fixture = Fixture::new();
        fixture.prepare();
        fixture.reopen();
        fixture
            .recover(|_| panic!("before image is not a committed capture"))
            .unwrap();
        let record = fixture.inbox.get(&fixture.claim.id).unwrap().unwrap();
        assert_eq!(record.state, CaptureState::Pending);
        assert_eq!(record.content, "synthetic note");
        assert_eq!(record.revision, fixture.claim.revision);
        assert!(fixture.inbox.outstanding().unwrap().is_none());
        assert!(read_journal(&fixture.directory).unwrap().is_none());
        fixture.cleanup();
    }

    #[test]
    fn after_image_requires_fixed_content_proof_before_acknowledgement() {
        let mut fixture = Fixture::new();
        fixture.prepare();
        fs::write(&fixture.primary, b"after").unwrap();
        fixture.reopen();
        assert!(
            fixture
                .recover(|_| Err("wrong fixed node".to_owned()))
                .is_err()
        );
        assert!(
            fixture
                .inbox
                .archived_revision(&fixture.claim.id)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            fixture
                .inbox
                .get(&fixture.claim.id)
                .unwrap()
                .unwrap()
                .content,
            "synthetic note"
        );
        let checked = Cell::new(false);
        fixture
            .recover(|input| {
                assert_eq!(input.content, "synthetic note");
                assert_eq!(input.captured_at_ms, 1_788_400_000_000);
                checked.set(true);
                Ok(())
            })
            .unwrap();
        assert!(checked.get());
        assert_eq!(
            fixture.inbox.archived_revision(&fixture.claim.id).unwrap(),
            Some(fixture.claim.revision)
        );
        assert!(
            fixture
                .inbox
                .get(&fixture.claim.id)
                .unwrap()
                .unwrap()
                .content
                .is_empty()
        );
        fixture.cleanup();
    }

    #[test]
    fn neither_file_image_is_unknown_and_never_automatically_requeued() {
        let mut fixture = Fixture::new();
        fixture.prepare();
        fs::write(&fixture.primary, b"unrelated primary").unwrap();
        fixture.reopen();
        assert!(fixture.recover(|_| Ok(())).is_err());
        assert_eq!(
            fixture.inbox.get(&fixture.claim.id).unwrap().unwrap().state,
            CaptureState::Uncertain
        );
        assert!(fixture.inbox.claim_next().unwrap().is_none());
        assert!(
            fixture
                .inbox
                .save_draft(
                    &fixture.claim.id,
                    fixture.claim.revision,
                    String::new(),
                    "replacement".to_owned()
                )
                .is_err()
        );
        fixture.cleanup();
    }

    #[test]
    fn shared_intent_without_main_journal_is_not_commit_evidence() {
        let mut fixture = Fixture::new();
        fixture
            .inbox
            .prepare_commit(
                &fixture.claim.id,
                fixture.claim.revision,
                &fixture.claim.claim_id,
                Some(hex_digest(b"before")),
                hex_digest(b"after"),
            )
            .unwrap();
        fs::write(&fixture.primary, b"after").unwrap();
        assert!(fixture.recover(|_| Ok(())).is_err());
        assert!(
            fixture
                .inbox
                .archived_revision(&fixture.claim.id)
                .unwrap()
                .is_none()
        );
        fixture.cleanup();
    }

    #[test]
    fn main_journal_written_before_shared_intent_can_be_aborted() {
        let mut fixture = Fixture::new();
        let journal = ArchiveJournal {
            version: 1,
            phase: JournalPhase::Prepared,
            claim: fixture.claim.clone(),
            before_sha256: Some(hex_digest(b"before")),
            after_sha256: hex_digest(b"after"),
            input_sha256: input_digest(&fixture.input).unwrap(),
        };
        persist_journal(&fixture.directory, &journal).unwrap();
        fixture.reopen();
        fixture
            .recover(|_| panic!("replacement was not admitted"))
            .unwrap();
        assert_eq!(
            fixture.inbox.get(&fixture.claim.id).unwrap().unwrap().state,
            CaptureState::Pending
        );
        fixture.cleanup();
    }

    #[test]
    fn aborted_cleanup_does_not_delete_a_newer_draft_revision() {
        let mut fixture = Fixture::new();
        let mut journal = fixture.prepare();
        journal.phase = JournalPhase::NotCommitted;
        persist_journal(&fixture.directory, &journal).unwrap();
        fixture
            .inbox
            .recover_before_commit(&journal.intent())
            .unwrap();
        let edited = fixture
            .inbox
            .save_draft(
                &fixture.claim.id,
                fixture.claim.revision,
                String::new(),
                "newer draft".to_owned(),
            )
            .unwrap();
        fixture.reopen();
        fixture
            .recover(|_| panic!("already proved no commit"))
            .unwrap();
        let current = fixture.inbox.get(&fixture.claim.id).unwrap().unwrap();
        assert_eq!(current.revision, edited.revision);
        assert_eq!(current.content, "newer draft");
        fixture.cleanup();
    }

    #[test]
    fn durable_local_commit_settles_lost_ack_even_after_node_deletion() {
        let mut fixture = Fixture::new();
        let mut journal = fixture.prepare();
        fs::write(&fixture.primary, b"after").unwrap();
        journal.phase = JournalPhase::Committed;
        persist_journal(&fixture.directory, &journal).unwrap();
        fixture.reopen();
        fixture
            .recover(|_| panic!("local durable commit already proved"))
            .unwrap();
        fs::write(&fixture.primary, b"before").unwrap();
        fixture.reopen();
        fixture
            .recover(|_| panic!("receipt must not resurrect a deleted node"))
            .unwrap();
        assert!(fixture.inbox.claim_next().unwrap().is_none());
        assert!(
            fixture
                .inbox
                .get(&fixture.claim.id)
                .unwrap()
                .unwrap()
                .content
                .is_empty()
        );
        fixture.cleanup();
    }

    #[test]
    fn ack_before_local_cleanup_is_idempotent_across_backup_restore() {
        let mut fixture = Fixture::new();
        let mut journal = fixture.prepare();
        journal.phase = JournalPhase::Committed;
        persist_journal(&fixture.directory, &journal).unwrap();
        fixture.inbox.confirm_archived(&journal.intent()).unwrap();
        // Simulate a later explicit restore with a cleanup-only local journal.
        fs::write(&fixture.primary, b"older user backup").unwrap();
        fixture.reopen();
        fixture
            .recover(|_| panic!("shared receipt plus local commit is settled"))
            .unwrap();
        assert!(fixture.inbox.claim_next().unwrap().is_none());
        assert!(read_journal(&fixture.directory).unwrap().is_none());
        fixture.cleanup();
    }

    #[test]
    fn journal_is_bounded_strict_and_does_not_contain_capture_plaintext() {
        let mut fixture = Fixture::new();
        fixture.prepare();
        let path = fixture.directory.join(JOURNAL_FILE);
        let text = fs::read_to_string(&path).unwrap();
        assert!(!text.contains("synthetic note"));
        let mut value: serde_json::Value = serde_json::from_str(&text).unwrap();
        value["unexpected"] = true.into();
        fs::write(&path, value.to_string()).unwrap();
        assert!(read_journal(&fixture.directory).is_err());
        fs::write(&path, " ".repeat(4097)).unwrap();
        assert!(read_journal(&fixture.directory).is_err());
        fixture.cleanup();
    }
}
