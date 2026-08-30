use std::{
    collections::BTreeMap,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

use linked_info_extension_host_protocol::{
    EXTENSION_HOST_PROTOCOL_VERSION, ExtensionHostRequestV1, ExtensionHostResponseV1,
    MAXIMUM_EXTENSION_HOST_REQUEST_BYTES, MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES,
};
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
#[cfg(windows)]
const EXTENSION_HOST_PROCESS_MEMORY_BYTES: usize = 512 * 1024 * 1024;

struct ExtensionHostConnection {
    child: Child,
    input: BufWriter<ChildStdin>,
    responses: mpsc::Receiver<ExtensionHostResponseV1>,
    reader_thread: Option<thread::JoinHandle<()>>,
}

impl ExtensionHostConnection {
    fn write_request(&mut self, request: &ExtensionHostRequestV1) -> Result<(), String> {
        let encoded = serde_json::to_vec(request)
            .map_err(|_| "extension_runtime_protocol_unavailable".to_owned())?;
        if encoded.len() > MAXIMUM_EXTENSION_HOST_REQUEST_BYTES {
            return Err("extension_runtime_request_invalid".to_owned());
        }
        self.input
            .write_all(&encoded)
            .and_then(|()| self.input.write_all(b"\n"))
            .and_then(|()| self.input.flush())
            .map_err(|_| "extension_runtime_protocol_unavailable".to_owned())
    }

    fn receive_response_with_guard(
        &self,
        timeout: Duration,
        mut guard: impl FnMut() -> bool,
    ) -> Result<ExtensionHostResponseV1, String> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| "extension_runtime_response_timeout".to_owned())?;
        loop {
            if !guard() {
                return Err("extension_runtime_generation_revoked".to_owned());
            }
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .filter(|remaining| !remaining.is_zero())
                .ok_or_else(|| "extension_runtime_response_timeout".to_owned())?;
            match self
                .responses
                .recv_timeout(remaining.min(Duration::from_millis(25)))
            {
                Ok(response) => return Ok(response),
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("extension_runtime_protocol_unavailable".to_owned());
                }
            }
        }
    }

    fn send_with_guard(
        &mut self,
        request: &ExtensionHostRequestV1,
        timeout: Duration,
        guard: impl FnMut() -> bool,
    ) -> Result<ExtensionHostResponseV1, String> {
        self.write_request(request)?;
        self.receive_response_with_guard(timeout, guard)
    }
}

fn read_bounded_response_line<R: BufRead>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if oversized {
                Err(io::Error::other(
                    "extension host response exceeds its limit",
                ))
            } else if line.is_empty() {
                Ok(None)
            } else {
                Ok(Some(line))
            };
        }
        let end = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if !oversized {
            let content_end = if available.get(end.wrapping_sub(1)) == Some(&b'\n') {
                end - 1
            } else {
                end
            };
            if line.len().saturating_add(content_end) > MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_end]);
            }
        }
        let ended = available.get(end.wrapping_sub(1)) == Some(&b'\n');
        reader.consume(end);
        if ended {
            if oversized {
                return Err(io::Error::other(
                    "extension host response exceeds its limit",
                ));
            }
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }
    }
}

impl Drop for ExtensionHostConnection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
    }
}

struct ExtensionHostTermination {
    terminated: AtomicBool,
    #[cfg(windows)]
    job: Mutex<Option<OwnedHandle>>,
    #[cfg(unix)]
    pid: u32,
}

impl ExtensionHostTermination {
    #[cfg(windows)]
    fn new(job: OwnedHandle) -> Self {
        Self {
            terminated: AtomicBool::new(false),
            job: Mutex::new(Some(job)),
        }
    }

    #[cfg(unix)]
    fn new(pid: u32) -> Self {
        Self {
            terminated: AtomicBool::new(false),
            pid,
        }
    }

