// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DocumentImportDialog, { type DocumentImportDialogLabels } from "./DocumentImportDialog";
import type { DocumentImportDraft } from "./documentImport";

const labels: DocumentImportDialogLabels = {
  title: "导入文档",
  description: "说明",
  sourceName: "来源名称",
  sourceNamePlaceholder: "来源",
  sourceText: "原始文本",
  sourceTextPlaceholder: "文本",
  chooseFile: "选择文档",
  chooseExternalDraft: "载入外部草稿",
  loadingExternalDraft: "正在载入外部草稿…",
  analyze: "分析",
  analyzing: "分析中",
  cancel: "取消",
  close: "关闭",
  draftTitle: "导入草稿",
  draftDescription: "检查草稿",
  draftLoaded: (source, count, selected) =>
    `已载入 ${source}：${count} 个候选，已选择 ${selected} 个；尚未写入工作区。`,
  preview: "预览",
  selectedCount: (count) => `已选 ${count} 项`,
  existingMatch: "已有",
  newNode: "新增",
  existingReadOnly: "只读",
  content: "内容",
  references: "引用",
  referencesPlaceholder: "引用名称",
  noCandidates: "没有候选",
};

const draft: DocumentImportDraft = {
  sourceNodeId: "11111111-1111-4111-8111-111111111111",
  sourceName: "accounts.txt",
  sourceText: "source",
  sourceHash: "hash",
  importedAtMs: 1,
  modelId: "external",
  candidates: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "账号记录",
      content: null,
      referenceNames: [],
      matchedNodeId: null,
      selected: true,
    },
  ],
};

const noOp = vi.fn();

describe("DocumentImportDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(currentDraft: DocumentImportDraft | null, loadingExternalDraft = false) {
    act(() => {
      root.render(
        <DocumentImportDialog
          busy={false}
          draft={currentDraft}
          error={null}
          labels={labels}
          loadingExternalDraft={loadingExternalDraft}
          onAnalyze={noOp}
          onCancel={noOp}
          onChooseExternalDraft={noOp}
          onChooseFile={noOp}
          onPreview={noOp}
          onSourceNameChange={noOp}
          onSourceTextChange={noOp}
          onUpdateCandidate={noOp}
          progress={null}
          sourceName=""
          sourceText=""
        />,
      );
    });
  }

  it("makes a successfully loaded external draft and the next step explicit", () => {
    render(draft);

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("已载入 accounts.txt");
    expect(status?.textContent).toContain("1 个候选");
    expect(status?.textContent).toContain("尚未写入工作区");
    expect(container.textContent).toContain("预览");
  });

  it("shows progress and prevents competing actions while loading a draft", () => {
    render(null, true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const loadingButton = buttons.find((button) =>
      button.textContent?.includes("正在载入外部草稿"),
    );
    expect(loadingButton).toBeDefined();
    expect(loadingButton?.disabled).toBe(true);
    expect(buttons.find((button) => button.textContent?.includes("选择文档"))?.disabled).toBe(true);
  });
});
