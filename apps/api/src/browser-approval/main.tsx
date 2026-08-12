import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { DeviceEnrollmentApproval } from "./DeviceEnrollmentApproval.js";
import { HighRiskActionApproval } from "./HighRiskActionApproval.js";
import "./styles.css";

const decodePathValue = (pattern: RegExp): string | null => {
  const value = window.location.pathname.match(pattern)?.[1];
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const selector = decodePathValue(
  /\/high-risk\/browser-activations\/([^/]+)\/?$/
);
const challengeId = decodePathValue(/\/device-enrollment\/([^/]+)\/?$/);
document.title = selector
  ? "Confirm sensitive action — Koed"
  : "Approve device enrollment — Koed";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {selector ? (
      <HighRiskActionApproval selector={selector} />
    ) : (
      <DeviceEnrollmentApproval challengeId={challengeId} />
    )}
  </StrictMode>
);
