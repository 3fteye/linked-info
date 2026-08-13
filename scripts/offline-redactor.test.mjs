import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../offline-redactor.html", import.meta.url), "utf8");
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/u);
assert.ok(scriptMatch, "offline-redactor.html should contain one executable script");

const context = { console };
context.globalThis = context;
vm.runInNewContext(scriptMatch[1], context, { filename: "offline-redactor.html" });
const { redactText, restoreText, restoreStructuredText } = context.LinkedInfoRedactor;

test("ships as a self-contained page with network access disabled", () => {
  assert.match(html, /connect-src 'none'/u);
  assert.equal(/<script[^>]+src=/iu.test(html), false);
  assert.equal(/<link[^>]+rel=["']stylesheet["']/iu.test(html), false);
  assert.equal(/localStorage|sessionStorage|indexedDB/u.test(scriptMatch[1]), false);
});

test("redacts representative secrets without removing useful structure", () => {
  const source = [
    "账号：zeta@example.invalid",
    "服务：Example Auth",
    "密码是 Fake-Pass!2026",
    "API Key: sk-example0123456789abcdefghijkl",
    "恢复码：ABCD-EFGH, IJKL-MNOP",
    "TOTP: otpauth://totp/Example:zeta?secret=JBSWY3DPEHPK3PXP&issuer=Example",
    "服务器：192.0.2.25",
    "手机：+86 13800138000",
    "脚本：C:\\Users\\ExampleUser\\Documents\\refresh.ps1",
    "内部代号：Amber Finch",
  ].join("\n");

  const result = redactText(source, {
    customTerms: ["Amber Finch"],
    customCaseInsensitive: true,
  });

  for (const secret of [
    "zeta@example.invalid",
    "Fake-Pass!2026",
    "sk-example0123456789abcdefghijkl",
    "ABCD-EFGH, IJKL-MNOP",
    "JBSWY3DPEHPK3PXP",
    "192.0.2.25",
    "13800138000",
    "ExampleUser",
    "Amber Finch",
  ]) {
    assert.equal(result.text.includes(secret), false, `redacted text leaked ${secret}`);
  }

  assert.match(result.text, /服务：Example Auth/u);
  assert.match(result.text, /脚本：C:\\Users\\\[\[LI_PATH_USER_001\]\]\\Documents\\refresh\.ps1/u);
  assert.ok(result.entries.length >= 9);

  const restored = restoreText(result.text, result.entries);
  assert.equal(restored.text, source);
  assert.equal(restored.unresolvedCount, 0);
});

test("reuses one placeholder for repeated values", () => {
  const result = redactText("a@example.invalid 和 a@example.invalid");
  assert.equal(result.entries.length, 1);
  assert.equal(result.text.match(/\[\[LI_EMAIL_001\]\]/gu)?.length, 2);
});

test("leaves ordinary relationship text intact", () => {
  const source = "账号节点引用 OpenAI 服务节点，订阅状态为正常。";
  const result = redactText(source);
  assert.equal(result.text, source);
  assert.deepEqual(Array.from(result.entries), []);
});

test("reports placeholders that are not part of the current mapping", () => {
  const result = redactText("密码：Fake-Pass!2026");
  const restored = restoreText(`${result.text}\n[[LI_TOKEN_999]]`, result.entries);
  assert.equal(restored.restoredCount, 1);
  assert.equal(restored.unresolvedCount, 1);
});

test("restores JSON strings without allowing secrets to break JSON syntax", () => {
  const secret = 'quote" slash\\ line\nbreak';
  const placeholder = "[[LI_PASSWORD_001]]";
  const entries = [{ placeholder, type: "PASSWORD", value: secret }];
  const structured = JSON.stringify({ content: `value=${placeholder}` });
  const restored = restoreStructuredText(structured, entries);

  assert.equal(restored.format, "json");
  assert.equal(restored.unresolvedCount, 0);
  assert.equal(JSON.parse(restored.text).content, `value=${secret}`);
});

test("redacts unlabeled and delimiter-free credentials while preserving trailing notes", () => {
  const genericApiKey = "a7qd953gpxdbd86pndkffspcuc28kqsrbmfog9yt";
  const totpSecret = "JBSWY3DPEHPK3PXP";
  const source = [
    "密码 Fake-Pass-No-Colon codex p",
    `2fa ${totpSecret} codex p`,
    genericApiKey,
    "Synthet1c!StandalonePassword codex p",
  ].join("\n");

  const result = redactText(source);

  assert.equal(result.text.includes("Fake-Pass-No-Colon"), false);
  assert.equal(result.text.includes(totpSecret), false);
  assert.equal(result.text.includes(genericApiKey), false);
  assert.equal(result.text.includes("Synthet1c!StandalonePassword"), false);
  assert.equal(result.text.match(/codex p/gu)?.length, 3);
  assert.equal(restoreText(result.text, result.entries).text, source);
});

test("redacts account and password from host-port-account-password proxy rows", () => {
  const source = "proxy.example.invalid:8443:demo-user:Fake-Proxy-Pass! codex p";
  const result = redactText(source);

  assert.equal(result.text.includes("demo-user"), false);
  assert.equal(result.text.includes("Fake-Proxy-Pass!"), false);
  assert.match(result.text, /^proxy\.example\.invalid:8443:\[\[LI_ACCOUNT_001\]\]:\[\[LI_PASSWORD_001\]\] codex p$/u);
  assert.equal(restoreText(result.text, result.entries).text, source);
});

test("redacts standalone promotion codes without storing real examples", () => {
  const syntheticCodes = ["AB4D6F8H2K9M3P5R", "Q7W9E2R4T6Y8U3P5", "ZX8C6V4B2N7M5L3K"];
  const source = syntheticCodes.join("\n");
  const result = redactText(source);

  for (const code of syntheticCodes) {
    assert.equal(result.text.includes(code), false);
  }
  assert.equal(result.entries.filter((entry) => entry.type === "PROMO_CODE").length, 3);
  assert.equal(restoreText(result.text, result.entries).text, source);
});

test("redacts a long complex email as one account instead of splitting its local part", () => {
  const account = "verylongaccount012345678901234567890@example.invalid";
  const result = redactText(`${account} codex died`);

  assert.equal(result.text, "[[LI_EMAIL_001]] codex died");
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].type, "EMAIL");
  assert.equal(restoreText(result.text, result.entries).text, `${account} codex died`);
});

test("redacts 2fa secret after the combined 2fa-key label and preserves notes", () => {
  const source = "2fa密钥 ABCDEFGHIJKLMNOP codex died";
  const result = redactText(source);

  assert.equal(result.text, "2fa密钥 [[LI_TOTP_001]] codex died");
  assert.equal(result.entries.length, 1);
  assert.equal(restoreText(result.text, result.entries).text, source);
});

test("uses dash-separated credential columns instead of password complexity", () => {
  const source = "person@example.invalid----simplepass----ABCDEFGHIJKLMNOP----codex died";
  const result = redactText(source);

  assert.equal(
    result.text,
    "[[LI_EMAIL_001]]----[[LI_PASSWORD_001]]----[[LI_TOTP_001]]----codex died",
  );
  assert.equal(restoreText(result.text, result.entries).text, source);
});
