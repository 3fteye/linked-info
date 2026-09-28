import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FeatureOperationId } from "./canvasOperations";

// 纯教学场景：只接收操作 ID，不接收工作区、节点、密钥或写入回调。
export default function FeatureOperationDemo({ id, replayIteration }: { id: FeatureOperationId; replayIteration: number }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setReduced(media.matches);
    change();
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!playing || reduced) return;
    const timer = window.setInterval(() => setStep((current) => (current + 1) % 4), 4000);
    return () => window.clearInterval(timer);
  }, [playing, reduced]);
  const frame = `featureDemos.${id}.${step}`;
  const connected = id === "incoming" || (id === "references" && step === 2) ||
    (id === "smartQueue" && step === 3) || (id === "templates" && step === 3);
  const distant = (id === "browse" && (step === 1 || step === 3)) || (id === "bookmarks" && step === 1);
  return <div className="feature-operation-demo" data-testid="canvas-operation-stage" data-demo={id}
    data-step={step} data-replay-iteration={replayIteration} data-playing={playing && !reduced}>
    <p className="feature-demo-disclaimer">{t("featureDemoControls.synthetic")}</p>
    <div className="feature-demo-viewport" role="img" aria-label={t(`${frame}.scene`)}>
      <div className="feature-demo-map" data-distant={distant}>
        <svg className="feature-demo-links" viewBox="0 0 600 180" preserveAspectRatio="none" aria-hidden="true">
          <defs><marker id="feature-demo-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
          <path className="feature-demo-edge" markerEnd="url(#feature-demo-arrow)" data-connected={connected && id !== "templates"} d="M 160 80 C 210 80 180 65 220 65" />
          <path className="feature-demo-edge" markerEnd="url(#feature-demo-arrow)" data-connected={connected && id !== "references"} d="M 440 110 C 395 110 425 80 380 80" />
        </svg>
        {[0, 1, 2].map((index) => <div key={index} className="feature-demo-card"
          data-card={index} data-active={index === (id === "filterContext" ? 1 : id === "templates" && step === 3 ? 2 : step % 3)}
          data-dimmed={id === "filterContext" && step > 0 && index !== 1}
          data-created={id !== "templates" || index !== 2 || step === 3}>
          <strong>{t(`featureDemoControls.node${index}`)}</strong>
          <span>{id === "markers" && index === 0 ? (step < 2 ? t("featureDemoControls.selectedText") : "••••••") : t(`featureDemoControls.card${index}`)}</span>
          {id === "markers" && index === 0 && step === 3 && <kbd>{t("featureDemoControls.code")}</kbd>}
        </div>)}
        {(id === "browse" || id === "bookmarks") && <span className="feature-demo-pin">{t("featureDemoControls.destination")}</span>}
      </div>
      {id === "smartQueue" && <div className="feature-demo-queue" aria-hidden="true">
        {[0, 1, 2].map((index) => <i key={index} data-done={index < step} />)}
      </div>}
      <div className="feature-demo-scene-label">{t(`${frame}.scene`)}</div>
    </div>
    <div className="feature-demo-explanation" aria-live={playing && !reduced ? "off" : "polite"}>
      <strong>{t("featureDemoControls.step", { current: step + 1, total: 4 })} · {t(`${frame}.title`)}</strong>
      <p>{t(`${frame}.body`)}</p>
    </div>
    <div className="feature-demo-controls">
      <button type="button" data-testid="demo-previous" disabled={step === 0} onClick={() => { setPlaying(false); setStep((current) => current - 1); }}>{t("featureDemoControls.previous")}</button>
      <button type="button" data-testid="demo-play" disabled={reduced} onClick={() => setPlaying((current) => !current)}>{t(playing && !reduced ? "featureDemoControls.pause" : "featureDemoControls.play")}</button>
      <button type="button" data-testid="demo-next" disabled={step === 3} onClick={() => { setPlaying(false); setStep((current) => current + 1); }}>{t("featureDemoControls.next")}</button>
    </div>
    {reduced && <small>{t("featureDemoControls.reduced")}</small>}
  </div>;
}
