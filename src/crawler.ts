import { withPage } from './browser.js';
import { extractBrandKitFromPage } from './brand.js';
import {
  detectWafOrChallenge,
  extractDocumentFromHtml,
  normalizeUrl,
  resolveRelativeUrl,
} from './markdown.js';
import { syncEpisodesToClueState } from './cluestate.js';
import type {
  ArticleItem,
  BrandKit,
  CrawledPage,
  CrawlOptions,
  CrawlResult,
  EpisodePayload,
  ScrapeOptions,
  StepState,
} from './types.js';

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type StepReporter = (key: string, status: StepState, detail?: string, progressPct?: number) => void | Promise<void>;

async function fastFetch(
  url: string,
  timeoutMs = 8000,
  accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
): Promise<{ ok: boolean; status: number; finalUrl: string; body: string; headers: Record<string, string>; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': FETCH_UA,
        Accept: accept,
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      body,
      headers,
      error: res.ok ? '' : `HTTP ${res.status}`,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      finalUrl: url,
      body: '',
      headers: {},
      error: err?.message || 'Fetch error',
    };
  } finally {
    clearTimeout(timer);
  }
}

function classifyPageBucket(urlStr: string, anchorText = ''): { bucket: string; score: number } {
  let path = '/';
  try {
    path = new URL(urlStr).pathname.toLowerCase();
  } catch {
    path = '/';
  }
  const haystack = `${path} ${anchorText.toLowerCase()}`;

  if (/\.(pdf|png|jpe?g|gif|svg|webp|ico|css|js|xml|zip|gz|mp4|woff2?)$/i.test(path)) {
    return { bucket: 'excluded', score: 0 };
  }
  if (/\/(login|signin|sign-in|signup|sign-up|register|logout|cart|checkout|account|wp-admin|wp-json|privacy|terms|cookie|legal|gdpr|tag\/|author\/|category\/|page\/\d+)/i.test(path)) {
    return { bucket: 'excluded', score: 0 };
  }

  const rules: Array<{ name: string; re: RegExp; base: number }> = [
    { name: 'identity', re: /\b(about|company|who-we-are|our-story|story|mission|team|leadership|founders|careers|overview)\b/i, base: 90 },
    { name: 'product', re: /\b(product|products|platform|solutions|solution|services|service|features|capabilities|use-cases|sectors|industries|integrations|how-it-works|technology)\b/i, base: 100 },
    { name: 'pricing', re: /\b(pricing|plans|packages|enterprise|editions)\b/i, base: 95 },
    { name: 'proof', re: /\b(customers|case-studies|case-study|projects|clients|work|portfolio|testimonials|success-stories|stories)\b/i, base: 92 },
    { name: 'news_blog', re: /\b(blog|news|newsroom|press|press-releases|updates|changelog|insights|articles|releases|announcements)\b/i, base: 85 },
  ];

  const depth = path.replace(/^\/|\/$/g, '') ? path.replace(/^\/|\/$/g, '').split('/').length : 0;
  let bestBucket = 'general';
  let bestScore = 10;

  for (const r of rules) {
    if (r.re.test(haystack)) {
      let score = r.base - depth * 6;
      if (depth === 1) score += 12;
      if (score > bestScore) {
        bestScore = score;
        bestBucket = r.name;
      }
    }
  }
  return { bucket: bestBucket, score: Math.max(1, bestScore) };
}

