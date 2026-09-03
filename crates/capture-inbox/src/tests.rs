use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Barrier},
    thread,
};

use rusqlite::{Connection, params};

use crate::{
    CaptureRecord, CaptureState, ClaimedCapture, CommitIntent, DATABASE_FILE_NAME, FailureCode,
    Inbox, InboxError, MAX_CONTENT_CHARACTERS, MAX_NAME_CHARACTERS, MAX_UNARCHIVED_RECORDS,
};

struct SyntheticDirectory(PathBuf);

impl SyntheticDirectory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "linked-info-capture-inbox-test-{}",
            uuid::Uuid::new_v4()
        )))
    }

    fn open(&self) -> Inbox {
        Inbox::open(self.0.clone()).unwrap()
    }

    fn raw(&self) -> Connection {
        Connection::open(self.0.join(DATABASE_FILE_NAME)).unwrap()
    }
}

impl Drop for SyntheticDirectory {
    fn drop(&mut self) {
        assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
        assert!(
            self.0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("linked-info-capture-inbox-test-")
        );
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn draft(inbox: &mut Inbox) -> CaptureRecord {
    inbox
        .create_draft("合成便签".to_owned(), "只用于测试的正文".to_owned())
        .unwrap()
}

fn pending(inbox: &mut Inbox) -> CaptureRecord {
    let record = draft(inbox);
    inbox
        .submit(&record.id, record.revision, 1_788_400_000_000, 480)
        .unwrap()
}

fn claim(inbox: &mut Inbox) -> ClaimedCapture {
    pending(inbox);
    inbox.claim_next().unwrap().unwrap()
}

fn prepare(inbox: &mut Inbox, claimed: &ClaimedCapture) -> CommitIntent {
    inbox
        .prepare_commit(
            &claimed.record.id,
            claimed.record.revision,
            &claimed.claim_id,
            Some("a".repeat(64)),
            "b".repeat(64),
        )
        .unwrap()
}

#[test]
fn draft_is_durable_without_main_application_and_reopens_with_exact_text() {
    let directory = SyntheticDirectory::new();
    let record = {
        let mut inbox = directory.open();
        let first = draft(&mut inbox);
        inbox
            .save_draft(
                &first.id,
                first.revision,
                String::new(),
                "第一行\n第二行".to_owned(),
            )
            .unwrap()
    };
    let mut inbox = directory.open();
    assert!(inbox.get(&record.id).unwrap().unwrap() == record);
    assert_eq!(record.state, CaptureState::Draft);
    assert_eq!(record.revision, 2);
    assert!(inbox.claim_next().unwrap().is_none());
}

#[test]
fn stale_autosave_cannot_overwrite_new_revision_or_resubmit_pending() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let original = draft(&mut inbox);
    let updated = inbox
        .save_draft(
            &original.id,
            original.revision,
            "新名称".to_owned(),
            "新正文".to_owned(),
        )
        .unwrap();
    assert_eq!(
        inbox
            .save_draft(
                &original.id,
                original.revision,
                String::new(),
                String::new()
            )
            .err(),
        Some(InboxError::Conflict)
    );
    let pending = inbox
        .submit(&updated.id, updated.revision, 1_788_400_000_000, 480)
        .unwrap();
    assert_eq!(
        inbox
            .submit(&pending.id, pending.revision, 1_788_500_000_000, 0)
            .err(),
        Some(InboxError::Conflict)
    );
    assert!(inbox.get(&pending.id).unwrap().unwrap() == pending);
}

#[test]
fn pending_edit_retracts_submission_atomically_and_preserves_other_records() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let pending = pending(&mut inbox);
    let other = draft(&mut inbox);
    let edited = inbox
        .save_draft(
            &pending.id,
            pending.revision,
            pending.name.clone(),
            pending.content.clone(),
        )
        .unwrap();
    assert_eq!(edited.state, CaptureState::Draft);
    assert_eq!(edited.revision, pending.revision + 1);
    assert_eq!(edited.captured_at_ms, None);
    assert_eq!(edited.utc_offset_minutes, None);
    assert!(inbox.claim_next().unwrap().is_none());
    assert!(inbox.get(&other.id).unwrap().unwrap() == other);
}

