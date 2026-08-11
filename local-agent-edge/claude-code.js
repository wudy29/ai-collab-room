import { pathToFileURL } from "node:url";
import { createLocalAgentEdge } from "./a2a-edge.js";
import { createGenericCliDriver } from "./generic-cli-driver.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PORT = 8767;

export function createClaudeCodeDriver({
  sessionId,
  workdir,
  claudeBin = "claude",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  requireNonEmpty("sessionId", sessionId);
  requireNonEmpty("workdir", workdir);
  requireNonEmpty("claudeBin", claudeBin);

  return createGenericCliDriver({
    command: claudeBin,
    args: ["-p", "--resume", sessionId],
    cwd: workdir,
    timeoutMs,
    env,
  });
}

export async function createClaudeCodeEdge({
  sessionId,
  workdir,
  claudeBin = "claude",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
  port = DEFAULT_PORT,
} = {}) {
  const driver = createClaudeCodeDriver({
    sessionId,
    workdir,
    claudeBin,
    timeoutMs,
    env,
  });

  return createLocalAgentEdge({ driver, port });
}

export async function startClaudeCodeEdgeFromEnv(env = process.env) {
  const rawPort = env.LOCAL_AGENT_EDGE_PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError(
      "LOCAL_AGENT_EDGE_PORT must be an integer between 0 and 65535",
    );
  }

  return createClaudeCodeEdge({
    sessionId: env.CLAUDE_SESSION_ID,
    workdir: env.CLAUDE_WORKDIR,
    claudeBin: env.CLAUDE_BIN ?? "claude",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    env,
    port,
  });
}

function requireNonEmpty(name, value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function isMainModule() {
  return Boolean(
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
  );
}

if (isMainModule()) {
  const edge = await startClaudeCodeEdgeFromEnv();
  console.log(`Local Agent Edge listening at ${edge.baseUrl}`);
  console.log(`Agent Card: ${edge.agentCardUrl}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await edge.close();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
