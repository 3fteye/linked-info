import assert from "node:assert/strict";
import test from "node:test";

import {
  createPredictionTemplate,
  scoreBenchmark,
  validateBenchmark,
} from "./document-import-benchmark.mjs";

const benchmark = {
  schemaVersion: 1,
  datasetId: "test",
  license: "Apache-2.0",
  cases: [{
    id: "case-1",
    sourceName: "test.txt",
    text: "账号 A 使用服务 B。",
    tags: ["test"],
    expectedNodes: [
      { name: "账号 A", requiredFacts: ["正常"], referenceNames: ["服务 B"] },
      { name: "服务 B", requiredFacts: [], referenceNames: [] },
    ],
    forbiddenNodeNames: ["标题"],
  }],
};

test("validates the benchmark and produces an empty prediction template", () => {
  const validated = validateBenchmark(benchmark);
  assert.equal(validated.cases.length, 1);
  assert.deepEqual(createPredictionTemplate(validated).cases, [{ id: "case-1", nodes: [] }]);
});

test("scores node, reference and fact quality independently", () => {
  const report = scoreBenchmark(benchmark, {
    schemaVersion: 1,
    datasetId: "test",
    modelId: "test-model",
    cases: [{
      id: "case-1",
      nodes: [
        { name: "账号 A", content: "当前正常", referenceNames: ["服务 B"] },
        { name: "服务 B", content: null, referenceNames: [] },
        { name: "标题", content: null, referenceNames: [] },
        { name: "标题", content: null, referenceNames: [] },
      ],
    }],
  });
  assert.deepEqual(report.metrics, {
    nodePrecision: 0.6667,
    nodeRecall: 1,
    nodeF1: 0.8,
    referencePrecision: 1,
    referenceRecall: 1,
    referenceF1: 1,
    factRecall: 1,
    duplicateNames: 1,
    forbiddenNameHits: 1,
  });
});

test("rejects predictions for a different dataset", () => {
  assert.throws(
    () => scoreBenchmark(benchmark, {
      schemaVersion: 1,
      datasetId: "other",
      modelId: "test-model",
      cases: [],
    }),
    /does not match/,
  );
});

test("does not report perfect precision for an empty prediction with expected nodes", () => {
  const report = scoreBenchmark(benchmark, {
    schemaVersion: 1,
    datasetId: "test",
    modelId: "test-model",
    cases: [{ id: "case-1", nodes: [] }],
  });
  assert.equal(report.metrics.nodePrecision, 0);
  assert.equal(report.metrics.nodeRecall, 0);
  assert.equal(report.metrics.referencePrecision, 0);
  assert.equal(report.metrics.referenceRecall, 0);
});
