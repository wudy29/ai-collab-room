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

class TestAgentExecutor {
  async execute(requestContext, eventBus) {
    const input = textFromParts(requestContext.userMessage.parts);
    const result = input.includes("turn-1")
      ? "你好，我是通过 A2A 接入的测试 A。"
      : "A2A 适配验证完成。";

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
          name: "result",
          description: "Deterministic M0.5 test result.",
          parts: [textPart(result)],
          metadata: undefined,
          extensions: [],
        },
      ],
      history: [requestContext.userMessage],
      metadata: requestContext.userMessage.metadata,
    }));
  }

  async cancelTask() {
    // M0.5 does not expose cancellation.
  }
}

export async function createA2ATestAgentServer({
  host = "127.0.0.1",
  port = 0,
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
    name: "M0.5 Test Agent",
    description: "A deterministic local A2A agent for the M0.5 experiment.",
    supportedInterfaces: [
      {
        url: baseUrl,
        protocolBinding: "JSONRPC",
        tenant: "",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: undefined,
    version: "1.0.0",
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
        id: "m0_5_test",
        name: "M0.5 deterministic reply",
        description: "Returns the deterministic reply for the current room turn.",
        tags: ["test"],
        examples: ["turn-1"],
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
    new TestAgentExecutor(),
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
