import { describe, it, expect, beforeEach } from "vitest";
import { t, initI18n, setLocale, getLocale, LOCALE_NAMES, LOCALE_FLAGS } from "../src/i18n.js";

describe("i18n", () => {
  beforeEach(() => {
    // Reset to a known state before each test
    setLocale("en");
  });

  describe("LOCALE_NAMES", () => {
    it("exposes all four supported locales", () => {
      expect(LOCALE_NAMES.en).toBe("English");
      expect(LOCALE_NAMES.de).toBe("Deutsch");
      expect(LOCALE_NAMES.es).toBe("Español");
      expect(LOCALE_NAMES.fr).toBe("Français");
    });
  });

  describe("LOCALE_FLAGS", () => {
    it("has a flag emoji for every locale", () => {
      expect(LOCALE_FLAGS.en).toBe("🇬🇧");
      expect(LOCALE_FLAGS.de).toBe("🇩🇪");
      expect(LOCALE_FLAGS.es).toBe("🇪🇸");
      expect(LOCALE_FLAGS.fr).toBe("🇫🇷");
    });
  });

  describe("t() — translation lookup", () => {
    it("returns the English string when locale is en", () => {
      const msg = t("bot.cancel.cancelling", "en");
      expect(msg).toContain("Cancelling");
    });

    it("returns the German string when locale is de", () => {
      const msg = t("bot.cancel.cancelling", "de");
      expect(msg).toContain("abgebrochen");
    });

    it("returns the Spanish string when locale is es", () => {
      const msg = t("bot.cancel.cancelling", "es");
      expect(msg.toLowerCase()).toContain("cancelando");
    });

    it("returns the French string when locale is fr", () => {
      const msg = t("bot.cancel.cancelling", "fr");
      expect(msg.toLowerCase()).toContain("annulation");
    });

    it("falls back to English when locale is missing for a key", () => {
      // Use a TUI key which only has en+de — request es, should fall through
      // to en since tui.* keys aren't translated for es/fr.
      const msg = t("tui.title", "es");
      expect(msg).toContain("Alvin Bot TUI");
    });

    it("returns the key itself if no locale has it at all", () => {
      const msg = t("bot.nonexistent.key.for.test", "en");
      expect(msg).toBe("bot.nonexistent.key.for.test");
    });

    it("uses the global currentLocale when no locale is passed", () => {
      setLocale("de");
      const msg = t("bot.cancel.cancelling");
      expect(msg).toContain("abgebrochen");
    });
  });

  describe("t() — interpolation", () => {
    it("substitutes a single {var} placeholder", () => {
      const msg = t("bot.error.timeoutStuck", "en", { min: 10 });
      expect(msg).toContain("10 minutes");
    });

    it("substitutes multiple {var} placeholders", () => {
      const msg = t("bot.error.midStream", "en", {
        name: "claude-sdk",
        detail: "connection reset",
      });
      expect(msg).toContain("claude-sdk");
      expect(msg).toContain("connection reset");
    });

    it("interpolation works in all four locales", () => {
      const vars = { min: 7 };
      expect(t("bot.error.timeoutStuck", "en", vars)).toContain("7");
      expect(t("bot.error.timeoutStuck", "de", vars)).toContain("7");
      expect(t("bot.error.timeoutStuck", "es", vars)).toContain("7");
      expect(t("bot.error.timeoutStuck", "fr", vars)).toContain("7");
    });

    it("leaves {placeholder} visible if the var is not provided", () => {
      const msg = t("bot.error.timeoutStuck", "en", {});
      expect(msg).toContain("{min}");
    });
  });

  describe("initI18n / setLocale / getLocale", () => {
    it("initI18n with explicit locale sets currentLocale", () => {
      initI18n("fr");
      expect(getLocale()).toBe("fr");
    });

    it("setLocale updates the global locale", () => {
      setLocale("es");
      expect(getLocale()).toBe("es");
    });
  });
});
