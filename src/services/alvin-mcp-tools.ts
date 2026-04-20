/**
 * v4.13 — Alvin's custom MCP tools, registered with the Claude Agent SDK
 * via `createSdkMcpServer()`.
 *
 * Currently exposes a single tool:
 *   `alvin_dispatch_agent(prompt, description)` — spawns a truly
 *   detached `claude -p` subprocess that's independent of the parent
 *   SDK lifecycle. Claude should prefer this over built-in
 *   `Task(run_in_background: true)` for any long-running work on
 *   Telegram so the main Telegram session isn't blocked by the SDK's
 *   task-notification injection mechanism.
 *
 * The MCP server is created lazily per-query so each query gets fresh
 * handler context (chatId/userId/sessionKey) via a closure.
 */
import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { dispatchDetachedAgent } from "./alvin-dispatch.js";

export interface AlvinDispatchContext {
  /**
   * v4.14 — widened to `number | string` for Slack/Discord/WhatsApp
   * channel IDs. Telegram keeps passing number.
   */
  chatId: number | string;
  userId: number | string;
  sessionKey: string;
  /**
   * v4.14 — Platform for delivery routing. Default "telegram" when
   * caller omits it (keeps Telegram behavior identical to v4.13.x).
   */
  platform?: "telegram" | "slack" | "discord" | "whatsapp";
  /** Optional working directory to pass into the spawned subprocess. */
  cwd?: string;
}

/**
 * Build an MCP server bound to a specific turn's context. Pass the
 * returned instance under `mcpServers: { alvin: <instance> }` in the
 * query options.
 */
export function buildAlvinMcpServer(ctx: AlvinDispatchContext) {
  return createSdkMcpServer({
    name: "alvin",
    version: "4.13.0",
    tools: [
      tool(
        "dispatch_agent",
        [
          "Dispatch a TRULY DETACHED background sub-agent that runs",
          "independently of this session. Use this for ANY long-running",
          "work on Telegram/Slack/Discord/WhatsApp — research tasks,",
          "audits, multi-page scraping, deep analysis — so the main",
          "user session stays responsive and the user can keep chatting",
          "with you while the sub-agent works.",
          "",
          "HOW IT DIFFERS FROM Task(run_in_background: true):",
          "- The built-in Task tool's subprocess is tied to this session,",
          "  so aborting the session also kills the sub-agent mid-work.",
          "- `alvin_dispatch.dispatch_agent` spawns a completely",
          "  independent `claude -p` subprocess that survives any abort,",
          "  crash, or restart of the main bot.",
          "",
          "WHEN TO USE:",
          "- Any audit/research visiting >2 URLs or reading >5 files",
          "- Full-repo scans, code reviews, SEO/security/perf audits",
          "- Anything you'd describe as 'thorough' or 'takes a few min'",
          "",
          "HOW THE RESULT GETS BACK TO THE USER:",
          "- The tool returns { agentId, outputFile } immediately.",
          "- The bot's async-agent watcher polls the outputFile and",
          "  delivers the final result as a separate chat message when",
          "  the sub-agent completes (success, failure, or 5-min",
          "  staleness).",
          "- Your job after calling this tool: tell the user ONE short",
          "  sentence about what you dispatched, then END your turn.",
          "  Do NOT wait. Do NOT poll the outputFile yourself.",
        ].join("\n"),
        {
          prompt: z
            .string()
            .describe(
              "The full prompt for the sub-agent. Be specific and self-contained — the sub-agent has no access to this conversation's context and will see only this prompt.",
            ),
          description: z
            .string()
            .describe(
              "Short human-readable title (e.g. 'SEO audit example.com', 'Research topic X'). Shown to the user when the result arrives.",
            ),
        },
        async (args): Promise<{
          content: Array<{ type: "text"; text: string }>;
          isError?: boolean;
        }> => {
          try {
            const result = dispatchDetachedAgent({
              prompt: args.prompt,
              description: args.description,
              chatId: ctx.chatId,
              userId: ctx.userId,
              sessionKey: ctx.sessionKey,
              platform: ctx.platform,
              cwd: ctx.cwd,
            });
            return {
              content: [
                {
                  type: "text",
                  text:
                    `✅ Background sub-agent dispatched.\n` +
                    `agentId: ${result.agentId}\n` +
                    `output_file: ${result.outputFile}\n` +
                    `The user will receive the result as a separate message when the sub-agent completes.\n` +
                    `End your turn now. Do not wait for the result — it arrives asynchronously.`,
                },
              ],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              content: [
                {
                  type: "text",
                  text: `⚠️ Failed to dispatch background agent: ${msg}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