function parseRssOrAtomXml(xml: string, limit = 5): ArticleItem[] {
  if (!xml || !xml.trim()) return [];
  const items: ArticleItem[] = [];

  const stripCdata = (s: string) =>
    s
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

  const extractTag = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
    return m ? stripCdata(m[1]) : '';
  };

  // RSS <item>
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    if (items.length >= limit) break;
    const title = extractTag(block, 'title');
    const url = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate');
    const summary = extractTag(block, 'description').slice(0, 500);
    const source = extractTag(block, 'source');
    if (title) {
      let isoDate = pubDate;
      const parsedDate = Date.parse(pubDate);
      if (!Number.isNaN(parsedDate)) isoDate = new Date(parsedDate).toISOString();
      items.push({ title, url, published_at: isoDate, source, summary });
    }
  }
  if (items.length > 0) return items;

  // Atom <entry>
  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const block of atomEntries) {
    if (items.length >= limit) break;
    const title = extractTag(block, 'title');
    const linkHref = block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] || extractTag(block, 'link');
    const pubDate = extractTag(block, 'published') || extractTag(block, 'updated');
    const summary = (extractTag(block, 'summary') || extractTag(block, 'content')).slice(0, 500);
    if (title) {
      items.push({ title, url: linkHref, published_at: pubDate, source: '', summary });
    }
  }

  return items;
}

async function fetchSitemapUrls(baseOrigin: string, host: string): Promise<string[]> {
  const urls: string[] = [];
  let sitemapUrl = `${baseOrigin}/sitemap.xml`;

  const robots = await fastFetch(`${baseOrigin}/robots.txt`, 4000, 'text/plain');
  if (robots.ok) {
    const smMatch = robots.body.match(/^Sitemap:\s*(https?:\/\/\S+)/im);
    if (smMatch) sitemapUrl = smMatch[1].trim();
  }

  const res = await fastFetch(sitemapUrl, 5000, 'application/xml,text/xml,*/*');
  if (!res.ok || !res.body) return urls;

  const locs = Array.from(res.body.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi)).map((m) => m[1].trim());
  for (const loc of locs) {
    try {
      const locHost = new URL(loc).hostname;
      if (locHost.toLowerCase() !== host.toLowerCase()) continue;
    } catch {
      continue;
    }

    if (loc.toLowerCase().endsWith('.xml') && urls.length < 50 && /(post|page|blog|news|main)/i.test(loc)) {
      const sub = await fastFetch(loc, 4000, 'application/xml,text/xml,*/*');
      if (sub.ok) {
        const subLocs = Array.from(sub.body.matchAll(/<loc>\s*(https?:\/\/[^<\s]+)\s*<\/loc>/gi)).map((m) => m[1].trim());
        urls.push(...subLocs.slice(0, 50));
      }
      continue;
    }

    urls.push(loc);
    if (urls.length >= 100) break;
  }

  return Array.from(new Set(urls));
}

async function fetchGoogleNews(companyName: string, host: string, limit = 5): Promise<ArticleItem[]> {
  if (!companyName && !host) return [];
  const query = companyName
    ? host
      ? `"${companyName}" OR ${host}`
      : `"${companyName}"`
    : host;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fastFetch(url, 6000, 'application/rss+xml,application/xml,text/xml');
  if (!res.ok || !res.body) return [];
  return parseRssOrAtomXml(res.body, limit);
}

/**
 * Single-URL fast scrape -> Clean Markdown + Metadata + optional Brand Kit
 */
