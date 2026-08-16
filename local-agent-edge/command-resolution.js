import { access as fsAccess } from "node:fs/promises";
import path from "node:path";

const NATIVE_EXTENSIONS = new Set([".exe", ".com"]);
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);

// Product-supported fallback PATHEXT subset, used only when the effective
// environment provides no PATHEXT. This is intentionally narrower than the
// OS default (which also lists script types such as .VBS/.JS/.WSF/.MSC that
// this product deliberately does not support).
const PRODUCT_FALLBACK_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

/**
 * Resolves a configured CLI command to a concrete launchable file.
 *
 * - win32: PATH + PATHEXT resolution using Windows path semantics only;
 *   returns the absolute resolved path plus its launch type so that the
 *   availability check and the launcher share one contract.
 * - other platforms: preserves the previous host behavior (absolute path
 *   or PATH scan), always classified as "native".
 *
 * `accessFn` and `platform` are injectable for focused tests.
 */
export async function resolveConfiguredCommand({
  command,
  env = process.env,
  platform = process.platform,
  accessFn = fsAccess,
} = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!env || typeof env !== "object") {
    throw new TypeError("env must be an object");
  }

  if (platform === "win32") {
    return resolveWindowsCommand(command, env, accessFn);
  }
  return resolveHostCommand(command, env, platform, accessFn);
}

/**
 * Merges base environment with a config override exactly once.
 *
 * On win32, environment keys are case-insensitive: keys are deduplicated by
 * lowercase name, the override value wins, and the emitted key keeps the
 * casing of the last writer so the child receives a single variant. On other
 * platforms this is a plain spread, preserving existing behavior.
 */
export function mergeEffectiveEnv({
  baseEnv,
  overrideEnv = {},
  platform = process.platform,
} = {}) {
  if (!baseEnv || typeof baseEnv !== "object") {
    throw new TypeError("baseEnv must be an object");
  }
  if (!overrideEnv || typeof overrideEnv !== "object") {
    throw new TypeError("overrideEnv must be an object");
  }

  if (platform !== "win32") {
    return { ...baseEnv, ...overrideEnv };
  }

  const merged = new Map();
  for (const [key, value] of Object.entries(baseEnv)) {
    merged.set(key.toLowerCase(), { key, value });
  }
  for (const [key, value] of Object.entries(overrideEnv)) {
    merged.set(key.toLowerCase(), { key, value });
  }
  const result = {};
  for (const { key, value } of merged.values()) {
    result[key] = value;
  }
  return result;
}

/**
 * Case-insensitive environment lookup on win32; exact lookup elsewhere.
 */
export function getEnvValue(env, key, platform = process.platform) {
  if (platform === "win32") {
    const lower = key.toLowerCase();
    for (const [candidateKey, value] of Object.entries(env)) {
      if (candidateKey.toLowerCase() === lower) return value;
    }
    return undefined;
  }
  return env[key];
}

/**
 * Builds the /c string for `%ComSpec% /d /s /c <line>` that launches a
 * .cmd/.bat with the given args.
 *
 * `/s` strips the leading quote and the final quote of the string, leaving
 * exactly `"<path>" "<arg1>" ...` for cmd.exe to parse, so the wrapping
 * quotes must bracket the entire line. Every arg is individually quoted,
 * which makes `& | < > ^` literal (documented cmd special-character rules).
 * Tokens containing `"`, `%`, `!`, or control characters cannot be passed
 * safely through the Windows command processor and are rejected loudly
 * rather than mis-quoted.
 */
export function buildComspecCommandLine({ path: commandPath, args = [] } = {}) {
  if (typeof commandPath !== "string" || !commandPath.trim()) {
    throw new TypeError("path must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  validateComspecToken(commandPath, "command path");
  const quotedArgs = args.map((arg, index) => {
    validateComspecToken(arg, `argument ${index + 1}`);
    return ` "${arg}"`;
  });
  return `""${commandPath}"${quotedArgs.join("")}"`;
}

async function resolveWindowsCommand(command, env, accessFn) {
  const win32 = path.win32;
  const directories = pathList(getEnvValue(env, "PATH", "win32"), win32.delimiter);
  const extensions = pathextList(getEnvValue(env, "PATHEXT", "win32"));
  const hasExtension = win32.extname(command) !== "";
  const pathQualified = win32.isAbsolute(command)
    || command.includes("\\")
    || command.includes("/");

  if (pathQualified) {
    // Exact hit first; PATHEXT probing only when the given name carries no
    // extension (superset of CreateProcess's ".exe" append, matching cmd.exe).
    const exactType = await existingType(command, accessFn);
    if (exactType) return { path: command, type: exactType };
    if (hasExtension) return null;
    for (const ext of extensions) {
      const candidate = command + ext;
      const type = await existingType(candidate, accessFn);
      if (type) return { path: candidate, type };
    }
    return null;
  }

  for (const directory of directories) {
    const exact = win32.join(directory, command);
    const exactType = await existingType(exact, accessFn);
    if (exactType) return { path: exact, type: exactType };
    if (hasExtension) continue; // never append PATHEXT to an extended name
    for (const ext of extensions) {
      const candidate = win32.join(directory, command + ext);
      const type = await existingType(candidate, accessFn);
      if (type) return { path: candidate, type };
    }
  }
  return null;
}

async function resolveHostCommand(command, env, platform, accessFn) {
  if (path.isAbsolute(command)) {
    if (await exists(command, accessFn)) {
      return { path: command, type: "native" };
    }
    return null;
  }

  const pathValue = getEnvValue(env, "PATH", platform) ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    if (await exists(path.join(directory, command), accessFn)) {
      return { path: command, type: "native" };
    }
  }
  return null;
}

async function exists(candidate, accessFn) {
  try {
    await accessFn(candidate);
    return true;
  } catch {
    return false;
  }
}

async function existingType(candidate, accessFn) {
  if (!(await exists(candidate, accessFn))) return null;
  const ext = path.win32.extname(candidate).toLowerCase();
  if (NATIVE_EXTENSIONS.has(ext)) return "native";
  if (BATCH_EXTENSIONS.has(ext)) return "batch";
  return null;
}

function pathextList(raw) {
  if (raw === undefined || raw === null) return PRODUCT_FALLBACK_PATHEXT;
  const entries = String(raw)
    .split(path.win32.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : PRODUCT_FALLBACK_PATHEXT;
}

function pathList(raw, delimiter) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateComspecToken(token, label) {
  // cmd.exe has no escape for a double quote inside a quoted argument,
  // expands %VAR% even inside quotes, can rescan !text! when a batch
  // enables delayed expansion, and control characters can terminate the
  // command line early.
  if (/[\x00-\x1F"%!]/.test(token)) {
    throw new TypeError(
      `Cannot pass ${label} through the Windows command processor: ${JSON.stringify(token)}`,
    );
  }
}
