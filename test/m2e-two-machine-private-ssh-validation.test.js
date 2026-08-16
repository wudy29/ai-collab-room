import assert from "node:assert/strict";
import test from "node:test";
import { createA2ATestAgentServer } from "../src/a2a-test-agent.js";
import {
  runM2ETwoMachinePrivateSshValidation,
} from "../scripts/run-m2e-two-machine-private-ssh-validation.js";

test("consumes two existing A2A endpoints for four non-empty A-B-A-B messages", async (t) => {
  const agentA = await createA2ATestAgentServer();
  const agentB = await createA2ATestAgentServer();
  t.after(() => agentA.close());
  t.after(() => agentB.close());

  const validation = await runM2ETwoMachinePrivateSshValidation({
    agentAUrl: agentA.baseUrl,
    agentBUrl: agentB.baseUrl,
    log() {},
  });
  t.after(() => validation.close());

  assert.match(
    validation.roomBaseUrl,
    /^http:\/\/127\.0\.0\.1:\d+\/rooms\/[A-Za-z0-9_-]+$/,
  );
  assert.equal(validation.messages.length, 4);
  assert.deepEqual(
    validation.messages.map((event) => event.side),
    ["A", "B", "A", "B"],
  );
  assert.ok(
    validation.messages.every(
      (event) => event.payload.content.trim().length > 0,
    ),
  );
});
