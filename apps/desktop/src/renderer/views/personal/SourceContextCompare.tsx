import type { PersonalDesktopApi } from "@koed/shared/personal-desktop";

type Result = Awaited<
  ReturnType<NonNullable<PersonalDesktopApi["manageSourceContext"]>>
>;
export type SourceContext = Result["context"];
export type SourceContextFact =
  | SourceContext["git"]["original"]
  | SourceContext["folder"]["original"];
export const factLabel = (fact: SourceContextFact) =>
  fact.state === "unresolved"
    ? fact.reason === "historical_unresolved"
      ? "Unresolved history"
      : fact.reason === "source_context_conflict"
        ? "Unresolved because corrections conflict"
        : fact.reason === "source_context_pending"
          ? "Waiting for synchronized context"
          : "Unresolved"
    : "reference" in fact.value
      ? `${fact.value.normalizedPath} (device ${fact.value.reference.originatingDeviceId}, profile ${fact.value.reference.originatingProfileId})`
      : (fact.value.anchorDisplay ?? fact.value.key);
export const effective = <T,>(assignment: {
  original: T;
  correction: { state: "original" } | { state: "corrected"; value: T };
}) =>
  assignment.correction.state === "corrected"
    ? assignment.correction.value
    : assignment.original;

export function SourceContextStatus({ context }: { context: SourceContext }) {
  if (!context.sync) return null;
  return (
    <section
      className="personal-source-sync-status"
      aria-label="Synchronized source context"
    >
      {context.sync.availability === "pending" ? (
        <p>The source is waiting for synchronized content.</p>
      ) : null}
      {(["git", "folder"] as const).map((kind) =>
        context.sync![kind].state === "available" ? null : (
          <div key={kind}>
            <p>
              {kind === "git" ? "Git" : "Folder"} context{" "}
              {context.sync![kind].state === "pending"
                ? "is waiting for synchronized history."
                : "has conflicting corrections. Review the candidates and preview a correction to resolve them."}
            </p>
            <ul>
              {context.sync![kind].heads.map((head) => (
                <li key={head.revisionId}>
                  {factLabel(effective<SourceContextFact>(head.assignment))}
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </section>
  );
}

export function SourceCorrectionImpact({
  preview
}: {
  preview: NonNullable<Result["preview"]>;
}) {
  const affected = preview.projects.filter(
    (project) => project.beforeReasons.length || project.afterReasons.length
  );
  return (
    <section className="personal-source-impact" aria-label="Correction preview">
      <h3>Project impact</h3>
      {affected.length ? (
        <ul>
          {affected.map((project) => (
            <li key={project.projectId}>
              <div>
                <strong>{project.name}</strong>
                <small>
                  {project.afterReasons
                    .map((reason) =>
                      reason.kind === "session"
                        ? "Direct inclusion"
                        : reason.kind === "folder"
                          ? "Folder"
                          : "Git Anchor"
                    )
                    .join(", ") || "No matching inclusions"}
                </small>
              </div>
              <span>
                {project.beforeIncluded ? "Included" : "Not included"} →{" "}
                {project.afterIncluded ? "Included" : "Not included"}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p>No Project membership changes.</p>
      )}
      <p>
        Matching rules update automatically. Direct inclusions and Project
        exclusions stay in effect.
      </p>
    </section>
  );
}
