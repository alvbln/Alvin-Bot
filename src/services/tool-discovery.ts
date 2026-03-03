/**
 * Tool Discovery Service
 *
 * Scans the system at startup for available CLI tools, configured plugins,
 * and custom tools. Injects a summary into the system prompt so the AI
 * knows exactly what it can use — instead of guessing or saying "I'd need X".
 *
 * Philosophy: An agent that doesn't know its own capabilities is useless.
 */

import { execSync } from "child_process";
import fs from "fs";
import { resolve } from "path";
import { TOOLS_MD, TOOLS_JSON, PLUGINS_DIR } from "../paths.js";

interface DiscoveredTool {
  name: string;
  path?: string;
  description?: string;
  category: string;
}

interface ToolReport {
  cliTools: DiscoveredTool[];
  customTools: string[];
  plugins: string[];
  summary: string; // Ready-to-inject prompt text
  scannedAt: number;
}

// Cache the report — only scan once per process lifetime
let cachedReport: ToolReport | null = null;

/**
 * CLI tools to probe for. Grouped by category.
 * Each entry: [binary, description]
 */
const TOOL_PROBES: Record<string, [string, string][]> = {
  "📧 Email & Communication": [
    ["himalaya", "Email CLI (IMAP/SMTP) — list, read, send, search emails"],
    ["wacli", "WhatsApp CLI — send messages, search history"],
    ["signal-cli", "Signal messenger CLI"],
  ],
  "🌐 Web & Network": [
    ["curl", "HTTP requests"],
    ["wget", "File downloads"],
    ["httpie", "Modern HTTP client"],
    ["jq", "JSON processor"],
  ],
  "📄 Document Processing": [
    ["pandoc", "Universal document converter (Markdown, HTML, PDF, DOCX, LaTeX)"],
    ["pdftotext", "Extract text from PDFs"],
    ["pdfinfo", "PDF metadata"],
    ["pdftoppm", "PDF to images"],
    ["gs", "Ghostscript — PDF manipulation (merge, split, compress)"],
    ["wkhtmltopdf", "HTML to PDF renderer"],
    ["libreoffice", "Office document conversion"],
  ],
  "🎨 Image Processing": [
    ["sips", "macOS image processing (resize, convert, rotate)"],
    ["magick", "ImageMagick — advanced image manipulation"],
    ["convert", "ImageMagick convert (legacy)"],
    ["ffmpeg", "Audio/Video/Image swiss army knife"],
  ],
  "🎬 Audio & Video": [
    ["ffmpeg", "Audio/Video conversion, extraction, streaming"],
    ["ffprobe", "Media file analysis (duration, codecs, bitrate)"],
    ["yt-dlp", "Download videos from YouTube and 1000+ sites"],
    ["whisper", "OpenAI Whisper — local speech-to-text"],
  ],
  "💻 Development": [
    ["node", "Node.js runtime"],
    ["npm", "Node package manager"],
    ["npx", "Node package executor"],
    ["python3", "Python 3"],
    ["pip3", "Python package manager"],
    ["git", "Version control"],
    ["gh", "GitHub CLI — issues, PRs, repos, actions"],
    ["docker", "Container runtime"],
    ["pm2", "Process manager"],
  ],
  "🖥️ macOS Automation": [
    ["osascript", "AppleScript / JXA automation"],
    ["cliclick", "Mouse/keyboard automation (click, type, key press)"],
    ["screencapture", "Take screenshots"],
    ["brightness", "Display brightness control"],
    ["blueutil", "Bluetooth control"],
    ["SwitchAudioSource", "Audio device switching"],
    ["mas", "Mac App Store CLI"],
    ["pbcopy", "Copy to clipboard"],
    ["pbpaste", "Paste from clipboard"],
  ],
  "📊 Data & Analysis": [
    ["sqlite3", "SQLite database CLI"],
    ["psql", "PostgreSQL client"],
    ["mysql", "MySQL client"],
    ["csvtool", "CSV processing"],
    ["mlr", "Miller — CSV/JSON/TSV data processor"],
  ],
  "🔧 System": [
    ["ssh", "Remote shell access"],
    ["sshpass", "SSH with password (non-interactive)"],
    ["rsync", "Fast file sync/transfer"],
    ["trash", "Safe file deletion (recoverable)"],
    ["htop", "System monitor"],
    ["lsof", "Open file/port inspector"],
  ],
};

