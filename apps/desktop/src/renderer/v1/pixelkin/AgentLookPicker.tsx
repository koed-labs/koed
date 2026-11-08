import type { CSSProperties } from "react";
import { Button, Card, CardTitle, buttonVariants } from "@koed/ui";
import {
  Box,
  Check,
  Circle,
  Palette,
  Pipette,
  RectangleVertical,
  Smile,
  SquareRoundCorner
} from "lucide-react";
import { ProjectChoice } from "../project-management/controls.js";
import { withAgentShape, type AgentLook } from "./agent-kin.js";
import {
  KIN_COLOURS,
  KIN_SHAPES,
  PixelkinPersonalities,
  clone,
  editKin,
  limitKinSaturation,
  type KinShape
} from "./vendor/index.js";

const shapes = {
  sphere: { label: "Sphere", Icon: Circle },
  cube: { label: "Cube", Icon: Box },
  roundedBox: { label: "Rounded cube", Icon: SquareRoundCorner },
  capsule: { label: "Capsule", Icon: RectangleVertical }
} satisfies Record<KinShape, { label: string; Icon: typeof Box }>;

const personalities = Object.entries(PixelkinPersonalities.profiles).map(
  ([value, profile]) => ({ value, label: profile.label })
);

export function AgentLookPicker({
  look,
  onChange,
  disabled = false
}: {
  look: AgentLook;
  onChange: (look: AgentLook) => void;
  disabled?: boolean;
}) {
  const colour = look.palette.base;
  const preset = KIN_COLOURS.find((entry) => entry.hex === colour);
  const changeColour = (value: string) =>
    onChange(editKin(clone(look), "palette.base", value));

  return (
    <div className="v1-look-picker">
      <Card className="v1-kin-control">
        <Box aria-hidden />
        <div>
          <CardTitle>Body shape</CardTitle>
          <div className="v1-kin-shapes" role="group" aria-label="Body shape">
            {KIN_SHAPES.map((shape) => {
              const { label, Icon } = shapes[shape];
              return (
                <Button
                  key={shape}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  aria-pressed={look.body.shape === shape}
                  onClick={() => onChange(withAgentShape(clone(look), shape))}
                >
                  <Icon aria-hidden />
                  {label}
                </Button>
              );
            })}
          </div>
        </div>
      </Card>
      <Card className="v1-kin-control">
        <Palette aria-hidden />
        <div>
          <CardTitle>
            Colour <span>{preset?.name ?? colour.toUpperCase()}</span>
          </CardTitle>
          <div className="v1-kin-colours" role="group" aria-label="Body colour">
            {KIN_COLOURS.map(({ name, hex }) => (
              <Button
                key={hex}
                type="button"
                variant="ghost"
                size="icon-xs"
                className="v1-kin-swatch"
                style={{ "--swatch": hex } as CSSProperties}
                title={name}
                aria-label={name}
                aria-pressed={colour === hex}
                disabled={disabled}
                onClick={() => changeColour(hex)}
              >
                {colour === hex && <Check aria-hidden />}
              </Button>
            ))}
            <label
              className={`${buttonVariants({ variant: "outline", size: "icon-xs" })} v1-kin-custom`}
              data-selected={!preset || undefined}
              title="Choose a custom colour"
            >
              <Pipette aria-hidden />
              <input
                type="color"
                aria-label="Custom colour"
                value={colour}
                disabled={disabled}
                onChange={(event) =>
                  changeColour(limitKinSaturation(event.target.value))
                }
              />
            </label>
          </div>
        </div>
      </Card>
      <Card className="v1-kin-control">
        <Smile aria-hidden />
        <div>
          <CardTitle>Personality</CardTitle>
          <ProjectChoice
            label="Personality"
            value={look.face.personality}
            options={personalities}
            disabled={disabled}
            onChange={(value) =>
              onChange(editKin(clone(look), "face.personality", value))
            }
          />
        </div>
      </Card>
    </div>
  );
}
