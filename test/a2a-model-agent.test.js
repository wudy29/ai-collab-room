import assert from "node:assert/strict";
import test from "node:test";
import { ModelAgentExecutor } from "../src/a2a-model-agent.js";

const identity = Object.freeze({
  displayName: "测试 Agent",
  companionName: "测试伙伴",
  description: "独立测试身份。",
  relationship: "",
  style: [],
  continuity: [],
});

test("treats turn-2 as first, then continues after success", async () => {
  const prompts = [];
  const executor = createExecutor(prompts);

  await executor.execute(request("task-1", "turn-2"), eventBus());
  await executor.execute(request("task-2", "turn-3"), eventBus());

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.doesNotMatch(prompts[0], /延续本次房间已经发生的对话/);
  assert.match(prompts[1], /延续本次房间已经发生的对话/);
  assert.doesNotMatch(prompts[1], /这是你进入房间后的第一次发言/);
});

test("retries as first after model failure", async () => {
  const prompts = [];
  let calls = 0;
  const executor = new ModelAgentExecutor({
    identity,
    runModel: async ({ prompt }) => {
      prompts.push(prompt);
      calls += 1;
      if (calls === 1) throw new Error("model failed");
      return "重试成功";
    },
  });

  await assert.rejects(
    executor.execute(request("task-1", "turn-1"), eventBus()),
    /model failed/,
  );
  await executor.execute(request("task-2", "turn-2"), eventBus());

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.match(prompts[1], /这是你进入房间后的第一次发言/);
});

test("retries as first after publish failure", async () => {
  const prompts = [];
  let publishes = 0;
  const executor = createExecutor(prompts);
  const bus = {
    async publish() {
      publishes += 1;
      if (publishes === 1) throw new Error("publish failed");
    },
  };

  await assert.rejects(
    executor.execute(request("task-1", "turn-1"), bus),
    /publish failed/,
  );
  await executor.execute(request("task-2", "turn-2"), bus);

  assert.match(prompts[0], /这是你进入房间后的第一次发言/);
  assert.match(prompts[1], /这是你进入房间后的第一次发言/);
});

test("isolates first-success state across executors", async () => {
  const promptsA = [];
  const promptsB = [];
  const executorA = createExecutor(promptsA);
  const executorB = createExecutor(promptsB);

  await executorA.execute(request("task-a1", "turn-1"), eventBus());
  await executorA.execute(request("task-a2", "turn-3"), eventBus());
  await executorB.execute(request("task-b1", "turn-2"), eventBus());

  assert.match(promptsA[0], /这是你进入房间后的第一次发言/);
  assert.match(promptsA[1], /延续本次房间已经发生的对话/);
  assert.match(promptsB[0], /这是你进入房间后的第一次发言/);
});

function createExecutor(prompts) {
  return new ModelAgentExecutor({
    identity,
    runModel: async ({ prompt }) => {
      prompts.push(prompt);
      return "成功回复";
    },
  });
}

function request(taskId, text) {
  return {
    taskId,
    contextId: "room-test",
    userMessage: {
      parts: [
        {
          content: { $case: "text", value: text },
        },
      ],
      metadata: {},
    },
  };
}

function eventBus() {
  return {
    publish() {},
  };
}
