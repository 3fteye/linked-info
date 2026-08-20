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
    time::Duration,
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
    fn send(
        &mut self,
        request: &ExtensionHostRequestV1,
        timeout: Duration,
    ) -> Result<ExtensionHostResponseV1, String> {
        let encoded = serde_json::to_vec(request)
            .map_err(|_| "extension_runtime_protocol_unavailable".to_owned())?;
        if encoded.len() > MAXIMUM_EXTENSION_HOST_REQUEST_BYTES {
            return Err("extension_runtime_request_invalid".to_owned());
        }
        self.input
            .write_all(&encoded)
            .and_then(|()| self.input.write_all(b"\n"))
            .and_then(|()| self.input.flush())
            .map_err(|_| "extension_runtime_protocol_unavailable".to_owned())?;
        self.responses
            .recv_timeout(timeout)
            .map_err(|_| "extension_runtime_response_timeout".to_owned())
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
    generation: AtomicU64,
    next_request_id: AtomicU64,
}

impl Default for ExtensionRuntimeState {
    fn default() -> Self {
        Self {
            hosts: Mutex::new(BTreeMap::new()),
            generation: AtomicU64::new(0),
            next_request_id: AtomicU64::new(1),
        }
    }
}

impl ExtensionRuntimeState {
    pub(crate) fn start(
        &self,
        app: &tauri::AppHandle,
        expected_extension_id: &str,
        package_path: &Path,
        generation: u64,
        allow_unsigned_development: bool,
    ) -> Result<(), String> {
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
        let ready = connection.send(
            &ExtensionHostRequestV1::Hello {
                protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
            },
            STARTUP_TIMEOUT,
        );
        match ready {
            Ok(ExtensionHostResponseV1::Ready {
                protocol_version,
                extension_id,
                generation: ready_generation,
            }) if protocol_version == EXTENSION_HOST_PROTOCOL_VERSION
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
        });
        let mut hosts = self
            .hosts
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?;
        let previous_generation = self.generation.fetch_max(generation, Ordering::AcqRel);
        if previous_generation > generation || self.generation.load(Ordering::Acquire) != generation
        {
            entry.terminate();
            return Err("extension_runtime_generation_revoked".to_owned());
        }
        if let Some(previous) = hosts.insert(expected_extension_id.to_owned(), entry) {
            previous.terminate();
        }
        Ok(())
    }

    pub(crate) fn request(
        &self,
        extension_id: &str,
        mut request: ExtensionHostRequestV1,
        timeout: Duration,
    ) -> Result<ExtensionHostResponseV1, String> {
        sanitize_request_content(&mut request);
        let request_id = request.request_id();
        let request_generation = request.generation();
        if request_id.is_none() || request_generation.is_none() {
            return Err("extension_runtime_request_invalid".to_owned());
        }
        let host = self
            .hosts
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?
            .get(extension_id)
            .cloned()
            .ok_or_else(|| "extension_runtime_not_started".to_owned())?;
        let response = match host
            .connection
            .lock()
            .map_err(|_| "extension_runtime_state_unavailable".to_owned())?
            .send(&request, timeout)
        {
            Ok(response) => response,
            Err(error) => {
                self.remove_failed_host(extension_id, &host);
                return Err(error);
            }
        };
        if response.request_id() != request_id || response.generation() != request_generation {
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
        self.generation.fetch_max(generation, Ordering::AcqRel);
        let hosts = self
            .hosts
            .lock()
            .map(|mut hosts| std::mem::take(&mut *hosts))
            .unwrap_or_default();
        for host in hosts.into_values() {
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
        | ExtensionHostRequestV1::Shutdown => {}
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
