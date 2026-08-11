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

const HOST = "127.0.0.1";

class CliEdgeExecutor {
  constructor(driver) {
    this.driver = driver;
  }

  async execute(requestContext, eventBus) {
    const prompt = textFromParts(requestContext.userMessage.parts);

    if (!prompt.trim()) {
      publishFailedTask(requestContext, eventBus);
      return;
    }

    try {
      const reply = await this.driver.run(prompt);
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
            name: "local-agent-reply",
            description: "Reply from the user-owned local Agent runtime.",
            parts: [textPart(reply)],
            metadata: undefined,
            extensions: [],
          },
        ],
        history: [requestContext.userMessage],
        metadata: requestContext.userMessage.metadata,
      }));
    } catch {
      publishFailedTask(requestContext, eventBus);
    }
  }

  async cancelTask() {}
}

export async function createLocalAgentEdge({
  driver,
  port = 0,
} = {}) {
  if (!driver || typeof driver.run !== "function") {
    throw new TypeError("driver.run(prompt) is required");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }

  const app = express();
  const server = app.listen(port, HOST);

  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  const baseUrl = `http://${HOST}:${address.port}`;
  const agentCard = {
    name: "Local Agent Edge",
    description: "A localhost A2A edge for a user-owned local Agent runtime.",
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
        id: "local_agent_reply",
        name: "Local Agent reply",
        description: "Forwards one text turn to the user-owned local Agent.",
        tags: ["local-agent"],
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
    new CliEdgeExecutor(driver),
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

function publishFailedTask(requestContext, eventBus) {
  eventBus.publish(AgentEvent.task({
    id: requestContext.taskId,
    contextId: requestContext.contextId,
    status: {
      state: TaskState.TASK_STATE_FAILED,
      timestamp: new Date().toISOString(),
      message: undefined,
    },
    artifacts: [],
    history: [requestContext.userMessage],
    metadata: requestContext.userMessage.metadata,
  }));
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
    .map((part) => {
      if (part.content?.$case === "text") return part.content.value;
      if (part.kind === "text") return part.text;
      return "";
    })
    .filter(Boolean)
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
