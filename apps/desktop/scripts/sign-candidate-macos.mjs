import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { signCandidateBundle } from "../../../scripts/candidate-macos-payload.mjs";

const exec = promisify(execFile);
const runTool = async (command, args) => {
  try {
    const { stdout } = await exec(command, args, {
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR
      },
      maxBuffer: 1024 * 1024
    });
    return stdout;
  } catch {
    throw new Error(`Trusted ${command} command failed`);
  }
};

const decodeSecret = (value) => {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    ) ||
    !value.length ||
    value.length > 1024 * 1024
  )
    throw new Error("Invalid signing secret");
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value)
    throw new Error("Invalid signing secret");
  return decoded;
};

const validateInputs = (input) => {
  if (
    !input ||
    !isAbsolute(input.workspace) ||
    !isAbsolute(input.outputDir) ||
    !input.bundle ||
    !/^[A-Z0-9]{10}$/.test(input.expectedTeamId) ||
    !/^[A-Z0-9]{10}$/.test(input.apiKeyId) ||
    !/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(
      input.issuerId
    ) ||
    typeof input.p12Password !== "string" ||
    !input.p12Password ||
    input.p12Password.includes("\0")
  )
    throw new Error("Invalid signing inputs");
  if (dirname(resolve(input.outputDir)) !== resolve(input.workspace))
    throw new Error("Invalid signing output directory");
  try {
    lstatSync(input.outputDir);
    throw new Error("Signing output already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const importIdentity = async ({
  run,
  keychain,
  password,
  p12,
  p12Password,
  team
}) => {
  await run("security", ["create-keychain", "-p", password, keychain]);
  await run("security", ["unlock-keychain", "-p", password, keychain]);
  await run("security", [
    "import",
    p12,
    "-k",
    keychain,
    "-P",
    p12Password,
    "-T",
    "/usr/bin/codesign"
  ]);
  await run("security", [
    "set-key-partition-list",
    "-S",
    "apple-tool:,apple:",
    "-s",
    "-k",
    password,
    keychain
  ]);
  const identities = await run("security", [
    "find-identity",
    "-v",
    "-p",
    "codesigning",
    keychain
  ]);
  const matches = [
    ...identities.matchAll(
      /^\s*\d+\)\s+([A-F0-9]{40})\s+"Developer ID Application: [^"\r\n]+ \(([A-Z0-9]{10})\)"\s*$/gm
    )
  ].filter((match) => match[2] === team);
  if (matches.length !== 1)
    throw new Error("Expected exactly one Developer ID signing identity");
  return matches[0][1];
};

const notarize = async (run, path, api) => {
  const output = await run("xcrun", [
    "notarytool",
    "submit",
    path,
    "--key",
    api.key,
    "--key-id",
    api.id,
    "--issuer",
    api.issuer,
    "--wait",
    "--output-format",
    "json"
  ]);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("Invalid notarization response");
  }
  if (result.status !== "Accepted")
    throw new Error("Notarization was not accepted");
};

const packageAndNotarize = async ({ run, bundle, outputDir, temp, api }) => {
  const preliminary = join(temp, "notarization.zip");
  const zip = join(outputDir, "Koed.zip");
  const dmg = join(outputDir, "Koed.dmg");
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    bundle.appPath,
    preliminary
  ]);
  await notarize(run, preliminary, api);
  await run("xcrun", ["stapler", "staple", bundle.appPath]);
  await run("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    bundle.appPath,
    zip
  ]);
  await run("hdiutil", [
    "create",
    "-fs",
    "HFS+",
    "-volname",
    "Koed",
    "-srcfolder",
    bundle.appPath,
    "-format",
    "UDZO",
    dmg
  ]);
  await notarize(run, dmg, api);
  await run("xcrun", ["stapler", "staple", dmg]);
  return { zip, dmg };
};

export const signAndPackageCandidate = async (
  input,
  { run = runTool, sign = signCandidateBundle } = {}
) => {
  validateInputs(input);
  const temp = mkdtempSync(join(input.workspace, "candidate-signing-"));
  const keychain = join(temp, "signing.keychain-db");
  const stage = mkdtempSync(join(input.workspace, "candidate-output-"));
  let result;
  let failure;
  try {
    const p12 = join(temp, "identity.p12");
    const key = join(temp, "AuthKey.p8");
    writeFileSync(p12, decodeSecret(input.p12Base64), {
      mode: 0o600,
      flag: "wx"
    });
    writeFileSync(key, decodeSecret(input.apiKeyBase64), {
      mode: 0o600,
      flag: "wx"
    });
    const password = randomBytes(32).toString("hex");
    const identity = await importIdentity({
      run,
      keychain,
      password,
      p12,
      p12Password: input.p12Password,
      team: input.expectedTeamId
    });
    await sign(input.bundle, { identity, keychain });
    await packageAndNotarize({
      run,
      bundle: input.bundle,
      outputDir: stage,
      temp,
      api: { key, id: input.apiKeyId, issuer: input.issuerId }
    });
  } catch (error) {
    failure = new Error(
      `Candidate signing failed: ${error.message?.includes("identity") ? "signing identity invalid" : "trusted signing operation failed"}`
    );
  }
  try {
    await run("security", ["delete-keychain", keychain]);
  } catch {
    failure = new Error("Candidate signing keychain cleanup failed");
  }
  try {
    rmSync(temp, { recursive: true, force: true });
  } catch {
    failure = new Error(
      "Candidate signing temporary credential cleanup failed"
    );
  }
  if (!failure) {
    try {
      renameSync(stage, input.outputDir);
      result = {
        zip: join(input.outputDir, "Koed.zip"),
        dmg: join(input.outputDir, "Koed.dmg")
      };
    } catch {
      failure = new Error("Candidate signing output promotion failed");
    }
  }
  if (failure) {
    try {
      rmSync(stage, { recursive: true, force: true });
    } catch {
      throw new Error("Candidate signing output cleanup failed");
    }
    throw failure;
  }
  return result;
};
