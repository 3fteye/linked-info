import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [endpoint, apiKey, outputArgument] = process.argv.slice(2);
if (!endpoint || !apiKey || !outputArgument) {
  process.stderr.write(
    "usage: run-local-document-import-benchmark.mjs <endpoint> <api-key> <output>\n",
  );
  process.exit(1);
}

const benchmarkPath = path.resolve(
  "fixtures",
  "document-import-benchmark",
  "cases.json",
);
const outputPath = path.resolve(outputArgument);
const benchmark = JSON.parse(await readFile(benchmarkPath, "utf8"));
const promptContract = JSON.parse(
  await readFile(path.resolve("fixtures", "document-import-prompt.json"), "utf8"),
);

const schema = {
  type: "object",
  properties: {
    nodes: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 160 },
          content: { type: ["string", "null"], maxLength: 2400 },
          referenceNames: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 160 },
            uniqueItems: true,
          },
        },
        required: ["name", "content", "referenceNames"],
        additionalProperties: false,
      },
    },
  },
  required: ["nodes"],
  additionalProperties: false,
};

if (
  promptContract.schemaVersion !== 1 ||
  typeof promptContract.systemPrompt !== "string" ||
  !Array.isArray(promptContract.examples)
) {
  throw new Error("document import prompt contract is invalid");
}

const predictions = {
  schemaVersion: 1,
  datasetId: benchmark.datasetId,
  modelId: "Qwen/Qwen3-1.7B-GGUF",
  cases: [],
};

function validateNodes(nodes, caseId) {
  if (!Array.isArray(nodes) || nodes.length > 24) {
    throw new Error(`case ${caseId} returned an invalid node count`);
  }
  const names = new Set();
  for (const node of nodes) {
    const name = typeof node?.name === "string" ? node.name.trim() : "";
    const key = name.toLocaleLowerCase("zh-CN");
    if (
      !name ||
      [...name].length > 160 ||
      names.has(key) ||
      (node.content !== null &&
        (typeof node.content !== "string" || [...node.content].length > 2400)) ||
      !Array.isArray(node.referenceNames) ||
      node.referenceNames.length > 12
    ) {
      throw new Error(`case ${caseId} returned an invalid node`);
    }
    names.add(key);
    const referenceNames = new Set();
    for (const referenceNameValue of node.referenceNames) {
      const referenceName =
        typeof referenceNameValue === "string" ? referenceNameValue.trim() : "";
      const referenceKey = referenceName.toLocaleLowerCase("zh-CN");
      if (
        !referenceName ||
        [...referenceName].length > 160 ||
        referenceKey === key ||
        referenceNames.has(referenceKey)
      ) {
        throw new Error(`case ${caseId} returned an invalid reference`);
      }
      referenceNames.add(referenceKey);
    }
  }
  return nodes;
}

for (let index = 0; index < benchmark.cases.length; index += 1) {
  const item = benchmark.cases[index];
  process.stderr.write(`Running ${index + 1}/${benchmark.cases.length}: ${item.id}\n`);
  const request = {
    sourceName: item.sourceName,
    chunkIndex: 0,
    chunkCount: 1,
    text: item.text,
  };
  const response = await fetch(`${endpoint.replace(/\/$/u, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "linked-info-local",
      messages: [
        { role: "system", content: promptContract.systemPrompt },
        ...promptContract.examples.flatMap((example) => [
          { role: "user", content: JSON.stringify(example.request) },
          { role: "assistant", content: JSON.stringify(example.response) },
        ]),
        { role: "user", content: JSON.stringify(request) },
      ],
      temperature: 0,
      max_tokens: 768,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "linked_info_document_import",
          strict: true,
          schema,
        },
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`local runtime returned HTTP ${response.status}`);
  const envelope = await response.json();
  const content = envelope.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`case ${item.id} returned no content`);
  const result = JSON.parse(content);
  predictions.cases.push({ id: item.id, nodes: validateNodes(result.nodes, item.id) });
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(predictions, null, 2)}\n`);
process.stdout.write(`Local benchmark predictions written to ${outputPath}.\n`);
