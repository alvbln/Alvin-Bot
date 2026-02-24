/**
 * Browser Service — Web browsing via Playwright.
 *
 * Capabilities:
 * - Screenshot a URL
 * - Extract text content from a URL
 * - Fill forms (basic)
 * - PDF generation
 *
 * Playwright is an optional dependency — browser features are only available if installed.
 */

import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const TEMP_DIR = path.join(os.tmpdir(), "alvin-bot", "browser");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

/** Check if Playwright is available */
export function hasPlaywright(): boolean {
  try {
    execSync("npx playwright --version", { stdio: "pipe", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Take a screenshot of a URL.
 * Returns path to the screenshot image.
 */
export async function screenshotUrl(url: string, options: {
  fullPage?: boolean;
  width?: number;
  height?: number;
} = {}): Promise<string> {
  const { fullPage = false, width = 1280, height = 720 } = options;
  const outputPath = path.join(TEMP_DIR, `screenshot_${Date.now()}.png`);

  // Use a standalone Node script to avoid importing playwright at module level
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: ${width}, height: ${height} } });
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
      await page.screenshot({ path: ${JSON.stringify(outputPath)}, fullPage: ${fullPage} });
      await browser.close();
    })().catch(err => { console.error(err.message); process.exit(1); });
  `;

  try {
    execSync(`node -e '${script.replace(/'/g, "\\'")}'`, {
      stdio: "pipe",
      timeout: 45000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    });

    if (!fs.existsSync(outputPath)) throw new Error("Screenshot not created");
    return outputPath;
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message: string };
    throw new Error(`Screenshot failed: ${error.stderr?.toString()?.trim() || error.message}`);
  }
}

/**
 * Extract text content from a URL.
 * Returns the visible text content.
 */
export async function extractText(url: string): Promise<string> {
  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
      const text = await page.evaluate(() => document.body.innerText);
      console.log(text);
      await browser.close();
    })().catch(err => { console.error(err.message); process.exit(1); });
  `;

  try {
    const result = execSync(`node -e '${script.replace(/'/g, "\\'")}'`, {
      stdio: "pipe",
      timeout: 45000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    });
    return result.toString().trim();
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message: string };
    throw new Error(`Text extraction failed: ${error.stderr?.toString()?.trim() || error.message}`);
  }
}

/**
 * Generate PDF from a URL.
 * Returns path to the PDF file.
 */
export async function generatePdf(url: string): Promise<string> {
  const outputPath = path.join(TEMP_DIR, `page_${Date.now()}.pdf`);

  const script = `
    const { chromium } = require('playwright');
    (async () => {
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
      await page.pdf({ path: ${JSON.stringify(outputPath)}, format: 'A4', printBackground: true });
      await browser.close();
    })().catch(err => { console.error(err.message); process.exit(1); });
  `;

  try {
    execSync(`node -e '${script.replace(/'/g, "\\'")}'`, {
      stdio: "pipe",
      timeout: 45000,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: "0" },
    });

    if (!fs.existsSync(outputPath)) throw new Error("PDF not created");
    return outputPath;
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message: string };
    throw new Error(`PDF generation failed: ${error.stderr?.toString()?.trim() || error.message}`);
  }
}
