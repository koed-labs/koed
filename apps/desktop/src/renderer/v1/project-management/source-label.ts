import type { DesktopProject } from "../../../project-memory-ui.js";
import {
  factLabel,
  type SourceContextFact
} from "../../views/personal/SourceContextCompare.js";

export function sourceLabel(
  fact: SourceContextFact,
  projects: readonly DesktopProject[]
) {
  if (fact.state !== "known" || !("reference" in fact.value))
    return factLabel(fact);
  const folder = fact.value;
  const device = projects
    .flatMap((p) => p.threads)
    .find((t) => t.originDevice?.id === folder.reference.originatingDeviceId)
    ?.originDevice?.name;
  return device
    ? `${folder.normalizedPath} · ${device}`
    : folder.normalizedPath;
}
