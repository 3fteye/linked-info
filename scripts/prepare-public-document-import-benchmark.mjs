import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function normalizeName(value) {
  return value.trim().toLocaleLowerCase("zh-CN");
}

function uniqueNames(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const name = typeof value === "string" ? value.trim() : "";
    const key = normalizeName(name);
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(name);
    }
  }
  return result;
}

function parseLimit(value) {
  const limit = value === undefined ? 30 : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("limit must be an integer from 1 to 500");
  }
  return limit;
}

function convertCluener(source, limit) {
  const records = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`CLUENER line ${index + 1} is invalid JSON: ${error.message}`);
      }
    });
  return records.slice(0, limit).map((record, index) => {
    if (typeof record.text !== "string" || typeof record.label !== "object" || record.label === null) {
      throw new Error(`CLUENER record ${index + 1} must contain text and label`);
    }
    const names = uniqueNames(
      Object.values(record.label).flatMap((entities) =>
        entities && typeof entities === "object" ? Object.keys(entities) : [],
      ),
    );
    return {
      id: `cluener-${index + 1}`,
      sourceName: `CLUENER2020-${index + 1}.txt`,
      text: record.text,
      expectedNodes: names.map((name) => ({ name, requiredFacts: [], referenceNames: [] })),
      forbiddenNodeNames: [],
      tags: ["public", "cluener2020", "entity-only"],
    };
  });
}

function docredEntityName(document, entityIndex) {
  const mentions = document.vertexSet?.[entityIndex];
  return Array.isArray(mentions) && typeof mentions[0]?.name === "string"
    ? mentions[0].name.trim()
    : "";
}

function convertDocred(source, limit) {
  const documents = JSON.parse(source);
  if (!Array.isArray(documents)) throw new Error("DocRED input must be a JSON array");
  return documents.slice(0, limit).map((document, index) => {
    if (!Array.isArray(document.sents) || !Array.isArray(document.vertexSet)) {
      throw new Error(`DocRED document ${index + 1} is missing sents or vertexSet`);
    }
    const names = document.vertexSet.map((_, entityIndex) =>
      docredEntityName(document, entityIndex),
    );
    const references = new Map(names.map((name) => [normalizeName(name), new Set()]));
    for (const label of Array.isArray(document.labels) ? document.labels : []) {
      const sourceName = names[label.h] ?? "";
      const targetName = names[label.t] ?? "";
      if (sourceName && targetName && normalizeName(sourceName) !== normalizeName(targetName)) {
        references.get(normalizeName(sourceName))?.add(targetName);
      }
    }
    return {
      id: `docred-${index + 1}`,
      sourceName: `${typeof document.title === "string" ? document.title : `DocRED-${index + 1}`}.txt`,
      text: document.sents.map((sentence) => sentence.join(" ")).join("\n\n"),
      expectedNodes: uniqueNames(names).map((name) => ({
        name,
        requiredFacts: [],
        referenceNames: [...(references.get(normalizeName(name)) ?? [])],
      })),
      forbiddenNodeNames: [],
      tags: ["public", "docred", "document-relation"],
    };
  });
}

const [format, inputArgument, outputArgument, limitArgument] = process.argv.slice(2);
if (!inputArgument || !outputArgument || !["cluener", "docred"].includes(format)) {
  process.stderr.write(
    "usage: prepare-public-document-import-benchmark.mjs cluener|docred <input> <output> [limit]\n",
  );
  process.exit(1);
}

try {
  const inputPath = path.resolve(inputArgument);
  const outputPath = path.resolve(outputArgument);
  const source = await readFile(inputPath, "utf8");
  const limit = parseLimit(limitArgument);
  const cases = format === "cluener" ? convertCluener(source, limit) : convertDocred(source, limit);
  const output = {
    schemaVersion: 1,
    datasetId: `${format}-derived-${cases.length}`,
    source: format === "cluener"
      ? "https://github.com/CLUEbenchmark/CLUENER2020"
      : "https://github.com/thunlp/DocRED",
    generatedAt: new Date().toISOString(),
    cases,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`Prepared ${cases.length} ${format} cases at ${outputPath}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
