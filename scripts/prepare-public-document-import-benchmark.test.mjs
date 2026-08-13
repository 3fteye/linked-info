import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(
  new URL("./prepare-public-document-import-benchmark.mjs", import.meta.url),
);

async function runConverter(format, contents) {
  const directory = await mkdtemp(path.join(tmpdir(), "linked-info-public-benchmark-"));
  const inputPath = path.join(directory, "input.json");
  const outputPath = path.join(directory, "output.json");
  await writeFile(inputPath, contents, "utf8");
  const result = spawnSync(
    process.execPath,
    [scriptPath, format, inputPath, outputPath, "1"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(await readFile(outputPath, "utf8"));
}

test("converts a CLUENER JSONL record without copying labels into content", async () => {
  const output = await runConverter(
    "cluener",
    `${JSON.stringify({
      text: "北京勘察设计协会秘书长周某",
      label: {
        organization: { 北京勘察设计协会: [[0, 7]] },
        name: { 周某: [[11, 12]] },
      },
    })}\n`,
  );
  assert.deepEqual(
    output.cases[0].expectedNodes.map((node) => node.name),
    ["北京勘察设计协会", "周某"],
  );
  assert.equal(output.cases[0].text, "北京勘察设计协会秘书长周某");
});

test("converts DocRED entities and directed relation labels", async () => {
  const output = await runConverter(
    "docred",
    JSON.stringify([{
      title: "Example",
      sents: [["Alice", "uses", "ServiceX", "."]],
      vertexSet: [[{ name: "Alice" }], [{ name: "ServiceX" }]],
      labels: [{ h: 0, t: 1, r: "uses" }],
    }]),
  );
  assert.deepEqual(output.cases[0].expectedNodes, [
    { name: "Alice", requiredFacts: [], referenceNames: ["ServiceX"] },
    { name: "ServiceX", requiredFacts: [], referenceNames: [] },
  ]);
  assert.equal(output.cases[0].text, "Alice uses ServiceX .");
});
