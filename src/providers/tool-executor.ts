/**
 * Tool Executor — Executes tool calls for non-SDK providers.
 *
 * Provides core agent capabilities (shell, file read/write, web fetch)
 * to any OpenAI-compatible provider that supports function calling.
 *
 * This bridges the gap between Claude SDK (built-in tools) and other
 * providers (Groq, NVIDIA, Gemini, etc.) — giving them all agent powers.
 */

import { execSync } from "child_process";
import fs from "fs";
import { resolve } from "path";

// ── Tool Definitions (OpenAI function calling format) ───────────────────────

export const AGENT_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description: "Execute a shell command and return the output. Use for: running CLI tools, checking system state, installing packages, processing files, git operations, etc. Timeout: 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute (bash). Example: 'ls -la', 'which ffmpeg', 'curl wttr.in/Berlin'"
          },
          workingDir: {
            type: "string",
            description: "Working directory (optional, defaults to user's configured dir)"
          }
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the text content. Use for: reading configs, code files, documents, logs, memory files, etc.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file"
          },
          maxLines: {
            type: "number",
            description: "Maximum number of lines to read (optional, default: all)"
          }
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Use for: creating files, saving results, writing memory, updating configs.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute or relative path to the file"
          },
          content: {
            type: "string",
            description: "Content to write"
          },
          append: {
            type: "boolean",
            description: "Append instead of overwrite (default: false)"
          }
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return the content as text/markdown. Use for: reading web pages, APIs, documentation, search results.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL to fetch (http or https)"
          },
          maxChars: {
            type: "number",
            description: "Maximum characters to return (default: 10000)"
          }
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "web_search",
      description: "Search the web and return results. Use for: looking up information, finding answers, research.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query"
          }
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_directory",
      description: "List files and directories at a given path. Returns names, types (file/dir), and sizes. Use for: exploring project structures, finding files, checking what exists.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default: current working directory)"
          },
          recursive: {
            type: "boolean",
            description: "List recursively (max 3 levels deep, default: false)"
          }
        },
        required: [],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "python_execute",
      description: "Execute a Python 3 script and return stdout/stderr. Use for: data processing, creating Excel/CSV files, complex calculations, JSON/XML transformation, image processing, PDF generation, chart creation, and any task that benefits from Python libraries (openpyxl, pandas, matplotlib, Pillow, etc.).",
      parameters: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Python 3 code to execute. Can use installed pip packages. Use print() for output."
          },
          workingDir: {
            type: "string",
            description: "Working directory for the script (optional)"
          }
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description: "Make a precise edit to a file by replacing exact text. More surgical than write_file — preserves the rest of the file. Use for: fixing bugs, updating configs, changing specific lines.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit"
          },
          oldText: {
            type: "string",
            description: "Exact text to find (must match exactly including whitespace)"
          },
          newText: {
            type: "string",
            description: "Replacement text"
          }
        },
        required: ["path", "oldText", "newText"],
      },
    },
  },
];

// ── Tool Execution ──────────────────────────────────────────────────────────

export interface ToolResult {
  name: string;
  result: string;
  error?: boolean;
}

/**
 * Execute a tool call and return the result.
 */
