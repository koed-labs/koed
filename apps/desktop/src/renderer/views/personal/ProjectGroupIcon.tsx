import {
  CircleHelp,
  Folder,
  GitFork,
  Layers,
  MessagesSquare
} from "lucide-react";
import type { ProjectRowPresentation } from "../../../project-row-presentation.js";

const icons = {
  project: Layers,
  git: GitFork,
  folder: Folder,
  independent: MessagesSquare,
  unresolved: CircleHelp
};

export function ProjectGroupIcon({
  kind
}: {
  kind: ProjectRowPresentation["kind"];
}) {
  const Icon = icons[kind];
  return <Icon aria-hidden="true" />;
}
