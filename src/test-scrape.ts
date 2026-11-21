import fs from 'node:fs/promises';
import { closeBrowser } from './browser.js';
import { runIntelligentCrawl, scrapeSingleUrl } from './crawler.js';
import type { BrandKit, CrawlResult, JobRecord } from './types.js';

interface CliArgs {
  url: string;
  crawl: boolean;
  noJs: boolean;
  noBrand: boolean;
  full: boolean;
  maxPages: number;
  name?: string;
  api?: string;
  secret?: string;
  out?: string;
}

function printUsage(): void {
  console.log(`
Usage:
  npm run test:url -- <url> [options]

Options:
  --crawl              Run full multi-page crawl (default: single-page scrape)
  --name <company>     Optional company name for news search / crawl metadata
  --max-pages <n>      Max pages for --crawl (1-15, default: 8)
  --no-js              Disable Playwright JS rendering (single-page fetch only)
  --no-brand           Skip Brand Kit extraction
  --full               Print full extracted Markdown instead of a preview
  --out <file.json>    Save full JSON output to a file
  --api <base-url>     Test against a running scraper API (e.g. http://localhost:3090)
  --secret <token>     Bearer/X-Scraper-Secret for --api (or set SCRAPER_API_SECRET)
  --help, -h           Show this help

Examples:
  npm run test:url -- https://stripe.com
  npm run test:url -- https://stripe.com --crawl --name "Stripe"
  npm run test:url -- https://stripe.com --api http://localhost:3090 --secret my-secret
`.trim());
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: '',
    crawl: false,
    noJs: false,
    noBrand: false,
    full: false,
    maxPages: 8,
    secret: process.env.SCRAPER_API_SECRET || undefined,
    api: process.env.SCRAPER_SERVICE_URL || undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else if (a === '--crawl') {
      args.crawl = true;
    } else if (a === '--no-js') {
      args.noJs = true;
    } else if (a === '--no-brand') {
      args.noBrand = true;
    } else if (a === '--full') {
      args.full = true;
    } else if (a === '--name' && argv[i + 1]) {
      args.name = argv[++i];
    } else if (a === '--max-pages' && argv[i + 1]) {
      args.maxPages = Math.max(1, Math.min(15, Number(argv[++i]) || 8));
    } else if (a === '--api' && argv[i + 1]) {
      args.api = argv[++i];
    } else if (a === '--secret' && argv[i + 1]) {
      args.secret = argv[++i];
    } else if (a === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    } else if (!a.startsWith('-') && !args.url) {
      args.url = a;
    }
  }

  return args;
}

function printBrandKit(brand: BrandKit | null): void {
  console.log('\n--- Brand Kit ---');
  if (!brand) {
    console.log('None extracted');
    return;
  }
  console.log(`Status / Source : ${brand.status} (${brand.source})`);
  console.log(`Domain          : ${brand.domain}`);
  console.log(`Logo URL        : ${brand.logo_url || '(none)'}`);
  if (brand.logo_dark_url) console.log(`Dark Logo URL   : ${brand.logo_dark_url}`);
  if (brand.icon_url) console.log(`Icon URL        : ${brand.icon_url}`);
  console.log(
    `Colors          : primary=${brand.primary_color} secondary=${brand.secondary_color} accent=${brand.accent_color}`
  );
  console.log(
    `                  bg=${brand.background_color} surface=${brand.surface_color} text=${brand.text_color} dark_bg=${brand.dark_bg_color}`
  );
  console.log(`Fonts           : heading="${brand.heading_font}" | body="${brand.body_font}"`);
  console.log(`Palette Swatches: ${brand.palette?.length || 0}`);
  if (brand.linkedin_company_url) console.log(`LinkedIn        : ${brand.linkedin_company_url}`);
}

function printMarkdown(markdown: string, full: boolean): void {
  console.log(`\n--- Markdown (${markdown.length} chars) ---`);
  if (!markdown) {
    console.log('(empty)');
    return;
  }
  if (full || markdown.length <= 1500) {
    console.log(markdown);
  } else {
    console.log(markdown.slice(0, 1500));
    console.log(`\n... [truncated ${markdown.length - 1500} chars — pass --full to print everything]`);
  }
}

