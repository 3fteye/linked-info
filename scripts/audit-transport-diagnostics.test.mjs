import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import test from "node:test";
import {
  MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS, runAuditTransportDiagnostics,
} from "./audit-transport-diagnostics.mjs";

const environment = Object.freeze({
  GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows",
});

function fixture({ httpsOutcome = "success", fetchOutcome = "success", status = 200 } = {}) {
  let now = 0;
  let active = 0;
  let maxActive = 0;
  let destroyed = 0;
  let readerCancelled = 0;
  const timers = new Set();
  const calls = [];
  const start = () => { active += 1; maxActive = Math.max(maxActive, active); };
  const dependencies = {
    environment, platform: "win32", clock: () => now,
    schedule(callback, delay) {
      assert.equal(delay, REQUEST_TIMEOUT_MS);
      const timer = { callback };
      timers.add(timer);
      return timer;
    },
    cancel(timer) { timers.delete(timer); },
    request(url, options, callback) {
      start();
      const outgoing = new EventEmitter();
      let closed = false;
      outgoing.destroy = () => {
        if (!closed) { closed = true; active -= 1; destroyed += 1; }
      };
      outgoing.end = (body) => {
        calls.push({ client: "https", url, options, body });
        if (httpsOutcome === "hang") return;
        const socket = new EventEmitter();
        outgoing.emit("socket", socket);
        now += 1; socket.emit("lookup", null, "private-address-not-for-output", 4, "untrusted-host");
        now += 2; socket.emit("connect");
        now += 3; socket.emit("secureConnect");
        if (httpsOutcome === "error") {
          outgoing.emit("error", Object.assign(new Error("SECRET raw error text"), { code: "SECRET" }));
          return;
        }
        if (httpsOutcome === "known-error") {
          outgoing.emit("error", Object.assign(new Error("SECRET"), { code: "ECONNRESET" }));
          return;
        }
        const incoming = new EventEmitter();
        incoming.statusCode = status;
        incoming.headers = { location: "https://do-not-follow.invalid/SECRET", authorization: "SECRET" };
        incoming.destroy = () => {};
        now += 4;
        callback(incoming);
        if (httpsOutcome === "body-hang") return;
        const chunk = httpsOutcome === "oversize" ? Buffer.alloc(MAX_RESPONSE_BYTES + 1) : Buffer.from("SECRET");
        incoming.emit("data", chunk);
        incoming.emit("end");
        // Late events must neither mutate the report nor cause a second result.
        incoming.emit("data", Buffer.from("LATE-SECRET"));
        outgoing.emit("error", new Error("LATE-SECRET"));
      };
      return outgoing;
    },
    async fetch(url, options) {
      start();
      calls.push({ client: "fetch", url, options, body: options.body });
      options.signal.addEventListener("abort", () => { active -= 1; }, { once: true });
      if (fetchOutcome === "hang") return new Promise(() => {});
      if (fetchOutcome === "error") throw new Error("SECRET fetch error");
      if (fetchOutcome === "known-error") {
        throw new Error("SECRET", { cause: Object.assign(new Error("SECRET"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
      }
      let read = false;
      return {
        status,
        headers: { secret: "SECRET" },
        body: {
          getReader() {
            return {
              async read() {
                if (fetchOutcome === "body-hang") return new Promise(() => {});
                if (read) return { done: true };
                read = true;
                now += 5;
                return { done: false, value: fetchOutcome === "oversize"
                  ? Buffer.alloc(MAX_RESPONSE_BYTES + 1) : Buffer.from("SECRET") };
              },
              async cancel() { readerCancelled += 1; },
            };
          },
        },
      };
    },
  };
  return {
    dependencies, calls, timers,
    inspect: () => ({ active, maxActive, destroyed, readerCancelled }),
    fireTimer() {
      assert.equal(timers.size, 1);
      now += REQUEST_TIMEOUT_MS;
      [...timers][0].callback();
    },
  };
}

async function drainMicrotasks() {
  for (let count = 0; count < 12; count += 1) await Promise.resolve();
}

for (const field of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS"]) {
  test(`invalid ${field} refuses before any client or clock access`, async () => {
    let touched = false;
    const forbidden = () => { touched = true; throw new Error("must not run"); };
    await assert.rejects(runAuditTransportDiagnostics({
      environment: { ...environment, [field]: "wrong" }, platform: "win32",
      request: forbidden, fetch: forbidden, clock: forbidden, schedule: forbidden,
    }), /audit_transport_ci_required/);
    assert.equal(touched, false);
  });
}

test("non-Windows platform refuses despite forged CI environment", async () => {
  let touched = false;
  await assert.rejects(runAuditTransportDiagnostics({
    environment, platform: "linux", request: () => { touched = true; }, fetch: () => { touched = true; },
  }), /audit_transport_ci_required/);
  assert.equal(touched, false);
});

test("disabled TLS validation refuses before accessing either network client", async () => {
  let touched = false;
  const forbidden = () => { touched = true; throw new Error("must not run"); };
  await assert.rejects(runAuditTransportDiagnostics({
    environment: { ...environment, NODE_TLS_REJECT_UNAUTHORIZED: "0" }, platform: "win32",
    request: forbidden, fetch: forbidden, clock: forbidden, schedule: forbidden,
  }), /audit_transport_tls_verification_required/);
  assert.equal(touched, false);
});

test("exactly six sequential fixed probes use bounded public input and no credentials", async () => {
  const state = fixture();
  const report = await runAuditTransportDiagnostics(state.dependencies);
  assert.equal(report.purpose, "transport-only-not-a-vulnerability-audit");
  assert.equal(report.requests.length, 6);
  assert.equal(state.calls.length, 6);
  assert.deepEqual(state.inspect(), { active: 0, maxActive: 1, destroyed: 3, readerCancelled: 3 });
  assert.equal(state.timers.size, 0);
  for (const [index, call] of state.calls.entries()) {
    const ping = index % 3 === 0;
    const gzip = index % 3 === 2;
    assert.equal(call.url, `https://registry.npmjs.org${ping ? "/-/ping" : "/-/npm/v1/security/advisories/bulk"}`);
    assert.equal(call.options.method, ping ? "GET" : "POST");
    assert.equal(call.options.headers.authorization, undefined);
    assert.equal(call.options.headers["accept-encoding"], "identity");
    if (call.client === "https") {
      assert.equal(call.options.agent, false);
      assert.equal(call.options.rejectUnauthorized, true);
      assert.equal(call.options.maxHeaderSize, 8192);
    } else {
      assert.equal(call.options.credentials, "omit");
      assert.equal(call.options.redirect, "manual");
      assert.equal(call.options.signal.aborted, true);
    }
    if (ping) assert.equal(call.body, undefined);
    else {
      assert.ok(call.body.byteLength <= MAX_REQUEST_BYTES);
      assert.equal(call.options.headers["content-length"], String(call.body.byteLength));
      assert.equal(call.options.headers["content-type"], "application/json");
      assert.equal(call.options.headers["content-encoding"], gzip ? "gzip" : undefined);
      assert.equal((gzip ? gunzipSync(call.body) : call.body).toString(), '{"react":["19.2.8"]}');
    }
  }
  for (const result of report.requests) {
    assert.equal(result.statusCode, 200);
    assert.equal(result.error, null);
    assert.equal(result.responseBytes, 6);
    assert.deepEqual(result.phases, result.client === "https"
      ? { dnsMs: 1, tcpMs: 3, tlsMs: 6, responseHeadersMs: 10 }
      : { dnsMs: null, tcpMs: null, tlsMs: null, responseHeadersMs: null });
  }
  assert.doesNotMatch(JSON.stringify(report), /SECRET|private-address|untrusted-host|authorization|https:\/\//);
});

test("redirect status is reported without following the location", async () => {
  const state = fixture({ status: 302 });
  const report = await runAuditTransportDiagnostics(state.dependencies);
  assert.equal(state.calls.length, 6);
  assert.ok(report.requests.every((result) => result.statusCode === 302));
  assert.doesNotMatch(JSON.stringify(report), /do-not-follow|SECRET/);
});

test("HTTP error status stays distinct from transport errors", async () => {
  const state = fixture({ status: 503 });
  const report = await runAuditTransportDiagnostics(state.dependencies);
  assert.ok(report.requests.every((result) => result.statusCode === 503 && result.error === null));
});

test("both clients cancel oversized responses without retaining response content", async () => {
  const state = fixture({ httpsOutcome: "oversize", fetchOutcome: "oversize" });
  const report = await runAuditTransportDiagnostics(state.dependencies);
  assert.ok(report.requests.every((result) => result.error === "response_limit"));
  assert.ok(report.requests.every((result) => result.responseBytes === MAX_RESPONSE_BYTES + 1));
  assert.equal(state.inspect().active, 0);
  assert.equal(state.timers.size, 0);
});

test("only allowlisted direct or wrapped network codes escape", async () => {
  const known = fixture({ httpsOutcome: "known-error", fetchOutcome: "known-error" });
  const report = await runAuditTransportDiagnostics(known.dependencies);
  assert.deepEqual(report.requests.map((result) => result.error), [
    "ECONNRESET", "ECONNRESET", "ECONNRESET",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT",
  ]);
  const unknown = fixture({ httpsOutcome: "error", fetchOutcome: "error" });
  const unknownReport = await runAuditTransportDiagnostics(unknown.dependencies);
  assert.ok(unknownReport.requests.every((result) => result.error === "unknown"));
  assert.doesNotMatch(JSON.stringify([report, unknownReport]), /SECRET/);
});

for (const outcome of ["hang", "body-hang"]) {
  test(`whole-request deadline bounds ${outcome} without retries or parallel work`, async () => {
    const state = fixture({ httpsOutcome: outcome, fetchOutcome: outcome });
    const pending = runAuditTransportDiagnostics(state.dependencies);
    for (let count = 0; count < 6; count += 1) {
      await drainMicrotasks();
      assert.equal(state.calls.length, count + 1);
      state.fireTimer();
    }
    const report = await pending;
    assert.ok(report.requests.every((result) => result.error === "timeout"));
    assert.equal(state.calls.length, 6);
    assert.equal(state.inspect().maxActive, 1);
    assert.equal(state.inspect().active, 0);
    assert.equal(state.timers.size, 0);
  });
}

test("unavailable status is rejected rather than coerced into a success", async () => {
  const state = fixture({ status: "200 SECRET" });
  const report = await runAuditTransportDiagnostics(state.dependencies);
  assert.ok(report.requests.every((result) => result.statusCode === null && result.error === "invalid_response"));
  assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});