    fn terminate(&self) {
        if self.terminated.swap(true, Ordering::AcqRel) {
            return;
        }
        #[cfg(windows)]
        {
            // Closing the sole Job Object handle terminates the child even while
            // another thread is blocked waiting for its response.
            if let Ok(mut job) = self.job.lock() {
                drop(job.take());
            }
        }
        #[cfg(unix)]
        unsafe {
            // The PID belongs to the child created for this entry and the atomic
            // guard prevents a later repeated signal after it has been reaped.
            let _ = libc::kill(self.pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

struct ExtensionHostEntry {
    connection: Mutex<ExtensionHostConnection>,
    termination: ExtensionHostTermination,
    generation: u64,
}

impl ExtensionHostEntry {
    fn terminate(&self) {
        // Revocation and workspace locking must never acquire the connection
        // mutex or wait for untrusted guest code.
        self.termination.terminate();
    }
}

pub struct ExtensionRuntimeState {
    hosts: Mutex<BTreeMap<String, Arc<ExtensionHostEntry>>>,
    start_lock: Mutex<()>,
    // Orders generation validation with request bytes entering the host pipe.
    // It is never held while waiting for guest execution.
    request_gate: Mutex<()>,
    generation: AtomicU64,
    next_request_id: AtomicU64,
}

impl Default for ExtensionRuntimeState {
    fn default() -> Self {
        Self {
            hosts: Mutex::new(BTreeMap::new()),
            start_lock: Mutex::new(()),
            request_gate: Mutex::new(()),
            generation: AtomicU64::new(0),
            next_request_id: AtomicU64::new(1),
        }
    }
}

fn detach_hosts_for_revoke<T>(
    hosts: &mut BTreeMap<String, T>,
    generation: &AtomicU64,
    requested_generation: u64,
    host_generation: impl Fn(&T) -> u64,
) -> BTreeMap<String, T> {
    let previous = generation.fetch_max(requested_generation, Ordering::AcqRel);
    let boundary = previous.max(requested_generation);

    let mut revoked = BTreeMap::new();
    for (key, host) in std::mem::take(hosts) {
        let host_generation = host_generation(&host);
        let should_revoke =
            host_generation < boundary || (boundary == u64::MAX && host_generation == u64::MAX);
        if should_revoke {
            revoked.insert(key, host);
        } else {
            hosts.insert(key, host);
        }
    }
    revoked
}

impl ExtensionRuntimeState {
    pub(crate) fn ensure_started(
        &self,
        app: &tauri::AppHandle,
        runtime_key: &str,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
        self.ensure_started_internal(
            app,
            runtime_key,
            expected_extension_id,
            package_path,
            generation,
            None,
            allow_unsigned_development,
        )
    }

    pub(crate) fn ensure_started_for_access_generation(
        &self,
        app: &tauri::AppHandle,
        runtime_key: &str,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        access_generation: &AtomicU64,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
        self.ensure_started_internal(
            app,
            runtime_key,
            expected_extension_id,
            package_path,
            generation,
            Some(access_generation),
            allow_unsigned_development,
        )
    }

    fn ensure_started_internal(
        &self,
        app: &tauri::AppHandle,
        runtime_key: &str,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        access_generation: Option<&AtomicU64>,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
        let _start = self
            .start_lock
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
        self.ensure_generation_startable(generation, access_generation)?;

        let stale_host = {
            // Keep host lookup and generation validation ordered with revoke.
            let _gate = self
                .request_gate
                .lock()
                .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
            self.ensure_generation_startable(generation, access_generation)?;
            let mut hosts = self
                .hosts
                .lock()
                .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
            match hosts.get(runtime_key) {
                Some(host) if host.generation == generation => return Ok(()),
                Some(_) => hosts.remove(runtime_key),
                None => None,
            }
        };
        if let Some(stale_host) = stale_host {
            stale_host.terminate();
        }

        self.start_with_access_generation(
            app,
            runtime_key,
            expected_extension_id,
            package_path,
            generation,
            access_generation,
            allow_unsigned_development,
        )
    }

    pub(crate) fn start(
        &self,
        app: &tauri::AppHandle,
        runtime_key: &str,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
        self.start_with_access_generation(
            app,
            runtime_key,
            expected_extension_id,
            package_path,
            generation,
            None,
            allow_unsigned_development,
        )
    }

    fn start_with_access_generation(
        &self,
        app: &tauri::AppHandle,
        runtime_key: &str,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        access_generation: Option<&AtomicU64>,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
        self.ensure_generation_startable(generation, access_generation)?;
        let executable = extension_host_executable(app)?;
        let package_path = package_path
            .canonicalize()
            .map_err(|_| "extension_runtime_package_unavailable".to_owned())?;
        if !package_path.is_file() {
            return Err("extension_runtime_package_unavailable".to_owned());
        }
        let mut command = Command::new(&executable);
        command
            .arg("--package")
            .arg(&package_path)
            .arg("--generation")
            .arg(generation.to_string())
            .current_dir(
                executable
                    .parent()
                    .ok_or_else(|| "extension_runtime_unavailable".to_owned())?,
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if allow_unsigned_development {
            command.arg("--allow-unsigned-development");
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "extension_runtime_unavailable".to_owned())?;
        #[cfg(windows)]
        let job = assign_child_to_kill_on_close_job(&child).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            error
        })?;
        #[cfg(unix)]
        let child_pid = child.id();
        let input = child
            .stdin
            .take()
            .ok_or_else(|| "extension_runtime_protocol_unavailable".to_owned())?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| "extension_runtime_protocol_unavailable".to_owned())?;
        let (responses, receiver) = mpsc::sync_channel(16);
        let reader_thread = thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let Ok(Some(line)) = read_bounded_response_line(&mut reader) else {
                    break;
                };
                let Ok(response) = serde_json::from_slice(&line) else {
                    break;
                };
                if responses.send(response).is_err() {
                    break;
                }
            }
        });
        let mut connection = ExtensionHostConnection {
            child,
            input: BufWriter::new(input),
            responses: receiver,
            reader_thread: Some(reader_thread),
        };
        let ready = connection.send_with_guard(
            &ExtensionHostRequestV1::Hello {
                protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
            },
            STARTUP_TIMEOUT,
            || {
                self.ensure_generation_startable(generation, access_generation)
                    .is_ok()
            },
        );
        let ready = match ready {
            Ok(ready) => ready,
            Err(error) => {
                #[cfg(windows)]
                drop(job);
                #[cfg(unix)]
                unsafe {
                    let _ = libc::kill(child_pid as libc::pid_t, libc::SIGKILL);
                }
                return Err(error);
            }
        };
        match ready {
            ExtensionHostResponseV1::Ready {
                protocol_version,
                extension_id,
                generation: ready_generation,
            } if protocol_version == EXTENSION_HOST_PROTOCOL_VERSION
                && extension_id == expected_extension_id
                && ready_generation == generation => {}
            _ => {
                #[cfg(windows)]
                drop(job);
                #[cfg(unix)]
                unsafe {
                    let _ = libc::kill(child_pid as libc::pid_t, libc::SIGKILL);
                }
                return Err("extension_runtime_handshake_failed".to_owned());
            }
        }
        let entry = Arc::new(ExtensionHostEntry {
            connection: Mutex::new(connection),
            termination: {
                #[cfg(windows)]
                {
                    ExtensionHostTermination::new(job)
                }
                #[cfg(unix)]
                {
                    ExtensionHostTermination::new(child_pid)
                }
            },
            generation,
        });
        let previous = {
            // Revoke takes this same short gate before advancing its generation.
            // Startup never holds it while waiting for the child handshake.
            let _gate = self
                .request_gate
                .lock()
                .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
            self.ensure_generation_startable(generation, access_generation)?;
            let mut hosts = self
                .hosts
                .lock()
                .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
            let previous_generation = self.generation.fetch_max(generation, Ordering::AcqRel);
            if previous_generation > generation
                || self.generation.load(Ordering::Acquire) != generation
                || access_generation
                    .is_some_and(|current| current.load(Ordering::Acquire) != generation)
            {
                drop(hosts);
                entry.terminate();
                return Err("extension_runtime_generation_revoked".to_owned());
            }
            hosts.insert(runtime_key.to_owned(), Arc::clone(&entry))
        };
        if let Some(previous) = previous {
            previous.terminate();
        }
        Ok(())
    }

    fn ensure_generation_current(
        &self,
        expected: u64,
        access_generation: Option<&AtomicU64>,
    ) -> Result<(), String> {
        if expected == u64::MAX
            || self.generation.load(Ordering::Acquire) != expected
            || access_generation.is_some_and(|current| current.load(Ordering::Acquire) != expected)
        {
            return Err("extension_runtime_generation_revoked".to_owned());
        }
        Ok(())
    }

    fn ensure_generation_startable(
        &self,
        expected: u64,
        access_generation: Option<&AtomicU64>,
    ) -> Result<(), String> {
        if expected == u64::MAX
            || self.generation.load(Ordering::Acquire) > expected
            || access_generation.is_some_and(|current| current.load(Ordering::Acquire) != expected)
        {
            return Err("extension_runtime_generation_revoked".to_owned());
        }
        Ok(())
    }

    pub(crate) fn request(
        &self,
        extension_id: &str,
        request: ExtensionHostRequestV1,
        timeout: Duration,
    ) -> Result<ExtensionHostResponseV1, String> {
        self.request_internal(extension_id, request, timeout, None)
    }

    pub(crate) fn request_for_access_generation(
        &self,
        extension_id: &str,
        request: ExtensionHostRequestV1,
        timeout: Duration,
        access_generation: &AtomicU64,
    ) -> Result<ExtensionHostResponseV1, String> {
        self.request_internal(extension_id, request, timeout, Some(access_generation))
    }

    fn request_internal(
        &self,
        extension_id: &str,
        mut request: ExtensionHostRequestV1,
        timeout: Duration,
        access_generation: Option<&AtomicU64>,
    ) -> Result<ExtensionHostResponseV1, String> {
        let request_id = request.request_id();
        let Some(request_generation) = request.generation() else {
            return Err("extension_runtime_request_invalid".to_owned());
        };
        if request_id.is_none() {
            return Err("extension_runtime_request_invalid".to_owned());
        }
        let host = self
            .hosts
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?
            .get(extension_id)
            .cloned()
            .ok_or_else(|| "extension_runtime_not_started".to_owned())?;
        let mut connection = host
            .connection
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
        let response = (|| {
            // The gate covers only validation, sanitization, and the pipe write;
            // waiting for guest code happens after it is released.
            let _gate = self
                .request_gate
                .lock()
                .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
            self.ensure_generation_current(request_generation, access_generation)?;
            if host.generation != request_generation {
                return Err("extension_runtime_generation_revoked".to_owned());
            }
            sanitize_request_content(&mut request);
            connection.write_request(&request)?;
            drop(_gate);
            connection.receive_response_with_guard(timeout, || {
                self.ensure_generation_current(request_generation, access_generation)
                    .is_ok()
            })
        })();
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.remove_failed_host(extension_id, &host);
                return Err(error);
            }
        };
        if response.request_id() != request_id || response.generation() != Some(request_generation)
        {
            self.remove_failed_host(extension_id, &host);
            return Err("extension_runtime_protocol_unavailable".to_owned());
        }
        Ok(response)
    }

    fn remove_failed_host(&self, extension_id: &str, failed: &Arc<ExtensionHostEntry>) {
        failed.terminate();
        if let Ok(mut hosts) = self.hosts.lock()
            && hosts
                .get(extension_id)
                .is_some_and(|current| Arc::ptr_eq(current, failed))
        {
            hosts.remove(extension_id);
        }
    }

    pub(crate) fn next_request_id(&self) -> u64 {
        self.next_request_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn revoke_all(&self, generation: u64) {
        // Generation advancement and detaching the hosts are one short,
        // ordered operation. A stale revoke (for example, one racing a newly
        // unlocked session) must not take hosts that already belong to a
        // newer generation.
        let hosts = {
            let _gate = self
                .request_gate
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let mut hosts = self
                .hosts
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            detach_hosts_for_revoke(&mut hosts, &self.generation, generation, |host| {
                host.generation
            })
        };
        for host in hosts.into_values() {
            host.terminate();
        }
    }

    pub fn stop(&self, extension_id: &str) {
        let host = self
            .hosts
            .lock()
            .ok()
            .and_then(|mut hosts| hosts.remove(extension_id));
        if let Some(host) = host {
            host.terminate();
        }
    }

    pub fn shutdown(&self) {
        let generation = self.generation.load(Ordering::Acquire).saturating_add(1);
        self.revoke_all(generation);
    }
}

