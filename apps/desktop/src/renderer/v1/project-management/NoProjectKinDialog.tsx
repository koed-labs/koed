import { useState } from "react";
import type { PersonalProjectKin } from "@koed-labs/shared";
import { Button, DialogFooter } from "@koed-labs/ui";
import { AgentLookPicker } from "../pixelkin/AgentLookPicker.js";
import { Pixelkin } from "../pixelkin/Pixelkin.js";
import { projectKinLook, projectKinSettings } from "../pixelkin/agent-kin.js";
import { NO_PROJECT_ID } from "../project-sidebar-model.js";
import { ProjectError, ProjectPopup } from "./controls.js";

/** Settings for No project: only its Kin, which stays on this device. */
export function NoProjectKinDialog({
  kin,
  onSave,
  onClose
}: {
  kin?: PersonalProjectKin;
  onSave: (kin: PersonalProjectKin) => boolean;
  onClose: () => void;
}) {
  const [look, setLook] = useState(() => projectKinLook(NO_PROJECT_ID, kin));
  const [error, setError] = useState<string | null>(null);
  return (
    <ProjectPopup
      title="No project Kin"
      description="Conversations without a Project share this Kin. It's saved on this device."
      onClose={onClose}
    >
      <div className="v1-pm-form-stack">
        <fieldset className="v1-pm-kin-builder" aria-label="No project Kin">
          <div
            className="v1-pm-kin-preview"
            role="img"
            aria-label="Kin preview"
          >
            <div className="v1-kin-spot" aria-hidden="true" />
            <Pixelkin look={look} size={142} hopOnChange />
          </div>
          <AgentLookPicker look={look} onChange={setLook} />
        </fieldset>
      </div>
      <ProjectError error={error} />
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            if (onSave(projectKinSettings(look))) onClose();
            else setError("The Kin could not be saved. Please try again.");
          }}
        >
          Save
        </Button>
      </DialogFooter>
    </ProjectPopup>
  );
}