#[test]
fn claim_is_persistent_read_only_and_never_reset_by_reopening() {
    let directory = SyntheticDirectory::new();
    let claimed = {
        let mut inbox = directory.open();
        claim(&mut inbox)
    };
    let mut inbox = directory.open();
    assert!(inbox.outstanding().unwrap().unwrap().claimed == claimed);
    assert!(inbox.claim_next().unwrap().is_none());
    assert_eq!(
        inbox
            .save_draft(
                &claimed.record.id,
                claimed.record.revision,
                String::new(),
                "不能覆盖".to_owned(),
            )
            .err(),
        Some(InboxError::ReadOnly)
    );
    let other = draft(&mut inbox);
    assert_eq!(other.state, CaptureState::Draft);
    inbox
        .release_claim(
            &claimed.record.id,
            claimed.record.revision,
            &claimed.claim_id,
        )
        .unwrap();
    let reclaimed = inbox.claim_next().unwrap().unwrap();
    assert_eq!(reclaimed.record.id, claimed.record.id);
    assert_eq!(reclaimed.record.revision, claimed.record.revision);
    assert_ne!(reclaimed.claim_id, claimed.claim_id);
    assert_eq!(
        inbox
            .release_claim(
                &claimed.record.id,
                claimed.record.revision,
                &claimed.claim_id,
            )
            .err(),
        Some(InboxError::Conflict)
    );
}

#[test]
fn failed_name_conflict_keeps_original_text_and_allows_user_correction() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let claimed = claim(&mut inbox);
    inbox
        .fail_claim(
            &claimed.record.id,
            claimed.record.revision,
            &claimed.claim_id,
            FailureCode::DuplicateName,
        )
        .unwrap();
    let failed = inbox.get(&claimed.record.id).unwrap().unwrap();
    assert_eq!(failed.state, CaptureState::Failed);
    assert_eq!(failed.failure, Some(FailureCode::DuplicateName));
    assert!(failed.content == claimed.record.content);
    assert!(inbox.claim_next().unwrap().is_none());
    let corrected = inbox
        .save_draft(
            &failed.id,
            failed.revision,
            "新的合成名称".to_owned(),
            failed.content,
        )
        .unwrap();
    assert_eq!(corrected.state, CaptureState::Draft);
    assert_eq!(corrected.failure, None);
}

#[test]
fn intent_survives_restart_and_blocks_unsafe_release_or_failure() {
    let directory = SyntheticDirectory::new();
    let (claimed, intent) = {
        let mut inbox = directory.open();
        let claimed = claim(&mut inbox);
        let intent = prepare(&mut inbox, &claimed);
        (claimed, intent)
    };
    let mut inbox = directory.open();
    assert_eq!(inbox.outstanding().unwrap().unwrap().intent, Some(intent));
    assert_eq!(
        inbox
            .release_claim(
                &claimed.record.id,
                claimed.record.revision,
                &claimed.claim_id,
            )
            .err(),
        Some(InboxError::RecoveryRequired)
    );
    assert_eq!(
        inbox
            .fail_claim(
                &claimed.record.id,
                claimed.record.revision,
                &claimed.claim_id,
                FailureCode::SaveFailed,
            )
            .err(),
        Some(InboxError::RecoveryRequired)
    );
}

#[test]
fn uncertain_outcome_keeps_text_and_only_matching_before_proof_can_retry() {
    let directory = SyntheticDirectory::new();
    let (claimed, intent) = {
        let mut inbox = directory.open();
        let claimed = claim(&mut inbox);
        let intent = prepare(&mut inbox, &claimed);
        inbox.mark_uncertain(&intent).unwrap();
        (claimed, intent)
    };
    let mut inbox = directory.open();
    let uncertain = inbox.get(&claimed.record.id).unwrap().unwrap();
    assert_eq!(uncertain.state, CaptureState::Uncertain);
    assert!(uncertain.content == claimed.record.content);
    assert!(inbox.claim_next().unwrap().is_none());
    let mut stale = intent.clone();
    stale.after_sha256 = "c".repeat(64);
    assert_eq!(
        inbox.recover_before_commit(&stale).err(),
        Some(InboxError::Conflict)
    );
    inbox.recover_before_commit(&intent).unwrap();
    let retry = inbox.claim_next().unwrap().unwrap();
    assert_eq!(retry.record.id, claimed.record.id);
    assert_eq!(retry.record.revision, claimed.record.revision);
    assert!(retry.record.content == claimed.record.content);
    assert_ne!(retry.claim_id, claimed.claim_id);
    assert_eq!(
        inbox.confirm_archived(&intent).err(),
        Some(InboxError::Conflict)
    );
}

