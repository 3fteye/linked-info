//! 当前系统用户目录内的独立明文便签收件箱。
//!
//! 路径只由原生组合根提供，不能来自 WebView；本 crate 不读取主工作区。
//! 归档调用方必须在自己的 owner/文件独占边界确认主文件提交结果。
//! SQLite 回执表示该固定修订已被消费，不表示正式节点现在仍然存在。

mod error;
mod model;
mod schema;
mod store;

pub use error::{InboxError, Result};
pub use model::{
    APPLICATION_DIRECTORY, CaptureRecord, CaptureState, CaptureSummary, ClaimedCapture,
    CommitIntent, DATABASE_FILE_NAME, FailureCode, MAX_CONTENT_CHARACTERS, MAX_NAME_CHARACTERS,
    MAX_RECORD_BYTES, MAX_REVISION, MAX_TOTAL_BYTES, MAX_UNARCHIVED_RECORDS, OutstandingCapture,
};
pub use store::Inbox;

#[cfg(test)]
mod tests;
