use thiserror::Error;

/// 对外错误不包含 SQLite 原文、文件路径或用户输入。
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum InboxError {
    #[error("capture_invalid_input")]
    InvalidInput,
    #[error("capture_conflict")]
    Conflict,
    #[error("capture_read_only")]
    ReadOnly,
    #[error("capture_not_found")]
    NotFound,
    #[error("capture_capacity")]
    Capacity,
    #[error("capture_schema_unsupported")]
    SchemaUnsupported,
    #[error("capture_corrupt")]
    Corrupt,
    #[error("capture_io")]
    Io,
    #[error("capture_busy")]
    Busy,
    #[error("capture_recovery_required")]
    RecoveryRequired,
}

impl InboxError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidInput => "capture_invalid_input",
            Self::Conflict => "capture_conflict",
            Self::ReadOnly => "capture_read_only",
            Self::NotFound => "capture_not_found",
            Self::Capacity => "capture_capacity",
            Self::SchemaUnsupported => "capture_schema_unsupported",
            Self::Corrupt => "capture_corrupt",
            Self::Io => "capture_io",
            Self::Busy => "capture_busy",
            Self::RecoveryRequired => "capture_recovery_required",
        }
    }
}

impl From<rusqlite::Error> for InboxError {
    fn from(error: rusqlite::Error) -> Self {
        match error {
            rusqlite::Error::SqliteFailure(error, _) => match error.code {
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => Self::Busy,
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                    Self::Corrupt
                }
                rusqlite::ErrorCode::ConstraintViolation => Self::Corrupt,
                _ => Self::Io,
            },
            _ => Self::Corrupt,
        }
    }
}

impl From<std::io::Error> for InboxError {
    fn from(_: std::io::Error) -> Self {
        Self::Io
    }
}

pub type Result<T> = std::result::Result<T, InboxError>;