#[test]
fn confirmed_archive_is_atomic_minimal_idempotent_and_persistent() {
    let directory = SyntheticDirectory::new();
    let intent = {
        let mut inbox = directory.open();
        let claimed = claim(&mut inbox);
        let intent = prepare(&mut inbox, &claimed);
        inbox.confirm_archived(&intent).unwrap();
        intent
    };
    let mut inbox = directory.open();
    inbox.confirm_archived(&intent).unwrap();
    let record = inbox.get(&intent.id).unwrap().unwrap();
    assert_eq!(record.state, CaptureState::Archived);
    assert!(record.name.is_empty());
    assert!(record.content.is_empty());
    assert!(record.captured_at_ms.is_none());
    assert!(inbox.list().unwrap().is_empty());
    assert!(inbox.claim_next().unwrap().is_none());
    assert_eq!(
        inbox.archived_revision(&intent.id).unwrap(),
        Some(intent.revision)
    );
    let raw = directory.raw();
    let count: i64 = raw
        .query_row("SELECT count(*) FROM captures", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 0);
    let mut statement = raw.prepare("PRAGMA table_info(receipts)").unwrap();
    let columns: Vec<String> = statement
        .query_map([], |row| row.get(1))
        .unwrap()
        .collect::<std::result::Result<_, _>>()
        .unwrap();
    assert_eq!(columns, vec!["id", "revision"]);
    let mut stale = intent.clone();
    stale.revision += 1;
    assert_eq!(
        inbox.confirm_archived(&stale).err(),
        Some(InboxError::Conflict)
    );
}

#[test]
fn claim_and_edit_race_has_exactly_one_winner_across_connections() {
    let directory = SyntheticDirectory::new();
    let pending = pending(&mut directory.open());
    let barrier = Arc::new(Barrier::new(2));
    let edit_barrier = Arc::clone(&barrier);
    let edit_path = directory.0.clone();
    let edit_record = pending.clone();
    let edit = thread::spawn(move || {
        let mut inbox = Inbox::open(edit_path).unwrap();
        edit_barrier.wait();
        inbox.save_draft(
            &edit_record.id,
            edit_record.revision,
            "修改后".to_owned(),
            edit_record.content,
        )
    });
    let claim_path = directory.0.clone();
    let claim = thread::spawn(move || {
        let mut inbox = Inbox::open(claim_path).unwrap();
        barrier.wait();
        inbox.claim_next()
    });
    let edited = edit.join().unwrap();
    let claimed = claim.join().unwrap().unwrap();
    assert_ne!(edited.is_ok(), claimed.is_some());
    let actual = directory.open().get(&pending.id).unwrap().unwrap();
    if let Some(claimed) = claimed {
        assert_eq!(edited.err(), Some(InboxError::ReadOnly));
        assert_eq!(actual.state, CaptureState::Claimed);
        assert!(actual.content == claimed.record.content);
        assert_eq!(actual.revision, pending.revision);
    } else {
        assert_eq!(actual.state, CaptureState::Draft);
        assert_eq!(actual.revision, pending.revision + 1);
    }
}

#[test]
fn two_stale_autosaves_have_only_one_success_across_connections() {
    let directory = SyntheticDirectory::new();
    let record = draft(&mut directory.open());
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = ["第一个", "第二个"]
        .into_iter()
        .map(|name| {
            let path = directory.0.clone();
            let record = record.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let mut inbox = Inbox::open(path).unwrap();
                barrier.wait();
                inbox.save_draft(&record.id, record.revision, name.to_owned(), record.content)
            })
        })
        .collect();
    let results: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result.as_ref().err() == Some(&InboxError::Conflict))
            .count(),
        1
    );
}

