import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const maximumNodes = 24;
const maximumReferencesPerNode = 12;
const maximumEstimatedInputTokens = 3_000;
const entityKinds = [
  "account", "service", "plan", "script", "tool", "project", "promoCode",
  "person", "organization", "other",
];
const [endpoint, apiKey, outputArgument] = process.argv.slice(2);
if (!endpoint || !apiKey || !outputArgument) {
  process.stderr.write(
    "usage: run-local-document-import-benchmark.mjs <endpoint> <api-key> <output>\n",
  );
  process.exit(1);
}

const benchmark = JSON.parse(
  await readFile(
    path.resolve("fixtures", "document-import-benchmark", "cases.json"),
    "utf8",
  ),
);
const contract = JSON.parse(
  await readFile(path.resolve("fixtures", "document-import-prompt.json"), "utf8"),
);
const outputPath = path.resolve(outputArgument);
if (
  contract.schemaVersion !== 2 ||
  !contract.entity?.systemPrompt ||
  !contract.record?.systemPrompt ||
  !contract.reference?.systemPrompt
) {
  throw new Error("document import prompt contract is invalid");
}

const namedContentProperties = {
  kind: { type: "string", enum: entityKinds },
  name: { type: "string", minLength: 1, maxLength: 160 },
  content: { type: ["string", "null"], maxLength: 2400 },
};

const entitySchema = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      maxItems: maximumNodes,
      items: {
        type: "object",
        properties: namedContentProperties,
        required: ["kind", "name", "content"],
        additionalProperties: false,
      },
    },
  },
  required: ["entities"],
  additionalProperties: false,
};

function recordSchema(aliases) {
  return {
    type: "object",
    properties: {
      records: {
        type: "array",
        maxItems: maximumNodes - aliases.length,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            content: { type: "string", minLength: 1, maxLength: 2400 },
            participantAliases: {
              type: "array",
              minItems: 2,
              maxItems: maximumReferencesPerNode,
              items: { type: "string", enum: aliases },
              uniqueItems: true,
            },
          },
          required: ["name", "content", "participantAliases"],
          additionalProperties: false,
        },
      },
    },
    required: ["records"],
    additionalProperties: false,
  };
}

function referenceSchema(aliases) {
  return {
    type: "object",
    properties: {
      references: {
        type: "array",
        maxItems: maximumNodes * maximumReferencesPerNode,
        items: {
          type: "object",
          properties: {
            sourceAlias: { type: "string", enum: aliases },
            targetAlias: { type: "string", enum: aliases },
          },
          required: ["sourceAlias", "targetAlias"],
          additionalProperties: false,
        },
      },
    },
    required: ["references"],
    additionalProperties: false,
  };
}

