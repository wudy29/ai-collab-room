import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const CONFIG_FILE = ".local-agent-edge.json";
const SECRET_ENV_KEY = /token|secret|password|credential|api_key|private_key|authorization|cookie|session/i;
const ALLOWED_KEYS = new Set(["command", "args", "cwd", "env", "port"]);

export async function parseConfigurationCommand(line) {
  if (typeof line !== "string" || !line.startsWith("edge:configure ")) {
    throw new TypeError("Configuration must be one edge:configure {JSON} line");
  }

  let config;
  try {
    config = JSON.parse(line.slice("edge:configure ".length));
  } catch (error) {
    throw new TypeError(`Configuration JSON is invalid: ${error.message}`);
  }

  return validateConfiguration(config);
}

export async function readLocalAgentEdgeConfig({ configDir } = {}) {
  const configPath = configurationPath(configDir);
  let text;

  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(
      `Unable to read Local Agent Edge configuration at ${configPath}: ${error.message}`,
      { cause: error },
    );
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Local Agent Edge configuration at ${configPath} is invalid: ${error.message}`,
      { cause: error },
    );
  }

  return validateConfiguration(config);
}

export async function writeLocalAgentEdgeConfig({ configDir, config } = {}) {
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
      `Unable to save Local Agent Edge configuration at ${configPath}: ${error.message}`,
      { cause: error },
    );
  }
}

async function validateConfiguration(config) {
  if (!isObject(config) || Object.keys(config).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new TypeError("Configuration must contain only command, args, cwd, env, and port");
  }

  if (typeof config.command !== "string" || !config.command.trim()) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (typeof config.cwd !== "string" || !config.cwd.trim()) {
    throw new TypeError("cwd must be an existing directory");
  }

  let cwdStat;
  try {
    cwdStat = await stat(config.cwd);
  } catch (error) {
    throw new TypeError(`cwd must be an existing directory: ${error.message}`);
  }
  if (!cwdStat.isDirectory()) {
    throw new TypeError("cwd must be an existing directory");
  }

  const env = config.env ?? {};
  if (!isObject(env) || Object.entries(env).some(([key, value]) => (
    typeof value !== "string" || SECRET_ENV_KEY.test(key)
  ))) {
    throw new TypeError("env must contain only non-secret string values");
  }

  if (config.port !== undefined && (
    !Number.isInteger(config.port) || config.port < 0 || config.port > 65_535
  )) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }

  return {
    command: config.command,
    args: [...config.args],
    cwd: config.cwd,
    env: { ...env },
    ...(config.port === undefined ? {} : { port: config.port }),
  };
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