#[test]
fn two_archivers_cannot_claim_different_records_concurrently() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    pending(&mut inbox);
    pending(&mut inbox);
    drop(inbox);
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let path = directory.0.clone();
            let barrier = Arc::clone(&barrier);
            thread::spawn(move || {
                let mut inbox = Inbox::open(path).unwrap();
                barrier.wait();
                inbox.claim_next().unwrap()
            })
        })
        .collect();
    let count = handles
        .into_iter()
        .filter_map(|handle| handle.join().unwrap())
        .count();
    assert_eq!(count, 1);
}

#[test]
fn original_capture_time_controls_queue_order_and_survives_restarts() {
    let directory = SyntheticDirectory::new();
    let earlier = {
        let mut inbox = directory.open();
        let first = draft(&mut inbox);
        inbox
            .submit(&first.id, first.revision, 10_000, 480)
            .unwrap();
        let earlier = draft(&mut inbox);
        inbox
            .submit(&earlier.id, earlier.revision, 1_000, -840)
            .unwrap()
    };
    let claimed = directory.open().claim_next().unwrap().unwrap();
    assert_eq!(claimed.record.id, earlier.id);
    assert_eq!(claimed.record.captured_at_ms, Some(1_000));
    assert_eq!(claimed.record.utc_offset_minutes, Some(-840));
}

#[test]
fn single_record_and_timestamp_boundaries_are_validated_before_writes() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    assert!(
        inbox
            .create_draft(
                "名".repeat(MAX_NAME_CHARACTERS),
                "😀".repeat(MAX_CONTENT_CHARACTERS),
            )
            .is_ok()
    );
    for (name, content) in [
        ("名".repeat(MAX_NAME_CHARACTERS + 1), String::new()),
        (String::new(), "a".repeat(MAX_CONTENT_CHARACTERS + 1)),
        (String::new(), "invalid\0text".to_owned()),
    ] {
        assert_eq!(
            inbox.create_draft(name, content).err(),
            Some(InboxError::InvalidInput)
        );
    }
    let record = draft(&mut inbox);
    for (time, offset) in [(253_402_300_800_000, 0), (0, 841), (0, -841)] {
        assert_eq!(
            inbox
                .submit(&record.id, record.revision, time, offset)
                .err(),
            Some(InboxError::InvalidInput)
        );
    }
    assert_eq!(
        inbox
            .submit(&record.id, record.revision, u64::MAX, 0)
            .err(),
        Some(InboxError::InvalidInput)
    );
    assert!(inbox.get(&record.id).unwrap().unwrap() == record);
}

#[test]
fn maximum_contract_integers_round_trip_through_sqlite_and_receipts() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let record = draft(&mut inbox);
    let initial_revision = crate::MAX_REVISION - 2;
    directory
        .raw()
        .execute(
            "UPDATE captures SET revision = ?1 WHERE id = ?2",
            params![i64::try_from(initial_revision).unwrap(), record.id],
        )
        .unwrap();
    let updated = inbox
        .save_draft(
            &record.id,
            initial_revision,
            record.name,
            record.content,
        )
        .unwrap();
    let maximum_time = 253_402_300_799_999;
    let pending = inbox
        .submit(&updated.id, updated.revision, maximum_time, 840)
        .unwrap();
    assert_eq!(pending.revision, crate::MAX_REVISION);
    assert_eq!(pending.captured_at_ms, Some(253_402_300_799_999));
    let summary = inbox.list().unwrap().remove(0);
    assert_eq!(summary.revision, pending.revision);
    assert_eq!(summary.captured_at_ms, pending.captured_at_ms);
    let claimed = inbox.claim_next().unwrap().unwrap();
    let intent = prepare(&mut inbox, &claimed);
    inbox.confirm_archived(&intent).unwrap();
    assert_eq!(
        inbox.archived_revision(&intent.id).unwrap(),
        Some(crate::MAX_REVISION)
    );
}

