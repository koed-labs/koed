import { runPdsSecretBridgeClient } from "./pds-secret-bridge-client.js";

const [operation, reference] = process.argv.slice(2);
const socketPath = process.env.PDS_DESKTOP_SECRET_BRIDGE_SOCKET;
const token = process.env.PDS_DESKTOP_SECRET_BRIDGE_TOKEN;

if (
  (operation !== "get" && operation !== "put" && operation !== "delete") ||
  !reference ||
  !socketPath ||
  !token
) {
  process.exitCode = 1;
} else {
  void runPdsSecretBridgeClient({
    operation,
    reference,
    socketPath,
    token,
    stdin: process.stdin,
    stdout: process.stdout
  })
    .then((ok) => {
      if (!ok) process.exitCode = 1;
    })
    .catch(() => {
      process.exitCode = 1;
    });
}