async function infer(stage, schemaName, schema, request) {
  const messages = [
    { role: "system", content: stage.systemPrompt },
    ...stage.examples.flatMap((example) => [
      { role: "user", content: JSON.stringify(example.request) },
      { role: "assistant", content: JSON.stringify(example.response) },
    ]),
    { role: "user", content: JSON.stringify(request) },
  ];
  const estimatedInputTokens = 16 + messages.length * 4 + messages.reduce(
    (total, message) => total + [...message.content].reduce(
      (subtotal, character) => subtotal + (character.codePointAt(0) <= 0x7f ? 0.25 : 1),
      0,
    ),
    0,
  );
  if (Math.ceil(estimatedInputTokens) > maximumEstimatedInputTokens) {
    throw new Error(`${schemaName} exceeds the context budget`);
  }
  const response = await fetch(`${endpoint.replace(/\/$/u, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "linked-info-local",
      messages,
      temperature: 0,
      max_tokens: 768,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`${schemaName} returned HTTP ${response.status}`);
  const envelope = await response.json();
  const content = envelope.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`${schemaName} returned no content`);
  return JSON.parse(content);
}

function normalizedName(value) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function validateNamedContent(value, location) {
  const name = typeof value?.name === "string" ? value.name.trim() : "";
  if (
    !name ||
    [...name].length > 160 ||
    (value.content !== null &&
      (typeof value.content !== "string" || [...value.content].length > 2400))
  ) {
    throw new Error(`${location} is invalid`);
  }
  return {
    name,
    content:
      typeof value.content === "string" && value.content.trim()
        ? value.content.trim()
        : null,
  };
}

function validateEntities(result, caseId) {
  if (!Array.isArray(result?.entities) || result.entities.length > maximumNodes) {
    throw new Error(`${caseId} returned invalid entities`);
  }
  const names = new Set();
  return result.entities.map((entity, index) => {
    const validated = validateNamedContent(entity, `${caseId}.entities[${index}]`);
    if (!entityKinds.includes(entity.kind)) {
      throw new Error(`${caseId} returned an invalid entity kind`);
    }
    const key = normalizedName(validated.name);
    if (names.has(key)) throw new Error(`${caseId} repeated an entity name`);
    names.add(key);
    return {
      alias: `E${String(index + 1).padStart(2, "0")}`,
      kind: entity.kind,
      ...validated,
    };
  });
}

function validateRecords(result, entities, caseId) {
  if (
    !Array.isArray(result?.records) ||
    entities.length + result.records.length > maximumNodes
  ) {
    throw new Error(`${caseId} returned invalid records`);
  }
  const entityAliases = new Set(entities.map((entity) => entity.alias));
  const names = new Set(entities.map((entity) => normalizedName(entity.name)));
  return result.records.map((record, index) => {
    const validated = validateNamedContent(record, `${caseId}.records[${index}]`);
    const key = normalizedName(validated.name);
    if (
      validated.content === null ||
      names.has(key) ||
      !Array.isArray(record.participantAliases) ||
      record.participantAliases.length < 2 ||
      record.participantAliases.length > maximumReferencesPerNode ||
      new Set(record.participantAliases).size !== record.participantAliases.length ||
      record.participantAliases.some((alias) => !entityAliases.has(alias))
    ) {
      throw new Error(`${caseId} returned an invalid record`);
    }
    names.add(key);
    return { ...validated, participantAliases: record.participantAliases };
  });
}

function buildReferenceNodes(entities, records) {
  const entityNodeAlias = new Map(
    entities.map((entity, index) => [entity.alias, `N${String(index + 1).padStart(2, "0")}`]),
  );
  return [
    ...entities.map((entity, index) => ({
      alias: `N${String(index + 1).padStart(2, "0")}`,
      kind: entity.kind,
      name: entity.name,
      content: entity.content,
      participantAliases: [],
    })),
    ...records.map((record, index) => ({
      alias: `N${String(entities.length + index + 1).padStart(2, "0")}`,
      kind: "record",
      name: record.name,
      content: record.content,
      participantAliases: record.participantAliases.map((alias) => entityNodeAlias.get(alias)),
    })),
  ];
}

function validateReferences(result, nodes, caseId) {
  if (
    !Array.isArray(result?.references) ||
    result.references.length > maximumNodes * maximumReferencesPerNode
  ) {
    throw new Error(`${caseId} returned invalid references`);
  }
  const aliases = new Set(nodes.map((node) => node.alias));
  const pairs = new Set();
  const sourceCounts = new Map();
  return result.references.map((reference) => {
    const source = reference?.sourceAlias;
    const target = reference?.targetAlias;
    const pair = `${source}\0${target}`;
    const count = (sourceCounts.get(source) ?? 0) + 1;
    if (
      !aliases.has(source) ||
      !aliases.has(target) ||
      source === target ||
      pairs.has(pair) ||
      count > maximumReferencesPerNode
    ) {
      throw new Error(`${caseId} returned an invalid reference`);
    }
    pairs.add(pair);
    sourceCounts.set(source, count);
    return { sourceAlias: source, targetAlias: target };
  });
}

function assembleNodes(nodes, references) {
  const nodeByAlias = new Map(nodes.map((node) => [node.alias, node]));
  const targets = new Map();
  for (const reference of references) {
    const values = targets.get(reference.sourceAlias) ?? [];
    values.push(nodeByAlias.get(reference.targetAlias).name);
    targets.set(reference.sourceAlias, values);
  }
  return nodes.map((node) => ({
    name: node.name,
    content: node.content,
    referenceNames: targets.get(node.alias) ?? [],
  }));
}

const predictions = {
  schemaVersion: 1,
  datasetId: benchmark.datasetId,
  modelId: "Qwen/Qwen3-1.7B-GGUF-multistage-v2",
  cases: [],
  failures: [],
};

for (let index = 0; index < benchmark.cases.length; index += 1) {
  const item = benchmark.cases[index];
  const baseRequest = {
    sourceName: item.sourceName,
    chunkIndex: 0,
    chunkCount: 1,
    text: item.text,
  };
  let stage = "entity";
  try {
    process.stderr.write(`Running ${index + 1}/${benchmark.cases.length} entity: ${item.id}\n`);
    const entityResult = await infer(
      contract.entity,
      "linked_info_document_entities",
      entitySchema,
      baseRequest,
    );
    const entities = validateEntities(entityResult, item.id);

    stage = "record";
    process.stderr.write(`Running ${index + 1}/${benchmark.cases.length} record: ${item.id}\n`);
    const recordRequest = { ...baseRequest, entities };
    const recordResult = await infer(
      contract.record,
      "linked_info_document_records",
      recordSchema(entities.map((entity) => entity.alias)),
      recordRequest,
    );
    const records = validateRecords(recordResult, entities, item.id);
    const nodes = buildReferenceNodes(entities, records);

    stage = "reference";
    process.stderr.write(`Running ${index + 1}/${benchmark.cases.length} reference: ${item.id}\n`);
    const referenceRequest = {
      sourceName: baseRequest.sourceName,
      chunkIndex: baseRequest.chunkIndex,
      chunkCount: baseRequest.chunkCount,
      nodes,
    };
    const referenceResult = await infer(
      contract.reference,
      "linked_info_document_references",
      referenceSchema(nodes.map((node) => node.alias)),
      referenceRequest,
    );
    const references = validateReferences(referenceResult, nodes, item.id);
    predictions.cases.push({ id: item.id, nodes: assembleNodes(nodes, references) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed ${item.id} at ${stage}: ${message}\n`);
    predictions.failures.push({ id: item.id, stage, message });
    predictions.cases.push({ id: item.id, nodes: [] });
  }
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(predictions, null, 2)}\n`);
process.stdout.write(`Local benchmark predictions written to ${outputPath}.\n`);
