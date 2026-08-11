use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    error::Error,
    fs, io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

const CACHE_FILE_NAME: &str = "embedding-vectors.v1.sqlite3";
const DEFAULT_MAX_BYTES: u64 = 512 * 1024 * 1024;
const ACTIVE_DATABASE_TARGET_BYTES: u64 = 448 * 1024 * 1024;
const MAXIMUM_CACHE_BATCH_SIZE: usize = 256;
const MAXIMUM_VECTOR_DIMENSIONS: usize = 4_096;
const WAL_SIZE_LIMIT_BYTES: u64 = 8 * 1024 * 1024;

type StoreResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

#[derive(Default)]
pub struct VectorCacheState {
    operation_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum VectorRole {
    Query,
    Document,
}

impl VectorRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Query => "query",
            Self::Document => "document",
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCacheKey {
    fingerprint: String,
    role: VectorRole,
    content_hash: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCacheEntry {
    fingerprint: String,
    role: VectorRole,
    content_hash: String,
    vector: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VectorCacheStatus {
    persistent: bool,
    entry_count: u64,
    disk_bytes: u64,
    max_bytes: u64,
}

struct VectorCacheStore {
    database_path: PathBuf,
}

impl VectorCacheStore {
    fn new(database_path: PathBuf) -> Self {
        Self { database_path }
    }

    fn read(&self, keys: &[VectorCacheKey]) -> StoreResult<Vec<Option<Vec<f32>>>> {
        validate_batch_size(keys.len())?;
        for key in keys {
            validate_key(&key.fingerprint, &key.content_hash)?;
        }
        if !self.database_path.exists() {
            return Ok(keys.iter().map(|_| None).collect());
        }

        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let accessed_at = unix_time_micros()?;
        let mut results = Vec::with_capacity(keys.len());
        for key in keys {
            let row = transaction
                .query_row(
                    "SELECT dimensions, vector FROM embedding_vector_cache
                     WHERE fingerprint = ?1 AND role = ?2 AND content_hash = ?3",
                    params![key.fingerprint, key.role.as_str(), key.content_hash],
                    |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .optional()?;
            let (vector, corrupted) = match row {
                Some((dimensions, bytes)) => {
                    let decoded = decode_vector(dimensions, &bytes);
                    (decoded, true)
                }
                None => (None, false),
            };
            if vector.is_some() {
                transaction.execute(
                    "UPDATE embedding_vector_cache SET last_accessed = ?4
                     WHERE fingerprint = ?1 AND role = ?2 AND content_hash = ?3",
                    params![
                        key.fingerprint,
                        key.role.as_str(),
                        key.content_hash,
                        accessed_at
                    ],
                )?;
            } else if corrupted {
                transaction.execute(
                    "DELETE FROM embedding_vector_cache
                     WHERE fingerprint = ?1 AND role = ?2 AND content_hash = ?3",
                    params![key.fingerprint, key.role.as_str(), key.content_hash],
                )?;
            }
            results.push(vector);
        }
        transaction.commit()?;
        Ok(results)
    }

    fn write(&self, entries: &[VectorCacheEntry]) -> StoreResult<()> {
        validate_batch_size(entries.len())?;
        for entry in entries {
            validate_key(&entry.fingerprint, &entry.content_hash)?;
            validate_vector(&entry.vector)?;
        }
        if entries.is_empty() {
            return Ok(());
        }

        let mut connection = self.open()?;
        let transaction = connection.transaction()?;
        let accessed_at = unix_time_micros()?;
        {
            let mut statement = transaction.prepare_cached(
                "INSERT INTO embedding_vector_cache
                   (fingerprint, role, content_hash, dimensions, vector, last_accessed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(fingerprint, role, content_hash) DO UPDATE SET
                   dimensions = excluded.dimensions,
                   vector = excluded.vector,
                   last_accessed = excluded.last_accessed",
            )?;
            for entry in entries {
                statement.execute(params![
                    entry.fingerprint,
                    entry.role.as_str(),
                    entry.content_hash,
                    entry.vector.len() as i64,
                    encode_vector(&entry.vector),
                    accessed_at,
                ])?;
            }
        }
        transaction.commit()?;
        enforce_capacity(&connection)?;
        Ok(())
    }

    fn status(&self) -> StoreResult<VectorCacheStatus> {
        if !self.database_path.exists() {
            return Ok(empty_status());
        }
        let connection = self.open()?;
        let entry_count =
            connection.query_row("SELECT COUNT(*) FROM embedding_vector_cache", [], |row| {
                row.get::<_, u64>(0)
            })?;
        Ok(VectorCacheStatus {
            persistent: true,
            entry_count,
            disk_bytes: cache_disk_bytes(&self.database_path)?,
            max_bytes: DEFAULT_MAX_BYTES,
        })
    }

    fn clear(&self) -> StoreResult<VectorCacheStatus> {
        remove_if_present(&self.database_path)?;
        remove_if_present(&sidecar_path(&self.database_path, "-wal"))?;
        remove_if_present(&sidecar_path(&self.database_path, "-shm"))?;
        Ok(empty_status())
    }

    fn open(&self) -> StoreResult<Connection> {
        let parent = self.database_path.parent().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "vector cache path has no parent",
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
             PRAGMA foreign_keys = ON;
             PRAGMA wal_autocheckpoint = 256;
             PRAGMA journal_size_limit = {WAL_SIZE_LIMIT_BYTES};
             CREATE TABLE IF NOT EXISTS embedding_vector_cache (
               fingerprint TEXT NOT NULL,
               role TEXT NOT NULL CHECK(role IN ('query', 'document')),
               content_hash TEXT NOT NULL,
               dimensions INTEGER NOT NULL,
               vector BLOB NOT NULL,
               last_accessed INTEGER NOT NULL,
               PRIMARY KEY (fingerprint, role, content_hash)
             );
             CREATE INDEX IF NOT EXISTS embedding_vector_cache_lru
               ON embedding_vector_cache(last_accessed);"
        ))?;
        Ok(connection)
    }
}

fn validate_batch_size(size: usize) -> StoreResult<()> {
    if size > MAXIMUM_CACHE_BATCH_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "vector cache batch is too large",
        )
        .into());
    }
    Ok(())
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn validate_key(fingerprint: &str, content_hash: &str) -> StoreResult<()> {
    if !valid_sha256(fingerprint) || !valid_sha256(content_hash) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "vector cache key must contain lowercase SHA-256 values",
        )
        .into());
    }
    Ok(())
}

