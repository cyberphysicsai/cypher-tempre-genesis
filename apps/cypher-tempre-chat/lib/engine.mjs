import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../engine_bridge.py", import.meta.url));
export async function engine(request, { signal, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.CT_CHAT_PYTHON ||
        (process.platform === "win32" ? "python" : "python3"),
      [script],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    );
    let output = "";
    let diagnostics = "";
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (err) reject(err);
      else resolve(value);
    };
    const fail = (message, code = "ENGINE_ERROR") =>
      Object.assign(new Error(message), { code, status: 422 });
    const abort = () => {
      child.kill();
      finish(
        fail(
          "Operation cancelled before completion. Verify the chain before retrying.",
          "CANCELLED",
        ),
      );
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        fail(
          "The engine timed out. Verify the chain before retrying.",
          "ENGINE_TIMEOUT",
        ),
      );
    }, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) return abort();
    child.on("error", () =>
      finish(
        fail(
          "Python could not be started. Install Python 3.10+ or set CT_CHAT_PYTHON.",
          "PYTHON_UNAVAILABLE",
        ),
      ),
    );
    child.stdout.on("data", (b) => {
      output += b.toString("utf8");
      if (output.length > 24 * 1024 * 1024) {
        child.kill();
        finish(fail("Engine response exceeded the local transport limit."));
      }
    });
    child.stderr.on("data", (b) => {
      if (diagnostics.length < 4096) diagnostics += b.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("close", () => {
      if (done) return;
      try {
        const value = JSON.parse(output);
        if (!value.ok) {
          const error = fail(
              value.error?.message || "The engine refused this operation.",
              value.error?.code || "ENGINE_REJECTED",
            );
          if (value.error?.code === "POI_REJECTED" && value.verdict && typeof value.verdict === "object")
            error.nativeVerdict = value.verdict;
          return finish(error);
        }
        finish(null, value);
      } catch {
        finish(
          fail(
            "The engine returned an invalid response. No generated answer was released.",
            "ENGINE_PROTOCOL",
          ),
        );
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}
