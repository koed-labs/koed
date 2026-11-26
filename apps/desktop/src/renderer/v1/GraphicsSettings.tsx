import { useRef, useState } from "react";
import { Card, Slider, Switch } from "@koed-labs/ui";
import {
  defaultPresentationPreferences,
  kinResolutions,
  type KinResolution
} from "../../ipc/presentation-preferences-protocol.js";
import { Pixelkin } from "./pixelkin/Pixelkin.js";
import { projectKinLook } from "./pixelkin/agent-kin.js";
import { kinStageSize } from "./pixelkin/presentation.js";
import { Group, PageHeading, Row } from "./settings-controls.js";
import type { PresentationSettingsState } from "./use-presentation-preferences.js";
import "./graphics-settings.css";

const labels: Record<KinResolution, string> = {
  classic: "Classic",
  balanced: "Balanced",
  max: "Max"
};
const previewSize = 142;
const previewLook = projectKinLook("graphics-preview", {
  shape: "roundedBox",
  colour: "#55cca3",
  personality: "neutral"
});

export function GraphicsSettings({
  onBack,
  presentation
}: {
  onBack: () => void;
  presentation: PresentationSettingsState;
}) {
  const [preview, setPreview] = useState<KinResolution | null>(null);
  const previewRevision = useRef(0);
  const { available, saved, busy, error, update } = presentation;
  const selected =
    saved?.kinResolution ?? defaultPresentationPreferences.kinResolution;
  const resolution = preview ?? selected;
  const { width: pixels } = kinStageSize(previewSize, previewSize, resolution);

  async function saveResolution(index: number) {
    const next = kinResolutions[index];
    if (!next) return;
    const revision = previewRevision.current;
    if (next !== selected || busy) await update({ kinResolution: next });
    if (revision === previewRevision.current) setPreview(null);
  }

  return (
    <>
      <PageHeading page="graphics" onBack={onBack} />
      <Card className="graphics-resolution-card">
        <div className="graphics-resolution-setting">
          <div className="performance-slider-row">
            <div>
              <strong>Kin resolution</strong>
              <p>Choose how pixelated Kin look.</p>
            </div>
            <div className="performance-slider-control">
              <Slider
                label="Kin resolution"
                valueText={`${labels[resolution]}, ${pixels} by ${pixels} pixels`}
                min={0}
                max={kinResolutions.length - 1}
                step={1}
                value={kinResolutions.indexOf(resolution)}
                disabled={!saved}
                onValueChange={(index) => {
                  previewRevision.current += 1;
                  setPreview(kinResolutions[index] ?? null);
                }}
                onValueCommitted={(index) => void saveResolution(index)}
              />
              <div className="performance-slider-keys" aria-hidden="true">
                {kinResolutions.map((preset) => (
                  <span
                    key={preset}
                    className={preset === resolution ? "selected" : undefined}
                  >
                    {labels[preset]}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div
          className="graphics-kin-preview"
          role="img"
          aria-label="Kin preview"
        >
          <div className="v1-kin-spot" aria-hidden="true" />
          <Pixelkin
            look={previewLook}
            size={previewSize}
            presentation="stage"
            resolution={resolution}
            expression="happy"
            motion="still"
          />
        </div>
      </Card>
      <Group title="Rendering">
        <Row
          title="Graphics acceleration"
          description="Takes effect after restarting Koed."
        >
          <Switch
            aria-label="Graphics acceleration"
            checked={saved?.graphicsAcceleration ?? false}
            disabled={!saved || busy}
            onCheckedChange={(graphicsAcceleration) =>
              void update({ graphicsAcceleration })
            }
          />
        </Row>
      </Group>
      {error && <p role="alert">{error}</p>}
      {!available && <p role="status">Graphics settings are unavailable.</p>}
    </>
  );
}
