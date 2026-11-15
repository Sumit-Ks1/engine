/**
 * Opens a normal browser window with the engine's saved profile so you can sign in to
 * Instagram, X and Reddit. Sign in to each tab, then close the window.
 * The engine must be stopped while this runs.
 */
import { chromium } from 'playwright-core';
import { launchOptions, profileDir } from '../src/browser.js';

const SITES = ['https://www.instagram.com/accounts/login/', 'https://x.com/i/flow/login', 'https://www.reddit.com/login/'];

try {
  const ctx = await chromium.launchPersistentContext(profileDir(), launchOptions(false, true));
  const pages = ctx.pages();
  for (const [i, url] of SITES.entries()) {
    const page = pages[i] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }
  console.log('\nA browser window is open with three tabs: Instagram, X and Reddit.');
  console.log('Sign in on each tab, then CLOSE THE WINDOW. Your sign-ins stay saved on this PC.\n');
  await new Promise<void>((done) => ctx.on('close', () => done()));
  console.log('Saved. Start the engine again with: npm run dev');
} catch (e) {
  const msg = (e as Error).message;
  console.error(/ProcessSingleton|in use|already running/i.test(msg)
    ? '\nThe browser profile is in use. Stop the engine (Ctrl+C in its terminal) and run this again.\n'
    : `\nCould not open the browser: ${msg.split('\n')[0]}\nIf Chrome is not installed, set BROWSER_CHANNEL=msedge in .env.\n`);
  process.exit(1);
}
