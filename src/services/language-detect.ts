/**
 * Language Detection & Auto-Adaptation Service
 *
 * Detects the language of incoming messages using keyword heuristics,
 * tracks usage statistics per user, and auto-adapts the preferred language
 * when a clear pattern emerges.
 *
 * No external APIs — lightweight, fast, runs on every message.
 */

import { loadProfile, saveProfile, type UserProfile } from "./users.js";

// ── Detection Heuristics ─────────────────────────────────

// Common words that strongly indicate a language
const DE_MARKERS = new Set([
  // Articles, pronouns, prepositions
  "ich", "du", "er", "sie", "wir", "ihr", "ein", "eine", "der", "die", "das",
  "den", "dem", "des", "ist", "sind", "hat", "haben", "wird", "werden",
  "nicht", "und", "oder", "aber", "auch", "noch", "schon", "nur", "sehr",
  "mit", "von", "für", "auf", "aus", "bei", "nach", "über", "unter",
  "kann", "muss", "soll", "will", "möchte", "bitte", "danke", "ja", "nein",
  "wie", "was", "wer", "wo", "wann", "warum", "welche", "welcher",
  "diese", "dieser", "dieses", "jetzt", "hier", "dort", "heute", "morgen",
  "hallo", "guten", "morgen", "abend", "nacht", "tschüss", "mach", "mache",
  "kannst", "könntest", "würde", "würdest", "gibt", "gib", "zeig", "sag",
  "mir", "dir", "uns", "euch", "mein", "dein", "sein", "kein", "keine",
  "alle", "alles", "etwas", "nichts", "viel", "mehr", "wenig", "gut",
  "neue", "neuen", "neues", "ersten", "letzten", "nächsten",
]);

const EN_MARKERS = new Set([
  // Articles, pronouns, prepositions
  "the", "is", "are", "was", "were", "have", "has", "had", "will", "would",
  "can", "could", "should", "must", "shall", "may", "might",
  "not", "and", "but", "also", "still", "already", "only", "very",
  "with", "from", "for", "about", "into", "through", "between",
  "this", "that", "these", "those", "here", "there", "now", "then",
  "what", "who", "where", "when", "why", "which", "how",
  "please", "thanks", "thank", "yes", "hello", "hey", "bye",
  "you", "your", "my", "his", "her", "our", "their",
  "some", "any", "every", "all", "each", "many", "much", "more",
  "just", "really", "actually", "right", "well", "sure", "okay",
  "want", "need", "know", "think", "make", "give", "show", "tell",
  "new", "first", "last", "next", "good", "great",
  "create", "delete", "update", "send", "check", "find", "search",
  "daily", "weekly", "summary", "list", "file", "open", "close",
  "start", "stop", "run", "set", "get", "add", "remove",
]);

/**
 * Detect the language of a text message.
 * Returns 'de', 'en', or 'unknown'.
 */
export function detectLanguage(text: string): "de" | "en" | "unknown" {
  if (!text || text.length < 3) return "unknown";

  // Skip commands, URLs, code blocks
  const cleaned = text
    .replace(/^\/\w+/g, "")           // remove /commands
    .replace(/https?:\/\/\S+/g, "")    // remove URLs
    .replace(/```[\s\S]*?```/g, "")    // remove code blocks
    .replace(/`[^`]+`/g, "")           // remove inline code
    .toLowerCase();

  const words = cleaned.split(/[\s,.!?;:()[\]{}'"]+/).filter(w => w.length >= 2);
  if (words.length < 2) return "unknown";

  let deScore = 0;
  let enScore = 0;

  for (const word of words) {
    if (DE_MARKERS.has(word)) deScore++;
    if (EN_MARKERS.has(word)) enScore++;
  }

  // Umlauts are a very strong German signal
  if (/[äöüß]/i.test(cleaned)) deScore += 3;

  const total = deScore + enScore;
  if (total < 2) return "unknown"; // too few signals

  if (deScore > enScore * 1.3) return "de";
  if (enScore > deScore * 1.3) return "en";

  return "unknown"; // ambiguous
}

/**
 * Update language statistics for a user and auto-adapt if pattern is clear.
 * Returns the recommended language for this session.
 */
export function trackAndAdapt(userId: number, text: string, currentSessionLang: "de" | "en"): "de" | "en" {
  const profile = loadProfile(userId);
  if (!profile) return currentSessionLang;

  // If user explicitly set language, don't auto-switch
  if (profile.langExplicit) return profile.language;

  const detected = detectLanguage(text);
  if (detected === "unknown") return currentSessionLang;

  // Initialize langStats if missing (existing profiles)
  if (!profile.langStats) {
    profile.langStats = { de: 0, en: 0, other: 0 };
  }

  // Update stats
  profile.langStats[detected]++;

  const total = profile.langStats.de + profile.langStats.en;

  // Auto-adapt after enough signal (at least 3 messages)
  if (total >= 3) {
    const deRatio = profile.langStats.de / total;
    const enRatio = profile.langStats.en / total;

    let newLang: "de" | "en" = profile.language;

    if (deRatio >= 0.6) newLang = "de";
    else if (enRatio >= 0.6) newLang = "en";

    if (newLang !== profile.language) {
      profile.language = newLang;
    }
  } else {
    // Early phase: follow immediate language for responsiveness
    profile.language = detected;
  }

  saveProfile(profile);
  return profile.language;
}

/**
 * Mark language as explicitly set by user (disables auto-detection).
 */
export function setExplicitLanguage(userId: number, lang: "de" | "en"): void {
  const profile = loadProfile(userId);
  if (!profile) return;
  profile.language = lang;
  profile.langExplicit = true;
  saveProfile(profile);
}

/**
 * Reset to auto-detection mode.
 */
export function resetToAutoLanguage(userId: number): void {
  const profile = loadProfile(userId);
  if (!profile) return;
  profile.langExplicit = false;
  saveProfile(profile);
}
