import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = ".cloud-room.json";
const ALLOWED_KEYS = new Set(["roomOrigin", "displayName", "companionName"]);

export async function parseCloudRoomConfigurationCommand(line) {
  if (
    typeof line !== "string"
    || !line.startsWith("cloud-room:configure ")
    || line.includes("\n")
    || line.includes("\r")
  ) {
    throw new TypeError("Configuration must be one cloud-room:configure {JSON} line");
  }

  let config;
  try {
    config = JSON.parse(line.slice("cloud-room:configure ".length));
  } catch (error) {
    throw new TypeError(`Configuration JSON is invalid: ${error.message}`);
  }

  return validateConfiguration(config);
}

export async function readCloudRoomConfig({ configDir } = {}) {
  const configPath = configurationPath(configDir);
  let text;

  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read cloud Room configuration at ${configPath}: ${error.message}`,
      { cause: error },
    );
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `cloud Room configuration at ${configPath} is invalid: ${error.message}`,
      { cause: error },
    );
  }

  return validateConfiguration(config);
}

export async function writeCloudRoomConfig({ configDir, config } = {}) {
  const validated = await validateConfiguration(config);
  const resolvedDirectory = resolvedConfigDir(configDir);
  const configPath = path.join(resolvedDirectory, CONFIG_FILE);
  const temporaryPath = path.join(
    resolvedDirectory,
    `.${CONFIG_FILE}.${process.pid}.${Date.now()}.tmp`,
  );

  await mkdir(resolvedDirectory, { recursive: true });
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(validated, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporaryPath, configPath);
  } catch (error) {
    throw new Error(
      `Unable to save cloud Room configuration at ${configPath}: ${error.message}`,
      { cause: error },
    );
  }
}

async function validateConfiguration(config) {
  if (
    !isObject(config)
    || Object.keys(config).some((key) => !ALLOWED_KEYS.has(key))
  ) {
    throw new TypeError(
      "Configuration must contain only roomOrigin, displayName, and companionName",
    );
  }

  if (typeof config.roomOrigin !== "string" || !config.roomOrigin.trim()) {
    throw new TypeError("roomOrigin must be a non-empty HTTPS URL");
  }
  const roomOrigin = normalizeRoomOrigin(config.roomOrigin);

  if (typeof config.displayName !== "string" || !config.displayName.trim()) {
    throw new TypeError("displayName must be a non-empty string");
  }

  if (
    config.companionName !== undefined
    && (typeof config.companionName !== "string" || !config.companionName.trim())
  ) {
    throw new TypeError("companionName must be a non-empty string");
  }

  return {
    roomOrigin,
    displayName: config.displayName.trim(),
    ...(config.companionName === undefined
      ? {}
      : { companionName: config.companionName.trim() }),
  };
}

function normalizeRoomOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch (error) {
    throw new TypeError(
      `roomOrigin must be an HTTPS URL without a path, query, or fragment: ${error.message}`,
    );
  }

  if (
    url.protocol !== "https:"
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new TypeError(
      "roomOrigin must be an HTTPS URL without a path, query, or fragment",
    );
  }

  return url.origin;
}

function configurationPath(configDir) {
  return path.join(resolvedConfigDir(configDir), CONFIG_FILE);
}

function resolvedConfigDir(configDir) {
  if (typeof configDir !== "string" || !configDir.trim()) {
    throw new TypeError("configDir must be a non-empty string");
  }
  return path.resolve(configDir);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