#[test]
fn negative_and_out_of_contract_sql_integers_fail_closed_without_rewriting() {
    for statement in [
        "UPDATE captures SET revision = ?1 WHERE id = ?2",
        "UPDATE captures SET captured_at_ms = ?1 WHERE id = ?2",
    ] {
        for invalid in [-1_i64, i64::MAX] {
            let directory = SyntheticDirectory::new();
            let mut inbox = directory.open();
            let record = pending(&mut inbox);
            let raw = directory.raw();
            raw.pragma_update(None, "ignore_check_constraints", true)
                .unwrap();
            raw.execute(statement, params![invalid, record.id])
                .unwrap();
            assert_eq!(inbox.list().err(), Some(InboxError::Corrupt));
            assert_eq!(inbox.get(&record.id).err(), Some(InboxError::Corrupt));
            let (revision, time): (i64, i64) = raw
                .query_row(
                    "SELECT revision, captured_at_ms FROM captures WHERE id = ?1",
                    [&record.id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap();
            assert!(revision == invalid || time == invalid);
        }
    }
    for invalid in [-1_i64, i64::MAX] {
        let directory = SyntheticDirectory::new();
        let mut inbox = directory.open();
        let claimed = claim(&mut inbox);
        let intent = prepare(&mut inbox, &claimed);
        inbox.confirm_archived(&intent).unwrap();
        let raw = directory.raw();
        raw.pragma_update(None, "ignore_check_constraints", true)
            .unwrap();
        raw.execute(
            "UPDATE receipts SET revision = ?1 WHERE id = ?2",
            params![invalid, intent.id],
        )
        .unwrap();
        assert_eq!(
            inbox.archived_revision(&intent.id).err(),
            Some(InboxError::Corrupt)
        );
        assert_eq!(inbox.get(&intent.id).err(), Some(InboxError::Corrupt));
    }
}

#[test]
fn empty_draft_can_persist_but_cannot_be_submitted() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let empty = inbox
        .create_draft(String::new(), " \n\t".to_owned())
        .unwrap();
    assert_eq!(
        inbox.submit(&empty.id, empty.revision, 0, 0).err(),
        Some(InboxError::InvalidInput)
    );
    assert_eq!(inbox.list().unwrap().len(), 1);
}

#[test]
fn unarchived_count_limit_includes_drafts_but_not_receipts() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let claimed = claim(&mut inbox);
    let intent = prepare(&mut inbox, &claimed);
    inbox.confirm_archived(&intent).unwrap();
    for _ in 0..MAX_UNARCHIVED_RECORDS {
        inbox.create_draft(String::new(), String::new()).unwrap();
    }
    assert_eq!(
        inbox.create_draft(String::new(), String::new()).err(),
        Some(InboxError::Capacity)
    );
    assert_eq!(inbox.list().unwrap().len(), MAX_UNARCHIVED_RECORDS);
    assert!(inbox.archived_revision(&intent.id).unwrap().is_some());
}

#[test]
fn total_utf8_budget_failure_does_not_partially_change_draft() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let body = "😀".repeat(MAX_CONTENT_CHARACTERS);
    let body_bytes = body.len();
    let full_records = crate::MAX_TOTAL_BYTES / body_bytes;
    for _ in 0..full_records {
        inbox.create_draft(String::new(), body.clone()).unwrap();
    }
    let remaining = crate::MAX_TOTAL_BYTES % body_bytes;
    let partial = inbox
        .create_draft(String::new(), "😀".repeat(remaining / 4))
        .unwrap();
    assert_eq!(
        inbox
            .save_draft(
                &partial.id,
                partial.revision,
                "额外名称".to_owned(),
                partial.content.clone(),
            )
            .err(),
        Some(InboxError::Capacity)
    );
    assert!(inbox.get(&partial.id).unwrap().unwrap() == partial);
}

