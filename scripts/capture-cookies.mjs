#!/usr/bin/env node
/**
 * capture-cookies.mjs — open a real browser, log in to X, and export the
 * session cookies to cookies.json.
 *
 * Why a real browser: X's login is behind Cloudflare, so a headless script
 * cannot reliably authenticate. This opens a headed browser for you to log in
 * by hand, then exports the session cookies automatically.
 *
 * Requires Playwright (not needed to run the server, only to capture cookies):
 *   npm i -D playwright && npx playwright install chromium
 *
 * Env:
 *   COOKIES_FILE  output path (default ./cookies.json)
 *   X_PROXY       optional proxy for the browser, e.g. socks5://127.0.0.1:1080
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = process.env.COOKIES_FILE || 'cookies.json';
const PROXY = process.env.X_PROXY || '';

const args = PROXY ? [`--proxy-server=${PROXY}`] : [];

const browser = await chromium.launch({ headless: false, args });
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 820 },
});

console.log('→ Log in to X in the browser window that just opened.');
console.log('  This script auto-detects the login and saves cookies.');

const page = await ctx.newPage();
await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' }).catch(() => {});

// Poll until the auth_token cookie appears (up to 5 minutes).
const deadline = Date.now() + 300_000;
while (Date.now() < deadline) {
  const cookies = await ctx.cookies('https://x.com');
  if (cookies.some((c) => c.name === 'auth_token')) {
    const lines = cookies.map((c) => `${c.name}=${c.value}`);
    fs.writeFileSync(OUT, JSON.stringify(lines, null, 2) + '\n');
    console.log(`\n✓ Saved ${cookies.length} cookies to ${OUT}`);
    console.log('  Cookie names: ' + cookies.map((c) => c.name).join(', '));
    await browser.close();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}

console.error('✗ Timed out after 5 minutes without detecting a login.');
await browser.close();
process.exit(1);
