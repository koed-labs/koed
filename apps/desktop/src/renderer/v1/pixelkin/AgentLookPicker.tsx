import { useId, useState } from "react";
import {
  SHOW_LOOK_EXTRAS,
  withAgentShape,
  type AgentLook
} from "./agent-kin.js";
import {
  KIN_COLOURS,
  KIN_SHAPES,
  PixelkinAccessories,
  PixelkinPersonalities,
  clone,
  editKin,
  limitKinSaturation,
  type KinShape
} from "./vendor/index.js";

// Choices from Create your Kin. Every change goes through the engine's editKin,
// so accessories replace each other the same way they do in the generator.
const shapeNames: Record<KinShape, string> = {
  sphere: "Sphere",
  cube: "Cube",
  roundedBox: "Rounded cube",
  capsule: "Capsule"
};
const features = [
  {
    label: "Arms",
    path: "body.arms",
    on: (look: AgentLook) => look.body.arms,
    value: (on: boolean) => !on
  },
  {
    label: "Shininess",
    path: "body.shininess",
    on: (look: AgentLook) => look.body.shininess > 0,
    value: (on: boolean) => (on ? 0 : 0.25)
  },
  {
    label: "Glitter",
    path: "body.glitter",
    on: (look: AgentLook) => look.body.glitter > 0,
    value: (on: boolean) => (on ? 0 : 0.5)
  },
  {
    label: "Horizontal stripes",
    path: "body.stripes",
    on: (look: AgentLook) => look.body.stripes,
    value: (on: boolean) => !on
  },
  {
    label: "Gradient",
    path: "palette.gradient",
    on: (look: AgentLook) => look.palette.gradient,
    value: (on: boolean) => !on
  }
] as const;
const accessories = [
  { label: "Hats", path: "face.hat", items: PixelkinAccessories.hats },
  {
    label: "Glasses",
    path: "face.glasses",
    items: PixelkinAccessories.glasses
  },
  {
    label: "Halloween",
    path: "face.halloween",
    items: PixelkinAccessories.halloween
  },
  {
    label: "Christmas",
    path: "face.christmas",
    items: PixelkinAccessories.christmas
  }
] as const;
const accessoryValue = (
  look: AgentLook,
  path: (typeof accessories)[number]["path"]
) =>
  look.face[
    path.slice("face.".length) as "hat" | "glasses" | "halloween" | "christmas"
  ];

export function AgentLookPicker({
  look,
  onChange
}: {
  look: AgentLook;
  onChange: (look: AgentLook) => void;
}) {
  const edit = (...changes: [string, unknown][]) => {
    const next = clone(look);
    for (const [path, value] of changes) editKin(next, path, value);
    onChange(next);
  };
  const chosen = accessories.find(({ path, items }) =>
    items.some((item) => item.id === accessoryValue(look, path))
  );
  const [category, setCategory] = useState<(typeof accessories)[number]>(
    chosen ?? accessories[0]
  );
  const clearAccessories = accessories.map(
    ({ path }) => [path, "none"] as [string, unknown]
  );
  const featureCount = features.filter((feature) => feature.on(look)).length;
  const swatch = KIN_COLOURS.some((colour) => colour.hex === look.palette.base);
  const id = useId();
  return (
    <div className="v1-look-picker">
      <div className="v1-field">
        <span>Body shape</span>
        <div className="v1-kin-segment" role="group" aria-label="Body shape">
          {KIN_SHAPES.map((shape) => (
            <button
              type="button"
              key={shape}
              aria-pressed={look.body.shape === shape}
              onClick={() => onChange(withAgentShape(clone(look), shape))}
            >
              {shapeNames[shape]}
            </button>
          ))}
        </div>
      </div>
      <div className="v1-field">
        <span id={`${id}-personality`}>Personality</span>
        <select
          aria-labelledby={`${id}-personality`}
          value={look.face.personality}
          onChange={(event) => edit(["face.personality", event.target.value])}
        >
          {Object.entries(PixelkinPersonalities.profiles).map(
            ([id, profile]) => (
              <option key={id} value={id}>
                {profile.label}
              </option>
            )
          )}
        </select>
      </div>
      <div className="v1-field">
        <span>Colour</span>
        <div
          className="v1-options v1-swatches"
          role="group"
          aria-label="Body colour"
        >
          {KIN_COLOURS.map((colour) => (
            <button
              type="button"
              key={colour.hex}
              className="v1-swatch"
              style={{ background: colour.hex }}
              aria-label={colour.name}
              title={colour.name}
              aria-pressed={look.palette.base === colour.hex}
              onClick={() => edit(["palette.base", colour.hex])}
            />
          ))}
          <span
            className="v1-swatch v1-swatch-custom"
            title="Choose a custom colour"
            data-active={!swatch || undefined}
            style={swatch ? undefined : { background: look.palette.base }}
          >
            <input
              type="color"
              aria-label="Custom colour"
              value={look.palette.base}
              onChange={(event) =>
                edit(["palette.base", limitKinSaturation(event.target.value)])
              }
            />
            <span aria-hidden="true">+</span>
          </span>
        </div>
      </div>
      {SHOW_LOOK_EXTRAS && (
        <>
          <details className="v1-kin-disclosure">
            <summary>
              Special features
              <span>{featureCount || ""}</span>
            </summary>
            <div
              className="v1-options"
              role="group"
              aria-label="Special features"
            >
              {features.map((feature) => (
                <button
                  type="button"
                  key={feature.path}
                  className="v1-kin-chip"
                  aria-pressed={feature.on(look)}
                  onClick={() =>
                    edit([feature.path, feature.value(feature.on(look))])
                  }
                >
                  {feature.label}
                </button>
              ))}
            </div>
          </details>
          <details className="v1-kin-disclosure">
            <summary>
              Accessories
              <span>
                {chosen?.items.find(
                  (item) => item.id === accessoryValue(look, chosen.path)
                )?.label ?? "None"}
              </span>
            </summary>
            <div
              className="v1-options"
              role="group"
              aria-label="Accessory category"
            >
              {accessories.map((entry) => (
                <button
                  type="button"
                  key={entry.path}
                  className="v1-kin-tab"
                  aria-pressed={category === entry}
                  onClick={() => setCategory(entry)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div
              className="v1-options"
              role="group"
              aria-label={category.label}
            >
              <button
                type="button"
                className="v1-kin-chip"
                aria-pressed={!chosen}
                onClick={() => edit(...clearAccessories)}
              >
                None
              </button>
              {category.items.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className="v1-kin-chip"
                  aria-pressed={accessoryValue(look, category.path) === item.id}
                  onClick={() =>
                    edit(...clearAccessories, [category.path, item.id])
                  }
                >
                  {item.label}
                </button>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