export async function scrapeSingleUrl(options: ScrapeOptions): Promise<{
  ok: boolean;
  blocked: boolean;
  http_status: number;
  blocked_reason: string | null;
  url: string;
  final_url: string;
  title: string;
  description: string;
  markdown: string;
  brand_kit: BrandKit | null;
  json_ld: Record<string, unknown>;
  links: Array<{ url: string; anchor: string }>;
  duration_ms: number;
}> {
  const started = Date.now();
  const url = normalizeUrl(options.url);
  const host = new URL(url).hostname;
  const maxChars = options.max_chars || 16000;

  let status = 0;
  let finalUrl = url;
  let html = '';
  let headers: Record<string, string> = {};
  let brandKit: BrandKit | null = null;

  const shouldUsePlaywright = options.render_js !== false || Boolean(options.extract_brand);

  if (shouldUsePlaywright) {
    await withPage(async (page) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
      status = response?.status() || 0;
      headers = response?.headers() || {};
      finalUrl = page.url() || url;

      // Give SPAs a brief moment to settle without stalling on long-polling sockets
      await page.waitForLoadState('networkidle', { timeout: 3500 }).catch(() => {});
      html = await page.content();

      const waf = detectWafOrChallenge(status, headers, html);
      if (!waf.blocked && status >= 200 && status < 400 && options.extract_brand) {
        const docMeta = extractDocumentFromHtml(html, finalUrl, 4000);
        brandKit = await extractBrandKitFromPage(
          page,
          new URL(finalUrl).hostname || host,
          typeof docMeta.jsonLd.logo === 'string' ? docMeta.jsonLd.logo : undefined,
          docMeta.linkedinUrl || undefined
        );
      }
    });
  } else {
    const res = await fastFetch(url, 10000);
    status = res.status;
    finalUrl = res.finalUrl;
    html = res.body;
    headers = res.headers;
  }

  const waf = detectWafOrChallenge(status, headers, html);
  if (waf.blocked || status < 200 || status >= 400 || !html) {
    return {
      ok: false,
      blocked: waf.blocked,
      http_status: status,
      blocked_reason: waf.reason || (status ? `HTTP ${status} fetching ${url}` : `Could not connect to ${url}`),
      url,
      final_url: finalUrl,
      title: '',
      description: '',
      markdown: '',
      brand_kit: null,
      json_ld: {},
      links: [],
      duration_ms: Date.now() - started,
    };
  }

  const doc = extractDocumentFromHtml(html, finalUrl, maxChars);
  return {
    ok: true,
    blocked: false,
    http_status: status,
    blocked_reason: null,
    url,
    final_url: finalUrl,
    title: doc.title,
    description: doc.description,
    markdown: doc.markdown,
    brand_kit: brandKit,
    json_ld: doc.jsonLd,
    links: doc.links,
    duration_ms: Date.now() - started,
  };
}

/**
 * Full intelligent multi-page crawl + Brand Kit + RSS/Blog + External News + optional ClueState sync
 */
