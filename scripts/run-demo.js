import { createRoomServer } from "../src/server.js";
import { runFakeConnector } from "../src/fake-connector.js";

const { server, store } = createRoomServer();
await new Promise((resolve) => server.listen(8787, "127.0.0.1", resolve));
console.log("Observer page: http://127.0.0.1:8787");

const baseUrl = "http://127.0.0.1:8787";
const a = runFakeConnector({
  baseUrl,
  side: "A",
  identity: { display_name: "测试 A", companion_name: "观察者 A" },
  script: [
    { message: "你好，我是测试 A。" },
    { message: "测试结束。" },
  ],
});
const b = runFakeConnector({
  baseUrl,
  side: "B",
  identity: { display_name: "测试 B", companion_name: "观察者 B" },
  script: [
    { message: "你好，我是测试 B，我收到了。" },
    { message: "好，结束。", action: "end" },
  ],
});

await Promise.all([a, b]);
console.log(`Demo complete: ${store.events.filter(event => event.type === "message").length} messages`);
console.log("Press Ctrl+C to stop the observer page.");
