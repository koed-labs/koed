import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function verifyApproval(
  { actor, triggeringActor, attempt, version },
  approvals
) {
  if (
    typeof actor !== "string" ||
    !actor.trim() ||
    typeof triggeringActor !== "string" ||
    !triggeringActor.trim() ||
    attempt !== "1" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? "") ||
    !Array.isArray(approvals)
  )
    throw new Error("Invalid production approval context.");
  const excluded = [actor.toLowerCase(), triggeringActor.toLowerCase()];
  if (
    !approvals.some(
      (item) =>
        item?.state === "approved" &&
        item.user?.type === "User" &&
        typeof item.user.login === "string" &&
        item.user.login.trim() &&
        !excluded.includes(item.user.login.toLowerCase()) &&
        Array.isArray(item.environments) &&
        item.environments.some((env) => env.name === "production")
    )
  )
    throw new Error("Independent production approval evidence missing.");
  return true;
}

export function verifyWorkflowApproval(version) {
  const {
    GITHUB_REPOSITORY,
    GITHUB_RUN_ID,
    GITHUB_RUN_ATTEMPT,
    GITHUB_ACTOR,
    GITHUB_TRIGGERING_ACTOR
  } = process.env;
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? "") ||
    !/^\d+$/.test(GITHUB_RUN_ID ?? "")
  )
    throw new Error("Invalid workflow identity.");
  const approvals = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/approvals`
      ],
      { encoding: "utf8" }
    )
  );
  return verifyApproval(
    {
      actor: GITHUB_ACTOR,
      triggeringActor: GITHUB_TRIGGERING_ACTOR,
      attempt: GITHUB_RUN_ATTEMPT,
      version
    },
    approvals
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    verifyWorkflowApproval(process.env.RELEASE_VERSION);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
