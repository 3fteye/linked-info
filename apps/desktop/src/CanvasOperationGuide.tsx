import { Keyboard, MousePointer2, RotateCcw, Search } from "lucide-react";
import { useState } from "react";
import type { CanvasOperationItem, CanvasOperationId } from "./canvasOperations";

interface CanvasOperationGuideProps {
  items: readonly CanvasOperationItem[];
  pickerLabel: string;
  replayLabel: string;
}

export default function CanvasOperationGuide({
  items,
  pickerLabel,
  replayLabel,
}: CanvasOperationGuideProps) {
  const [selectedId, setSelectedId] = useState<CanvasOperationId>(
    items[0]?.id ?? "pan",
  );
  const [replayIteration, setReplayIteration] = useState(0);
  const selectedItem =
    items.find((item) => item.id === selectedId) ?? items[0] ?? null;

  if (selectedItem === null) {
    return null;
  }

  return (
    <div className="canvas-operation-guide" data-testid="canvas-operation-guide">
      <div
        aria-label={pickerLabel}
        className="canvas-operation-picker"
        role="group"
      >
        {items.map((item) => (
          <button
            aria-pressed={item.id === selectedItem.id}
            className="canvas-operation-picker-item"
            data-operation={item.id}
            data-selected={item.id === selectedItem.id}
            key={item.id}
            onClick={() => {
              setSelectedId(item.id);
              setReplayIteration((current) => current + 1);
            }}
            type="button"
          >
            <span>{item.action}</span>
            <kbd>{item.keys}</kbd>
          </button>
        ))}
      </div>

      <section className="canvas-operation-preview">
        <header>
          <div>
            <strong>{selectedItem.action}</strong>
            <kbd>{selectedItem.keys}</kbd>
          </div>
          <button
            aria-label={replayLabel}
            className="canvas-operation-replay"
            data-testid="canvas-operation-replay"
            onClick={() => setReplayIteration((current) => current + 1)}
            title={replayLabel}
            type="button"
          >
            <RotateCcw aria-hidden="true" size={15} />
            <span>{replayLabel}</span>
          </button>
        </header>
        <div
          aria-label={`${selectedItem.action} · ${selectedItem.keys}`}
          className="canvas-operation-stage"
          data-demo={selectedItem.id}
          data-replay-iteration={replayIteration}
          data-testid="canvas-operation-stage"
          key={`${selectedItem.id}-${replayIteration}`}
          role="img"
        >
          <div aria-hidden="true" className="canvas-operation-scene">
            <div className="canvas-operation-search">
              <Search size={12} />
              <i />
            </div>
            <div className="canvas-operation-node canvas-operation-node-a">
              <b />
              <span />
              <div className="canvas-operation-editor">
                <i />
              </div>
            </div>
            <div className="canvas-operation-node canvas-operation-node-b">
              <b />
              <span />
            </div>
            <div className="canvas-operation-node canvas-operation-node-c">
              <b />
              <span />
            </div>
            <div className="canvas-operation-marquee" />
            <div className="canvas-operation-context-menu">
              <i />
              <i />
              <i />
            </div>
            <div className="canvas-operation-help">
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <div aria-hidden="true" className="canvas-operation-key-state">
            <Keyboard size={13} />
            <span>{selectedItem.keys}</span>
          </div>
          <MousePointer2
            aria-hidden="true"
            className="canvas-operation-cursor"
            fill="currentColor"
            size={22}
          />
        </div>
      </section>
    </div>
  );
}
