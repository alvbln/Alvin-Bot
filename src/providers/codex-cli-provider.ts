/**
 * Codex CLI Provider
 *
 * Wraps OpenAI's Codex CLI as a provider, similar to how Claude SDK Provider
 * wraps the Claude CLI. Uses `codex exec` for non-interactive completions.
 *
 * Requires: Codex CLI installed & logged in (`codex login --device-auth`)
 */

import { spawn } from "child_process";
import type { Provider, ProviderConfig, QueryOptions, StreamChunk } from "./types.js";

export class CodexCLIProvider implements Provider {
  readonly config: ProviderConfig;

  constructor(config?: Partial<ProviderConfig>) {
    this.config = {
      type: "codex-cli" as ProviderConfig["type"],
      name: "Codex CLI (OpenAI)",
      model: "gpt-5.4",
      supportsTools: true,
      supportsVision: false,
      supportsStreaming: true,
      ...config,
    };
  }

  async *query(options: QueryOptions): AsyncGenerator<StreamChunk> {
    const args = [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s", "read-only",
      "-m", this.config.model,
    ];

    if (options.workingDir) {
      args.push("-C", options.workingDir);
    }

    // Build the prompt with system context
    let fullPrompt = options.prompt;
    if (options.systemPrompt) {
      fullPrompt = `${options.systemPrompt}\n\n${fullPrompt}`;
    }

    args.push(fullPrompt);

    try {
      const result = await this.execCodex(args, options.abortSignal);

      if (result.trim()) {
        yield {
          type: "text",
          text: result,
          delta: result,
        };
      }

      yield {
        type: "done",
        text: result,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes("abort")) {
        yield { type: "error", error: "Request aborted" };
      } else {
        yield {
          type: "error",
          error: `Codex CLI error: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { execSync } = await import("child_process");
      const output = execSync("codex login status 2>&1", {
        stdio: "pipe",
        timeout: 5000,
        encoding: "utf-8",
      });
      return output.includes("Logged in");
    } catch {
      return false;
    }
  }

  getInfo(): { name: string; model: string; status: string } {
    return {
      name: this.config.name,
      model: this.config.model,
      status: "✅ Codex CLI (ChatGPT auth)",
    };
  }

  private execCodex(args: string[], abortSignal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn("codex", args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, NO_COLOR: "1" },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0 || stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr.trim() || `codex exec exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });

      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          proc.kill("SIGTERM");
          reject(new Error("abort"));
        });
      }
    });
  }
}