#[test]
fn unknown_versions_extra_schema_and_corrupt_rows_fail_closed() {
    let unknown = SyntheticDirectory::new();
    drop(unknown.open());
    unknown
        .raw()
        .pragma_update(None, "user_version", 2)
        .unwrap();
    assert_eq!(
        Inbox::open(unknown.0.clone()).err(),
        Some(InboxError::SchemaUnsupported)
    );
    let altered = SyntheticDirectory::new();
    drop(altered.open());
    altered
        .raw()
        .execute("CREATE TABLE sqliteXunexpected (value TEXT)", [])
        .unwrap();
    assert_eq!(
        Inbox::open(altered.0.clone()).err(),
        Some(InboxError::Corrupt)
    );
    let corrupt = SyntheticDirectory::new();
    let record = draft(&mut corrupt.open());
    let raw = corrupt.raw();
    raw.pragma_update(None, "ignore_check_constraints", true)
        .unwrap();
    raw.execute(
        "UPDATE captures SET id = ?1 WHERE id = ?2",
        params!["x".repeat(36), record.id],
    )
    .unwrap();
    drop(raw);
    assert_eq!(
        Inbox::open(corrupt.0.clone()).err(),
        Some(InboxError::Corrupt)
    );
}

#[test]
fn existing_unrecognized_database_is_not_reinitialized_or_overwritten() {
    let directory = SyntheticDirectory::new();
    drop(directory.open());
    let raw = directory.raw();
    raw.pragma_update(None, "application_id", 1).unwrap();
    drop(raw);
    assert_eq!(
        Inbox::open(directory.0.clone()).err(),
        Some(InboxError::SchemaUnsupported)
    );
    let application: i64 = directory
        .raw()
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .unwrap();
    assert_eq!(application, 1);
}

#[test]
fn incomplete_sqlite_transaction_rolls_back_on_connection_drop() {
    let directory = SyntheticDirectory::new();
    let record = draft(&mut directory.open());
    {
        let raw = directory.raw();
        raw.execute_batch("BEGIN IMMEDIATE").unwrap();
        raw.execute("DELETE FROM captures WHERE id = ?1", [&record.id])
            .unwrap();
        raw.execute(
            "INSERT INTO receipts (id, revision) VALUES (?1, ?2)",
            params![record.id, i64::try_from(record.revision).unwrap()],
        )
        .unwrap();
        // 模拟在正文删除与回执写入后、COMMIT 前丢失连接。
    }
    let mut inbox = directory.open();
    assert!(inbox.get(&record.id).unwrap().unwrap() == record);
    assert_eq!(inbox.archived_revision(&record.id).unwrap(), None);
}

#[test]
fn invalid_digest_and_revision_cannot_prepare_or_confirm_a_commit() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let claimed = claim(&mut inbox);
    for after in ["A".repeat(64), "0".repeat(63), "a".repeat(64)] {
        assert_eq!(
            inbox
                .prepare_commit(
                    &claimed.record.id,
                    claimed.record.revision,
                    &claimed.claim_id,
                    Some("a".repeat(64)),
                    after,
                )
                .err(),
            Some(InboxError::InvalidInput)
        );
    }
    let intent = prepare(&mut inbox, &claimed);
    let mut oversized = intent.clone();
    oversized.revision = u64::MAX;
    assert_eq!(
        inbox.confirm_archived(&oversized).err(),
        Some(InboxError::InvalidInput)
    );
    let mut stale = intent.clone();
    stale.revision += 1;
    assert_eq!(
        inbox.confirm_archived(&stale).err(),
        Some(InboxError::Conflict)
    );
    assert!(inbox.get(&intent.id).unwrap().unwrap().content == claimed.record.content);
}

#[test]
fn public_dtos_reject_unknown_fields_and_use_stable_state_names() {
    let directory = SyntheticDirectory::new();
    let mut inbox = directory.open();
    let record = draft(&mut inbox);
    let mut value = serde_json::to_value(&record).unwrap();
    assert_eq!(value["state"], "draft");
    assert!(value.get("capturedAtMs").is_some());
    value["unexpected"] = serde_json::Value::Bool(true);
    assert!(serde_json::from_value::<CaptureRecord>(value).is_err());
    assert_eq!(
        serde_json::to_value(FailureCode::DuplicateName).unwrap(),
        "duplicateName"
    );
    assert_eq!(
        InboxError::Conflict.to_string(),
        InboxError::Conflict.code()
    );
}
