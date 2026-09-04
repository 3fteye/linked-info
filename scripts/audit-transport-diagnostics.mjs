import { request as httpsRequest } from "node:https";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const REQUEST_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 64 * 1024;
export const MAX_REQUEST_BYTES = 1024;
const REGISTRY = "https://registry.npmjs.org";
const BULK_PATH = "/-/npm/v1/security/advisories/bulk";
const ERROR_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "EPROTO", "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
  "HPE_HEADER_OVERFLOW", "ERR_HTTP_HEADERS_OVERFLOW",
]);

function errorCode(error) {
  for (const candidate of [error?.code, error?.cause?.code]) {
    if (typeof candidate === "string" && ERROR_CODES.has(candidate)) return candidate;
  }
  return "unknown";
}

function assertHostedWindows(environment, platform) {
  if (platform !== "win32" || environment.GITHUB_ACTIONS !== "true" ||
    environment.RUNNER_ENVIRONMENT !== "github-hosted" || environment.RUNNER_OS !== "Windows") {
    throw new Error("audit_transport_ci_required");
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new Error("audit_transport_tls_verification_required");
  }
}

function probes() {
  // Public, synthetic input only: never read the project's dependency graph.
  const body = Buffer.from('{"react":["19.2.8"]}', "utf8");
  const compressed = gzipSync(body);
  return ["https", "fetch"].flatMap((client) => [
    { probe: "registry-ping", client, encoding: "none", method: "GET", path: "/-/ping", body: null },
    { probe: "audit-bulk", client, encoding: "identity", method: "POST", path: BULK_PATH, body },
    { probe: "audit-bulk", client, encoding: "gzip", method: "POST", path: BULK_PATH, body: compressed },
  ]);
}

function headers(probe) {
  return {
    "user-agent": "linked-info-audit-transport-diagnostics",
    accept: "application/json",
    "accept-encoding": "identity",
    ...(probe.body === null ? {} : {
      "content-type": "application/json",
      "content-length": String(probe.body.byteLength),
      ...(probe.encoding === "gzip" ? { "content-encoding": "gzip" } : {}),
    }),
  };
}

function measurement(probe, clock) {
  const started = clock();
  const elapsed = () => Math.max(0, Math.round((clock() - started) * 100) / 100);
  const result = {
    probe: probe.probe, client: probe.client, encoding: probe.encoding,
    // Counts bytes read by this client, not necessarily wire bytes; overflow is capped.
    statusCode: null, requestBytes: probe.body?.byteLength ?? 0, responseBytes: 0,
    elapsedMs: null,
    // Milestones are elapsed milliseconds since this request started, not durations.
    phases: { dnsMs: null, tcpMs: null, tlsMs: null, responseHeadersMs: null },
    error: null,
  };
  return { result, elapsed };
}

function statusCode(status) {
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function countChunk(result, chunk) {
  if (!(chunk instanceof Uint8Array)) return "invalid_response";
  result.responseBytes = Math.min(MAX_RESPONSE_BYTES + 1, result.responseBytes + chunk.byteLength);
  return result.responseBytes > MAX_RESPONSE_BYTES ? "response_limit" : null;
}

function probeHttps(probe, dependencies) {
  const { request, clock, schedule, cancel } = dependencies;
  const { result, elapsed } = measurement(probe, clock);
  return new Promise((resolve) => {
    let finished = false;
    let outgoing;
    let incoming;
    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      cancel(timer);
      result.elapsedMs = elapsed();
      result.error = error;
      incoming?.destroy();
      outgoing?.destroy();
      resolve(result);
    };
    const timer = schedule(() => finish("timeout"), REQUEST_TIMEOUT_MS);
    try {
      outgoing = request(`${REGISTRY}${probe.path}`, {
        method: probe.method, headers: headers(probe), agent: false,
        rejectUnauthorized: true, maxHeaderSize: 8192,
      }, (response) => {
        incoming = response;
        response.on("error", (error) => finish(errorCode(error)));
        if (finished) { response.destroy(); return; }
        result.phases.responseHeadersMs = elapsed();
        result.statusCode = statusCode(response.statusCode);
        if (result.statusCode === null) { finish("invalid_response"); return; }
        response.on("data", (chunk) => {
          if (finished) return;
          const error = countChunk(result, chunk);
          if (error !== null) finish(error);
        });
        response.on("end", () => finish());
        response.on("aborted", () => finish("response_aborted"));
      });
      outgoing.on("socket", (socket) => {
        for (const [event, field] of [["lookup", "dnsMs"], ["connect", "tcpMs"], ["secureConnect", "tlsMs"]]) {
          socket.once(event, () => {
            if (!finished && result.phases[field] === null) result.phases[field] = elapsed();
          });
        }
      });
      outgoing.on("error", (error) => finish(errorCode(error)));
      // node:https never follows redirects. Consume only a bounded response.
      outgoing.end(probe.body ?? undefined);
    } catch (error) {
      finish(errorCode(error));
    }
  });
}

