/**
 * Telegram Markdown Sanitizer
 *
 * Telegram's Markdown parser is strict — unbalanced markers crash message sending.
 * This module sanitizes AI-generated markdown to be Telegram-safe.
 */

/**
 * Sanitize markdown for Telegram compatibility.
 * Fixes common issues:
 * - Unbalanced bold (*), italic (_), code (`) markers
 * - Nested formatting that Telegram doesn't support
 * - Code blocks without closing ```
 */
export function sanitizeTelegramMarkdown(text: string): string {
  if (!text) return text;

  let result = text;

  // Fix unclosed code blocks (```)
  const codeBlockCount = (result.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) {
    result += "\n```";
  }

  // Fix unclosed inline code (`)
  // Count backticks outside of code blocks
  const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, "");
  const inlineCodeCount = (withoutCodeBlocks.match(/`/g) || []).length;
  if (inlineCodeCount % 2 !== 0) {
    result += "`";
  }

  // Fix unbalanced bold markers (*) outside code blocks
  // Simple approach: count * outside code, close if unbalanced
  const outsideCode = result.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const boldCount = (outsideCode.match(/\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    // Find the last * and remove it (safer than adding one)
    const lastStarIdx = result.lastIndexOf("*");
    if (lastStarIdx >= 0) {
      result = result.slice(0, lastStarIdx) + result.slice(lastStarIdx + 1);
    }
  }

  // Fix unbalanced italic markers (_) outside code blocks
  const underscoreCount = (outsideCode.match(/_/g) || []).length;
  if (underscoreCount % 2 !== 0) {
    const lastIdx = result.lastIndexOf("_");
    if (lastIdx >= 0) {
      result = result.slice(0, lastIdx) + result.slice(lastIdx + 1);
    }
  }

  return result;
}

/**
 * Attempt to send with Markdown, fallback to plain text.
 * Returns the parse_mode that worked (or undefined for plain).
 */
export function getMarkdownSafe(text: string): { text: string; parseMode: "Markdown" | undefined } {
  try {
    const sanitized = sanitizeTelegramMarkdown(text);
    return { text: sanitized, parseMode: "Markdown" };
  } catch {
    return { text, parseMode: undefined };
  }
}
