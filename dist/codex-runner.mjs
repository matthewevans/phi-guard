import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/bin/codex-runner.ts
import { spawn } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import { constants as osConstants } from "node:os";

// src/hooks/codex-command.ts
function failureName(error) {
  const code = error?.code;
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : "UnknownError";
}

// src/hooks/deadline.ts
function exitAfterWrite(stream, text, code) {
  stream.write(text ?? "", () => process.exit(code));
}

// src/bin/codex-runner.ts
var MARKER = "[phi-guard: output captured for scanning]\n";
var withheld = (why) => `[phi-guard: output withheld, ${why}]
`;
var [capturePath, encoded] = process.argv.slice(2);
var fd;
try {
  if (!capturePath || !encoded) throw Object.assign(new Error("missing arguments"), { name: "InvalidArguments" });
  fd = openSync(capturePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 384);
  const child = spawn(process.env.SHELL || "/bin/sh", ["-c", Buffer.from(encoded, "base64").toString("utf8")], {
    detached: true,
    stdio: ["pipe", fd, fd]
  });
  const stdin = child.stdin;
  stdin.on("error", () => {
  });
  process.stdin.pipe(stdin);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      try {
        process.kill(-child.pid, signal);
      } catch {
      }
    });
  }
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (exitCode, signal) => resolve(signal ? 128 + osConstants.signals[signal] : exitCode ?? 1));
  });
  writeSync(fd, `
[exit code ${code}]
`);
  closeSync(fd);
  exitAfterWrite(process.stdout, MARKER, code);
} catch (error) {
  const why = fd === void 0 ? "capture dir not writable under the current sandbox" : "runner failed";
  const line = withheld(`${why} (${failureName(error)})`);
  if (fd !== void 0) {
    try {
      writeSync(fd, line);
      closeSync(fd);
    } catch {
    }
  }
  exitAfterWrite(process.stdout, line, 1);
}