async function runViaApi(args: CliArgs): Promise<Record<string, unknown>> {
  const baseUrl = args.api!.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(args.secret ? { Authorization: `Bearer ${args.secret}` } : {}),
  };

  console.log(`Checking health at ${baseUrl}/health ...`);
  const healthRes = await fetch(`${baseUrl}/health`);
  const health = await healthRes.json().catch(() => null);
  console.log('Health:', JSON.stringify(health));

  if (!args.crawl) {
    const res = await fetch(`${baseUrl}/v1/scrape`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        url: args.url,
        render_js: !args.noJs,
        extract_brand: !args.noBrand && !args.noJs,
      }),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(`API ${res.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  const startRes = await fetch(`${baseUrl}/v1/crawl`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      url: args.url,
      name: args.name,
      max_pages: args.maxPages,
      extract_brand: !args.noBrand,
      render_js: !args.noJs,
      async: true,
    }),
  });
  const startData = (await startRes.json()) as { success?: boolean; job_id?: string; error?: string };
  if (!startRes.ok || !startData.job_id) {
    throw new Error(`API ${startRes.status}: ${startData.error || JSON.stringify(startData)}`);
  }

  console.log(`Started async crawl job: ${startData.job_id}`);
  const seenSteps = new Map<string, string>();

  while (true) {
    await new Promise((r) => setTimeout(r, 1500));
    const pollRes = await fetch(`${baseUrl}/v1/jobs/${encodeURIComponent(startData.job_id)}`, { headers });
    const pollData = (await pollRes.json()) as { success?: boolean; job?: JobRecord; error?: string };
    if (!pollRes.ok || !pollData.job) {
      throw new Error(`Poll failed (${pollRes.status}): ${pollData.error || JSON.stringify(pollData)}`);
    }
    const job = pollData.job;
    for (const s of job.steps) {
      const sig = `${s.status}:${s.detail || ''}`;
      if (seenSteps.get(s.key) !== sig && s.status !== 'pending') {
        seenSteps.set(s.key, sig);
        console.log(`  [${job.progress_pct}%] ${s.label}: ${s.status}${s.detail ? ` — ${s.detail}` : ''}`);
      }
    }
    if (job.status === 'completed' || job.status === 'partial' || job.status === 'failed') {
      if (!job.result) {
        throw new Error(job.error || `Job ended with status=${job.status}`);
      }
      return job.result as Record<string, unknown>;
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    printUsage();
    process.exit(1);
  }

  console.log(`Target : ${args.url}`);
  console.log(`Mode   : ${args.api ? `Remote API (${args.api})` : 'Local direct'} | ${args.crawl ? 'Full Crawl' : 'Single-page Scrape'}`);

  let output: Record<string, unknown>;

  try {
    if (args.api) {
      output = await runViaApi(args);
    } else if (args.crawl) {
      const result: CrawlResult = await runIntelligentCrawl(
        {
          url: args.url,
          name: args.name,
          max_pages: args.maxPages,
          extract_brand: !args.noBrand,
          render_js: !args.noJs,
        },
        (key, status, detail, pct) => {
          console.log(`  [${pct ?? '-'}%] ${key}: ${status}${detail ? ` — ${detail}` : ''}`);
        }
      );
      output = result as unknown as Record<string, unknown>;
    } else {
      const result = await scrapeSingleUrl({
        url: args.url,
        render_js: !args.noJs,
        extract_brand: !args.noBrand && !args.noJs,
      });
      output = result as unknown as Record<string, unknown>;
    }

    console.log('\n=== Result Summary ===');
    console.log(`OK / Status     : ${output.ok} (HTTP ${output.http_status})`);
    console.log(`Final URL       : ${output.final_url}`);
    console.log(`Blocked         : ${output.blocked}${output.blocked_reason ? ` (${output.blocked_reason})` : ''}`);
    console.log(`Duration        : ${output.duration_ms} ms`);
    console.log(`Title           : ${output.title || '(none)'}`);
    console.log(`Description     : ${output.description || '(none)'}`);

    printBrandKit((output.brand_kit as BrandKit | null) || null);

    if (Array.isArray(output.pages_crawled)) {
      console.log(`\n--- Pages Crawled (${output.pages_crawled.length}) ---`);
      for (const p of output.pages_crawled as CrawlResult['pages_crawled']) {
        console.log(`  - [${p.category} | ${p.method}] ${p.url} (${p.chars} chars)`);
      }
    }

    if (Array.isArray(output.articles) && output.articles.length > 0) {
      console.log(`\n--- Blog/RSS Articles (${output.articles.length}) ---`);
      for (const a of output.articles as CrawlResult['articles']) {
        console.log(`  - ${a.title} (${a.url})`);
      }
    }

    if (Array.isArray(output.external_news) && output.external_news.length > 0) {
      console.log(`\n--- External Press (${output.external_news.length}) ---`);
      for (const n of output.external_news as CrawlResult['external_news']) {
        console.log(`  - ${n.title}${n.source ? ` [${n.source}]` : ''}`);
      }
    }

    if (Array.isArray(output.episodes) && output.episodes.length > 0) {
      console.log(`\n--- Episodes (${output.episodes.length}) ---`);
      for (const ep of output.episodes as CrawlResult['episodes']) {
        console.log(`  - ${ep.key} (source_type=${ep.source_type}, chars=${ep.content.length})`);
      }
    }

    printMarkdown(String(output.markdown || ''), args.full);

    if (args.out) {
      await fs.writeFile(args.out, JSON.stringify(output, null, 2), 'utf8');
      console.log(`\nSaved full JSON output to ${args.out}`);
    }
  } finally {
    await closeBrowser();
  }
}

main().catch((err) => {
  console.error('\nTest scrape failed:', err?.message || err);
  process.exit(1);
});