fn sanitize_request_content(request: &mut ExtensionHostRequestV1) {
    let sanitize = |content: &mut Option<String>| {
        if let Some(value) = content.as_mut() {
            *value = crate::extension_runtime_content::content_for_extension_runtime(value);
        }
    };
    match request {
        ExtensionHostRequestV1::Render { request, .. } => sanitize(&mut request.node.content),
        ExtensionHostRequestV1::Invoke { request, .. } => {
            for node in &mut request.nodes {
                sanitize(&mut node.content);
            }
        }
        ExtensionHostRequestV1::Hello { .. }
        | ExtensionHostRequestV1::MigrateMetadata { .. }
        | ExtensionHostRequestV1::Revoke { .. }
        | ExtensionHostRequestV1::Shutdown { .. } => {}
    }
}

impl Drop for ExtensionRuntimeState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn extension_host_executable(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let file_name = if cfg!(windows) {
        "linked-info-extension-host.exe"
    } else {
        "linked-info-extension-host"
    };
    let current_executable =
        std::env::current_exe().map_err(|_| "extension_runtime_unavailable".to_owned())?;
    let sibling = current_executable
        .parent()
        .map(|directory| directory.join(file_name))
        .filter(|path| path.is_file());
    if let Some(path) = sibling {
        return Ok(path);
    }
    app.path()
        .resource_dir()
        .map(|directory| directory.join(file_name))
        .map_err(|_| "extension_runtime_unavailable".to_owned())
        .and_then(|path| {
            path.is_file()
                .then_some(path)
                .ok_or_else(|| "extension_runtime_unavailable".to_owned())
        })
}

