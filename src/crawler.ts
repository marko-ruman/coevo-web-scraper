import { withPage } from './browser.js';
import { extractBrandKitFromPage } from './brand.js';
import {
  extractNewsArticleLinksFromHtml,
  extractPeopleAndContactsFromHtml,
  mergeContactsLists,
  mergePeopleLists,
} from './extractors.js';
import {
  BUCKET_SYNONYMS,
  detectSiteLanguage,
  foldAccents,
  getGoogleNewsLocale,
  type DetectedLanguageResult,
} from './i18n.js';
import {
  detectWafOrChallenge,
  extractDocumentFromHtml,
  normalizeUrl,
  resolveRelativeUrl,
} from './markdown.js';
import type {
  ArticleItem,
  BrandKit,
  CrawledPage,
  CrawlOptions,
  CrawlResult,
  EpisodePayload,
  ScrapedContacts,
  ScrapedPerson,
  ScrapeOptions,
  StepState,
} from './types.js';

const FETCH_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export type StepReporter = (key: string, status: StepState, detail?: string, progressPct?: number) => void | Promise<void>;

async function fastFetch(
  url: string,
  timeoutMs = 8000,
  accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  acceptLanguage = 'en-US,en;q=0.9,*;q=0.7'
): Promise<{ ok: boolean; status: number; finalUrl: string; body: string; headers: Record<string, string>; error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      headers: {
        'User-Agent': FETCH_UA,
        Accept: accept,
        'Accept-Language': acceptLanguage,
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

export function classifyPageBucket(urlStr: string, anchorText = ''): { bucket: string; score: number } {
  let rawPath = '/';
  try {
    rawPath = new URL(urlStr).pathname;
  } catch {
    rawPath = '/';
  }

  const lowerPath = rawPath.toLowerCase();
  if (/\.(pdf|png|jpe?g|gif|svg|webp|ico|css|js|xml|zip|gz|mp4|woff2?)$/i.test(lowerPath)) {
    return { bucket: 'excluded', score: 0 };
  }
  if (/\/(login|signin|sign-in|signup|sign-up|register|logout|cart|checkout|account|wp-admin|wp-json|tag\/|author\/|category\/|kategorie\/|stitek\/|page\/\d+|strana\/\d+)/i.test(lowerPath)) {
    return { bucket: 'excluded', score: 0 };
  }

  const foldedPath = foldAccents(rawPath);
  const foldedAnchor = foldAccents(anchorText).replace(/[^a-z0-9\s-]+/g, ' ').trim();
  const pathSegments = foldedPath.split('/').filter(Boolean);
  const depth = pathSegments.length;

  let bestBucket = 'general';
  let bestScore = 10;

  for (const [bucketName, cfg] of Object.entries(BUCKET_SYNONYMS)) {
    let bucketScore = 0;

    for (const kw of cfg.keywords) {
      const cleanKw = kw.replace(/-/g, ' ');
      const segExact = pathSegments.some((seg) => seg === kw || seg.replace(/_/g, '-') === kw);
      const segSub = !segExact && kw.length >= 4 && pathSegments.some((seg) => seg.includes(kw));

      if (segExact) {
        bucketScore = Math.max(bucketScore, cfg.urlScore);
      } else if (segSub) {
        bucketScore = Math.max(bucketScore, Math.round(cfg.urlScore * 0.78));
      }

      if (foldedAnchor) {
        const anchorWords = foldedAnchor.split(/\s+/);
        if (foldedAnchor === cleanKw || anchorWords.includes(kw)) {
          bucketScore = Math.max(bucketScore, cfg.anchorScore + (bucketScore > 0 ? 14 : 38));
        } else if (cleanKw.length >= 4 && foldedAnchor.includes(cleanKw)) {
          bucketScore = Math.max(bucketScore, cfg.anchorScore + 26);
        }
      }
    }

    if (bucketScore > 0) {
      if (bucketName === 'legal') {
        if (bestBucket === 'general' && bucketScore >= cfg.urlScore) {
          return { bucket: 'excluded', score: 0 };
        }
        continue;
      }

      let finalScore = bucketScore - Math.max(0, depth - 1) * 5;
      if (depth === 1) finalScore += 12;
      if (finalScore > bestScore) {
        bestScore = finalScore;
        bestBucket = bucketName;
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

async function fetchGoogleNews(companyName: string, host: string, limit = 5, langCode?: string): Promise<ArticleItem[]> {
  if (!companyName && !host) return [];
  const query = companyName
    ? host
      ? `"${companyName}" OR ${host}`
      : `"${companyName}"`
    : host;
  const locale = getGoogleNewsLocale(langCode, host);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=${encodeURIComponent(locale.hl)}&gl=${encodeURIComponent(locale.gl)}&ceid=${encodeURIComponent(locale.ceid)}`;
  const res = await fastFetch(url, 6000, 'application/rss+xml,application/xml,text/xml', `${locale.hl},en;q=0.7`);
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
 * Full intelligent multi-page crawl + Brand Kit + RSS/Blog + External News
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

  let detectedLang: DetectedLanguageResult = detectSiteLanguage({ url });
  let title = '';
  let description = '';
  let jsonLd: Record<string, unknown> = {};
  const pagesCrawled: CrawledPage[] = [];
  const sourcePages: string[] = [];
  const articles: ArticleItem[] = [];
  let externalNews: ArticleItem[] = [];
  const peopleLists: ScrapedPerson[][] = [];
  const contactLists: ScrapedContacts[] = [];
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
    detectedLang = detectSiteLanguage({ html: homeHtml, text: homeDoc.markdown, url: finalUrl });
    const homePC = extractPeopleAndContactsFromHtml(homeHtml, finalUrl, homeDoc.markdown);
    if (homePC.people.length > 0) peopleLists.push(homePC.people);
    contactLists.push(homePC.contacts);

    title = homeDoc.title || inputHost;
    description = homeDoc.description;
    jsonLd = homeDoc.jsonLd;

    await report('homepage', 'completed', `Rendered ${title.slice(0, 60)} (${homeDoc.textLength} chars · lang=${detectedLang.code})`, 28);

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
      `### HOMEPAGE (${finalUrl})\nLanguage: ${detectedLang.code} (confidence=${detectedLang.confidence})\nTitle: ${title}\nMeta Description: ${description}\n\n${homeDoc.markdown}`
    );
    if (Object.keys(jsonLd).length > 0) {
      bucketChunks.identity.push(`Structured Schema.org Data:\n\`\`\`json\n${JSON.stringify(jsonLd, null, 2)}\n\`\`\``);
    }

    // Step 3: Intelligent URL discovery + parallel subpage crawl
    const effParsed = new URL(finalUrl);
    const effHost = effParsed.hostname;
    const baseOrigin = `${effParsed.protocol}//${effHost}`;
    const acceptLangHeader = `${detectedLang.code},en;q=0.7`;

    await report('subpages', 'running', `Discovering sitemap & key (${detectedLang.code}) subpages...`, 38);

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
      leadership: [],
      about: [],
      products_services: [],
      contact: [],
      customers: [],
      news_blog: [],
      general: [],
      careers: [],
    };
    for (const cand of candidatesByUrl.values()) {
      (byBucket[cand.bucket] || byBucket.general).push(cand);
    }
    for (const list of Object.values(byBucket)) {
      list.sort((a, b) => b.score - a.score);
    }

    const bucketOrder = [
      'leadership',
      'about',
      'products_services',
      'contact',
      ...(includeBlogNews ? ['news_blog'] : []),
      'customers',
      'general',
      'careers',
    ];
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

    // Fetch subpages in parallel via fast fetch(); fall back to Playwright for JS shells or empty news hubs
    const subResults = await Promise.all(
      selectedToCrawl.map(async (target) => {
        const res = await fastFetch(target.url, 6500, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', acceptLangHeader);
        let htmlBody = res.ok ? res.body : '';
        let method: 'fetch' | 'playwright' = 'fetch';

        let doc = htmlBody ? extractDocumentFromHtml(htmlBody, res.finalUrl || target.url, 4500) : null;
        const needsNewsJsRender =
          target.bucket === 'news_blog' &&
          options.render_js !== false &&
          (!htmlBody || extractNewsArticleLinksFromHtml(htmlBody, target.url, 4).articleUrls.length === 0);

        if (!doc || doc.textLength < 220 || needsNewsJsRender) {
          if (['leadership', 'about', 'contact', 'products_services', 'customers', 'news_blog'].includes(target.bucket)) {
            try {
              await withPage(async (p) => {
                const r = await p.goto(target.url, { waitUntil: 'domcontentloaded' }).catch(() => null);
                if (r && r.status() >= 200 && r.status() < 400) {
                  await p.waitForLoadState('networkidle', { timeout: 2800 }).catch(() => {});
                  const rendered = await p.content();
                  if (rendered && rendered.length > htmlBody.length * 0.6) {
                    htmlBody = rendered;
                    doc = extractDocumentFromHtml(htmlBody, p.url() || target.url, 4500);
                    method = 'playwright';
                  }
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
      if (item.htmlBody) {
        const subPC = extractPeopleAndContactsFromHtml(item.htmlBody, item.target.url, item.doc?.markdown || '');
        if (subPC.people.length > 0) peopleLists.push(subPC.people);
        contactLists.push(subPC.contacts);
      }

      if (!item.doc || item.doc.textLength < 90) continue;
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

      if (['about', 'leadership', 'contact', 'careers'].includes(item.target.bucket)) {
        bucketChunks.identity.push(`### [${item.target.bucket.toUpperCase()}] ${subTitle} (${item.target.url})\n\n${item.doc.markdown}`);
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

    // Step 4: Blog RSS & Article Scraping (Multilingual hub discovery + inline fallback)
    if (includeBlogNews) {
      await report('blog_rss', 'running', 'Scanning company blog, news hubs & RSS feeds...', 64);
      const hubFeedHints = newsHubHtmls.flatMap((h) => {
        const cleanHub = h.url.replace(/\/$/, '');
        return [`${cleanHub}/feed`, `${cleanHub}/rss.xml`];
      });
      const feedUrls =
        homeDoc.rssFeeds.length > 0
          ? [...homeDoc.rssFeeds, ...hubFeedHints]
          : [...hubFeedHints, `${baseOrigin}/feed`, `${baseOrigin}/rss.xml`, `${baseOrigin}/blog/rss.xml`];

      for (const fUrl of Array.from(new Set(feedUrls)).slice(0, 4)) {
        if (articles.length >= maxArticles) break;
        const fRes = await fastFetch(fUrl, 4000, 'application/rss+xml,application/atom+xml,application/xml,text/xml', acceptLangHeader);
        if (fRes.ok && (fRes.body.includes('<rss') || fRes.body.includes('<feed'))) {
          const parsedFeed = parseRssOrAtomXml(fRes.body, maxArticles - articles.length);
          for (const a of parsedFeed) {
            articles.push({ ...a, source: 'company_blog_rss' });
          }
        }
      }

      // If no dedicated news_blog subpage was selected, check homepage links for news/article URLs directly
      if (newsHubHtmls.length === 0) {
        newsHubHtmls.push({ url: finalUrl, html: homeHtml });
      }

      if (articles.length < maxArticles && newsHubHtmls.length > 0) {
        const seenArtUrls = new Set<string>(sourcePages);
        const targetArtUrls: Array<{ url: string; fallbackItem?: ArticleItem }> = [];
        const inlineFallbackMap = new Map<string, ArticleItem>();

        for (const hub of newsHubHtmls) {
          const extracted = extractNewsArticleLinksFromHtml(hub.html, hub.url, Math.max(8, maxArticles * 3));
          for (const inline of extracted.inlineItems) {
            inlineFallbackMap.set(inline.url, inline);
          }
          for (const artUrl of extracted.articleUrls) {
            if (seenArtUrls.has(artUrl)) continue;
            seenArtUrls.add(artUrl);
            targetArtUrls.push({ url: artUrl, fallbackItem: inlineFallbackMap.get(artUrl) });
          }
        }

        const targets = targetArtUrls.slice(0, maxArticles - articles.length);
        const fetchedArts = await Promise.all(
          targets.map(async (entry) => {
            const aRes = await fastFetch(entry.url, 5500, 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', acceptLangHeader);
            let aBody = aRes.ok ? aRes.body : '';
            let aMethod: 'fetch' | 'playwright' = 'fetch';
            let aDoc = aBody ? extractDocumentFromHtml(aBody, entry.url, 3200) : null;

            if ((!aDoc || aDoc.textLength < 140) && options.render_js !== false) {
              try {
                await withPage(async (p) => {
                  const r = await p.goto(entry.url, { waitUntil: 'domcontentloaded' }).catch(() => null);
                  if (r && r.status() >= 200 && r.status() < 400) {
                    await p.waitForLoadState('networkidle', { timeout: 2200 }).catch(() => {});
                    aBody = await p.content();
                    aDoc = extractDocumentFromHtml(aBody, p.url() || entry.url, 3200);
                    aMethod = 'playwright';
                  }
                });
              } catch {
                // fall back to inline card summary if present
              }
            }

            if (aDoc && aDoc.textLength >= 110) {
              return {
                title: aDoc.title || entry.fallbackItem?.title || 'Article',
                url: entry.url,
                published_at: entry.fallbackItem?.published_at || '',
                source: 'company_blog_page',
                summary: aDoc.markdown,
                chars: aDoc.textLength,
                method: aMethod,
              };
            }
            if (entry.fallbackItem && (entry.fallbackItem.summary.length >= 25 || entry.fallbackItem.title.length >= 12)) {
              return {
                title: entry.fallbackItem.title,
                url: entry.url,
                published_at: entry.fallbackItem.published_at,
                source: 'company_blog_hub_card',
                summary: entry.fallbackItem.summary || entry.fallbackItem.title,
                chars: (entry.fallbackItem.summary || entry.fallbackItem.title).length,
                method: 'fetch' as const,
              };
            }
            return null;
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
            method: fa.method,
            markdown: fa.summary,
          });
          sourcePages.push(fa.url);
        }
      }
      await report('blog_rss', 'completed', `Found ${articles.length} company blog/news items`, 70);
    } else {
      await report('blog_rss', 'skipped', 'Disabled in scraper settings', 70);
    }
  }

  // Step 5: External Press & News (localized to detected language + ccTLD, ALWAYS runs even if website returned 403!)
  if (includeExternalNews) {
    await report('external_news', 'running', `Fetching recent press & external news (${detectedLang.googleNews.ceid})...`, 75);
    externalNews = await fetchGoogleNews(companyName, inputHost, 5, detectedLang.code);
    await report(
      'external_news',
      externalNews.length > 0 ? 'completed' : 'warning',
      externalNews.length > 0 ? `Found ${externalNews.length} recent press articles` : 'No recent external news found',
      82
    );
  } else {
    await report('external_news', 'skipped', 'Disabled in scraper settings', 82);
  }

  // Merge discovered people & contacts across homepage + team/about/contact pages
  const people = mergePeopleLists(peopleLists);
  const contacts = mergeContactsLists(contactLists);

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

  if (
    people.length > 0 ||
    contacts.emails.length > 0 ||
    contacts.phones.length > 0 ||
    contacts.social_links.length > 0 ||
    contacts.addresses.length > 0
  ) {
    const contactSections: string[] = [];
    if (contacts.emails.length > 0) contactSections.push(`Emails: ${contacts.emails.join(', ')}`);
    if (contacts.phones.length > 0) contactSections.push(`Phones: ${contacts.phones.join(', ')}`);
    if (contacts.social_links.length > 0) contactSections.push(`Social Profiles: ${contacts.social_links.join(', ')}`);
    if (contacts.addresses.length > 0) contactSections.push(`Addresses: ${contacts.addresses.join(' | ')}`);

    const peopleLines = people.map((p) => {
      const parts = [p.role, p.email, p.phone, p.linkedin_url].filter(Boolean);
      return `- **${p.name}**${parts.length > 0 ? ` — ${parts.join(' | ')}` : ''}${p.bio ? `\n  ${p.bio}` : ''}`;
    });

    const bodyParts: string[] = [];
    if (peopleLines.length > 0) bodyParts.push(`Leadership & Team Contacts Discovered:\n\n${peopleLines.join('\n')}`);
    if (contactSections.length > 0) bodyParts.push(`Public Contact Channels:\n${contactSections.join('\n')}`);

    episodes.push({
      key: 'company_people_contacts',
      category: 'people',
      title: 'Key People, Leadership & Public Contact Channels',
      url: finalUrl,
      source_type: 'website_team_contacts',
      occurred_at: nowIso,
      content: bodyParts.join('\n\n').slice(0, 14000),
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

  const combinedMarkdown = episodes
    .map((ep) => `## ${ep.title}\n\n${ep.content}`)
    .join('\n\n==============================\n\n');

  const partial = !homeOk && externalNews.length > 0;
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
    detected_language: detectedLang.code,
    detected_language_confidence: detectedLang.confidence,
    detected_language_source: detectedLang.source,
    people,
    contacts,
    pages_crawled: pagesCrawled,
    articles,
    external_news: externalNews,
    episodes,
    source_pages: Array.from(new Set(sourcePages)),
    duration_ms: Date.now() - started,
  };
}
