use serde::{Deserialize, Serialize};

use crate::{InboxError, Result};

pub const APPLICATION_DIRECTORY: &str = "com.linkedinfo.capture";
pub const DATABASE_FILE_NAME: &str = "capture-inbox.v1.sqlite3";
pub const MAX_UNARCHIVED_RECORDS: usize = 1_000;
pub const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_NAME_CHARACTERS: usize = 512;
pub const MAX_CONTENT_CHARACTERS: usize = 100_000;
pub const MAX_RECORD_BYTES: usize = 512 * 1024;
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;
const MAX_CAPTURED_AT_MS: u64 = 253_402_300_799_999;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CaptureState {
    Draft,
    Pending,
    Claimed,
    Failed,
    Uncertain,
    Archived,
}

impl CaptureState {
    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "draft" => Ok(Self::Draft),
            "pending" => Ok(Self::Pending),
            "claimed" => Ok(Self::Claimed),
            "failed" => Ok(Self::Failed),
            "uncertain" => Ok(Self::Uncertain),
            _ => Err(InboxError::Corrupt),
        }
    }
}

/// 仅保存稳定原因码；不持久化工作区错误消息或其他节点的名称。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FailureCode {
    DuplicateName,
    Empty,
    Invalid,
    SaveFailed,
}

impl FailureCode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::DuplicateName => "duplicateName",
            Self::Empty => "empty",
            Self::Invalid => "invalid",
            Self::SaveFailed => "saveFailed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        match value {
            "duplicateName" => Ok(Self::DuplicateName),
            "empty" => Ok(Self::Empty),
            "invalid" => Ok(Self::Invalid),
            "saveFailed" => Ok(Self::SaveFailed),
            _ => Err(InboxError::Corrupt),
        }
    }
}

// 有意不派生 Debug：名称、正文不能被普通调试日志意外输出。
#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureRecord {
    pub id: String,
    pub revision: u64,
    pub state: CaptureState,
    pub name: String,
    pub content: String,
    pub captured_at_ms: Option<u64>,
    pub utc_offset_minutes: Option<i32>,
    pub failure: Option<FailureCode>,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureSummary {
    pub id: String,
    pub revision: u64,
    pub state: CaptureState,
    pub name: String,
    pub captured_at_ms: Option<u64>,
    pub utc_offset_minutes: Option<i32>,
    pub failure: Option<FailureCode>,
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimedCapture {
    pub record: CaptureRecord,
    pub claim_id: String,
}

/// 只包含正式文件的提交校验信息，不包含正文、正文散列或工作区快照。
/// 收件箱并不是可信提交证明；调用方必须在自己的文件写入边界复验。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitIntent {
    pub id: String,
    pub revision: u64,
    pub claim_id: String,
    pub before_sha256: Option<String>,
    pub after_sha256: String,
}

impl CommitIntent {
    pub(crate) fn validate(&self) -> Result<()> {
        validate_id(&self.id)?;
        validate_id(&self.claim_id)?;
        validate_revision(self.revision)?;
        validate_digest(&self.after_sha256)?;
        if let Some(before) = &self.before_sha256 {
            validate_digest(before)?;
            if before == &self.after_sha256 {
                return Err(InboxError::InvalidInput);
            }
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutstandingCapture {
    pub claimed: ClaimedCapture,
    pub intent: Option<CommitIntent>,
}

pub(crate) fn validate_id(id: &str) -> Result<()> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| InboxError::InvalidInput)?;
    if parsed.to_string() != id
        || !matches!(id.as_bytes()[14], b'1'..=b'8')
        || !matches!(id.as_bytes()[19], b'8' | b'9' | b'a' | b'b')
    {
        return Err(InboxError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn validate_revision(revision: u64) -> Result<()> {
    if !(1..=MAX_REVISION).contains(&revision) {
        return Err(InboxError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn validate_text(name: &str, content: &str) -> Result<()> {
    if name.len().saturating_add(content.len()) > MAX_RECORD_BYTES
        || name.chars().count() > MAX_NAME_CHARACTERS
        || content.chars().count() > MAX_CONTENT_CHARACTERS
        || name.contains('\0')
        || content.contains('\0')
    {
        return Err(InboxError::InvalidInput);
    }
    Ok(())
}

pub(crate) fn validate_time(captured_at_ms: u64, utc_offset_minutes: i32) -> Result<()> {
    if captured_at_ms > MAX_CAPTURED_AT_MS || !(-840..=840).contains(&utc_offset_minutes) {
        return Err(InboxError::InvalidInput);
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<()> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(InboxError::InvalidInput);
    }
    Ok(())
}