fn validate_vector(vector: &[f32]) -> StoreResult<()> {
    if vector.is_empty()
        || vector.len() > MAXIMUM_VECTOR_DIMENSIONS
        || vector.iter().any(|value| !value.is_finite())
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "vector cache entry contains an invalid vector",
        )
        .into());
    }
    Ok(())
}

fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(vector.len() * size_of::<f32>());
    for value in vector {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes
}

fn decode_vector(dimensions: i64, bytes: &[u8]) -> Option<Vec<f32>> {
    let dimensions = usize::try_from(dimensions).ok()?;
    if dimensions == 0
        || dimensions > MAXIMUM_VECTOR_DIMENSIONS
        || bytes.len() != dimensions * size_of::<f32>()
    {
        return None;
    }
    let vector = bytes
        .chunks_exact(size_of::<f32>())
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("f32 chunk has four bytes")))
        .collect::<Vec<_>>();
    vector
        .iter()
        .all(|value| value.is_finite())
        .then_some(vector)
}

fn enforce_capacity(connection: &Connection) -> StoreResult<()> {
    let mut pruned = false;
    while active_database_bytes(connection)? > ACTIVE_DATABASE_TARGET_BYTES {
        let removed = connection.execute(
            "DELETE FROM embedding_vector_cache WHERE rowid IN (
               SELECT rowid FROM embedding_vector_cache
               ORDER BY last_accessed ASC, rowid ASC
               LIMIT 1024
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
    let page_size = connection.pragma_query_value(None, "page_size", |row| row.get::<_, u64>(0))?;
    let page_count =
        connection.pragma_query_value(None, "page_count", |row| row.get::<_, u64>(0))?;
    let free_pages =
        connection.pragma_query_value(None, "freelist_count", |row| row.get::<_, u64>(0))?;
    Ok(page_count.saturating_sub(free_pages) * page_size)
}

fn unix_time_micros() -> StoreResult<i64> {
    let micros = SystemTime::now().duration_since(UNIX_EPOCH)?.as_micros();
    i64::try_from(micros).map_err(|_| {
        io::Error::other("system time is outside the supported vector cache range").into()
    })
}

fn empty_status() -> VectorCacheStatus {
    VectorCacheStatus {
        persistent: true,
        entry_count: 0,
        disk_bytes: 0,
        max_bytes: DEFAULT_MAX_BYTES,
    }
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

fn vector_cache_store(app: &AppHandle) -> Result<VectorCacheStore, String> {
    app.path()
        .app_cache_dir()
        .map(|directory| VectorCacheStore::new(directory.join(CACHE_FILE_NAME)))
        .map_err(|error| format!("cannot resolve vector cache directory: {error}"))
}

fn operation_lock(state: &tauri::State<'_, VectorCacheState>) -> Arc<Mutex<()>> {
    Arc::clone(&state.operation_lock)
}

#[tauri::command]
pub async fn read_embedding_vector_cache(
    app: AppHandle,
    state: tauri::State<'_, VectorCacheState>,
    keys: Vec<VectorCacheKey>,
) -> Result<Vec<Option<Vec<f32>>>, String> {
    let store = vector_cache_store(&app)?;
    let lock = operation_lock(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "vector cache operation lock is unavailable".to_owned())?;
        store.read(&keys).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn write_embedding_vector_cache(
    app: AppHandle,
    state: tauri::State<'_, VectorCacheState>,
    entries: Vec<VectorCacheEntry>,
) -> Result<(), String> {
    let store = vector_cache_store(&app)?;
    let lock = operation_lock(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "vector cache operation lock is unavailable".to_owned())?;
        store.write(&entries).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn inspect_embedding_vector_cache(
    app: AppHandle,
    state: tauri::State<'_, VectorCacheState>,
) -> Result<VectorCacheStatus, String> {
    let store = vector_cache_store(&app)?;
    let lock = operation_lock(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "vector cache operation lock is unavailable".to_owned())?;
        store.status().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clear_embedding_vector_cache(
    app: AppHandle,
    state: tauri::State<'_, VectorCacheState>,
) -> Result<VectorCacheStatus, String> {
    let store = vector_cache_store(&app)?;
    let lock = operation_lock(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock
            .lock()
            .map_err(|_| "vector cache operation lock is unavailable".to_owned())?;
        store.clear().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);

    fn test_store() -> (PathBuf, VectorCacheStore) {
        let sequence = TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "linked-info-vector-cache-test-{}-{sequence}",
            std::process::id()
        ));
        let store = VectorCacheStore::new(directory.join(CACHE_FILE_NAME));
        (directory, store)
    }

    fn key() -> VectorCacheKey {
        VectorCacheKey {
            fingerprint: "a".repeat(64),
            role: VectorRole::Document,
            content_hash: "b".repeat(64),
        }
    }

    #[test]
    fn stores_float32_vectors_without_raw_text() {
        let (directory, store) = test_store();
        let cache_key = key();
        store
            .write(&[VectorCacheEntry {
                fingerprint: cache_key.fingerprint.clone(),
                role: cache_key.role,
                content_hash: cache_key.content_hash.clone(),
                vector: vec![0.25, -0.5, 1.0],
            }])
            .unwrap();

        assert_eq!(
            store.read(&[cache_key]).unwrap(),
            vec![Some(vec![0.25, -0.5, 1.0])]
        );
        let status = store.status().unwrap();
        assert_eq!(status.entry_count, 1);
        assert!(status.disk_bytes > 0);
        assert_eq!(status.max_bytes, DEFAULT_MAX_BYTES);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clearing_removes_only_the_vector_cache_files() {
        let (directory, store) = test_store();
        let cache_key = key();
        store
            .write(&[VectorCacheEntry {
                fingerprint: cache_key.fingerprint,
                role: cache_key.role,
                content_hash: cache_key.content_hash,
                vector: vec![1.0, 0.0],
            }])
            .unwrap();
        let unrelated = directory.join("keep.txt");
        fs::write(&unrelated, "keep").unwrap();

        let status = store.clear().unwrap();

        assert_eq!(status.entry_count, 0);
        assert_eq!(status.disk_bytes, 0);
        assert!(unrelated.exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_non_hash_keys_and_non_finite_vectors() {
        assert!(validate_key("raw model name", &"b".repeat(64)).is_err());
        assert!(validate_vector(&[f32::NAN]).is_err());
    }
}
