/**
 * Memory Extractor (v4.11.0, experimental)
 *
 * When the compaction service archives old conversation chunks, it normally
 * dumps prose into the daily log. This extractor adds a structured pass that
 * pulls user_facts, preferences, and decisions out of the chunk and appends
 * them to MEMORY.md (de-duplicated by exact-string match).
 *
 * Pattern inspired by Mem0's auto-extraction. Designed to be safe:
 *   - Opt-out via MEMORY_EXTRACTION_DISABLED=1
 *   - Uses the active provider with effort=low
 *   - Failures are swallowed; compaction continues regardless
 *   - Dedup is exact-string only (no embedding-based semantic dedup yet)
 */
import fs from "fs";
import { dirname } from "path";
import { MEMORY_FILE } from "../paths.js";

export interface ExtractedFacts {
  user_facts: string[];
  preferences: string[];
  decisions: string[];
}

export interface ExtractionResult {
  disabled: boolean;
  factsStored: number;
}

const EMPTY_FACTS: ExtractedFacts = {
  user_facts: [],
  preferences: [],
  decisions: [],
};

const EXTRACTION_PROMPT = `Extract structured facts from this conversation chunk. Return ONLY a JSON object with these keys:

{
  "user_facts": ["concrete facts about the user that should persist forever"],
  "preferences": ["communication style or workflow preferences the user expressed"],
  "decisions": ["explicit decisions made (e.g., 'use X instead of Y')"]
}

Rules:
- Each entry must be ONE short, declarative sentence (max 100 chars).
- Skip transient conversation details (questions, todos, ephemeral state).
- Skip facts that are obvious from context (e.g., "user asked a question").
- Empty arrays are fine — don't invent facts.
- Output ONLY the JSON, no commentary.

Conversation chunk:
`;

/**
 * Parse the JSON output from the AI extractor. Tolerates markdown code-fence
 * wrapping and surrounding prose. Returns empty arrays on any parse failure.
 */
export function parseExtractedFacts(text: string): ExtractedFacts {
  if (!text || typeof text !== "string") return { ...EMPTY_FACTS };

  // Strip markdown code fences if present
  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  // Try to find the first { ... } block if there's surrounding prose
  const braceMatch = cleaned.match(/\{[\s\S]*\}/);
  if (braceMatch) cleaned = braceMatch[0];

  try {
    const parsed = JSON.parse(cleaned) as Partial<ExtractedFacts>;
    return {
      user_facts: Array.isArray(parsed.user_facts)
        ? parsed.user_facts.filter((s): s is string => typeof s === "string")
        : [],
      preferences: Array.isArray(parsed.preferences)
        ? parsed.preferences.filter((s): s is string => typeof s === "string")
        : [],
      decisions: Array.isArray(parsed.decisions)
        ? parsed.decisions.filter((s): s is string => typeof s === "string")
        : [],
    };
  } catch {
    return { ...EMPTY_FACTS };
  }
}

/**
 * Append extracted facts to MEMORY.md under structured headers, deduplicated
 * by exact-string match against existing content.
 */
export async function appendFactsToMemoryFile(facts: ExtractedFacts): Promise<number> {
  const total = facts.user_facts.length + facts.preferences.length + facts.decisions.length;
  if (total === 0) return 0;

  // Read existing content for dedup
  let existing = "";
  try {
    existing = fs.readFileSync(MEMORY_FILE, "utf-8");
  } catch {
    // File doesn't exist yet — that's fine, mkdir parent
    fs.mkdirSync(dirname(MEMORY_FILE), { recursive: true });
  }

  const isDuplicate = (line: string): boolean => existing.includes(line);

  const newLines: string[] = [];
  const todayIso = new Date().toISOString().slice(0, 10);
  const sectionHeader = `\n\n## Auto-extracted (${todayIso})\n`;
  let stored = 0;

  if (facts.user_facts.length > 0) {
    const newOnes = facts.user_facts.filter(f => !isDuplicate(f));
    if (newOnes.length > 0) {
      newLines.push("\n### User Facts");
      for (const f of newOnes) {
        newLines.push(`- ${f}`);
        stored++;
      }
    }
  }
  if (facts.preferences.length > 0) {
    const newOnes = facts.preferences.filter(p => !isDuplicate(p));
    if (newOnes.length > 0) {
      newLines.push("\n### Preferences");
      for (const p of newOnes) {
        newLines.push(`- ${p}`);
        stored++;
      }
    }
  }
  if (facts.decisions.length > 0) {
    const newOnes = facts.decisions.filter(d => !isDuplicate(d));
    if (newOnes.length > 0) {
      newLines.push("\n### Decisions");
      for (const d of newOnes) {
        newLines.push(`- ${d}`);
        stored++;
      }
    }
  }

  if (stored > 0) {
    const block = sectionHeader + newLines.join("\n") + "\n";
    fs.appendFileSync(MEMORY_FILE, block, "utf-8");
  }

  return stored;
}

/**
 * Extract facts from a conversation chunk and store them in MEMORY.md.
 * Safe wrapper — never throws, always returns an ExtractionResult.
 */
export async function extractAndStoreFacts(conversationText: string): Promise<ExtractionResult> {
  if (process.env.MEMORY_EXTRACTION_DISABLED === "1") {
    return { disabled: true, factsStored: 0 };
  }

  if (!conversationText || conversationText.trim().length < 50) {
    return { disabled: false, factsStored: 0 };
  }

  let extractedText = "";
  try {
    // Lazy-import the registry so test environments without an engine init
    // don't crash on module load.
    const { getRegistry } = await import("../engine.js");
    const registry = getRegistry();
    const opts = {
      prompt: EXTRACTION_PROMPT + conversationText.slice(0, 8000),
      systemPrompt: "You are a fact extractor. Output only valid JSON, no commentary.",
      effort: "low" as const,
    };
    for await (const chunk of registry.queryWithFallback(opts)) {
      if (chunk.type === "text" && chunk.text) {
        extractedText = chunk.text;
      }
      if (chunk.type === "error") {
        // Provider failed — silent fallback
        return { disabled: false, factsStored: 0 };
      }
    }
  } catch {
    return { disabled: false, factsStored: 0 };
  }

  if (!extractedText) return { disabled: false, factsStored: 0 };

  const facts = parseExtractedFacts(extractedText);
  let stored = 0;
  try {
    stored = await appendFactsToMemoryFile(facts);
  } catch {
    // appendFactsToMemoryFile failed — non-fatal
  }

  return { disabled: false, factsStored: stored };
}
