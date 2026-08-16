import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComspecCommandLine,
  getEnvValue,
  mergeEffectiveEnv,
  resolveConfiguredCommand,
} from "../local-agent-edge/command-resolution.js";

function fakeAccess(existing) {
  const probes = [];
  // Windows filesystem lookup is case-insensitive, so existence matches
  // regardless of how the resolver writes the PATHEXT casing; probes still
  // record the exact candidate strings for order assertions.
  const existingLower = new Set([...existing].map((candidate) => candidate.toLowerCase()));
  return {
    probes,
    fn: async (candidate) => {
      probes.push(candidate);
      if (existingLower.has(candidate.toLowerCase())) return undefined;
      const error = new Error(`ENOENT: ${candidate}`);
      error.code = "ENOENT";
      throw error;
    },
  };
}

test("bare command resolves through PATH + PATHEXT to a .cmd batch with case-insensitive env keys", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\npm\\claude.CMD"]));
  const resolved = await resolveConfiguredCommand({
    command: "claude",
    env: { Path: "C:\\tools\\npm", Pathext: ".CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, {
    path: "C:\\tools\\npm\\claude.CMD",
    type: "batch",
  });
  // exact probe first, then the single PATHEXT extension
  assert.deepEqual(probes, [
    "C:\\tools\\npm\\claude",
    "C:\\tools\\npm\\claude.CMD",
  ]);
});

test("bare .exe command resolves to a native executable and is not re-extended", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\foo.exe"]));
  const resolved = await resolveConfiguredCommand({
    command: "foo.exe",
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, { path: "C:\\tools\\foo.exe", type: "native" });
  // a name that already carries a supported extension is never re-extended
  assert.deepEqual(probes, ["C:\\tools\\foo.exe"]);
});

test("bare .cmd command resolves to a batch and is not re-extended", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\foo.cmd"]));
  const resolved = await resolveConfiguredCommand({
    command: "foo.cmd",
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, { path: "C:\\tools\\foo.cmd", type: "batch" });
  assert.deepEqual(probes, ["C:\\tools\\foo.cmd"]);
});

