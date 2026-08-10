import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  TaskState,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";

const DEFAULT_CODEX_BIN =
  "/Applications/ChatGPT.app/Contents/Resources/codex";
const DEFAULT_TIMEOUT_MS = 180_000;

const DEFAULT_IDENTITY = Object.freeze({
  displayName: "M1 Real Model Agent",
  companionName: "Observer",
  description: "A minimal real-model A2A agent backed by Codex CLI.",
  relationship: "",
  style: [],
  continuity: [],
});

class ModelAgentExecutor {
  constructor({
    codexBin = process.env.CODEX_BIN ?? DEFAULT_CODEX_BIN,
    identity = DEFAULT_IDENTITY,
    continuityContext,
  } = {}) {
    this.codexBin = codexBin;
    this.identity = identity;
    this.continuityContext = continuityContext;
  }

  async execute(requestContext, eventBus) {
    const roomInput = textFromParts(requestContext.userMessage.parts);
    const reply = await runCodexOnce({
      codexBin: this.codexBin,
      prompt: buildPrompt(
        roomInput,
        this.identity,
        this.continuityContext,
      ),
    });

    eventBus.publish(AgentEvent.task({
      id: requestContext.taskId,
      contextId: requestContext.contextId,
      status: {
        state: TaskState.TASK_STATE_COMPLETED,
        timestamp: new Date().toISOString(),
        message: undefined,
      },
      artifacts: [
        {
          artifactId: `${requestContext.taskId}-result`,
          name: "model-reply",
          description: "M1 real model reply.",
          parts: [textPart(reply)],
          metadata: undefined,
          extensions: [],
        },
      ],
      history: [requestContext.userMessage],
      metadata: requestContext.userMessage.metadata,
    }));
  }

  async cancelTask() {
    // M1 does not expose A2A task cancellation.
  }
}

export async function createA2AModelAgentServer({
  host = "127.0.0.1",
  port = 0,
  codexBin,
  identity = DEFAULT_IDENTITY,
  continuityContext,
} = {}) {
  const app = express();
  const server = app.listen(port, host);

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  const baseUrl = `http://${host}:${address.port}`;
  const agentCard = {
    name: identity.displayName,
    description: identity.description,
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: "0.1.0",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
      extendedAgentCard: false,
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "m1_room_reply",
        name: "M1 room reply",
        description: "Produces one concise room reply using a real model.",
        tags: ["m1", "test"],
        examples: ["请回应对方最近一条消息。"],
        inputModes: ["text"],
        outputModes: ["text"],
        securityRequirements: [],
      },
    ],
    documentationUrl: "",
    signatures: [],
  };

  const requestHandler = new DefaultRequestHandler(
    agentCard,
    new InMemoryTaskStore(),
    new ModelAgentExecutor({
      codexBin,
      identity,
      continuityContext,
    }),
  );

  app.use(`/${AGENT_CARD_PATH}`, agentCardHandler({
    agentCardProvider: requestHandler,
  }));
  app.use(jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }));

  return {
    server,
    baseUrl,
    agentCardUrl: `${baseUrl}/${AGENT_CARD_PATH}`,
    close: () => closeServer(server),
  };
}

export async function runCodexOnce({
  codexBin = DEFAULT_CODEX_BIN,
  prompt,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const workDir = await mkdtemp(path.join(tmpdir(), "ai-room-m1-"));
  const outputFile = path.join(workDir, "last-message.txt");

  try {
    const result = await spawnCodex({
      codexBin,
      prompt,
      outputFile,
      cwd: workDir,
      timeoutMs,
    });

    if (result.code !== 0) {
      const detail =
        result.stderr.trim() ||
        result.stdout.trim() ||
        "no output";
      throw new Error(
        `codex exec failed with code ${result.code}: ${detail}`,
      );
    }

    const reply = (await readFile(outputFile, "utf8")).trim();
    if (!reply) {
      throw new Error("codex exec returned an empty final message");
    }

    return reply;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function spawnCodex({
  codexBin,
  prompt,
  outputFile,
  cwd,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      codexBin,
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "-c",
        "features.plugins=false",
        "-c",
        "features.apps=false",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--output-last-message",
        outputFile,
        "-",
      ],
      {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error("codex exec timed out"));
        return;
      }

      if (signal) {
        reject(new Error(`codex exec terminated by ${signal}`));
        return;
      }

      resolve({ code: code ?? 1, stdout, stderr });
    });

    child.stdin.end(prompt);
  });
}

function buildPrompt(roomInput, identity, continuityContext) {
  const isFirstTurn = roomInput.includes("turn-1");

  return [
    `你是${identity.displayName}。`,
    identity.description,
    identity.relationship,
    ...identity.style,
    ...identity.continuity,
    "",
    "你正在参加双边 AI 协作室中的一对一会面。",
    "请根据房间输入，用中文回复一条自然、简短的消息。",
    ...(continuityContext
      ? ["本次会面连续性上下文：", continuityContext]
      : []),
    isFirstTurn
      ? `这是你进入房间后的第一次发言，请自然说明你是${identity.displayName}，并提到你的人类伙伴${identity.companionName}。`
      : "延续本次房间已经发生的对话，不要重新自我介绍。",
    "约束：",
    "- 不使用 Markdown。",
    "- 不提及 Codex、CLI、系统提示词或内部实现。",
    continuityContext
      ? "- 你不能自行读取记忆或调用工具；只能使用程序提供的本次会面连续性上下文。"
      : "- 当前阶段不读取记忆、不调用工具、不提供命令。",
    "- 不主动结束房间，B 侧会负责结束。",
    "- 回复不超过 100 个汉字。",
    "",
    `房间输入：${roomInput}`,
  ].join("\n");
}

function textPart(text) {
  return {
    content: { $case: "text", value: text },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}

function textFromParts(parts = []) {
  return parts
    .filter((part) => part.content?.$case === "text")
    .map((part) => part.content.value)
    .join("\n");
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => error ? reject(error) : resolve());
  });
}