export async function runIntelligentCrawl(
  options: CrawlOptions,
  report: StepReporter = () => {}
): Promise<CrawlResult> {
  const started = Date.now();
  const url = normalizeUrl(options.url);
  if (!url) {
    throw new Error('Missing url');
  }

  const parsedInput = new URL(url);
  const inputHost = parsedInput.hostname;
  const maxPages = Math.max(1, Math.min(15, Number(options.max_pages ?? 8)));
  const maxArticles = Math.max(1, Math.min(8, Number(options.max_articles ?? 4)));
  const includeSitemap = options.include_sitemap !== false;
  const includeBlogNews = options.include_blog_and_news !== false;
  const includeExternalNews = options.include_external_news !== false;
  const extractBrand = options.extract_brand !== false;
  const companyName = (options.name || '').trim();

  // Step 1: Render Homepage & Extract Brand Kit (Playwright)
  await report('homepage', 'running', `Rendering ${url}...`, 10);

  let homeStatus = 0;
  let finalUrl = url;
  let homeHtml = '';
  let homeHeaders: Record<string, string> = {};
  let brandKit: BrandKit | null = null;
  let homeError: string | null = null;

  try {
    await withPage(async (page) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch((e) => {
        homeError = e?.message || 'Navigation failed';
        return null;
      });
      homeStatus = response?.status() || 0;
      homeHeaders = response?.headers() || {};
      finalUrl = page.url() || url;

      if (response && homeStatus >= 200 && homeStatus < 400) {
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      }
      homeHtml = await page.content().catch(() => '');

      const waf = detectWafOrChallenge(homeStatus, homeHeaders, homeHtml);
      if (!waf.blocked && homeStatus >= 200 && homeStatus < 400 && extractBrand) {
        await report('brand_kit', 'running', 'Inspecting computed styles, fonts & logos...', 22);
        const quickDoc = extractDocumentFromHtml(homeHtml, finalUrl, 2000);
        const effHost = new URL(finalUrl).hostname || inputHost;
        brandKit = await extractBrandKitFromPage(
          page,
          effHost,
          typeof quickDoc.jsonLd.logo === 'string' ? quickDoc.jsonLd.logo : undefined,
          quickDoc.linkedinUrl || undefined
        );
        const colorCount = brandKit.palette.length;
        await report(
          'brand_kit',
          brandKit.status === 'extracted' ? 'completed' : 'warning',
          brandKit.status === 'extracted'
            ? `Extracted ${colorCount} swatches${brandKit.heading_font ? ` & ${brandKit.heading_font}` : ''}`
            : 'No strong brand colors detected automatically',
          30
        );
      }
    });
  } catch (err: any) {
    homeError = err?.message || 'Playwright navigation error';
  }

  const wafCheck = detectWafOrChallenge(homeStatus, homeHeaders, homeHtml);
  const homeOk = !wafCheck.blocked && homeStatus >= 200 && homeStatus < 400 && homeHtml.length > 0;

  let title = '';
  let description = '';
  let jsonLd: Record<string, unknown> = {};
  const pagesCrawled: CrawledPage[] = [];
  const sourcePages: string[] = [];
  const articles: ArticleItem[] = [];
  let externalNews: ArticleItem[] = [];
  const bucketChunks: Record<'identity' | 'product_pricing_proof' | 'news_blog', string[]> = {
    identity: [],
    product_pricing_proof: [],
    news_blog: [],
  };

  if (!homeOk) {
    const blockedReason =
      wafCheck.reason ||
      homeError ||
      (homeStatus ? `HTTP ${homeStatus} fetching ${url}` : `Could not connect to ${url}`);
    await report('homepage', 'warning', blockedReason, 25);
    if (extractBrand) {
      await report('brand_kit', 'skipped', 'Skipped — homepage was blocked/unreachable', 30);
    }
    await report('subpages', 'skipped', 'Skipped — homepage was blocked/unreachable', 55);
    await report('blog_rss', 'skipped', 'Skipped — homepage was blocked/unreachable', 65);
  } else {
    const homeDoc = extractDocumentFromHtml(homeHtml, finalUrl, 8000);
    title = homeDoc.title || inputHost;
    description = homeDoc.description;
    jsonLd = homeDoc.jsonLd;

    await report('homepage', 'completed', `Rendered ${title.slice(0, 60)} (${homeDoc.textLength} chars)`, 28);

    pagesCrawled.push({
      url: finalUrl,
      category: 'homepage',
      title: title || 'Homepage',
      description,
      chars: homeDoc.textLength,
      method: 'playwright',
      markdown: homeDoc.markdown,
    });
    sourcePages.push(finalUrl);

    bucketChunks.identity.push(
      `### HOMEPAGE (${finalUrl})\nTitle: ${title}\nMeta Description: ${description}\n\n${homeDoc.markdown}`
    );
    if (Object.keys(jsonLd).length > 0) {
      bucketChunks.identity.push(`Structured Schema.org Data:\n\`\`\`json\n${JSON.stringify(jsonLd, null, 2)}\n\`\`\``);
    }

    // Step 3: Intelligent URL discovery + parallel subpage crawl
    const effParsed = new URL(finalUrl);
    const effHost = effParsed.hostname;
    const baseOrigin = `${effParsed.protocol}//${effHost}`;

    await report('subpages', 'running', 'Discovering sitemap & high-signal subpages...', 38);

    const candidatesByUrl = new Map<string, { url: string; bucket: string; score: number }>();
    const normalizedHome = finalUrl.replace(/\/$/, '');

    for (const lnk of homeDoc.links) {
      try {
        const lh = new URL(lnk.url).hostname;
        if (lh.toLowerCase() !== effHost.toLowerCase()) continue;
      } catch {
        continue;
      }
      const clean = lnk.url.replace(/\/$/, '');
      if (!clean || clean === normalizedHome) continue;
      const cls = classifyPageBucket(clean, lnk.anchor);
      if (cls.bucket === 'excluded') continue;
      const prev = candidatesByUrl.get(clean);
      if (!prev || cls.score > prev.score) {
        candidatesByUrl.set(clean, { url: clean, bucket: cls.bucket, score: cls.score });
      }
    }

    if (includeSitemap) {
      const smUrls = await fetchSitemapUrls(baseOrigin, effHost);
      for (const smUrl of smUrls) {
        const clean = smUrl.split('#')[0].replace(/\/$/, '');
        if (!clean || clean === normalizedHome || candidatesByUrl.has(clean)) continue;
        const cls = classifyPageBucket(clean, '');
        if (cls.bucket === 'excluded') continue;
        candidatesByUrl.set(clean, { url: clean, bucket: cls.bucket, score: cls.score });
      }
    }

    const byBucket: Record<string, Array<{ url: string; bucket: string; score: number }>> = {
      identity: [],
      product: [],
      pricing: [],
      proof: [],
      news_blog: [],
      general: [],
    };
    for (const cand of candidatesByUrl.values()) {
      (byBucket[cand.bucket] || byBucket.general).push(cand);
    }
    for (const list of Object.values(byBucket)) {
      list.sort((a, b) => b.score - a.score);
    }

    const bucketOrder = ['identity', 'product', 'pricing', 'proof', ...(includeBlogNews ? ['news_blog'] : []), 'general'];
    const selectedToCrawl: Array<{ url: string; bucket: string; score: number }> = [];
    while (selectedToCrawl.length < maxPages - 1) {
      let added = false;
      for (const bName of bucketOrder) {
        if (selectedToCrawl.length >= maxPages - 1) break;
        const next = byBucket[bName]?.shift();
        if (next) {
          selectedToCrawl.push(next);
          added = true;
        }
      }
      if (!added) break;
    }

    const newsHubHtmls: Array<{ url: string; html: string }> = [];

    // Fetch subpages in parallel batches of 4 via fast fetch(); fall back to Playwright ONLY for empty JS shells
    const subResults = await Promise.all(
      selectedToCrawl.map(async (target) => {
        const res = await fastFetch(target.url, 6500);
        let htmlBody = res.ok ? res.body : '';
        let method: 'fetch' | 'playwright' = 'fetch';

        let doc = htmlBody ? extractDocumentFromHtml(htmlBody, res.finalUrl || target.url, 4500) : null;
        if (!doc || doc.textLength < 220) {
          // Optional single Playwright fallback for JS-rendered key pages (cap to identity/product/proof)
          if (['identity', 'product', 'pricing', 'proof'].includes(target.bucket)) {
            try {
              await withPage(async (p) => {
                const r = await p.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => null);
                if (r && r.status() >= 200 && r.status() < 400) {
                  await p.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
                  htmlBody = await p.content();
                  doc = extractDocumentFromHtml(htmlBody, p.url() || target.url, 4500);
                  method = 'playwright';
                }
              });
            } catch {
              // ignore individual subpage Playwright failure
            }
          }
        }

        return { target, htmlBody, doc, method };
      })
    );

    for (const item of subResults) {
      if (!item.doc || item.doc.textLength < 100) continue;
      const subTitle = item.doc.title || item.target.bucket;
      pagesCrawled.push({
        url: item.target.url,
        category: item.target.bucket,
        title: subTitle,
        description: item.doc.description,
        chars: item.doc.textLength,
        method: item.method,
        markdown: item.doc.markdown,
      });
      sourcePages.push(item.target.url);

      if (item.target.bucket === 'identity') {
        bucketChunks.identity.push(`### ${subTitle} (${item.target.url})\n\n${item.doc.markdown}`);
      } else if (item.target.bucket === 'news_blog') {
        bucketChunks.news_blog.push(`### ${subTitle} (${item.target.url})\n\n${item.doc.markdown}`);
        if (item.htmlBody) newsHubHtmls.push({ url: item.target.url, html: item.htmlBody });
      } else {
        bucketChunks.product_pricing_proof.push(
          `### [${item.target.bucket.toUpperCase()}] ${subTitle} (${item.target.url})\n\n${item.doc.markdown}`
        );
      }
    }

    await report('subpages', 'completed', `Crawled ${pagesCrawled.length} pages total`, 58);

    // Step 4: Blog RSS & Article Scraping
    if (includeBlogNews) {
      await report('blog_rss', 'running', 'Scanning company blog & RSS feeds...', 64);
      const feedUrls =
        homeDoc.rssFeeds.length > 0
          ? homeDoc.rssFeeds
          : [`${baseOrigin}/feed`, `${baseOrigin}/rss.xml`, `${baseOrigin}/blog/rss.xml`];

      for (const fUrl of Array.from(new Set(feedUrls)).slice(0, 3)) {
        if (articles.length >= maxArticles) break;
        const fRes = await fastFetch(fUrl, 4000, 'application/rss+xml,application/atom+xml,application/xml,text/xml');
        if (fRes.ok && (fRes.body.includes('<rss') || fRes.body.includes('<feed'))) {
          const parsedFeed = parseRssOrAtomXml(fRes.body, maxArticles - articles.length);
          for (const a of parsedFeed) {
            articles.push({ ...a, source: 'company_blog_rss' });
          }
        }
      }

      if (articles.length < maxArticles && newsHubHtmls.length > 0) {
        const artCandidates = new Map<string, string>();
        for (const hub of newsHubHtmls) {
          const hubDoc = extractDocumentFromHtml(hub.html, hub.url, 500);
          for (const lnk of hubDoc.links) {
            if (sourcePages.includes(lnk.url)) continue;
            try {
              const u = new URL(lnk.url);
              if (u.hostname.toLowerCase() !== effHost.toLowerCase()) continue;
              if (/\/(blog|news|newsroom|press|insights|articles)\/[a-z0-9\-_]{5,}/i.test(u.pathname)) {
                artCandidates.set(lnk.url, lnk.anchor);
              }
            } catch {
              continue;
            }
          }
        }

        const targets = Array.from(artCandidates.entries()).slice(0, maxArticles - articles.length);
        const fetchedArts = await Promise.all(
          targets.map(async ([artUrl, anchor]) => {
            const aRes = await fastFetch(artUrl, 5000);
            if (!aRes.ok || !aRes.body) return null;
            const aDoc = extractDocumentFromHtml(aRes.body, artUrl, 2400);
            if (aDoc.textLength < 120) return null;
            return {
              title: aDoc.title || anchor || 'Article',
              url: artUrl,
              published_at: '',
              source: 'company_blog_page',
              summary: aDoc.markdown,
              chars: aDoc.textLength,
            };
          })
        );

        for (const fa of fetchedArts) {
          if (!fa) continue;
          articles.push({
            title: fa.title,
            url: fa.url,
            published_at: fa.published_at,
            source: fa.source,
            summary: fa.summary,
          });
          pagesCrawled.push({
            url: fa.url,
            category: 'article',
            title: fa.title,
            chars: fa.chars,
            method: 'fetch',
          });
          sourcePages.push(fa.url);
        }
      }
      await report('blog_rss', 'completed', `Found ${articles.length} company blog/news items`, 70);
    } else {
      await report('blog_rss', 'skipped', 'Disabled in scraper settings', 70);
    }
  }

  // Step 5: External Press & News (ALWAYS runs even if website returned 403!)
  if (includeExternalNews) {
    await report('external_news', 'running', 'Fetching recent press & external news...', 75);
    externalNews = await fetchGoogleNews(companyName, inputHost, 5);
    await report(
      'external_news',
      externalNews.length > 0 ? 'completed' : 'warning',
      externalNews.length > 0 ? `Found ${externalNews.length} recent press articles` : 'No recent external news found',
      82
    );
  } else {
    await report('external_news', 'skipped', 'Disabled in scraper settings', 82);
  }

  // Step 6: Assemble structured Markdown episodes
  const episodes: EpisodePayload[] = [];
  const nowIso = new Date().toISOString();

  if (bucketChunks.identity.length > 0) {
    episodes.push({
      key: 'homepage_identity',
      category: 'identity',
      title: 'Company Identity, Homepage & About',
      url: finalUrl,
      source_type: 'website_homepage',
      occurred_at: nowIso,
      content: bucketChunks.identity.join('\n\n---\n\n').slice(0, 14000),
    });
  }

  if (bucketChunks.product_pricing_proof.length > 0) {
    episodes.push({
      key: 'products_pricing_proof',
      category: 'products',
      title: 'Products, Solutions, Pricing & Case Studies',
      url: finalUrl,
      source_type: 'website_products_proof',
      occurred_at: nowIso,
      content: bucketChunks.product_pricing_proof.join('\n\n---\n\n').slice(0, 15000),
    });
  }

  if (bucketChunks.news_blog.length > 0 || articles.length > 0) {
    const artLines = [...bucketChunks.news_blog];
    for (const a of articles) {
      artLines.push(
        `### ARTICLE: ${a.title}\nURL: ${a.url}${a.published_at ? `\nPublished: ${a.published_at}` : ''}\n\n${a.summary}`
      );
    }
    episodes.push({
      key: 'company_blog_articles',
      category: 'blog',
      title: 'Company Blog Posts & Announcements',
      url: finalUrl,
      source_type: 'company_blog',
      occurred_at: nowIso,
      content: artLines.join('\n\n---\n\n').slice(0, 14000),
    });
  }

  if (externalNews.length > 0) {
    const newsLines = externalNews.map(
      (n) =>
        `- **${n.title}**${n.source ? ` (${n.source})` : ''}${n.published_at ? ` [${n.published_at}]` : ''}${n.summary ? `\n  ${n.summary}` : ''}${n.url ? `\n  Link: ${n.url}` : ''}`
    );
    episodes.push({
      key: 'company_news_press',
      category: 'news',
      title: 'Recent External News & Press Coverage',
      url: finalUrl,
      source_type: 'press_news',
      occurred_at: externalNews[0]?.published_at || nowIso,
      content: `Recent News & Press Mentions:\n\n${newsLines.join('\n\n')}`.slice(0, 10000),
    });
  }

  // Step 7: Optional ClueState ingestion
  let cluestateResult = undefined;
  if (options.cluestate?.api_key) {
    await report('cluestate', 'running', `Syncing ${Math.max(1, episodes.length)} episode(s) to ClueState...`, 88);
    cluestateResult = await syncEpisodesToClueState(
      {
        ...options.cluestate,
        profile_header: options.cluestate.profile_header || options.profile_header,
        meta: {
          ...(options.cluestate.meta || {}),
          website: finalUrl,
          source_pages_count: pagesCrawled.length,
          ...(brandKit ? { brand_kit: brandKit } : {}),
        },
      },
      episodes
    );
    await report(
      'cluestate',
      cluestateResult.cluestate_synced ? 'completed' : 'warning',
      cluestateResult.cluestate_synced
        ? `Synced ${cluestateResult.episodes_ingested} new / ${cluestateResult.episodes_replayed} replayed episodes (${cluestateResult.memories.length} memories)`
        : cluestateResult.cluestate_error || 'ClueState sync failed',
      100
    );
  } else {
    await report('cluestate', 'skipped', 'No ClueState key supplied', 100);
  }

  const combinedMarkdown = episodes
    .map((ep) => `## ${ep.title}\n\n${ep.content}`)
    .join('\n\n==============================\n\n');

  const partial = !homeOk && (externalNews.length > 0 || Boolean(cluestateResult?.cluestate_synced));
  const blockedReason = !homeOk
    ? wafCheck.reason || homeError || (homeStatus ? `HTTP ${homeStatus} fetching ${url}` : `Could not connect to ${url}`)
    : null;

  return {
    ok: homeOk,
    partial,
    blocked: wafCheck.blocked,
    http_status: homeStatus,
    blocked_reason: blockedReason,
    error: homeOk ? null : blockedReason,
    url,
    final_url: finalUrl,
    title: title || companyName || inputHost,
    description,
    markdown: combinedMarkdown,
    brand_kit: brandKit,
    json_ld: jsonLd,
    pages_crawled: pagesCrawled,
    articles,
    external_news: externalNews,
    episodes,
    source_pages: Array.from(new Set(sourcePages)),
    cluestate: cluestateResult,
    duration_ms: Date.now() - started,
  };
}
