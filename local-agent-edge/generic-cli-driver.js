import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 1_000;

export function createGenericCliDriver({
  command,
  args = [],
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (typeof command !== "string" || !command.trim()) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (typeof cwd !== "string" || !cwd.trim()) {
    throw new TypeError("cwd must be a non-empty string");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive number");
  }
  if (!env || typeof env !== "object") {
    throw new TypeError("env must be an object");
  }

  const fixedArgs = [...args];

  return Object.freeze({
    run(prompt) {
      if (typeof prompt !== "string") {
        return Promise.reject(new TypeError("prompt must be a string"));
      }
      return spawnOnce({
        command,
        args: fixedArgs,
        cwd,
        timeoutMs,
        env,
        prompt,
      });
    },
  });
}

function spawnOnce({
  command,
  args,
  cwd,
  timeoutMs,
  env,
  prompt,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer = null;

    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
    };

    const failEarly = (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      signalChild(child, "SIGTERM");
      reject(error);
    };

    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
      }, KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.stdin.on("error", (error) => {
      failEarly(error);
    });

    child.once("error", (error) => {
      failEarly(error);
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimers();

      if (timedOut) {
        reject(new Error(`CLI process timed out after ${timeoutMs}ms`));
        return;
      }
      if (signal) {
        reject(new Error(`CLI process terminated by ${signal}`));
        return;
      }
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || "no output";
        reject(new Error(`CLI process failed with code ${code}: ${detail}`));
        return;
      }

      const reply = stdout.trim();
      if (!reply) {
        reject(new Error("CLI process returned empty stdout"));
        return;
      }

      resolve(reply);
    });

    child.stdin.end(prompt);
  });
}

function signalChild(child, signal) {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }

  if (!Number.isInteger(child.pid)) return;

  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}
