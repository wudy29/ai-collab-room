# Local Agent Edge + Generic CLI Driver 实施计划

日期：2026-08-11

目标：不改 Room/connector/core，只新增 localhost Edge、Generic CLI Driver 和 Claude Code 首个 profile。

全局约束：只新增 `local-agent-edge/` 三个实现文件与 `test/local-agent-edge.test.js`；删除旧 Claude adapter spec/plan；不改 `src/`、package.json、lockfile 或依赖；不重试、不持久化、不增加 registry/framework/session manager/UI；不 commit，不 push。

## Task 1 — Generic CLI Driver

1. RED：先写 fake CLI 测试，覆盖固定 argv、stdin、cwd、stdout、非零退出、空 stdout、timeout；实现文件不存在时运行并确认真实 RED。
2. GREEN：创建 `generic-cli-driver.js`，只实现一次 spawn 与 `run(prompt)`；目标测试全绿。

## Task 2 — Local Agent Edge

1. RED：增加 Agent Card、localhost、现有 A2A message/send、driver success/failure 测试；`a2a-edge.js` 不存在时确认失败。
2. GREEN：复用现有 `@a2a-js/sdk` 和 express，成功返回 completed task，失败返回 failed task；目标测试全绿。

## Task 3 — Claude Code profile

1. RED：验证 session/workdir 必填；fake Claude 收到精确 `-p --resume <session-id>`；prompt 走 stdin、cwd 正确、无持久化；`claude-code.js` 不存在时确认失败。
2. GREEN：只做配置校验与 Generic CLI Driver + Edge 组合；目标测试全绿。

## Task 4 — Verification

运行 `node --check`、目标测试、`npm test`、`git diff --check` 和最终路径范围检查。通过即停，不开始真实 Claude session、网络、认证、并发或多用户工作。
