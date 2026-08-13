import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath = path.join(
  repositoryRoot,
  "fixtures",
  "document-import-benchmark",
  "cases.json",
);

const normalizeName = (value) => value.trim().toLocaleLowerCase("zh-CN");

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value, location, { allowEmpty = false } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${location} must be a ${allowEmpty ? "string" : "non-empty string"}`);
  }
  return value;
}

function requireStringArray(value, location) {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const strings = value.map((item, index) => requireString(item, `${location}[${index}]`));
  if (new Set(strings.map(normalizeName)).size !== strings.length) {
    throw new Error(`${location} contains duplicate values`);
  }
  return strings;
}

function validateExpectedNode(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  return {
    name: requireString(value.name, `${location}.name`),
    requiredFacts: requireStringArray(value.requiredFacts, `${location}.requiredFacts`),
    referenceNames: requireStringArray(value.referenceNames, `${location}.referenceNames`),
  };
}

function validateCase(value, index) {
  const location = `cases[${index}]`;
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  if (!Array.isArray(value.expectedNodes)) {
    throw new Error(`${location}.expectedNodes must be an array`);
  }
  const expectedNodes = value.expectedNodes.map((node, nodeIndex) =>
    validateExpectedNode(node, `${location}.expectedNodes[${nodeIndex}]`),
  );
  if (new Set(expectedNodes.map((node) => normalizeName(node.name))).size !== expectedNodes.length) {
    throw new Error(`${location}.expectedNodes contains duplicate names`);
  }
  const forbiddenNodeNames = requireStringArray(
    value.forbiddenNodeNames,
    `${location}.forbiddenNodeNames`,
  );
  const expectedNames = new Set(expectedNodes.map((node) => normalizeName(node.name)));
  if (forbiddenNodeNames.some((name) => expectedNames.has(normalizeName(name)))) {
    throw new Error(`${location} contains a name that is both expected and forbidden`);
  }
  return {
    id: requireString(value.id, `${location}.id`),
    sourceName: requireString(value.sourceName, `${location}.sourceName`),
    text: requireString(value.text, `${location}.text`),
    tags: requireStringArray(value.tags, `${location}.tags`),
    expectedNodes,
    forbiddenNodeNames,
  };
}

export function validateBenchmark(value) {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
    throw new Error("benchmark must use schemaVersion 1 and contain a cases array");
  }
  const cases = value.cases.map(validateCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) {
    throw new Error("benchmark contains duplicate case ids");
  }
  return {
    schemaVersion: 1,
    datasetId: requireString(value.datasetId, "datasetId"),
    license: requireString(value.license, "license"),
    cases,
  };
}

function validatePredictionNode(value, location) {
  if (!isObject(value)) throw new Error(`${location} must be an object`);
  return {
    name: requireString(value.name, `${location}.name`),
    content:
      value.content === null
        ? null
        : requireString(value.content, `${location}.content`, { allowEmpty: true }),
    referenceNames: requireStringArray(value.referenceNames, `${location}.referenceNames`),
  };
}

export function validatePredictions(value) {
  if (!isObject(value) || value.schemaVersion !== 1 || !Array.isArray(value.cases)) {
    throw new Error("predictions must use schemaVersion 1 and contain a cases array");
  }
  return {
    schemaVersion: 1,
    datasetId: requireString(value.datasetId, "datasetId"),
    modelId: requireString(value.modelId, "modelId"),
    cases: value.cases.map((item, index) => {
      const location = `predictions.cases[${index}]`;
      if (!isObject(item) || !Array.isArray(item.nodes)) {
        throw new Error(`${location} must contain a nodes array`);
      }
      return {
        id: requireString(item.id, `${location}.id`),
        nodes: item.nodes.map((node, nodeIndex) =>
          validatePredictionNode(node, `${location}.nodes[${nodeIndex}]`),
        ),
      };
    }),
  };
}

const ratio = (numerator, denominator, emptyValue = 0) =>
  denominator === 0 ? emptyValue : numerator / denominator;
const harmonicMean = (precision, recall) =>
  precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

function roundMetric(value) {
  return Number(value.toFixed(4));
}

export function scoreBenchmark(benchmarkInput, predictionInput) {
  const benchmark = validateBenchmark(benchmarkInput);
  const predictions = validatePredictions(predictionInput);
  if (predictions.datasetId !== benchmark.datasetId) {
    throw new Error(
      `prediction datasetId ${predictions.datasetId} does not match ${benchmark.datasetId}`,
    );
  }
  const predictionCases = new Map();
  for (const item of predictions.cases) {
    if (predictionCases.has(item.id)) throw new Error(`duplicate prediction case id: ${item.id}`);
    predictionCases.set(item.id, item);
  }
  const expectedCaseIds = new Set(benchmark.cases.map((item) => item.id));
  const unknownCases = predictions.cases.filter((item) => !expectedCaseIds.has(item.id));
  if (unknownCases.length > 0) {
    throw new Error(`unknown prediction case ids: ${unknownCases.map((item) => item.id).join(", ")}`);
  }

  const totals = {
    expectedNodes: 0,
    predictedNodes: 0,
    matchedNodes: 0,
    duplicateNames: 0,
    expectedReferences: 0,
    predictedReferences: 0,
    matchedReferences: 0,
    expectedFacts: 0,
    matchedFacts: 0,
    forbiddenNameHits: 0,
  };
  const cases = [];

  for (const expectedCase of benchmark.cases) {
    const prediction = predictionCases.get(expectedCase.id) ?? { id: expectedCase.id, nodes: [] };
    const predictedByName = new Map();
    let duplicateNames = 0;
    for (const node of prediction.nodes) {
      const key = normalizeName(node.name);
      if (predictedByName.has(key)) duplicateNames += 1;
      else predictedByName.set(key, node);
    }
    const expectedByName = new Map(
      expectedCase.expectedNodes.map((node) => [normalizeName(node.name), node]),
    );
    const matchedNames = [...expectedByName.keys()].filter((name) => predictedByName.has(name));
    const predictedReferences = new Set();
    for (const [sourceName, node] of predictedByName) {
      for (const targetName of node.referenceNames) {
        predictedReferences.add(`${sourceName}\0${normalizeName(targetName)}`);
      }
    }
    const expectedReferences = new Set();
    for (const [sourceName, node] of expectedByName) {
      for (const targetName of node.referenceNames) {
        expectedReferences.add(`${sourceName}\0${normalizeName(targetName)}`);
      }
    }
    const matchedReferences = [...expectedReferences].filter((key) => predictedReferences.has(key));
    let expectedFacts = 0;
    let matchedFacts = 0;
    for (const [name, expectedNode] of expectedByName) {
      const content = predictedByName.get(name)?.content ?? "";
      for (const fact of expectedNode.requiredFacts) {
        expectedFacts += 1;
        if (content.includes(fact)) matchedFacts += 1;
      }
    }
    const forbiddenNameHits = expectedCase.forbiddenNodeNames.filter((name) =>
      predictedByName.has(normalizeName(name)),
    ).length;
    const caseTotals = {
      expectedNodes: expectedByName.size,
      predictedNodes: predictedByName.size,
      matchedNodes: matchedNames.length,
      duplicateNames,
      expectedReferences: expectedReferences.size,
      predictedReferences: predictedReferences.size,
      matchedReferences: matchedReferences.length,
      expectedFacts,
      matchedFacts,
      forbiddenNameHits,
    };
    for (const key of Object.keys(totals)) totals[key] += caseTotals[key];
    cases.push({ id: expectedCase.id, ...caseTotals });
  }

  const nodePrecision = ratio(
    totals.matchedNodes,
    totals.predictedNodes,
    totals.expectedNodes === 0 ? 1 : 0,
  );
  const nodeRecall = ratio(totals.matchedNodes, totals.expectedNodes);
  const referencePrecision = ratio(
    totals.matchedReferences,
    totals.predictedReferences,
    totals.expectedReferences === 0 ? 1 : 0,
  );
  const referenceRecall = ratio(totals.matchedReferences, totals.expectedReferences);
  return {
    datasetId: benchmark.datasetId,
    modelId: predictions.modelId,
    caseCount: benchmark.cases.length,
    suppliedCaseCount: predictions.cases.length,
    metrics: {
      nodePrecision: roundMetric(nodePrecision),
      nodeRecall: roundMetric(nodeRecall),
      nodeF1: roundMetric(harmonicMean(nodePrecision, nodeRecall)),
      referencePrecision: roundMetric(referencePrecision),
      referenceRecall: roundMetric(referenceRecall),
      referenceF1: roundMetric(harmonicMean(referencePrecision, referenceRecall)),
      factRecall: roundMetric(ratio(totals.matchedFacts, totals.expectedFacts)),
      duplicateNames: totals.duplicateNames,
      forbiddenNameHits: totals.forbiddenNameHits,
    },
    totals,
    cases,
  };
}

export function createPredictionTemplate(benchmarkInput) {
  const benchmark = validateBenchmark(benchmarkInput);
  return {
    schemaVersion: 1,
    datasetId: benchmark.datasetId,
    modelId: "Qwen/Qwen3-1.7B-GGUF",
    cases: benchmark.cases.map((item) => ({ id: item.id, nodes: [] })),
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  const benchmark = validateBenchmark(await readJson(fixturePath));
  if (command === "validate") {
    process.stdout.write(
      `Document import benchmark is valid: ${benchmark.datasetId}, ${benchmark.cases.length} cases.\n`,
    );
    return;
  }
  if (command === "template") {
    if (!argument) throw new Error("template requires an output path");
    const outputPath = path.resolve(repositoryRoot, argument);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(createPredictionTemplate(benchmark), null, 2)}\n`);
    process.stdout.write(`Prediction template written to ${outputPath}.\n`);
    return;
  }
  if (command === "score") {
    if (!argument) throw new Error("score requires a prediction JSON path");
    const report = scoreBenchmark(benchmark, await readJson(path.resolve(repositoryRoot, argument)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  throw new Error("usage: document-import-benchmark.mjs validate | template <output> | score <predictions>");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
