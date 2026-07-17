import os from "node:os";
import path from "node:path";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const accountRoot = path.resolve(
  process.env.CODEX_MULTI_HOME || path.join(os.homedir(), ".codex-accounts"),
);
export const hubHome = path.resolve(
  process.env.CODEX_HUB_HOME || path.join(projectRoot, ".hub"),
);
export const hubHost = process.env.CODEX_HUB_HOST || "127.0.0.1";
export const hubPort = Number.parseInt(process.env.CODEX_HUB_PORT || "47831", 10);
export const hubBaseUrl = process.env.CODEX_HUB_URL || `http://${hubHost}:${hubPort}`;

export const hostModel = process.env.CODEX_HOST_MODEL || "gpt-5.6-sol";
export const hostReasoningEffort = process.env.CODEX_HOST_REASONING_EFFORT || "low";
export const hostTimeZone = process.env.CODEX_HOST_TIME_ZONE
  || Intl.DateTimeFormat().resolvedOptions().timeZone
  || "UTC";

export const instanceNames = ["zxc", "aiasio"];
export const hubSourceNames = [...instanceNames, "gui"];

export function assertInstance(value) {
  if (!instanceNames.includes(value)) {
    throw new Error(`Unknown instance '${value}'. Expected zxc or aiasio.`);
  }
  return value;
}

export function assertHubSource(value) {
  if (!hubSourceNames.includes(value)) {
    throw new Error(`Unknown hub source '${value}'. Expected zxc, aiasio, or gui.`);
  }
  return value;
}

export function accountHome(instance) {
  assertInstance(instance);
  return path.join(accountRoot, instance);
}

export function remoteStatePath(instance) {
  return path.join(accountHome(instance), "remote-windows.json");
}
