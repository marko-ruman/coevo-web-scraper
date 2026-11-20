import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const PAGE_TIMEOUT_MS = Number(process.env.PAGE_TIMEOUT_MS || 15000);

let browserInstance: Browser | null = null;
let launchingPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }
  if (launchingPromise) {
    return launchingPromise;
  }

  launchingPromise = chromium
    .launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--disable-extensions',
      ],
    })
    .then((b) => {
      browserInstance = b;
      b.on('disconnected', () => {
        browserInstance = null;
      });
      launchingPromise = null;
      return b;
    })
    .catch((err) => {
      launchingPromise = null;
      throw err;
    });

  return launchingPromise;
}

export function isBrowserConnected(): boolean {
  return Boolean(browserInstance && browserInstance.isConnected());
}

export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch {
      // ignore
    }
    browserInstance = null;
  }
}

export async function withPage<T>(
  fn: (page: Page, context: BrowserContext) => Promise<T>,
  options: { blockHeavyMedia?: boolean; viewport?: { width: number; height: number } } = {}
): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: options.viewport || { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);

  if (options.blockHeavyMedia !== false) {
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'media' || type === 'websocket') {
        route.abort();
      } else {
        route.continue();
      }
    });
  }

  try {
    return await fn(page, context);
  } finally {
    try {
      await page.close();
    } catch {
      // ignore
    }
    try {
      await context.close();
    } catch {
      // ignore
    }
  }
}
