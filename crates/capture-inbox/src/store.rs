use std::{
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    time::Duration,
};

use rusqlite::{
    Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior, params,
};

use crate::{
    CaptureRecord, CaptureState, CaptureSummary, ClaimedCapture, CommitIntent, DATABASE_FILE_NAME,
    FailureCode, InboxError, MAX_REVISION, OutstandingCapture, Result, model, schema,
};

/// 每个进程使用独立连接；所有修改在 BEGIN IMMEDIATE 中执行并确认落盘。
/// 不提供自动解锁、主文件读取、按时限释放领取或任意 SQL 接口。
pub struct Inbox {
    connection: Connection,
    recovery_required: bool,
}

impl Inbox {
    pub fn open(directory: PathBuf) -> Result<Self> {
        if !directory.is_absolute() {
            return Err(InboxError::InvalidInput);
        }
        create_user_directory(&directory)?;
        let path = directory.join(DATABASE_FILE_NAME);
        let new_file = create_user_file(&path)?;
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch("PRAGMA trusted_schema = OFF; PRAGMA foreign_keys = ON;")?;
        if !new_file {
            // 先拒绝其他格式，不能为一份不认识的数据库修改 journal 设置。
            let transaction = connection.transaction()?;
            schema::validate(&transaction)?;
            transaction.commit()?;
        }
        // DELETE + EXTRA 会在删除回滚日志后同步目录；不依赖异步 WAL checkpoint。
        // secure_delete 只减少 SQLite 可见残留，绝不是 SSD/系统备份的安全擦除承诺。
        connection.execute_batch(
            "PRAGMA journal_mode = DELETE;
             PRAGMA synchronous = EXTRA;
             PRAGMA secure_delete = ON;",
        )?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if new_file {
            schema::initialize(&transaction)?;
        }
        schema::validate(&transaction)?;
        let quick_check: String =
            transaction.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
        if quick_check != "ok" {
            return Err(InboxError::Corrupt);
        }
        // 验证完整活动记录，但不把整个收件箱正文常驻内存。
        let mut statement = transaction.prepare("SELECT id FROM captures ORDER BY id")?;
        let mut rows = statement.query([])?;
        while let Some(row) = rows.next()? {
            let id: String = row.get(0)?;
            read_stored(&transaction, &id)?.ok_or(InboxError::Corrupt)?;
        }
        drop(rows);
        drop(statement);
        transaction
            .commit()
            .map_err(|_| InboxError::RecoveryRequired)?;
        Ok(Self {
            connection,
            recovery_required: false,
        })
    }

    pub fn create_draft(&mut self, name: String, content: String) -> Result<CaptureRecord> {
        model::validate_text(&name, &content)?;
        self.write(|transaction| {
            schema::check_capacity(transaction, 0, name.len() + content.len(), true)?;
            let id = uuid::Uuid::new_v4().to_string();
            if receipt_revision(transaction, &id)?.is_some() {
                return Err(InboxError::Conflict);
            }
            transaction.execute(
                "INSERT INTO captures (id, revision, state, name, content)
                 VALUES (?1, 1, 'draft', ?2, ?3)",
                params![id, name, content],
            )?;
            Ok(required_stored(transaction, &id)?.record)
        })
    }

    /// Pending/Failed 的编辑与领取使用同一事务锁；成功后才允许 UI 开始编辑。
    /// 即便正文未变也推进修订，拒绝旧自动保存或旧提交覆盖此次编辑。
    pub fn save_draft(
        &mut self,
        id: &str,
        expected_revision: u64,
        name: String,
        content: String,
    ) -> Result<CaptureRecord> {
        validate_identity(id, expected_revision)?;
        model::validate_text(&name, &content)?;
        self.write(|transaction| {
            let stored = editable(transaction, id, expected_revision)?;
            let revision = next_revision(expected_revision)?;
            schema::check_capacity(
                transaction,
                stored.record.name.len() + stored.record.content.len(),
                name.len() + content.len(),
                false,
            )?;
            transaction.execute(
                "UPDATE captures SET revision = ?2, state = 'draft', name = ?3,
                    content = ?4, captured_at_ms = NULL, utc_offset_minutes = NULL, failure = NULL
                 WHERE id = ?1",
                params![id, sql_integer(revision)?, name, content],
            )?;
            Ok(required_stored(transaction, id)?.record)
        })
    }

