import express, { type Request, type Response, type NextFunction } from 'express';
import { closeBrowser, isBrowserConnected } from './browser.js';
import { runIntelligentCrawl, scrapeSingleUrl } from './crawler.js';
import { enqueueJob, getJob, getQueueStats } from './queue.js';
import type { CrawlOptions, ScrapeOptions } from './types.js';

const PORT = Number(process.env.PORT || 3090);
const API_SECRET = (process.env.SCRAPER_API_SECRET || '').trim();

const app = express();
app.use(express.json({ limit: '4mb' }));

// Simple CORS support for direct tooling/admin access
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Scraper-Secret');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function requireSecret(req: Request, res: Response, next: NextFunction) {
  if (!API_SECRET) {
    next();
    return;
  }
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerSecret = String(req.headers['x-scraper-secret'] || '').trim();
  if (bearer === API_SECRET || headerSecret === API_SECRET) {
    next();
    return;
  }
  res.status(401).json({ success: false, error: 'Unauthorized: invalid SCRAPER_API_SECRET' });
}

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'coevo-web-scraper',
    browser_connected: isBrowserConnected(),
    queue: getQueueStats(),
    uptime_sec: Math.round(process.uptime()),
  });
});

/**
 * POST /v1/scrape — Single URL to clean Markdown + metadata + optional Brand Kit
 */
app.post('/v1/scrape', requireSecret, async (req: Request, res: Response) => {
  const body = (req.body || {}) as ScrapeOptions & { async?: boolean; callback_url?: string; callback_secret?: string; callback_meta?: Record<string, unknown> };
  if (!body.url) {
    res.status(400).json({ success: false, error: 'Missing required field: url' });
    return;
  }

  if (body.async) {
    const job = enqueueJob({
      kind: 'scrape',
      initialSteps: [{ key: 'scrape', label: 'Scrape URL & Convert to Markdown' }],
      callbackUrl: body.callback_url,
      callbackSecret: body.callback_secret || API_SECRET,
      callbackMeta: body.callback_meta,
      runner: async (report) => {
        await report('scrape', 'running', `Scraping ${body.url}...`, 30);
        const result = await scrapeSingleUrl(body);
        await report('scrape', result.ok ? 'completed' : 'warning', result.ok ? `Extracted ${result.markdown.length} chars` : result.blocked_reason || 'Failed', 95);
        return {
          status: result.ok ? 'completed' : 'failed',
          result,
          error: result.blocked_reason,
        };
      },
    });
    res.status(202).json({ success: true, job_id: job.job_id, job });
    return;
  }

  try {
    const result = await scrapeSingleUrl(body);
    res.json({ success: result.ok, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Scrape failed' });
  }
});

/**
 * POST /v1/brand — Dedicated precision 6-role Semantic Brand Kit extractor
 */
app.post('/v1/brand', requireSecret, async (req: Request, res: Response) => {
  const url = String(req.body?.url || '').trim();
  if (!url) {
    res.status(400).json({ success: false, error: 'Missing required field: url' });
    return;
  }
  try {
    const result = await scrapeSingleUrl({ url, render_js: true, extract_brand: true, max_chars: 1500 });
    res.json({
      success: result.ok,
      blocked: result.blocked,
      http_status: result.http_status,
      blocked_reason: result.blocked_reason,
      url: result.final_url,
      brand_kit: result.brand_kit,
      duration_ms: result.duration_ms,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Brand extraction failed' });
  }
});

/**
 * POST /v1/crawl — Multi-page smart crawl -> Markdown + Brand Kit + RSS/News + optional ClueState sync
 */
app.post('/v1/crawl', requireSecret, async (req: Request, res: Response) => {
  const body = (req.body || {}) as CrawlOptions;
  if (!body.url) {
    res.status(400).json({ success: false, error: 'Missing required field: url' });
    return;
  }

  if (body.async) {
    const job = enqueueJob({
      kind: 'crawl',
      initialSteps: [
        { key: 'homepage', label: 'Render Homepage' },
        { key: 'brand_kit', label: 'Extract Brand Kit' },
        { key: 'subpages', label: 'Crawl Key Subpages' },
        { key: 'blog_rss', label: 'Scan Blog & RSS' },
        { key: 'external_news', label: 'Fetch External Press' },
        { key: 'cluestate', label: 'Sync ClueState Memory' },
      ],
      callbackUrl: body.callback_url,
      callbackSecret: body.callback_secret || API_SECRET,
      callbackMeta: body.callback_meta,
      runner: async (report) => {
        const result = await runIntelligentCrawl(body, report);
        const finalStatus = result.ok ? 'completed' : result.partial ? 'partial' : 'failed';
        return {
          status: finalStatus,
          result,
          error: result.error,
        };
      },
    });
    res.status(202).json({ success: true, job_id: job.job_id, job });
    return;
  }

  try {
    const result = await runIntelligentCrawl(body);
    res.json({ success: result.ok || result.partial, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Crawl failed' });
  }
});

/**
 * GET /v1/jobs/:id — Poll live progress & results of an async job
 */
app.get('/v1/jobs/:id', requireSecret, (req: Request, res: Response) => {
  const jobId = Array.isArray(req.params.id) ? req.params.id[0] : String(req.params.id || '');
  const job = getJob(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: 'Job not found or expired' });
    return;
  }
  res.json({ success: true, job });
});

const server = app.listen(PORT, () => {
  console.log(`[coevo-web-scraper] listening on :${PORT} (auth=${API_SECRET ? 'enabled' : 'disabled'})`);
});

async function shutdown() {
  console.log('[coevo-web-scraper] shutting down...');
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