test("PATH directory order wins over PATHEXT order", async () => {
  const { fn } = fakeAccess(new Set([
    "C:\\a\\tool.cmd",
    "C:\\b\\tool.exe",
  ]));
  const resolved = await resolveConfiguredCommand({
    command: "tool",
    env: { PATH: "C:\\a;C:\\b", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, { path: "C:\\a\\tool.CMD", type: "batch" });
});

test("PATHEXT order selects the preferred extension within a directory", async () => {
  const existing = new Set(["C:\\tools\\foo.exe", "C:\\tools\\foo.cmd"]);
  const cmdFirst = await resolveConfiguredCommand({
    command: "foo",
    env: { PATH: "C:\\tools", PATHEXT: ".CMD;.EXE" },
    platform: "win32",
    accessFn: fakeAccess(existing).fn,
  });
  // the resolved path keeps the PATHEXT casing of the matched candidate
  assert.deepEqual(cmdFirst, { path: "C:\\tools\\foo.CMD", type: "batch" });

  const exeFirst = await resolveConfiguredCommand({
    command: "foo",
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fakeAccess(existing).fn,
  });
  assert.deepEqual(exeFirst, { path: "C:\\tools\\foo.EXE", type: "native" });
});

test("missing PATHEXT uses the product fallback executable subset", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\claude.CMD"]));
  const resolved = await resolveConfiguredCommand({
    command: "claude",
    env: { PATH: "C:\\tools" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, {
    path: "C:\\tools\\claude.CMD",
    type: "batch",
  });
  // product-supported fallback: .COM, .EXE, .BAT, then .CMD
  assert.deepEqual(probes, [
    "C:\\tools\\claude",
    "C:\\tools\\claude.COM",
    "C:\\tools\\claude.EXE",
    "C:\\tools\\claude.BAT",
    "C:\\tools\\claude.CMD",
  ]);
});

test("absolute .cmd path resolves exactly and is not re-extended", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\run.cmd"]));
  const resolved = await resolveConfiguredCommand({
    command: "C:\\tools\\run.cmd",
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, { path: "C:\\tools\\run.cmd", type: "batch" });
  assert.deepEqual(probes, ["C:\\tools\\run.cmd"]);
});

test("extension-less absolute path probes PATHEXT", async () => {
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\mycli.EXE"]));
  const resolved = await resolveConfiguredCommand({
    command: "C:\\tools\\mycli",
    env: { PATH: "C:\\tools", PATHEXT: ".EXE;.CMD" },
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, { path: "C:\\tools\\mycli.EXE", type: "native" });
  assert.deepEqual(probes, ["C:\\tools\\mycli", "C:\\tools\\mycli.EXE"]);
});

test("unsupported script-type PATHEXT candidates are skipped", async () => {
  const onlyVbs = await resolveConfiguredCommand({
    command: "foo",
    env: { PATH: "C:\\tools", PATHEXT: ".VBS;.CMD" },
    platform: "win32",
    accessFn: fakeAccess(new Set(["C:\\tools\\foo.VBS"])).fn,
  });
  assert.equal(onlyVbs, null);

  const withCmd = await resolveConfiguredCommand({
    command: "foo",
    env: { PATH: "C:\\tools", PATHEXT: ".VBS;.CMD" },
    platform: "win32",
    accessFn: fakeAccess(new Set([
      "C:\\tools\\foo.VBS",
      "C:\\tools\\foo.CMD",
    ])).fn,
  });
  assert.deepEqual(withCmd, { path: "C:\\tools\\foo.CMD", type: "batch" });
});

test("no PATH/PATHEXT match resolves to null", async () => {
  const resolved = await resolveConfiguredCommand({
    command: "missing",
    env: { PATH: "C:\\tools", PATHEXT: ".CMD" },
    platform: "win32",
    accessFn: fakeAccess(new Set()).fn,
  });
  assert.equal(resolved, null);
});

test(
  "non-win32 keeps the existing host resolution behavior",
  // This test only validates the real non-win32 host path semantics
  // (host node:path delimiter/join/isAbsolute); it cannot run on a
  // Windows host, where PATH uses win32 semantics.
  { skip: process.platform === "win32" },
  async () => {
    const absolute = await resolveConfiguredCommand({
      command: "/usr/bin/node",
      env: { PATH: "/usr/bin" },
      accessFn: fakeAccess(new Set(["/usr/bin/node"])).fn,
    });
    assert.deepEqual(absolute, { path: "/usr/bin/node", type: "native" });

    const viaPath = await resolveConfiguredCommand({
      command: "tool",
      env: { PATH: "/a:/b" },
      accessFn: fakeAccess(new Set(["/b/tool"])).fn,
    });
    assert.deepEqual(viaPath, { path: "tool", type: "native" });

    const missing = await resolveConfiguredCommand({
      command: "tool",
      env: { PATH: "/a:/b" },
      accessFn: fakeAccess(new Set()).fn,
    });
    assert.equal(missing, null);
  },
);

test("mergeEffectiveEnv dedupes win32 case variants and override wins", () => {
  assert.deepEqual(
    mergeEffectiveEnv({
      baseEnv: { Path: "C:\\base", TERM: "x" },
      overrideEnv: { PATH: "C:\\override" },
      platform: "win32",
    }),
    { PATH: "C:\\override", TERM: "x" },
  );

  assert.deepEqual(
    mergeEffectiveEnv({
      baseEnv: { PATH: "C:\\base" },
      overrideEnv: { path: "C:\\override" },
      platform: "win32",
    }),
    { path: "C:\\override" },
  );

  assert.deepEqual(
    mergeEffectiveEnv({
      baseEnv: { Path: "C:\\base" },
      overrideEnv: {},
      platform: "win32",
    }),
    { Path: "C:\\base" },
  );
});

test("mergeEffectiveEnv stays a plain spread off win32", () => {
  assert.deepEqual(
    mergeEffectiveEnv({
      baseEnv: { A: "1", B: "base" },
      overrideEnv: { A: "2" },
      platform: "darwin",
    }),
    { A: "2", B: "base" },
  );
});

test("getEnvValue reads win32 keys case-insensitively", () => {
  assert.equal(
    getEnvValue({ ComSpec: "C:\\Windows\\System32\\cmd.exe" }, "COMSPEC", "win32"),
    "C:\\Windows\\System32\\cmd.exe",
  );
  assert.equal(getEnvValue({ PATHEXT: ".CMD" }, "pathext", "win32"), ".CMD");
  assert.equal(getEnvValue({}, "COMSPEC", "win32"), undefined);
});

test("getEnvValue stays case-sensitive off win32", () => {
  assert.equal(getEnvValue({ PATH: "a" }, "PATH", "darwin"), "a");
  assert.equal(getEnvValue({ PATH: "a" }, "Path", "darwin"), undefined);
});

test("config env PATH/PATHEXT override drives resolution from the merged env", async () => {
  const effectiveEnv = mergeEffectiveEnv({
    baseEnv: { Path: "C:\\empty" },
    overrideEnv: { PATH: "C:\\tools", PATHEXT: ".CMD" },
    platform: "win32",
  });
  const { fn, probes } = fakeAccess(new Set(["C:\\tools\\claude.CMD"]));
  const resolved = await resolveConfiguredCommand({
    command: "claude",
    env: effectiveEnv,
    platform: "win32",
    accessFn: fn,
  });
  assert.deepEqual(resolved, {
    path: "C:\\tools\\claude.CMD",
    type: "batch",
  });
  assert.deepEqual(probes, ["C:\\tools\\claude", "C:\\tools\\claude.CMD"]);
});

test("buildComspecCommandLine quotes path and args for cmd.exe /d /s /c", () => {
  assert.equal(
    buildComspecCommandLine({
      path: "C:\\tools\\my tool.cmd",
      args: ["--flag", "a b", "x&y|z<q>r^s"],
    }),
    '""C:\\tools\\my tool.cmd" "--flag" "a b" "x&y|z<q>r^s""',
  );
  assert.equal(
    buildComspecCommandLine({ path: "C:\\tools\\foo.cmd", args: [] }),
    '""C:\\tools\\foo.cmd""',
  );
});

test("buildComspecCommandLine rejects tokens that cannot pass cmd.exe safely", () => {
  for (const bad of ['say"hi', "100%", "bang!", "line\nbreak"]) {
    assert.throws(
      () => buildComspecCommandLine({ path: "C:\\tools\\x.cmd", args: [bad] }),
      /Windows command processor/,
    );
  }
  assert.throws(
    () => buildComspecCommandLine({ path: 'C:\\to"ols\\x.cmd', args: [] }),
    /Windows command processor/,
  );
});