    pub fn submit(
        &mut self,
        id: &str,
        expected_revision: u64,
        captured_at_ms: u64,
        utc_offset_minutes: i32,
    ) -> Result<CaptureRecord> {
        validate_identity(id, expected_revision)?;
        model::validate_time(captured_at_ms, utc_offset_minutes)?;
        self.write(|transaction| {
            let stored = editable(transaction, id, expected_revision)?;
            if stored.record.state == CaptureState::Pending {
                return Err(InboxError::Conflict);
            }
            if stored.record.name.trim().is_empty() && stored.record.content.trim().is_empty() {
                return Err(InboxError::InvalidInput);
            }
            let revision = next_revision(expected_revision)?;
            transaction.execute(
                "UPDATE captures SET revision = ?2, state = 'pending', captured_at_ms = ?3,
                    utc_offset_minutes = ?4, failure = NULL WHERE id = ?1",
                params![
                    id,
                    sql_integer(revision)?,
                    sql_integer(captured_at_ms)?,
                    utc_offset_minutes
                ],
            )?;
            Ok(required_stored(transaction, id)?.record)
        })
    }

    /// 只列出有界活动摘要；回执不会随着使用年限无限注入 WebView。
    pub fn list(&mut self) -> Result<Vec<CaptureSummary>> {
        self.read(|transaction| {
            let mut statement = transaction.prepare(
                "SELECT id, revision, state, name, captured_at_ms, utc_offset_minutes, failure
                 FROM captures ORDER BY rowid",
            )?;
            let mut rows = statement.query([])?;
            let mut summaries = Vec::new();
            while let Some(row) = rows.next()? {
                let summary = CaptureSummary {
                    id: row.get(0)?,
                    revision: unsigned_from_sql(row.get(1)?)?,
                    state: CaptureState::parse(&row.get::<_, String>(2)?)?,
                    name: row.get(3)?,
                    captured_at_ms: row
                        .get::<_, Option<i64>>(4)?
                        .map(unsigned_from_sql)
                        .transpose()?,
                    utc_offset_minutes: row.get(5)?,
                    failure: row
                        .get::<_, Option<String>>(6)?
                        .map(|value| FailureCode::parse(&value))
                        .transpose()?,
                };
                validate_summary(&summary).map_err(|_| InboxError::Corrupt)?;
                summaries.push(summary);
            }
            Ok(summaries)
        })
    }

    /// 已归档条目仅由 ID/revision 回执投影，不从磁盘恢复已删除正文。
    pub fn get(&mut self, id: &str) -> Result<Option<CaptureRecord>> {
        model::validate_id(id)?;
        self.read(|transaction| {
            if let Some(stored) = read_stored(transaction, id)? {
                return Ok(Some(stored.record));
            }
            Ok(
                receipt_revision(transaction, id)?.map(|revision| CaptureRecord {
                    id: id.to_owned(),
                    revision,
                    state: CaptureState::Archived,
                    name: String::new(),
                    content: String::new(),
                    captured_at_ms: None,
                    utc_offset_minutes: None,
                    failure: None,
                }),
            )
        })
    }

    pub fn archived_revision(&mut self, id: &str) -> Result<Option<u64>> {
        model::validate_id(id)?;
        self.read(|transaction| receipt_revision(transaction, id))
    }

