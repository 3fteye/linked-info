use std::{
    env, fs,
    io::{self, BufRead, BufReader, BufWriter, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

use linked_info_extension_contracts::{SignaturePolicy, validate_extension_package};
use linked_info_extension_host::{ExtensionRuntime, ExtensionRuntimeError, RuntimeLimits};
use linked_info_extension_host_protocol::{
    EXTENSION_HOST_PROTOCOL_VERSION, ExtensionHostErrorCode, ExtensionHostRequestV1,
    ExtensionHostResponseV1, MAXIMUM_EXTENSION_HOST_REQUEST_BYTES,
    MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES,
};

#[cfg(unix)]
const PROCESS_MEMORY_LIMIT_BYTES: libc::rlim_t = 512 * 1024 * 1024;

struct Startup {
    package: PathBuf,
    generation: u64,
    signature_policy: SignaturePolicy,
}

enum Work {
    Render {
        request_id: u64,
        generation: u64,
        request: linked_info_extension_contracts::ExtensionRenderRequestV1,
    },
    Invoke {
        request_id: u64,
        generation: u64,
        request: linked_info_extension_contracts::ExtensionActionRequestV1,
    },
    MigrateMetadata {
        request_id: u64,
        generation: u64,
        request: linked_info_extension_contracts::ExtensionMetadataMigrationRequestV1,
    },
}

fn parse_startup() -> Result<Startup, ()> {
    let mut arguments = env::args_os().skip(1);
    let mut package = None;
    let mut generation = None;
    let mut allow_unsigned = false;
    while let Some(argument) = arguments.next() {
        match argument.to_str() {
            Some("--package") if package.is_none() => {
                package = Some(PathBuf::from(arguments.next().ok_or(())?));
            }
            Some("--generation") if generation.is_none() => {
                generation = arguments
                    .next()
                    .and_then(|value| value.to_str().and_then(|value| value.parse().ok()));
                if generation.is_none() {
                    return Err(());
                }
            }
            Some("--allow-unsigned-development") if !allow_unsigned => allow_unsigned = true,
            _ => return Err(()),
        }
    }
    Ok(Startup {
        package: package.ok_or(())?,
        generation: generation.ok_or(())?,
        signature_policy: if allow_unsigned {
            SignaturePolicy::AllowUnsignedDevelopment
        } else {
            SignaturePolicy::RequireSigned
        },
    })
}

fn read_package(path: &Path) -> Result<Vec<u8>, ()> {
    let metadata = fs::metadata(path).map_err(|_| ())?;
    if !metadata.is_file()
        || metadata.len() > linked_info_extension_contracts::MAXIMUM_EXTENSION_PACKAGE_BYTES as u64
    {
        return Err(());
    }
    fs::read(path).map_err(|_| ())
}

fn response_error(
    request_id: Option<u64>,
    generation: u64,
    error: ExtensionRuntimeError,
) -> ExtensionHostResponseV1 {
    ExtensionHostResponseV1::Error {
        request_id,
        generation,
        code: error.code(),
    }
}

fn package_error(generation: u64) -> ExtensionHostResponseV1 {
    ExtensionHostResponseV1::Error {
        request_id: None,
        generation,
        code: ExtensionHostErrorCode::PackageInvalid,
    }
}

fn write_response(
    writer: &mut BufWriter<io::StdoutLock<'_>>,
    response: &ExtensionHostResponseV1,
) -> io::Result<()> {
    let encoded = serde_json::to_vec(response).map_err(io::Error::other)?;
    if encoded.len() > MAXIMUM_EXTENSION_HOST_RESPONSE_BYTES {
        return Err(io::Error::other(
            "extension host response exceeds its limit",
        ));
    }
    writer.write_all(&encoded)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

fn read_limited_line_with_limit<R: BufRead>(
    reader: &mut R,
    limit: usize,
) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    let mut line = Vec::new();
    let mut oversized = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if line.is_empty() && !oversized {
                Ok(None)
            } else if oversized {
                Ok(Some(Err(())))
            } else {
                Ok(Some(Ok(line)))
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
            if line.len().saturating_add(content_end) > limit {
                oversized = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_end]);
            }
        }
        let ended = available.get(end.wrapping_sub(1)) == Some(&b'\n');
        reader.consume(end);
        if ended {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(if oversized { Err(()) } else { Ok(line) }));
        }
    }
}

