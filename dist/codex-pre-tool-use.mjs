import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/bin/codex-pre-tool-use.ts
import { json } from "node:stream/consumers";

// src/hooks/codex-command.ts
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
function currentPaths(moduleUrl) {
  const uid = process.getuid();
  return {
    execPath: process.execPath,
    runnerPath: fileURLToPath(new URL("./codex-runner.mjs", moduleUrl)),
    captureDir: `${realpathSync("/tmp")}/phi-guard-${uid}`,
    uid
  };
}
var quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`;
var escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
var UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
var BASE64 = "(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?";
function wrapCommand({ execPath, runnerPath, captureDir }, command, id = randomUUID()) {
  const capturePath = `${captureDir}/${id}.out`;
  const encoded = Buffer.from(command, "utf8").toString("base64");
  return `${quote(execPath)} ${quote(runnerPath)} ${quote(capturePath)} ${encoded}`;
}
function parseWrapped({ execPath, runnerPath, captureDir }, command) {
  const form = new RegExp(
    `^${escapeRegExp(quote(execPath))} ${escapeRegExp(quote(runnerPath))} '(${escapeRegExp(quote(captureDir).slice(1, -1))}/${UUID}\\.out)' ${BASE64}$`
  );
  const quotedPath = form.exec(command)?.[1];
  return quotedPath?.replaceAll("'\\''", "'");
}
function verifyCaptureDir(dir, uid) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 63) !== 0) {
    throw Object.assign(new Error("capture dir failed verification"), { name: "UnsafeCaptureDir" });
  }
}
function ensureCaptureDir(dir, uid) {
  try {
    mkdirSync(dir, { mode: 448 });
  } catch (error) {
    if (failureName(error) !== "EEXIST") throw error;
  }
  verifyCaptureDir(dir, uid);
}
function failureName(error) {
  const code = error?.code;
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return code;
  return error instanceof Error ? error.name : "UnknownError";
}

// src/hooks/codex-pre-tool-use.ts
function rewriteCommand(input, paths) {
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || command === "") {
    throw Object.assign(new Error("missing tool_input.command"), { name: "InvalidHookInput" });
  }
  if (parseWrapped(paths, command) !== void 0) return void 0;
  ensureCaptureDir(paths.captureDir, paths.uid);
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { command: wrapCommand(paths, command) }
    }
  };
}

// src/hooks/deadline.ts
var HOOK_DEADLINE_MS = 15e3;
async function withDeadline(work, ms) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error("hook deadline exceeded"), { name: "HookDeadlineExceeded" })),
      ms
    );
    timer.unref();
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}
function exitAfterWrite(stream, text, code) {
  stream.write(text ?? "", () => process.exit(code));
}

// src/bin/codex-pre-tool-use.ts
try {
  const output = await withDeadline(
    (async () => rewriteCommand(await json(process.stdin), currentPaths(import.meta.url)))(),
    HOOK_DEADLINE_MS
  );
  exitAfterWrite(process.stdout, output && JSON.stringify(output), 0);
} catch (error) {
  exitAfterWrite(
    process.stderr,
    `phi-guard: command blocked, it could not be routed through the output scanner (${failureName(error)})
`,
    2
  );
}