    /// 全局最多一个在途记录；已有领取永不因墙钟或连接重开而失效。
    pub fn claim_next(&mut self) -> Result<Option<ClaimedCapture>> {
        self.write(|transaction| {
            if outstanding(transaction)?.is_some() {
                return Ok(None);
            }
            let id: Option<String> = transaction
                .query_row(
                    "SELECT id FROM captures WHERE state = 'pending'
                     ORDER BY captured_at_ms, id LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            let Some(id) = id else {
                return Ok(None);
            };
            required_stored(transaction, &id)?;
            let claim_id = uuid::Uuid::new_v4().to_string();
            transaction.execute(
                "UPDATE captures SET state = 'claimed', claim_id = ?2 WHERE id = ?1",
                params![id, claim_id],
            )?;
            Ok(Some(ClaimedCapture {
                record: required_stored(transaction, &id)?.record,
                claim_id,
            }))
        })
    }

    pub fn outstanding(&mut self) -> Result<Option<OutstandingCapture>> {
        self.read(outstanding)
    }

    /// 仅在调用方保证旧处理者不再写主文件后释放；此方法不判断进程存活。
    /// 已准备 intent 的领取必须走明确恢复证明，不能走这个入口。
    pub fn release_claim(&mut self, id: &str, revision: u64, claim_id: &str) -> Result<()> {
        validate_claim_identity(id, revision, claim_id)?;
        self.write(|transaction| {
            let stored = matching_claim(transaction, id, revision, claim_id)?;
            if stored.intent.is_some() {
                return Err(InboxError::RecoveryRequired);
            }
            transaction.execute(
                "UPDATE captures SET state = 'pending', claim_id = NULL WHERE id = ?1",
                [id],
            )?;
            Ok(())
        })
    }

    pub fn fail_claim(
        &mut self,
        id: &str,
        revision: u64,
        claim_id: &str,
        failure: FailureCode,
    ) -> Result<()> {
        validate_claim_identity(id, revision, claim_id)?;
        self.write(|transaction| {
            let stored = matching_claim(transaction, id, revision, claim_id)?;
            if stored.intent.is_some() {
                return Err(InboxError::RecoveryRequired);
            }
            transaction.execute(
                "UPDATE captures SET state = 'failed', claim_id = NULL, failure = ?2 WHERE id = ?1",
                params![id, failure.as_str()],
            )?;
            Ok(())
        })
    }

    /// 必须先持久化此边界，再替换主文件；摘要来源只能是主程序原生适配器。
    pub fn prepare_commit(
        &mut self,
        id: &str,
        revision: u64,
        claim_id: &str,
        before_sha256: Option<String>,
        after_sha256: String,
    ) -> Result<CommitIntent> {
        let intent = CommitIntent {
            id: id.to_owned(),
            revision,
            claim_id: claim_id.to_owned(),
            before_sha256,
            after_sha256,
        };
        intent.validate()?;
        self.write(|transaction| {
            let stored = matching_claim(transaction, id, revision, claim_id)?;
            if let Some(previous) = stored.intent {
                return if previous == intent {
                    Ok(intent)
                } else {
                    Err(InboxError::Conflict)
                };
            }
            transaction.execute(
                "UPDATE captures SET intent_before = ?2, intent_after = ?3 WHERE id = ?1",
                params![id, intent.before_sha256, intent.after_sha256],
            )?;
            Ok(intent)
        })
    }

    pub fn mark_uncertain(&mut self, intent: &CommitIntent) -> Result<()> {
        intent.validate()?;
        self.write(|transaction| {
            matching_intent(transaction, intent)?;
            transaction.execute(
                "UPDATE captures SET state = 'uncertain' WHERE id = ?1",
                [&intent.id],
            )?;
            Ok(())
        })
    }

    /// 调用方在可信主文件写锁下证明仍是 before，且旧写者不会再提交后调用。
    /// 没有匹配的正式文件证据时只能保留 Uncertain，不得自动重投。
    pub fn recover_before_commit(&mut self, intent: &CommitIntent) -> Result<()> {
        intent.validate()?;
        self.write(|transaction| {
            matching_intent(transaction, intent)?;
            transaction.execute(
                "UPDATE captures SET state = 'pending', claim_id = NULL,
                    intent_before = NULL, intent_after = NULL WHERE id = ?1",
                [&intent.id],
            )?;
            Ok(())
        })
    }

    /// 仅在正式持久化已确认（或可信主程序恢复已验证 after）后调用。
    /// 原子插入最小收据并删除正文；相同 ID/revision 的重复确认幂等。
    pub fn confirm_archived(&mut self, intent: &CommitIntent) -> Result<()> {
        intent.validate()?;
        self.write(|transaction| {
            if let Some(revision) = receipt_revision(transaction, &intent.id)? {
                return if revision == intent.revision {
                    Ok(())
                } else {
                    Err(InboxError::Conflict)
                };
            }
            matching_intent(transaction, intent)?;
            transaction.execute(
                "INSERT INTO receipts (id, revision) VALUES (?1, ?2)",
                params![intent.id, sql_integer(intent.revision)?],
            )?;
            transaction.execute("DELETE FROM captures WHERE id = ?1", [&intent.id])?;
            Ok(())
        })
    }

    fn read<T>(&mut self, operation: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let transaction = self.connection.transaction()?;
        schema::validate(&transaction)?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }

    fn write<T>(&mut self, operation: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        if self.recovery_required {
            return Err(InboxError::RecoveryRequired);
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        schema::validate(&transaction)?;
        let result = operation(&transaction)?;
        if transaction.commit().is_err() {
            // 不确定的 SQLite 提交不能被旧自动保存覆盖；重新打开后读取权威状态。
            self.recovery_required = true;
            return Err(InboxError::RecoveryRequired);
        }
        Ok(result)
    }
}

struct StoredCapture {
    record: CaptureRecord,
    claim_id: Option<String>,
    intent: Option<CommitIntent>,
}

fn read_stored(connection: &Connection, id: &str) -> Result<Option<StoredCapture>> {
    let mut statement = connection.prepare(
        "SELECT id, revision, state, name, content, captured_at_ms, utc_offset_minutes,
            failure, claim_id, intent_before, intent_after FROM captures WHERE id = ?1",
    )?;
    let mut rows = statement.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let record = CaptureRecord {
        id: row.get(0)?,
        revision: unsigned_from_sql(row.get(1)?)?,
        state: CaptureState::parse(&row.get::<_, String>(2)?)?,
        name: row.get(3)?,
        content: row.get(4)?,
        captured_at_ms: row
            .get::<_, Option<i64>>(5)?
            .map(unsigned_from_sql)
            .transpose()?,
        utc_offset_minutes: row.get(6)?,
        failure: row
            .get::<_, Option<String>>(7)?
            .map(|value| FailureCode::parse(&value))
            .transpose()?,
    };
    let claim_id: Option<String> = row.get(8)?;
    let before_sha256: Option<String> = row.get(9)?;
    let after_sha256: Option<String> = row.get(10)?;
    let summary = CaptureSummary {
        id: record.id.clone(),
        revision: record.revision,
        state: record.state,
        name: record.name.clone(),
        captured_at_ms: record.captured_at_ms,
        utc_offset_minutes: record.utc_offset_minutes,
        failure: record.failure,
    };
    validate_summary(&summary).map_err(|_| InboxError::Corrupt)?;
    model::validate_text(&record.name, &record.content).map_err(|_| InboxError::Corrupt)?;
    if matches!(
        record.state,
        CaptureState::Claimed | CaptureState::Uncertain
    ) != claim_id.is_some()
    {
        return Err(InboxError::Corrupt);
    }
    if let Some(claim_id) = &claim_id {
        model::validate_id(claim_id).map_err(|_| InboxError::Corrupt)?;
    }
    let intent = match after_sha256 {
        Some(after_sha256) => {
            let intent = CommitIntent {
                id: record.id.clone(),
                revision: record.revision,
                claim_id: claim_id.clone().ok_or(InboxError::Corrupt)?,
                before_sha256,
                after_sha256,
            };
            intent.validate().map_err(|_| InboxError::Corrupt)?;
            Some(intent)
        }
        None if before_sha256.is_some() || record.state == CaptureState::Uncertain => {
            return Err(InboxError::Corrupt);
        }
        None => None,
    };
    Ok(Some(StoredCapture {
        record,
        claim_id,
        intent,
    }))
}

fn validate_summary(summary: &CaptureSummary) -> Result<()> {
    validate_identity(&summary.id, summary.revision)?;
    model::validate_text(&summary.name, "")?;
    match (summary.captured_at_ms, summary.utc_offset_minutes) {
        (None, None) if summary.state == CaptureState::Draft => {}
        (Some(time), Some(offset)) if summary.state != CaptureState::Draft => {
            model::validate_time(time, offset)?;
        }
        _ => return Err(InboxError::Corrupt),
    }
    if (summary.state == CaptureState::Failed) != summary.failure.is_some() {
        return Err(InboxError::Corrupt);
    }
    Ok(())
}

fn required_stored(connection: &Connection, id: &str) -> Result<StoredCapture> {
    match read_stored(connection, id)? {
        Some(stored) => Ok(stored),
        None if receipt_revision(connection, id)?.is_some() => Err(InboxError::ReadOnly),
        None => Err(InboxError::NotFound),
    }
}

fn editable(connection: &Connection, id: &str, revision: u64) -> Result<StoredCapture> {
    let stored = required_stored(connection, id)?;
    if stored.record.revision != revision {
        return Err(InboxError::Conflict);
    }
    if !matches!(
        stored.record.state,
        CaptureState::Draft | CaptureState::Pending | CaptureState::Failed
    ) {
        return Err(InboxError::ReadOnly);
    }
    Ok(stored)
}

fn matching_claim(
    connection: &Connection,
    id: &str,
    revision: u64,
    claim_id: &str,
) -> Result<StoredCapture> {
    let stored = required_stored(connection, id)?;
    if stored.record.revision != revision || stored.claim_id.as_deref() != Some(claim_id) {
        return Err(InboxError::Conflict);
    }
    Ok(stored)
}

fn matching_intent(connection: &Connection, intent: &CommitIntent) -> Result<()> {
    let stored = matching_claim(connection, &intent.id, intent.revision, &intent.claim_id)?;
    if stored.intent.as_ref() != Some(intent) {
        return Err(InboxError::Conflict);
    }
    Ok(())
}

fn outstanding(connection: &Transaction<'_>) -> Result<Option<OutstandingCapture>> {
    let id: Option<String> = connection
        .query_row(
            "SELECT id FROM captures WHERE state IN ('claimed', 'uncertain')",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(id) = id else {
        return Ok(None);
    };
    let stored = required_stored(connection, &id)?;
    Ok(Some(OutstandingCapture {
        claimed: ClaimedCapture {
            record: stored.record,
            claim_id: stored.claim_id.ok_or(InboxError::Corrupt)?,
        },
        intent: stored.intent,
    }))
}

fn receipt_revision(connection: &Connection, id: &str) -> Result<Option<u64>> {
    let revision: Option<i64> = connection
        .query_row("SELECT revision FROM receipts WHERE id = ?1", [id], |row| {
            row.get(0)
        })
        .optional()?;
    revision
        .map(|revision| {
            let revision = unsigned_from_sql(revision)?;
            model::validate_revision(revision).map_err(|_| InboxError::Corrupt)?;
            Ok(revision)
        })
        .transpose()
}

// SQLite INTEGER 是有符号 64 位；公共 DTO 仍使用有界无符号整数。
fn sql_integer(value: u64) -> Result<i64> {
    i64::try_from(value).map_err(|_| InboxError::InvalidInput)
}

fn unsigned_from_sql(value: i64) -> Result<u64> {
    u64::try_from(value).map_err(|_| InboxError::Corrupt)
}

fn validate_identity(id: &str, revision: u64) -> Result<()> {
    model::validate_id(id)?;
    model::validate_revision(revision)
}

fn validate_claim_identity(id: &str, revision: u64, claim_id: &str) -> Result<()> {
    validate_identity(id, revision)?;
    model::validate_id(claim_id)
}

fn next_revision(revision: u64) -> Result<u64> {
    if revision >= MAX_REVISION {
        return Err(InboxError::Capacity);
    }
    Ok(revision + 1)
}

fn create_user_directory(directory: &Path) -> Result<()> {
    if !directory.exists() {
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(directory)?;
    }
    let metadata = fs::symlink_metadata(directory)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(InboxError::InvalidInput);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(InboxError::InvalidInput);
        }
    }
    // Windows 继承原生组合根提供的当前用户应用数据目录 ACL，不调用通用 shell。
    Ok(())
}

fn create_user_file(path: &Path) -> Result<bool> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(file) => {
            file.sync_all()?;
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let metadata = fs::symlink_metadata(path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(InboxError::InvalidInput);
            }
            if metadata.len() == 0 {
                // 另一进程可能正初始化；绝不能把已有空/损坏文件当成新收件箱覆盖。
                return Err(InboxError::Busy);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o077 != 0 {
                    return Err(InboxError::InvalidInput);
                }
            }
            Ok(false)
        }
        Err(error) => Err(error.into()),
    }
}
