use rusqlite::{Connection, Transaction, params};

use crate::{InboxError, MAX_RECORD_BYTES, MAX_TOTAL_BYTES, MAX_UNARCHIVED_RECORDS, Result};

const APPLICATION_ID: i64 = 0x4c_49_43_49;
const SCHEMA_VERSION: i64 = 1;

const CAPTURES_SQL: &str = "CREATE TABLE captures (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 36
        AND id GLOB '????????-????-[1-8]???-[89ab]???-????????????'
        AND id NOT GLOB '*[^0-9a-f-]*'),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    state TEXT NOT NULL CHECK(state IN ('draft', 'pending', 'claimed', 'failed', 'uncertain')),
    name TEXT NOT NULL CHECK(length(name) <= 512 AND instr(name, char(0)) = 0),
    content TEXT NOT NULL CHECK(length(content) <= 100000 AND instr(content, char(0)) = 0),
    captured_at_ms INTEGER CHECK(captured_at_ms BETWEEN 0 AND 253402300799999),
    utc_offset_minutes INTEGER CHECK(utc_offset_minutes BETWEEN -840 AND 840),
    failure TEXT CHECK(failure IN ('duplicateName', 'empty', 'invalid', 'saveFailed')),
    claim_id TEXT CHECK(length(claim_id) = 36
        AND claim_id GLOB '????????-????-[1-8]???-[89ab]???-????????????'
        AND claim_id NOT GLOB '*[^0-9a-f-]*'),
    intent_before TEXT CHECK(length(intent_before) = 64),
    intent_after TEXT CHECK(length(intent_after) = 64),
    CHECK(length(CAST(name AS BLOB)) + length(CAST(content AS BLOB)) <= 524288),
    CHECK((state = 'draft' AND captured_at_ms IS NULL AND utc_offset_minutes IS NULL)
        OR (state != 'draft' AND captured_at_ms IS NOT NULL AND utc_offset_minutes IS NOT NULL)),
    CHECK((state = 'failed' AND failure IS NOT NULL) OR (state != 'failed' AND failure IS NULL)),
    CHECK((state IN ('claimed', 'uncertain') AND claim_id IS NOT NULL)
        OR (state NOT IN ('claimed', 'uncertain') AND claim_id IS NULL)),
    CHECK(intent_before IS NULL OR intent_after IS NOT NULL),
    CHECK(intent_after IS NULL OR state IN ('claimed', 'uncertain')),
    CHECK(state != 'uncertain' OR intent_after IS NOT NULL)
) STRICT";

const RECEIPTS_SQL: &str = "CREATE TABLE receipts (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 36
        AND id GLOB '????????-????-[1-8]???-[89ab]???-????????????'
        AND id NOT GLOB '*[^0-9a-f-]*'),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991)
) STRICT";

const INFLIGHT_SQL: &str = "CREATE UNIQUE INDEX captures_one_inflight ON captures ((1))
    WHERE state IN ('claimed', 'uncertain')";
const PENDING_SQL: &str = "CREATE INDEX captures_pending_order ON captures (captured_at_ms, id)
    WHERE state = 'pending'";
const OBJECTS: [(&str, &str); 4] = [
    ("captures", CAPTURES_SQL),
    ("captures_one_inflight", INFLIGHT_SQL),
    ("captures_pending_order", PENDING_SQL),
    ("receipts", RECEIPTS_SQL),
];

pub(crate) fn initialize(transaction: &Transaction<'_>) -> Result<()> {
    for (_, sql) in OBJECTS {
        transaction.execute_batch(sql)?;
    }
    transaction.pragma_update(None, "application_id", APPLICATION_ID)?;
    transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

pub(crate) fn validate(connection: &Connection) -> Result<()> {
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    let application: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if version != SCHEMA_VERSION || application != APPLICATION_ID {
        return Err(InboxError::SchemaUnsupported);
    }
    // 不能让追加 trigger/view 或被改写的 CHECK 将收件箱变成另一份协议。
    let count: i64 = connection.query_row(
        "SELECT count(*) FROM sqlite_schema WHERE substr(name, 1, 7) != 'sqlite_'",
        [],
        |row| row.get(0),
    )?;
    if size_from_sql(count)? != OBJECTS.len() {
        return Err(InboxError::Corrupt);
    }
    for (name, expected_sql) in OBJECTS {
        let matches: bool = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = ?1 AND sql = ?2)",
            params![name, expected_sql],
            |row| row.get(0),
        )?;
        if !matches {
            return Err(InboxError::Corrupt);
        }
    }
    let (records, bytes, largest): (i64, i64, i64) = connection.query_row(
        "SELECT count(*), coalesce(sum(length(CAST(name AS BLOB))
            + length(CAST(content AS BLOB))), 0),
            coalesce(max(length(CAST(name AS BLOB)) + length(CAST(content AS BLOB))), 0)
         FROM captures",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    if size_from_sql(records)? > MAX_UNARCHIVED_RECORDS
        || size_from_sql(bytes)? > MAX_TOTAL_BYTES
        || size_from_sql(largest)? > MAX_RECORD_BYTES
    {
        return Err(InboxError::Corrupt);
    }
    let duplicate: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM captures INNER JOIN receipts USING (id))",
        [],
        |row| row.get(0),
    )?;
    if duplicate {
        return Err(InboxError::Corrupt);
    }
    Ok(())
}

pub(crate) fn check_capacity(
    connection: &Connection,
    replaced_bytes: usize,
    new_bytes: usize,
    adding: bool,
) -> Result<()> {
    let (records, bytes): (i64, i64) = connection.query_row(
        "SELECT count(*), coalesce(sum(length(CAST(name AS BLOB))
            + length(CAST(content AS BLOB))), 0) FROM captures",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let records = size_from_sql(records)?;
    let total = size_from_sql(bytes)?
        .checked_sub(replaced_bytes)
        .and_then(|bytes| bytes.checked_add(new_bytes))
        .ok_or(InboxError::Corrupt)?;
    if (adding && records >= MAX_UNARCHIVED_RECORDS) || total > MAX_TOTAL_BYTES {
        return Err(InboxError::Capacity);
    }
    Ok(())
}

fn size_from_sql(value: i64) -> Result<usize> {
    usize::try_from(value).map_err(|_| InboxError::Corrupt)
}
