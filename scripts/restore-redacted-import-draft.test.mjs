import assert from "node:assert/strict";
import test from "node:test";
import {
  derivePlaceholderMapping,
  restoreImportDraft,
} from "./restore-redacted-import-draft.mjs";

test("derives repeated placeholder values without exposing them in the draft schema", () => {
  const original = "account@example.invalid----P@ss\\word\naccount@example.invalid";
  const redacted = "[[LI_EMAIL_001]]----[[LI_PASSWORD_001]]\n[[LI_EMAIL_001]]";
  const mapping = derivePlaceholderMapping(original, redacted);

  assert.equal(mapping.get("[[LI_EMAIL_001]]"), "account@example.invalid");
  assert.equal(mapping.get("[[LI_PASSWORD_001]]"), "P@ss\\word");
});

test("restores JSON semantically and verifies its full source against the original", () => {
  const original = 'account@example.invalid----P@ss"\\word';
  const redacted = "[[LI_EMAIL_001]]----[[LI_PASSWORD_001]]";
  const draft = JSON.stringify({
    schemaVersion: 1,
    kind: "linked-info-document-import-draft",
    sourceName: "accounts.txt",
    sourceText: redacted,
    sourceHash: "redacted",
    handling: { secretsRemainAsLocalPlaceholders: true },
    responses: [
      {
        nodes: [
          {
            name: "账号：[[LI_EMAIL_001]]",
            content: "[[LI_PASSWORD_001]]",
            referenceNames: [],
          },
        ],
      },
    ],
  });
  const result = restoreImportDraft(original, redacted, draft);
  const restored = JSON.parse(result.text);

  assert.equal(restored.sourceText, original);
  assert.equal(restored.responses[0].nodes[0].content, 'P@ss"\\word');
  assert.equal(restored.handling.secretsRemainAsLocalPlaceholders, false);
  assert.equal(restored.handling.restoredLocally, true);
  assert.equal(result.text.includes("[[LI_"), false);
});

test("fails closed when the redacted text no longer aligns with the local original", () => {
  assert.throws(
    () => derivePlaceholderMapping("alpha secret omega", "alpha changed [[LI_TOKEN_001]] omega"),
    /alignment failed/u,
  );
});
