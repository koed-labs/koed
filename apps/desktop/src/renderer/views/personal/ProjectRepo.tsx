import { Github, GitFork } from "lucide-react";
import { repositoryPresentationFromRemoteDisplay } from "../../../project-memory-ui.js";

export function ProjectRepo({
  onOpenRepository,
  remoteDisplay
}: {
  onOpenRepository?: (url: string) => void;
  remoteDisplay: string;
}) {
  const repository = repositoryPresentationFromRemoteDisplay(remoteDisplay);
  const RepositoryIcon = repository.provider === "github" ? Github : GitFork;
  const actionLabel =
    repository.provider === "github"
      ? `Open ${repository.label} on GitHub`
      : `Open repository ${repository.label}`;
  if (!onOpenRepository) {
    return (
      <span
        aria-label={`Repository ${repository.label}`}
        className="personal-project-repo personal-project-repo-static"
        data-repository-provider={repository.provider}
      >
        <RepositoryIcon aria-hidden="true" />
        <span>{repository.label}</span>
      </span>
    );
  }
  return (
    <button
      aria-label={actionLabel}
      className="personal-project-repo"
      data-repository-provider={repository.provider}
      onClick={() => onOpenRepository(repository.url)}
      title={actionLabel}
      type="button"
    >
      <RepositoryIcon aria-hidden="true" />
      <span>{repository.label}</span>
    </button>
  );
}