fn read_limited_line<R: BufRead>(reader: &mut R) -> io::Result<Option<Result<Vec<u8>, ()>>> {
    read_limited_line_with_limit(reader, MAXIMUM_EXTENSION_HOST_REQUEST_BYTES)
}

fn enqueue_work(sender: &mpsc::SyncSender<Work>, busy: &AtomicBool, work: Work) -> bool {
    if busy.swap(true, Ordering::AcqRel) {
        return false;
    }
    if sender.send(work).is_err() {
        busy.store(false, Ordering::Release);
        return false;
    }
    true
}

fn work_response(runtime: &ExtensionRuntime, work: Work) -> ExtensionHostResponseV1 {
    match work {
        Work::Render {
            request_id,
            generation,
            request,
        } => match runtime.render(generation, &request) {
            Ok(presentation) => ExtensionHostResponseV1::Rendered {
                request_id,
                generation,
                presentation,
            },
            Err(error) => response_error(Some(request_id), generation, error),
        },
        Work::Invoke {
            request_id,
            generation,
            request,
        } => match runtime.invoke(generation, &request) {
            Ok(result) => ExtensionHostResponseV1::Invoked {
                request_id,
                generation,
                result,
            },
            Err(error) => response_error(Some(request_id), generation, error),
        },
        Work::MigrateMetadata {
            request_id,
            generation,
            request,
        } => match runtime.migrate_metadata(generation, &request) {
            Ok(metadata_json) => ExtensionHostResponseV1::MetadataMigrated {
                request_id,
                generation,
                metadata_json,
            },
            Err(error) => response_error(Some(request_id), generation, error),
        },
    }
}

#[cfg(unix)]
fn set_process_memory_limit() -> Result<(), ()> {
    let limit = libc::rlimit {
        rlim_cur: PROCESS_MEMORY_LIMIT_BYTES,
        rlim_max: PROCESS_MEMORY_LIMIT_BYTES,
    };
    // SAFETY: `limit` is a fully initialized `rlimit` value and this call only
    // narrows the current child process address-space allowance.
    (unsafe { libc::setrlimit(libc::RLIMIT_AS, &limit) } == 0)
        .then_some(())
        .ok_or(())
}

