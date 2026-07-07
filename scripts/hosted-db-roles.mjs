#!/usr/bin/env node
import {
  checkHostedRuntimeRole,
  generateHostedDbRoleSql,
  parseHostedDbRoleArgs,
  usage
} from "./hosted-db-roles-lib.mjs";

const main = async () => {
  const args = parseHostedDbRoleArgs(process.argv.slice(2));
  if (args.command === "help") {
    console.log(usage);
    return;
  }
  if (args.command === "plan") {
    process.stdout.write(`${generateHostedDbRoleSql(args)}\n`);
    return;
  }
  if (args.command === "check") {
    const result = await checkHostedRuntimeRole(args);
    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(result.message);
    }
    process.exitCode = result.ok ? 0 : 1;
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
