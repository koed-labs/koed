import { useState } from "react";
import { Button } from "@koed-labs/ui";
import { Check, X } from "lucide-react";
import { AgentLookPicker } from "../pixelkin/AgentLookPicker.js";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import {
  PROJECT_KIN_ACCESSORIES,
  withProjectKinAccessories,
  type AgentLook
} from "../pixelkin/agent-kin.js";
import "./project-kin-editor.css";

const categories = [
  {
    id: "headwear",
    label: "Headwear",
    items: PROJECT_KIN_ACCESSORIES.filter(
      (item) => !item.theme && item.occupies.includes("head")
    )
  },
  {
    id: "eyewear",
    label: "Eyewear",
    items: PROJECT_KIN_ACCESSORIES.filter(
      (item) => !item.theme && item.occupies.includes("eyes")
    )
  },
  {
    id: "seasonal",
    label: "Seasonal",
    items: PROJECT_KIN_ACCESSORIES.filter((item) => item.theme)
  }
].filter(({ items }) => items.length > 0);

const pages = [
  { id: "appearance", label: "Appearance" },
  { id: "accessories", label: "Accessories" }
] as const;
type Page = (typeof pages)[number]["id"];

export function ProjectKinEditor({
  look,
  disabled,
  onChange
}: {
  look: AgentLook;
  disabled: boolean;
  onChange: (look: AgentLook) => void;
}) {
  const [page, setPage] = useState<Page>("accessories");
  const [category, setCategory] = useState(categories[0]?.id);
  const items = categories.find(({ id }) => id === category)?.items ?? [];
  const equipped = PROJECT_KIN_ACCESSORIES.filter(({ id }) =>
    look.face.items.includes(id)
  );
  const toggle = (id: string) => {
    const current = look.face.items;
    onChange(
      withProjectKinAccessories(
        look,
        current.includes(id)
          ? current.filter((item) => item !== id)
          : [...current, id]
      )
    );
  };

  return (
    <fieldset
      disabled={disabled}
      className="v1-pm-kin-builder v1-pm-kin-editor"
      aria-label="Project Kin"
    >
      <div className="v1-pm-kin-stage">
        <div className="v1-pm-kin-preview" role="img" aria-label="Kin preview">
          <div className="v1-kin-spot" aria-hidden="true" />
          <Pixelkin look={look} size={142} presentation="stage" hopOnChange />
        </div>
        <div className="v1-pm-kin-equipped">
          <strong>Equipped</strong>
          {equipped.length > 0 ? (
            <ul aria-label="Equipped accessories">
              {equipped.map(({ id, label }) => (
                <li key={id}>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Remove ${label}`}
                    onClick={() => toggle(id)}
                  >
                    {label} <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p>No accessories equipped.</p>
          )}
          {page === "accessories" && <p>Accessories stay on this device.</p>}
        </div>
      </div>
      <div className="v1-pm-kin-controls">
        <div
          className="v1-pm-kin-tabs"
          role="group"
          aria-label="Kin customization"
        >
          {pages.map(({ id, label }) => (
            <Button
              key={id}
              size="sm"
              variant="ghost"
              aria-pressed={page === id}
              onClick={() => setPage(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        {page === "appearance" ? (
          <AgentLookPicker
            look={look}
            disabled={disabled}
            onChange={onChange}
          />
        ) : items.length > 0 ? (
          <>
            <div
              className="v1-pm-kin-filters"
              role="group"
              aria-label="Accessory category"
            >
              {categories.map(({ id, label }) => (
                <Button
                  key={id}
                  size="sm"
                  variant="outline"
                  aria-pressed={category === id}
                  onClick={() => setCategory(id)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div
              key={category}
              className="v1-pm-kin-catalogue"
              role="group"
              aria-label="Accessories catalogue"
              tabIndex={0}
            >
              {items.map(({ id, label }) => {
                const selected = look.face.items.includes(id);
                return (
                  <Button
                    key={id}
                    variant="outline"
                    className="v1-pm-kin-tile"
                    aria-label={label}
                    aria-pressed={selected}
                    onClick={() => toggle(id)}
                  >
                    <span className="v1-pm-kin-thumbnail">
                      <Pixelkin
                        look={withProjectKinAccessories(look, [id])}
                        size={80}
                        presentation="stage"
                        motion="still"
                      />
                      {selected && <Check aria-hidden />}
                    </span>
                    <span className="v1-pm-kin-tile-label">{label}</span>
                  </Button>
                );
              })}
            </div>
          </>
        ) : (
          <p>No accessories available.</p>
        )}
      </div>
    </fieldset>
  );
}