fn run() -> Result<(), ()> {
    #[cfg(unix)]
    set_process_memory_limit()?;
    let startup = parse_startup()?;
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let first = read_limited_line(&mut reader).map_err(|_| ())?.ok_or(())?;
    let hello = first
        .map_err(|_| ())
        .and_then(|line| serde_json::from_slice::<ExtensionHostRequestV1>(&line).map_err(|_| ()))?;
    if hello
        != (ExtensionHostRequestV1::Hello {
            protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
        })
    {
        return Err(());
    }
    let package_bytes = read_package(&startup.package)?;
    let package =
        validate_extension_package(&package_bytes, startup.signature_policy).map_err(|_| {
            let stdout = io::stdout();
            let mut writer = BufWriter::new(stdout.lock());
            let _ = write_response(&mut writer, &package_error(startup.generation));
        })?;
    let runtime = Arc::new(
        ExtensionRuntime::new(package, startup.generation, RuntimeLimits::default()).map_err(
            |error| {
                let stdout = io::stdout();
                let mut writer = BufWriter::new(stdout.lock());
                let _ = write_response(
                    &mut writer,
                    &response_error(None, startup.generation, error),
                );
            },
        )?,
    );
    let (response_sender, response_receiver) = mpsc::sync_channel(16);
    let writer_thread = thread::spawn(move || {
        let stdout = io::stdout();
        let mut writer = BufWriter::new(stdout.lock());
        for response in response_receiver {
            if write_response(&mut writer, &response).is_err() {
                break;
            }
        }
    });
    response_sender
        .send(ExtensionHostResponseV1::Ready {
            protocol_version: EXTENSION_HOST_PROTOCOL_VERSION,
            extension_id: runtime.extension_id().to_owned(),
            generation: startup.generation,
        })
        .map_err(|_| ())?;

    let (work_sender, work_receiver) = mpsc::sync_channel(1);
    let busy = Arc::new(AtomicBool::new(false));
    let worker_runtime = Arc::clone(&runtime);
    let worker_responses = response_sender.clone();
    let worker_busy = Arc::clone(&busy);
    let worker_thread = thread::spawn(move || {
        for work in work_receiver {
            let response = work_response(&worker_runtime, work);
            let _ = worker_responses.send(response);
            worker_busy.store(false, Ordering::Release);
        }
    });

    while let Some(line) = read_limited_line(&mut reader).map_err(|_| ())? {
        let request = match line.map_err(|_| ()).and_then(|line| {
            serde_json::from_slice::<ExtensionHostRequestV1>(&line).map_err(|_| ())
        }) {
            Ok(request) => request,
            Err(()) => {
                let _ = response_sender.send(ExtensionHostResponseV1::Error {
                    request_id: None,
                    generation: runtime.authorization_generation(),
                    code: ExtensionHostErrorCode::ProtocolInvalid,
                });
                continue;
            }
        };
        match request {
            ExtensionHostRequestV1::Render {
                request_id,
                generation,
                request,
            } => {
                if !enqueue_work(
                    &work_sender,
                    &busy,
                    Work::Render {
                        request_id,
                        generation,
                        request,
                    },
                ) {
                    let _ = response_sender.send(ExtensionHostResponseV1::Error {
                        request_id: Some(request_id),
                        generation,
                        code: ExtensionHostErrorCode::RequestInvalid,
                    });
                }
            }
            ExtensionHostRequestV1::Invoke {
                request_id,
                generation,
                request,
            } => {
                if !enqueue_work(
                    &work_sender,
                    &busy,
                    Work::Invoke {
                        request_id,
                        generation,
                        request,
                    },
                ) {
                    let _ = response_sender.send(ExtensionHostResponseV1::Error {
                        request_id: Some(request_id),
                        generation,
                        code: ExtensionHostErrorCode::RequestInvalid,
                    });
                }
            }
            ExtensionHostRequestV1::MigrateMetadata {
                request_id,
                generation,
                request,
            } => {
                if !enqueue_work(
                    &work_sender,
                    &busy,
                    Work::MigrateMetadata {
                        request_id,
                        generation,
                        request,
                    },
                ) {
                    let _ = response_sender.send(ExtensionHostResponseV1::Error {
                        request_id: Some(request_id),
                        generation,
                        code: ExtensionHostErrorCode::RequestInvalid,
                    });
                }
            }
            ExtensionHostRequestV1::Revoke { generation } => {
                let response = match runtime.advance_generation(generation) {
                    Ok(()) => ExtensionHostResponseV1::Revoked { generation },
                    Err(error) => response_error(None, generation, error),
                };
                let _ = response_sender.send(response);
            }
            ExtensionHostRequestV1::Shutdown { .. } => {
                if let Some(generation) = runtime.authorization_generation().checked_add(1) {
                    let _ = runtime.advance_generation(generation);
                }
                break;
            }
            ExtensionHostRequestV1::Hello { .. } => {
                let _ = response_sender.send(ExtensionHostResponseV1::Error {
                    request_id: None,
                    generation: runtime.authorization_generation(),
                    code: ExtensionHostErrorCode::ProtocolInvalid,
                });
            }
        }
    }

    drop(work_sender);
    let _ = worker_thread.join();
    let _ = response_sender.send(ExtensionHostResponseV1::ShuttingDown {});
    drop(response_sender);
    let _ = writer_thread.join();
    Ok(())
}

fn main() -> ExitCode {
    if run().is_ok() {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limited_reader_rejects_oversized_lines_without_losing_the_next_frame() {
        let oversized = vec![b'x'; 9];
        let mut input = oversized;
        input.extend_from_slice(b"\n{\"type\":\"shutdown\"}\n");
        let mut reader = BufReader::new(input.as_slice());

        assert_eq!(
            read_limited_line_with_limit(&mut reader, 8).unwrap(),
            Some(Err(()))
        );
        assert_eq!(
            read_limited_line_with_limit(&mut reader, 32).unwrap(),
            Some(Ok(br#"{"type":"shutdown"}"#.to_vec()))
        );
    }
}
