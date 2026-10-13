//! Stateful, loopback-only S3 subset for synthetic backup recovery tests.
use super::*;
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

#[derive(Default)]
struct State {
    objects: BTreeMap<String, Vec<u8>>,
    interrupt_upload: bool,
    corrupt_download: bool,
}

pub(crate) struct Service {
    endpoint: Url,
    state: Arc<Mutex<State>>,
    stopped: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Service {
    pub(crate) fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let state = Arc::new(Mutex::new(State::default()));
        let stopped = Arc::new(AtomicBool::new(false));
        let server_state = Arc::clone(&state);
        let server_stopped = Arc::clone(&stopped);
        let thread = thread::spawn(move || {
            while !server_stopped.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => serve(stream, &server_state),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(1));
                    }
                    Err(error) => panic!("test listener failed: {error}"),
                }
            }
        });
        Self {
            endpoint,
            state,
            stopped,
            thread: Some(thread),
        }
    }

    pub(crate) fn target(&self) -> S3BackupTarget {
        S3BackupTarget {
            client: Client::builder()
                .no_proxy()
                .redirect(Policy::none())
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            endpoint: self.endpoint.clone(),
            region: "us-east-1".into(),
            bucket: "synthetic-backups".into(),
            prefix: "linked-info/v1".into(),
            credentials: S3Credentials {
                access_key_id: "SYNTHETIC-KEY".into(),
                secret_access_key: "synthetic-test-secret".into(),
                session_token: None,
            },
        }
    }

    pub(crate) fn interrupt_next_upload(&self) {
        self.state.lock().unwrap().interrupt_upload = true;
    }

    pub(crate) fn corrupt_next_download(&self) {
        self.state.lock().unwrap().corrupt_download = true;
    }
}

impl Drop for Service {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
        let result = self.thread.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

fn serve(mut stream: TcpStream, state: &Mutex<State>) {
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut request = Vec::new();
    let header_end = loop {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0, "incomplete test request");
        request.extend_from_slice(&chunk[..count]);
        if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
            assert!(end < 16 * 1024);
            break end + 4;
        }
        assert!(request.len() < 16 * 1024);
    };
    let header = String::from_utf8(request[..header_end].to_vec()).unwrap();
    let mut parts = header.lines().next().unwrap().split_whitespace();
    let method = parts.next().unwrap();
    let url = Url::parse(&format!("http://127.0.0.1{}", parts.next().unwrap())).unwrap();
    let headers = header.to_ascii_lowercase();
    assert!(headers.contains("authorization: aws4-hmac-sha256 "));
    let length = headers
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length:")
                .map(|value| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    assert!(length <= 1024 * 1024);
    while request.len() - header_end < length {
        let mut chunk = [0; 4096];
        let count = stream.read(&mut chunk).unwrap();
        assert!(count > 0);
        request.extend_from_slice(&chunk[..count]);
    }
    let payload = &request[header_end..header_end + length];
    let query = url.query_pairs().collect::<BTreeMap<_, _>>();
    let key = url
        .path()
        .strip_prefix("/synthetic-backups")
        .unwrap()
        .trim_start_matches('/');
    let mut state = state.lock().unwrap();
    let (status, body) = match method {
        "PUT" => {
            if std::mem::take(&mut state.interrupt_upload) {
                return;
            }
            assert!(!state.objects.contains_key(key));
            state.objects.insert(key.to_owned(), payload.to_vec());
            (200, Vec::new())
        }
        "GET" if query.contains_key("list-type") || query.contains_key("versions") => {
            let prefix = query
                .get("prefix")
                .map(|value| value.as_ref())
                .unwrap_or("");
            let versions = query.contains_key("versions");
            let root = if versions {
                "ListVersionsResult"
            } else {
                "ListBucketResult"
            };
            let mut xml = format!("<{root}><IsTruncated>false</IsTruncated>");
            for (name, bytes) in &state.objects {
                if !name.starts_with(prefix) {
                    continue;
                }
                // Production keys are restricted to ASCII UUID/hash/path segments.
                assert!(!name.contains(['&', '<', '>']));
                xml.push_str(&if versions {
                    format!("<Version><Key>{name}</Key><VersionId>null</VersionId></Version>")
                } else {
                    format!(
                        "<Contents><Key>{name}</Key><Size>{}</Size></Contents>",
                        bytes.len()
                    )
                });
            }
            xml.push_str(&format!("</{root}>"));
            (200, xml.into_bytes())
        }
        "GET" => match state.objects.get(key).cloned() {
            Some(mut bytes) => {
                if std::mem::take(&mut state.corrupt_download) {
                    bytes[0] ^= 1;
                }
                (200, bytes)
            }
            None => (404, Vec::new()),
        },
        "DELETE" => {
            assert_eq!(
                query.get("versionId").map(|value| value.as_ref()),
                Some("null")
            );
            assert!(state.objects.remove(key).is_some());
            (204, Vec::new())
        }
        _ => panic!("unsupported synthetic S3 method"),
    };
    drop(state);
    write!(
        stream,
        "HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    )
    .unwrap();
    stream.write_all(&body).unwrap();
}
