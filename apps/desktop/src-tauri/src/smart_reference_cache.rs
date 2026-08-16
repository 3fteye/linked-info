use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CACHE_FILE_NAME: &str = "smart-reference-results.v1.sqlite3";
const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;
const ACTIVE_DATABASE_TARGET_BYTES: u64 = 224 * 1024 * 1024;
const MAXIMUM_RESULT_BYTES: usize = 2 * 1024 * 1024;
const MAXIMUM_CANDIDATES: usize = 256;
const MAXIMUM_RELATED_NODES: usize = 256;
const MAXIMUM_SUPPORTING_NODES: usize = 32;
const WAL_SIZE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;
const CACHE_AAD_PREFIX: &[u8] = b"linked-info-smart-reference-result-v1\0";

type StoreResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Default)]
pub struct SmartReferenceCacheState {
    operation_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedCandidate {
    node_id: String,
    score: f64,
    supporting_node_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedRelatedNode {
    node_id: String,
    similarity: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedSmartReferenceResult {
    candidates: Vec<CachedCandidate>,
    generated_at_ms: u64,
    llm_enabled: bool,
    llm_no_match: bool,
    llm_selected_node_ids: Vec<String>,
    llm_uncertain_node_ids: Vec<String>,
    related_nodes: Vec<CachedRelatedNode>,
    source_node_id: String,
    truncated_node_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartReferenceCacheStatus {
    persistent: bool,
    entry_count: u64,
    disk_bytes: u64,
    max_bytes: u64,
}

struct SmartReferenceCacheStore {
    database_path: PathBuf,
}

impl SmartReferenceCacheStore {
    fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    fn read(&self, key: &str) -> StoreResult<Option<Vec<u8>>> {
        if !self.database_path.exists() {
            return Ok(None);
        }
        let connection = self.open()?;
        connection
            .query_row(
                "SELECT encrypted_result FROM smart_reference_result_cache WHERE cache_key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    }

    fn touch(&self, key: &str) -> StoreResult<()> {
        if !self.database_path.exists() {
            return Ok(());
        }
        let connection = self.open()?;
        connection.execute(
            "UPDATE smart_reference_result_cache SET last_accessed = ?2 WHERE cache_key = ?1",
            params![key, unix_time_micros()?],
        )?;
        Ok(())
    }

    fn write(&self, key: &str, encrypted_result: &[u8]) -> StoreResult<()> {
        let connection = self.open()?;
        let now = unix_time_micros()?;
        connection.execute(
            "INSERT INTO smart_reference_result_cache
               (cache_key, encrypted_result, created_at, last_accessed)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(cache_key) DO UPDATE SET
               encrypted_result = excluded.encrypted_result,
               created_at = excluded.created_at,
               last_accessed = excluded.last_accessed",
            params![key, encrypted_result, now],
        )?;
        enforce_capacity(&connection)?;
        Ok(())
    }

    fn delete(&self, key: &str) -> StoreResult<()> {
        if !self.database_path.exists() {
            return Ok(());
        }
        self.open()?.execute(
            "DELETE FROM smart_reference_result_cache WHERE cache_key = ?1",
            params![key],
        )?;
        Ok(())
    }

    fn status(&self) -> StoreResult<SmartReferenceCacheStatus> {
        if !self.database_path.exists() {
            return Ok(empty_status(true));
        }
        let connection = self.open()?;
        let count = connection.query_row(
            "SELECT COUNT(*) FROM smart_reference_result_cache",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(SmartReferenceCacheStatus {
            persistent: true,
            entry_count: u64::try_from(count)
                .map_err(|_| io::Error::other("smart reference cache count is negative"))?,
            disk_bytes: cache_disk_bytes(&self.database_path)?,
            max_bytes: DEFAULT_MAX_BYTES,
        })
    }

    fn clear(&self) -> StoreResult<()> {
        remove_if_present(&self.database_path)?;
        remove_if_present(&sidecar_path(&self.database_path, "-wal"))?;
        remove_if_present(&sidecar_path(&self.database_path, "-shm"))?;
        Ok(())
    }

    fn open(&self) -> StoreResult<Connection> {
        let parent = self.database_path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "smart reference cache has no parent",
            )
        })?;
        fs::create_dir_all(parent)?;
        let is_new = !self.database_path.exists();
        let connection = Connection::open(&self.database_path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        if is_new {
            connection.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
        }
        connection.execute_batch(&format!(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA wal_autocheckpoint = 128;
             PRAGMA journal_size_limit = {WAL_SIZE_LIMIT_BYTES};
             CREATE TABLE IF NOT EXISTS smart_reference_result_cache (
               cache_key TEXT PRIMARY KEY NOT NULL,
               encrypted_result BLOB NOT NULL,
               created_at INTEGER NOT NULL,
               last_accessed INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS smart_reference_result_cache_lru
               ON smart_reference_result_cache(last_accessed);"
        ))?;
        Ok(connection)
    }
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_node_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

fn valid_unique_node_ids(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum
        && values.iter().all(|value| valid_node_id(value))
        && values.iter().collect::<HashSet<_>>().len() == values.len()
}

fn validate_result(result: &CachedSmartReferenceResult) -> Result<(), String> {
    if !valid_node_id(&result.source_node_id)
        || result.candidates.len() > MAXIMUM_CANDIDATES
        || result.related_nodes.len() > MAXIMUM_RELATED_NODES
        || !valid_unique_node_ids(&result.llm_selected_node_ids, MAXIMUM_CANDIDATES)
        || !valid_unique_node_ids(&result.llm_uncertain_node_ids, MAXIMUM_CANDIDATES)
        || result
            .llm_selected_node_ids
            .iter()
            .any(|id| result.llm_uncertain_node_ids.contains(id))
        || result.candidates.iter().any(|candidate| {
            !valid_node_id(&candidate.node_id)
                || !candidate.score.is_finite()
                || !(0.0..=1.0).contains(&candidate.score)
                || !valid_unique_node_ids(&candidate.supporting_node_ids, MAXIMUM_SUPPORTING_NODES)
        })
        || result.related_nodes.iter().any(|related| {
            !valid_node_id(&related.node_id)
                || !related.similarity.is_finite()
                || !(-1.0..=1.0).contains(&related.similarity)
        })
    {
        return Err("smart reference cache result is invalid".to_owned());
    }
    Ok(())
}

fn cache_aad(key: &str) -> Vec<u8> {
    let mut aad = Vec::with_capacity(CACHE_AAD_PREFIX.len() + key.len());
    aad.extend_from_slice(CACHE_AAD_PREFIX);
    aad.extend_from_slice(key.as_bytes());
    aad
}

fn smart_reference_cache_store(app: &AppHandle) -> Result<SmartReferenceCacheStore, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| SmartReferenceCacheStore::new(directory.join(CACHE_FILE_NAME)))
        .map_err(|error| format!("cannot resolve smart reference cache directory: {error}"))
}

fn operation_lock(state: &SmartReferenceCacheState) -> Arc<Mutex<()>> {
    Arc::clone(&state.operation_lock)
}

fn is_access_error(error: &str) -> bool {
    matches!(
        error,
        "workspace_vault_locked"
            | "workspace_vault_state_unavailable"
            | "workspace_vault_session_expired"
    )
}

async fn delete_cache_entry(
    store: SmartReferenceCacheStore,
    lock: Arc<Mutex<()>>,
    key: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        store.delete(&key).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_smart_reference_result_cache(
    app: AppHandle,
    cache_state: tauri::State<'_, SmartReferenceCacheState>,
    vault_state: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    key: String,
) -> Result<Option<CachedSmartReferenceResult>, String> {
    if !valid_sha256(&key) {
        return Err("smart reference cache key is invalid".to_owned());
    }
    if !crate::workspace_file::workspace_encryption_configured(&app) {
        return Ok(None);
    }
    let store = smart_reference_cache_store(&app)?;
    let lock = operation_lock(&cache_state);
    let read_store = SmartReferenceCacheStore::new(store.database_path.clone());
    let read_lock = Arc::clone(&lock);
    let read_key = key.clone();
    let encrypted = tauri::async_runtime::spawn_blocking(move || {
        let _guard = read_lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        read_store
            .read(&read_key)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    let Some(encrypted) = encrypted else {
        return Ok(None);
    };
    let plaintext = match vault_state.decrypt_derived_cache_payload(&encrypted, &cache_aad(&key)) {
        Ok(plaintext) => plaintext,
        Err(error) if is_access_error(&error) => return Err(error),
        Err(_) => {
            delete_cache_entry(store, lock, key).await?;
            return Ok(None);
        }
    };
    if plaintext.len() > MAXIMUM_RESULT_BYTES {
        delete_cache_entry(store, lock, key).await?;
        return Ok(None);
    }
    let result: CachedSmartReferenceResult = match serde_json::from_slice(&plaintext) {
        Ok(result) => result,
        Err(_) => {
            delete_cache_entry(store, lock, key).await?;
            return Ok(None);
        }
    };
    if validate_result(&result).is_err() {
        delete_cache_entry(store, lock, key).await?;
        return Ok(None);
    }
    let touch_store = SmartReferenceCacheStore::new(store.database_path.clone());
    let touch_lock = Arc::clone(&lock);
    let touch_key = key;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = touch_lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        touch_store
            .touch(&touch_key)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(Some(result))
}

#[tauri::command]
pub async fn write_smart_reference_result_cache(
    app: AppHandle,
    cache_state: tauri::State<'_, SmartReferenceCacheState>,
    vault_state: tauri::State<'_, crate::workspace_file::WorkspaceVaultState>,
    key: String,
    result: CachedSmartReferenceResult,
) -> Result<(), String> {
    if !valid_sha256(&key) {
        return Err("smart reference cache key is invalid".to_owned());
    }
    validate_result(&result)?;
    if !crate::workspace_file::workspace_encryption_configured(&app) {
        return Ok(());
    }
    let plaintext = serde_json::to_vec(&result)
        .map_err(|_| "smart reference cache result cannot be serialized".to_owned())?;
    if plaintext.len() > MAXIMUM_RESULT_BYTES {
        return Err("smart reference cache result is too large".to_owned());
    }
    let encrypted = vault_state.encrypt_derived_cache_payload(&plaintext, &cache_aad(&key))?;
    let store = smart_reference_cache_store(&app)?;
    let lock = operation_lock(&cache_state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        store
            .write(&key, &encrypted)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn inspect_smart_reference_result_cache(
    app: AppHandle,
    cache_state: tauri::State<'_, SmartReferenceCacheState>,
) -> Result<SmartReferenceCacheStatus, String> {
    if !crate::workspace_file::workspace_encryption_configured(&app) {
        return Ok(empty_status(false));
    }
    let store = smart_reference_cache_store(&app)?;
    let lock = operation_lock(&cache_state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        store.status().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clear_smart_reference_result_cache(
    app: AppHandle,
    cache_state: tauri::State<'_, SmartReferenceCacheState>,
) -> Result<SmartReferenceCacheStatus, String> {
    let store = smart_reference_cache_store(&app)?;
    let encrypted = crate::workspace_file::workspace_encryption_configured(&app);
    let lock = operation_lock(&cache_state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        store.clear().map_err(|error| error.to_string())?;
        Ok(empty_status(encrypted))
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn purge(app: &AppHandle, state: &SmartReferenceCacheState) -> Result<(), String> {
    let store = smart_reference_cache_store(app)?;
    let lock = operation_lock(state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "smart reference cache lock is unavailable".to_owned())?;
        store.clear().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn empty_status(persistent: bool) -> SmartReferenceCacheStatus {
    SmartReferenceCacheStatus {
        persistent,
        entry_count: 0,
        disk_bytes: 0,
        max_bytes: if persistent { DEFAULT_MAX_BYTES } else { 0 },
    }
}

fn enforce_capacity(connection: &Connection) -> StoreResult<()> {
    let mut pruned = false;
    while active_database_bytes(connection)? > ACTIVE_DATABASE_TARGET_BYTES {
        let removed = connection.execute(
            "DELETE FROM smart_reference_result_cache WHERE rowid IN (
               SELECT rowid FROM smart_reference_result_cache
               ORDER BY last_accessed ASC, rowid ASC
               LIMIT 256
             )",
            [],
        )?;
        if removed == 0 {
            break;
        }
        pruned = true;
    }
    if pruned {
        connection.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA incremental_vacuum;")?;
    }
    Ok(())
}

fn active_database_bytes(connection: &Connection) -> StoreResult<u64> {
    let page_size = connection.pragma_query_value(None, "page_size", |row| row.get::<_, i64>(0))?;
    let page_count =
        connection.pragma_query_value(None, "page_count", |row| row.get::<_, i64>(0))?;
    let free_pages =
        connection.pragma_query_value(None, "freelist_count", |row| row.get::<_, i64>(0))?;
    Ok(u64::try_from(page_count.saturating_sub(free_pages))?
        .saturating_mul(u64::try_from(page_size)?))
}

fn unix_time_micros() -> StoreResult<i64> {
    let micros = SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros();
    i64::try_from(micros)
        .map_err(|_| io::Error::other("system time is outside the cache range").into())
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut path = database_path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

fn file_bytes(path: &Path) -> io::Result<u64> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error),
    }
}

fn cache_disk_bytes(database_path: &Path) -> io::Result<u64> {
    Ok(file_bytes(database_path)?
        + file_bytes(&sidecar_path(database_path, "-wal"))?
        + file_bytes(&sidecar_path(database_path, "-shm"))?)
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_store() -> (PathBuf, SmartReferenceCacheStore) {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "linked-info-smart-reference-cache-test-{}-{sequence}",
            std::process::id()
        ));
        let store = SmartReferenceCacheStore::new(directory.join(CACHE_FILE_NAME));
        (directory, store)
    }

    fn node_id(index: u128) -> String {
        uuid::Uuid::from_u128(index).to_string()
    }

    fn result() -> CachedSmartReferenceResult {
        CachedSmartReferenceResult {
            candidates: vec![CachedCandidate {
                node_id: node_id(2),
                score: 0.75,
                supporting_node_ids: vec![node_id(3)],
            }],
            generated_at_ms: 42,
            llm_enabled: true,
            llm_no_match: false,
            llm_selected_node_ids: vec![node_id(2)],
            llm_uncertain_node_ids: Vec::new(),
            related_nodes: vec![CachedRelatedNode {
                node_id: node_id(3),
                similarity: 0.5,
            }],
            source_node_id: node_id(1),
            truncated_node_count: 0,
        }
    }

    #[test]
    fn stores_only_opaque_encrypted_payloads() {
        let (directory, store) = test_store();
        let key = "a".repeat(64);
        let opaque = b"cipher envelope only";
        store.write(&key, opaque).unwrap();
        assert_eq!(store.read(&key).unwrap(), Some(opaque.to_vec()));
        assert_eq!(store.status().unwrap().entry_count, 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_invalid_result_relationships() {
        let mut invalid = result();
        invalid.llm_uncertain_node_ids = invalid.llm_selected_node_ids.clone();
        assert!(validate_result(&invalid).is_err());
    }

    #[test]
    fn clearing_does_not_remove_unrelated_files() {
        let (directory, store) = test_store();
        store.write(&"b".repeat(64), b"opaque").unwrap();
        let unrelated = directory.join("keep.txt");
        fs::write(&unrelated, "keep").unwrap();
        store.clear().unwrap();
        assert!(unrelated.exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
