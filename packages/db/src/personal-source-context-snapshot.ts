import type pg from "pg";
import {
  personalSourceContextSnapshotSchema,
  personalGitAssignmentSchema,
  personalFolderAssignmentSchema,
  PdsConfigurationCompatibilityError,
  type PersonalSourceContextSnapshot
} from "@koed/shared";
import { evaluateSourceContextFrontier } from "./personal-source-context-graph.js";
import type { PersonalSourceBindingRow } from "./personal-source-binding-state.js";
type Axis = "git" | "folder";
const assignmentFor = (axis: Axis, value: unknown) =>
  (axis === "git"
    ? personalGitAssignmentSchema
    : personalFolderAssignmentSchema
  ).parse(value);
const unavailable = (device: string): never => {
  throw new PdsConfigurationCompatibilityError("source_context_v1", [device]);
};
/** Reads complete proven history; never truncates ancestry to make publication fit. */
export const readBoundPersonalSourceContextSnapshot = async (
  client: pg.PoolClient,
  binding: PersonalSourceBindingRow
): Promise<PersonalSourceContextSnapshot> => {
  if (binding.context_version !== 1 || binding.availability !== "available")
    return unavailable(binding.originating_device_id);
  const source = {
    ownerUserId: binding.owner_user_id,
    originatingDeploymentId: binding.originating_deployment_id,
    originatingDeviceId: binding.originating_device_id,
    logicalSessionId: binding.source_logical_session_id
  };
  const rows = await client.query<{
    axis: Axis;
    revision_id: string;
    replaces: string[];
    assignment: unknown;
  }>(
    "select axis,revision_id,replaces,assignment from personal_source_context_revisions where binding_id=$1 order by axis,revision_id limit 4097",
    [binding.binding_id]
  );
  const history = (axis: Axis) =>
    rows.rows
      .filter((row) => row.axis === axis)
      .map((row) => ({
        revisionId: row.revision_id,
        replaces: row.replaces,
        assignment: assignmentFor(axis, row.assignment)
      }));
  const gitHistory = history("git"),
    folderHistory = history("folder");
  if (gitHistory.length > 2048 || folderHistory.length > 2048)
    return unavailable(binding.originating_device_id);
  const git = evaluateSourceContextFrontier(gitHistory),
    folder = evaluateSourceContextFrontier(folderHistory);
  if (git.state !== "available" || folder.state !== "available")
    return unavailable(binding.originating_device_id);
  const snapshot = personalSourceContextSnapshotSchema.parse({
    version: "1",
    context: {
      version: 1,
      source,
      git: git.assignment,
      folder: folder.assignment
    },
    git: { head: git.frontier[0], revisions: gitHistory },
    folder: { head: folder.frontier[0], revisions: folderHistory }
  });
  return snapshot;
};
