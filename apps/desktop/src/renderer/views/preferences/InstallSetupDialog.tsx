import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@koed-labs/ui";
import {
  InstallSetupContent,
  type InstallSetupContentProps
} from "./InstallSetupContent.js";
export { installationSteps } from "./InstallSetupContent.js";
export type {
  InstallStage,
  InstallState,
  InstallTool
} from "./InstallSetupContent.js";
export function InstallSetupDialog({
  open,
  onOpenChange,
  ...props
}: InstallSetupContentProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const privacy = props.tool === "privacy";
  const busy = !props.retryStatus && props.job.stage === "progress";
  const ready = !props.retryStatus && props.job.stage === "ready";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="koed-setup-dialog">
        <DialogHeader>
          <DialogTitle>
            {privacy ? "Privacy Filter" : "Command line"}
          </DialogTitle>
          <DialogDescription>
            {privacy
              ? `Helps remove personally identifiable information (PII) before memory is shared with your Team.${!busy && !ready ? " Installation downloads both the Privacy runtime and model. The total download size is not yet known." : ""}`
              : "Use the koed command from any terminal."}
          </DialogDescription>
        </DialogHeader>
        <InstallSetupContent {...props} />
      </DialogPopup>
    </Dialog>
  );
}