#[cfg(windows)]
fn assign_child_to_kill_on_close_job(child: &Child) -> Result<OwnedHandle, String> {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_PROCESS_MEMORY, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
    };

    let raw_job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw_job.is_null() {
        return Err("extension_runtime_job_unavailable".to_owned());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
    information.ProcessMemoryLimit = EXTENSION_HOST_PROCESS_MEMORY_BYTES;
    let configured = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&information).cast(),
            std::mem::size_of_val(&information) as u32,
        )
    };
    if configured == 0 {
        return Err("extension_runtime_job_unavailable".to_owned());
    }
    let assigned = unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) };
    if assigned == 0 {
        return Err("extension_runtime_job_unavailable".to_owned());
    }
    Ok(job)
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Barrier};
    #[cfg(windows)]
    use std::time::Instant;

    use linked_info_extension_contracts::{ExtensionRenderRequestV1, NodeHandle, NodeSnapshotV1};

    use super::*;

    #[test]
    fn empty_runtime_state_revokes_and_advances_monotonically() {
        let state = ExtensionRuntimeState::default();
        state.revoke_all(9);
        assert_eq!(state.generation.load(Ordering::Acquire), 9);
        state.revoke_all(4);
        assert_eq!(state.generation.load(Ordering::Acquire), 9);
        assert_eq!(state.next_request_id(), 1);
        assert_eq!(state.next_request_id(), 2);
    }

    #[test]
    fn generation_guards_distinguish_new_startup_from_revoked_access() {
        let state = ExtensionRuntimeState::default();
        let access_generation = AtomicU64::new(7);

        // A freshly unlocked session may advance beyond the runtime's last
        // generation and initialize a new host.
        assert!(
            state
                .ensure_generation_startable(7, Some(&access_generation))
                .is_ok()
        );

        state.generation.store(7, Ordering::Release);
        access_generation.store(8, Ordering::Release);
        assert_eq!(
            state.ensure_generation_current(7, Some(&access_generation)),
            Err("extension_runtime_generation_revoked".to_owned())
        );
        assert_eq!(
            state.ensure_generation_startable(7, Some(&access_generation)),
            Err("extension_runtime_generation_revoked".to_owned())
        );
    }

    #[test]
    fn stale_revoke_keeps_a_newer_host_installed_before_the_revoke_barrier() {
        let generation = Arc::new(AtomicU64::new(7));
        let hosts = Arc::new(Mutex::new(BTreeMap::from([("old".to_owned(), 7_u64)])));
        let barrier = Arc::new(Barrier::new(2));
        let next_generation = Arc::clone(&generation);
        let next_hosts = Arc::clone(&hosts);
        let next_barrier = Arc::clone(&barrier);
        let installer = std::thread::spawn(move || {
            next_barrier.wait();
            next_generation.store(8, Ordering::Release);
            next_hosts.lock().unwrap().insert("new".to_owned(), 8_u64);
        });

        barrier.wait();
        installer.join().unwrap();
        let mut hosts = hosts.lock().unwrap();
        let revoked = detach_hosts_for_revoke(&mut hosts, &generation, 7, |value| *value);

        assert_eq!(revoked.get("old"), Some(&7));
        assert!(!hosts.contains_key("old"));
        assert_eq!(hosts.get("new"), Some(&8));
    }

    #[test]
    fn rust_proxy_strips_secret_payloads_before_ipc() {
        let mut request = ExtensionHostRequestV1::Render {
            request_id: 1,
            generation: 2,
            request: ExtensionRenderRequestV1 {
                processor_id: "inspect".to_owned(),
                node: NodeSnapshotV1 {
                    handle: NodeHandle(1),
                    name: None,
                    content: Some(
                        r#"API [[li:secret note="credential"]]synthetic-secret[[/li]]"#.to_owned(),
                    ),
                    direct_outgoing: Vec::new(),
                    direct_incoming: Vec::new(),
                },
                node_metadata_json: None,
                workspace_metadata_json: None,
                monotonic_time_ms: None,
            },
        };

        sanitize_request_content(&mut request);

        let ExtensionHostRequestV1::Render { request, .. } = request else {
            panic!("render request expected");
        };
        assert_eq!(request.node.content.as_deref(), Some("API credential"));
    }

    #[test]
    fn response_reader_drains_an_oversized_frame_before_the_next_frame() {
        let mut input = vec![b'x'; MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES + 1];
        input.extend_from_slice(b"\n{}\n");
        let mut reader = BufReader::new(input.as_slice());

        assert!(read_bounded_response_line(&mut reader).is_err());
        assert_eq!(
            read_bounded_response_line(&mut reader).unwrap(),
            Some(b"{}".to_vec())
        );
    }

    #[cfg(windows)]
    #[test]
    fn termination_does_not_wait_for_the_connection_mutex() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 > nul"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let input = child.stdin.take().unwrap();
        let job = assign_child_to_kill_on_close_job(&child).unwrap();
        let (_responses, receiver) = mpsc::sync_channel(1);
        let entry = Arc::new(ExtensionHostEntry {
            connection: Mutex::new(ExtensionHostConnection {
                child,
                input: BufWriter::new(input),
                responses: receiver,
                reader_thread: None,
            }),
            termination: ExtensionHostTermination::new(job),
            generation: 0,
        });
        let locked_entry = Arc::clone(&entry);
        let (locked, locked_receiver) = mpsc::sync_channel(1);
        let holder = thread::spawn(move || {
            let mut connection = locked_entry.connection.lock().unwrap();
            locked.send(()).unwrap();
            thread::sleep(Duration::from_millis(500));
            connection.child.try_wait().unwrap().is_some()
        });
        locked_receiver.recv().unwrap();

        let started = Instant::now();
        entry.terminate();

        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(holder.join().unwrap());
    }
}
