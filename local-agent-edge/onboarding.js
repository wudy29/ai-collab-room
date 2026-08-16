import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { createLocalAgentEdge } from "./a2a-edge.js";
import { createGenericCliDriver } from "./generic-cli-driver.js";
import { mergeEffectiveEnv, resolveConfiguredCommand } from "./command-resolution.js";
import {
  parseConfigurationCommand,
  readLocalAgentEdgeConfig,
  writeLocalAgentEdgeConfig,
} from "./onboarding-config.js";

const SETUP_PROMPT = `Give the following request to your own AI:

I want to run my local AI command through Local Agent Edge. Reply with exactly
one complete line in this format:
edge:configure {"command":"...","args":["..."],"cwd":"...","env":{"SAFE_NAME":"value"},"port":0}

Use only the command, string arguments, an existing working directory, optional
non-secret environment variables, and an optional port. Omit passwords, tokens,
API keys, cookies, session values, and all other secrets.

Paste that one edge:configure {JSON} line here:
`;

export async function runEdgeSetup({
  input,
  output,
  configDir,
} = {}) {
  if (!input || typeof input.on !== "function") {
    throw new TypeError("input must be a readable stream");
  }
  if (!output || typeof output.write !== "function") {
    throw new TypeError("output must be a writable stream");
  }

  output.write(SETUP_PROMPT);
  const readline = createInterface({ input, output, terminal: false });
  let line;
  try {
    line = await readline.question("");
  } finally {
    readline.close();
  }

  const config = await parseConfigurationCommand(line);
  await writeLocalAgentEdgeConfig({ configDir, config });
  output.write("Configuration saved.\nNext: npm run edge:start\n");
}

export async function startConfiguredLocalAgentEdge({
  configDir,
  env = process.env,
  output = process.stdout,
} = {}) {
  try {
    const config = await readLocalAgentEdgeConfig({ configDir });
    // Resolve once: availability and launch must share the same effective
    // environment (base env merged with the saved non-secret override).
    const effectiveEnv = mergeEffectiveEnv({
      baseEnv: env,
      overrideEnv: config.env,
    });
    const resolved = await resolveConfiguredCommand({
      command: config.command,
      env: effectiveEnv,
    });
    if (!resolved) {
      throw new Error(`Configured command is unavailable: ${config.command}`);
    }

    const driver = createGenericCliDriver({
      command: resolved.path,
      commandType: resolved.type,
      args: config.args,
      cwd: config.cwd,
      env: effectiveEnv,
    });
    const edge = await createLocalAgentEdge({
      driver,
      port: config.port ?? 0,
    });

    output.write("Local Agent Edge is ready\n");
    output.write(`Base URL: ${edge.baseUrl}\n`);
    output.write(`Agent Card URL: ${edge.agentCardUrl}\n`);
    return edge;
  } catch (error) {
    writeStartFailure(output, error);
    throw error;
  }
}

function writeStartFailure(output, error) {
  const reason = error instanceof Error ? error.message : String(error);
  output.write(`${reason}\n`);

  if (/configuration/i.test(reason) || /ENOENT/i.test(reason)) {
    output.write("Next: run npm run edge:setup to create a configuration.\n");
    return;
  }
  if (/Configured command is unavailable/.test(reason)) {
    output.write("Next: install the configured command or run npm run edge:setup again.\n");
    return;
  }
  output.write("Next: check the configured port and command, then try again.\n");
}

async function main() {
  const command = process.argv[2];
  const configDir = process.cwd();

  if (command === "setup") {
    await runEdgeSetup({
      input: process.stdin,
      output: process.stdout,
      configDir,
    });
    return;
  }

  if (command !== "start") {
    throw new Error("Usage: onboarding.js setup|start");
  }

  const edge = await startConfiguredLocalAgentEdge({
    configDir,
    env: process.env,
    output: process.stdout,
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await edge.close();
    process.exitCode = 0;
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!/Unable to read Local Agent Edge configuration|Configured command is unavailable|EADDRINUSE/.test(
      error instanceof Error ? error.message : String(error),
    )) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