function probeFetch(probe, dependencies) {
  const { fetch, clock, schedule, cancel } = dependencies;
  const { result, elapsed } = measurement(probe, clock);
  const controller = new AbortController();
  return new Promise((resolve) => {
    let finished = false;
    let reader;
    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      cancel(timer);
      result.elapsedMs = elapsed();
      result.error = error;
      controller.abort();
      // Cancellation is best-effort cleanup; it must not extend the deadline.
      if (reader) void reader.cancel().catch(() => {});
      resolve(result);
    };
    const timer = schedule(() => finish("timeout"), REQUEST_TIMEOUT_MS);
    void (async () => {
      try {
        const response = await fetch(`${REGISTRY}${probe.path}`, {
          method: probe.method, headers: headers(probe),
          ...(probe.body === null ? {} : { body: probe.body }),
          credentials: "omit", redirect: "manual", signal: controller.signal,
        });
        if (finished) {
          if (response.body) void response.body.cancel().catch(() => {});
          return;
        }
        result.statusCode = statusCode(response.status);
        if (result.statusCode === null) { finish("invalid_response"); return; }
        if (response.body) {
          reader = response.body.getReader();
          while (!finished) {
            const { done, value } = await reader.read();
            if (finished) return;
            if (done) break;
            const error = countChunk(result, value);
            if (error !== null) { finish(error); return; }
          }
        }
        finish();
      } catch (error) {
        finish(errorCode(error));
      }
    })();
  });
}

export async function runAuditTransportDiagnostics({
  environment = process.env, platform = process.platform,
  request = httpsRequest, fetch = globalThis.fetch,
  clock = () => performance.now(), schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  // This guard precedes body preparation and every network operation.
  assertHostedWindows(environment, platform);
  const results = [];
  for (const probe of probes()) {
    if ((probe.body?.byteLength ?? 0) > MAX_REQUEST_BYTES) throw new Error("audit_transport_request_limit");
    const dependencies = { request, fetch, clock, schedule, cancel };
    results.push(await (probe.client === "https" ? probeHttps : probeFetch)(probe, dependencies));
  }
  return {
    schemaVersion: 1,
    purpose: "transport-only-not-a-vulnerability-audit",
    requests: results,
  };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    assertHostedWindows(process.env, process.platform);
    if (process.argv.length !== 2) throw new Error("audit_transport_arguments_refused");
    process.stdout.write(`${JSON.stringify(await runAuditTransportDiagnostics())}\n`);
  } catch (error) {
    const known = new Set(["audit_transport_ci_required", "audit_transport_arguments_refused",
      "audit_transport_request_limit", "audit_transport_tls_verification_required"]);
    process.stdout.write(`${JSON.stringify({ error: known.has(error?.message) ? error.message : "unknown" })}\n`);
    process.exitCode = 1;
  }
}