export function executeTool(
  name: string,
  args: Record<string, any>,
  workingDir?: string
): ToolResult {
  try {
    switch (name) {
      case "run_shell":
        return executeShell(args.command, args.workingDir || workingDir);
      case "read_file":
        return executeReadFile(args.path, args.maxLines, workingDir);
      case "write_file":
        return executeWriteFile(args.path, args.content, args.append, workingDir);
      case "web_fetch":
        return executeWebFetch(args.url, args.maxChars);
      case "web_search":
        return executeWebSearch(args.query);
      case "list_directory":
        return executeListDirectory(args.path || workingDir, args.recursive, workingDir);
      case "python_execute":
        return executePython(args.code, args.workingDir || workingDir);
      case "edit_file":
        return executeEditFile(args.path, args.oldText, args.newText, workingDir);
      default:
        return { name, result: `Unknown tool: ${name}`, error: true };
    }
  } catch (err) {
    return {
      name,
      result: `Error: ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}

// ── Individual Tool Implementations ─────────────────────────────────────────

function executeShell(command: string, cwd?: string): ToolResult {
  // Security: block obviously dangerous commands
  const blocked = ["rm -rf /", "mkfs", "dd if=/dev/zero", "> /dev/sda"];
  if (blocked.some(b => command.includes(b))) {
    return { name: "run_shell", result: "Command blocked for safety.", error: true };
  }

  try {
    const output = execSync(command, {
      encoding: "utf-8",
      cwd: cwd || process.cwd(),
      timeout: 30_000,
      maxBuffer: 1024 * 1024, // 1MB
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });
    // Truncate very long output
    const truncated = output.length > 8000
      ? output.substring(0, 8000) + `\n... (truncated, ${output.length} chars total)`
      : output;
    return { name: "run_shell", result: truncated || "(no output)" };
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString().substring(0, 2000) : "";
    const stdout = err.stdout ? err.stdout.toString().substring(0, 2000) : "";
    return {
      name: "run_shell",
      result: `Exit code ${err.status || 1}\n${stdout}\n${stderr}`.trim(),
      error: true,
    };
  }
}

function executeReadFile(path: string, maxLines?: number, cwd?: string): ToolResult {
  const fullPath = path.startsWith("/") ? path : resolve(cwd || process.cwd(), path);
  try {
    let content = fs.readFileSync(fullPath, "utf-8");
    if (maxLines && maxLines > 0) {
      const lines = content.split("\n");
      if (lines.length > maxLines) {
        content = lines.slice(0, maxLines).join("\n") + `\n... (${lines.length} lines total)`;
      }
    }
    if (content.length > 20000) {
      content = content.substring(0, 20000) + `\n... (truncated, ${content.length} chars)`;
    }
    return { name: "read_file", result: content };
  } catch (err) {
    return { name: "read_file", result: `File not found or not readable: ${fullPath}`, error: true };
  }
}

function executeWriteFile(path: string, content: string, append?: boolean, cwd?: string): ToolResult {
  const fullPath = path.startsWith("/") ? path : resolve(cwd || process.cwd(), path);
  try {
    // Ensure directory exists
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (append) {
      fs.appendFileSync(fullPath, content);
    } else {
      fs.writeFileSync(fullPath, content);
    }
    return { name: "write_file", result: `✅ Written to ${fullPath} (${content.length} chars)` };
  } catch (err) {
    return { name: "write_file", result: `Write failed: ${err instanceof Error ? err.message : err}`, error: true };
  }
}

function executeWebFetch(url: string, maxChars?: number): ToolResult {
  try {
    // Use curl for simplicity and reliability
    const max = maxChars || 10000;
    const output = execSync(
      `curl -sL --max-time 15 --max-filesize 5000000 "${url}" | head -c ${max * 2}`,
      { encoding: "utf-8", timeout: 20_000, maxBuffer: 5 * 1024 * 1024 }
    );

    // Basic HTML → text conversion
    let text = output
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length > max) text = text.substring(0, max) + "...";
    return { name: "web_fetch", result: text || "(empty response)" };
  } catch (err) {
    return { name: "web_fetch", result: `Fetch failed: ${err instanceof Error ? err.message : err}`, error: true };
  }
}

function executeWebSearch(query: string): ToolResult {
  try {
    // Use DuckDuckGo instant answer API (no key needed)
    const encoded = encodeURIComponent(query);
    const output = execSync(
      `curl -sL "https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1"`,
      { encoding: "utf-8", timeout: 10_000 }
    );

    const data = JSON.parse(output);
    const results: string[] = [];

    if (data.AbstractText) {
      results.push(`📝 ${data.AbstractText}`);
      if (data.AbstractURL) results.push(`   Source: ${data.AbstractURL}`);
    }

    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics.slice(0, 5)) {
        if (topic.Text) {
          results.push(`• ${topic.Text}`);
          if (topic.FirstURL) results.push(`  ${topic.FirstURL}`);
        }
      }
    }

    if (results.length === 0) {
      // Fallback: use curl with a search engine
      const fallback = execSync(
        `curl -sL "https://html.duckduckgo.com/html/?q=${encoded}" | grep -oP '<a rel="nofollow" class="result__a" href="[^"]*">[^<]*</a>' | head -5 | sed 's/<[^>]*>//g'`,
        { encoding: "utf-8", timeout: 10_000 }
      ).trim();
      if (fallback) return { name: "web_search", result: fallback };
      return { name: "web_search", result: `No results for "${query}". Try a different query or use web_fetch with a specific URL.` };
    }

    return { name: "web_search", result: results.join("\n") };
  } catch (err) {
    return { name: "web_search", result: `Search failed: ${err instanceof Error ? err.message : err}`, error: true };
  }
}

function executeListDirectory(dirPath: string, recursive?: boolean, cwd?: string): ToolResult {
  const fullPath = dirPath?.startsWith("/") ? dirPath : resolve(cwd || process.cwd(), dirPath || ".");
  try {
    if (!fs.existsSync(fullPath)) {
      return { name: "list_directory", result: `Directory not found: ${fullPath}`, error: true };
    }

    const entries: string[] = [];

    function listDir(dir: string, depth: number) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const indent = "  ".repeat(depth);
      for (const item of items) {
        if (item.name.startsWith(".") && depth === 0 && items.length > 20) continue; // skip dotfiles in large dirs
        const itemPath = resolve(dir, item.name);
        if (item.isDirectory()) {
          entries.push(`${indent}📁 ${item.name}/`);
          if (recursive && depth < 3) {
            listDir(itemPath, depth + 1);
          }
        } else {
          try {
            const stats = fs.statSync(itemPath);
            const size = stats.size < 1024 ? `${stats.size}B`
              : stats.size < 1048576 ? `${(stats.size / 1024).toFixed(1)}KB`
              : `${(stats.size / 1048576).toFixed(1)}MB`;
            entries.push(`${indent}📄 ${item.name} (${size})`);
          } catch {
            entries.push(`${indent}📄 ${item.name}`);
          }
        }
      }
    }

    listDir(fullPath, 0);
    const result = entries.length > 0
      ? `${fullPath}:\n${entries.join("\n")}`
      : `${fullPath}: (empty directory)`;

    // Truncate if huge
    return { name: "list_directory", result: result.length > 8000 ? result.substring(0, 8000) + "\n..." : result };
  } catch (err) {
    return { name: "list_directory", result: `Error listing directory: ${err instanceof Error ? err.message : err}`, error: true };
  }
}

function executePython(code: string, cwd?: string): ToolResult {
  try {
    // Write code to temp file to avoid shell escaping issues
    const tmpFile = `/tmp/alvin-bot-py-${Date.now()}.py`;
    fs.writeFileSync(tmpFile, code);

    try {
      const output = execSync(`python3 "${tmpFile}"`, {
        encoding: "utf-8",
        cwd: cwd || process.cwd(),
        timeout: 60_000, // 60s for Python (may need to install packages, process data)
        maxBuffer: 5 * 1024 * 1024, // 5MB
        env: { ...process.env, LANG: "en_US.UTF-8", PYTHONIOENCODING: "utf-8" },
      });

      const truncated = output.length > 10000
        ? output.substring(0, 10000) + `\n... (truncated, ${output.length} chars total)`
        : output;
      return { name: "python_execute", result: truncated || "(no output)" };
    } finally {
      // Cleanup temp file
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  } catch (err: any) {
    const stderr = err.stderr ? err.stderr.toString().substring(0, 3000) : "";
    const stdout = err.stdout ? err.stdout.toString().substring(0, 3000) : "";
    return {
      name: "python_execute",
      result: `Python error (exit ${err.status || 1}):\n${stderr}\n${stdout}`.trim(),
      error: true,
    };
  }
}

function executeEditFile(filePath: string, oldText: string, newText: string, cwd?: string): ToolResult {
  const fullPath = filePath.startsWith("/") ? filePath : resolve(cwd || process.cwd(), filePath);
  try {
    if (!fs.existsSync(fullPath)) {
      return { name: "edit_file", result: `File not found: ${fullPath}`, error: true };
    }
    const content = fs.readFileSync(fullPath, "utf-8");
    if (!content.includes(oldText)) {
      return { name: "edit_file", result: `oldText not found in ${fullPath}. Make sure it matches exactly (including whitespace).`, error: true };
    }
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(fullPath, newContent);
    return { name: "edit_file", result: `✅ Edited ${fullPath} — replaced ${oldText.length} chars with ${newText.length} chars` };
  } catch (err) {
    return { name: "edit_file", result: `Edit failed: ${err instanceof Error ? err.message : err}`, error: true };
  }
}