/** Check if a binary exists on the system */
function whichTool(name: string): string | null {
  try {
    return execSync(`which ${name} 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

/** Load custom tool names from TOOLS.md (with legacy tools.json fallback) */
function loadCustomTools(): string[] {
  // Prefer TOOLS.md — extract tool names from ## headings
  if (fs.existsSync(TOOLS_MD)) {
    try {
      const content = fs.readFileSync(TOOLS_MD, "utf-8");
      const names: string[] = [];
      for (const match of content.matchAll(/^## (.+)$/gm)) {
        const name = match[1].trim().replace(/\s+/g, "_").toLowerCase();
        if (name) names.push(name);
      }
      if (names.length > 0) return names;
    } catch { /* fall through */ }
  }

  // Legacy fallback: docs/tools.json
  try {
    const data = JSON.parse(fs.readFileSync(TOOLS_JSON, "utf-8"));
    const tools = data.tools || data.items || (Array.isArray(data) ? data : []);
    return tools.map((t: any) => t.name || t.id || "unknown");
  } catch {
    return [];
  }
}

/** Get list of loaded plugins (read plugin directory) */
function discoverPlugins(): string[] {
  try {
    return fs.readdirSync(PLUGINS_DIR)
      .filter(d => fs.statSync(resolve(PLUGINS_DIR, d)).isDirectory())
      .filter(d => fs.existsSync(resolve(PLUGINS_DIR, d, "index.js")));
  } catch {
    return [];
  }
}

/**
 * Scan the system for available tools. Cached after first call.
 */
export function discoverTools(forceRescan = false): ToolReport {
  if (cachedReport && !forceRescan) return cachedReport;

  const cliTools: DiscoveredTool[] = [];
  const seen = new Set<string>();

  for (const [category, probes] of Object.entries(TOOL_PROBES)) {
    for (const [name, description] of probes) {
      if (seen.has(name)) continue;
      seen.add(name);
      const path = whichTool(name);
      if (path) {
        cliTools.push({ name, path, description, category });
      }
    }
  }

  const customTools = loadCustomTools();
  const plugins = discoverPlugins();

  // Build human-readable summary for the system prompt
  const lines: string[] = ["## Available Tools & Capabilities\n"];
  lines.push("The following tools are installed and ready to use on this system.\n");
  lines.push("**IMPORTANT:** Use these tools DIRECTLY. Do NOT say 'I would need X' when X is listed here.\n");

  // Group CLI tools by category
  const byCategory = new Map<string, DiscoveredTool[]>();
  for (const tool of cliTools) {
    const list = byCategory.get(tool.category) || [];
    list.push(tool);
    byCategory.set(tool.category, list);
  }

  for (const [category, tools] of byCategory) {
    lines.push(`### ${category}`);
    for (const t of tools) {
      lines.push(`- **${t.name}** — ${t.description}`);
    }
    lines.push("");
  }

  // Plugins
  if (plugins.length > 0) {
    lines.push("### 🔌 Active Plugins");
    for (const p of plugins) {
      lines.push(`- **${p}** — Use \`/${p}\` or ask directly about ${p} features`);
    }
    lines.push("");
  }

  // Custom tools
  if (customTools.length > 0) {
    lines.push(`### 🛠️ Custom Tools (${customTools.length} defined in TOOLS.md)`);
    lines.push(`Available via Web UI or by name. Examples: ${customTools.slice(0, 10).join(", ")}${customTools.length > 10 ? "..." : ""}`);
    lines.push("");
  }

  // Usage guidelines
  lines.push("### 💡 Usage Guidelines");
  lines.push("- **Act first, ask later.** If a tool is available → use it directly.");
  lines.push("- **`which <tool>`** if unsure whether something is installed.");
  lines.push("- **Combine tools:** e.g. `curl` + `jq` for APIs, `ffmpeg` + `ffprobe` for media.");
  lines.push("- **Missing tools:** Suggest installation, do NOT give up.");
  lines.push("");

  const summary = lines.join("\n");

  cachedReport = { cliTools, customTools, plugins, summary, scannedAt: Date.now() };
  console.log(`🔍 Tool discovery: ${cliTools.length} CLI tools, ${plugins.length} plugins, ${customTools.length} custom tools`);

  return cachedReport;
}

/**
 * Get the tool summary for injection into the system prompt.
 */
export function getToolSummary(): string {
  return discoverTools().summary;
}

/**
 * Force rescan (e.g., after plugin install).
 */
export function rescanTools(): ToolReport {
  return discoverTools(true);
}
