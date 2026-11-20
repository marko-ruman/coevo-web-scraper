import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';

const turndown = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
});

turndown.remove(['script', 'style', 'noscript', 'iframe', 'canvas', 'form']);
turndown.remove((node) => node.nodeName.toLowerCase() === 'svg');

export function normalizeUrl(rawUrl: string): string {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

export function resolveRelativeUrl(rel: string, base: string): string {
  const clean = (rel || '').trim();
  if (
    !clean ||
    clean.startsWith('data:') ||
    clean.startsWith('mailto:') ||
    clean.startsWith('tel:') ||
    clean.startsWith('javascript:') ||
    clean.startsWith('#')
  ) {
    return '';
  }
  try {
    return new URL(clean, base).toString();
  } catch {
    return '';
  }
}

export interface WafDetection {
  blocked: boolean;
  reason: string | null;
}

export function detectWafOrChallenge(
  status: number,
  headers: Record<string, string | undefined>,
  html: string
): WafDetection {
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined) lowerHeaders[k.toLowerCase()] = String(v).toLowerCase();
  }

  const cfMitigated = lowerHeaders['cf-mitigated'] || '';
  const server = lowerHeaders['server'] || '';
  const snippet = (html || '').slice(0, 6000).toLowerCase();

  if (
    cfMitigated.includes('challenge') ||
    snippet.includes('challenges.cloudflare.com') ||
    snippet.includes('<title>just a moment...</title>') ||
    snippet.includes('cf-browser-verification')
  ) {
    return {
      blocked: true,
      reason: `Website is protected by Cloudflare anti-bot challenge (HTTP ${status || 403}).`,
    };
  }

  if (
    status === 403 &&
    (server.includes('akamai') ||
      server.includes('imperva') ||
      server.includes('datadome') ||
      snippet.includes('access denied') ||
      snippet.includes('request blocked') ||
      snippet.includes('verify you are human') ||
      snippet.includes('bot protection') ||
      snippet.includes('perimeterx'))
  ) {
    return {
      blocked: true,
      reason: `Website blocked automated requests via WAF / bot protection (HTTP 403).`,
    };
  }

  if (status === 403 || status === 401) {
    return {
      blocked: true,
      reason: `Website returned HTTP ${status} denying automated access.`,
    };
  }

  if (status === 429) {
    return {
      blocked: true,
      reason: `Website rate-limited automated requests (HTTP 429).`,
    };
  }

  return { blocked: false, reason: null };
}

export interface ExtractedDocument {
  title: string;
  description: string;
  markdown: string;
  textLength: number;
  jsonLd: Record<string, unknown>;
  linkedinUrl: string;
  rssFeeds: string[];
  links: Array<{ url: string; anchor: string }>;
}

export function extractDocumentFromHtml(html: string, pageUrl: string, maxChars = 14000): ExtractedDocument {
  const dom = new JSDOM(html || '<html></html>', { url: pageUrl });
  const doc = dom.window.document;

  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('title')?.textContent?.trim() ||
    '';

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() ||
    doc.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim() ||
    '';

  // Parse JSON-LD Organization / WebSite
  const jsonLd: Record<string, unknown> = {};
  let linkedinUrl = '';
  for (const script of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const parsed = JSON.parse(script.textContent || '');
      const nodes = Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed];
      for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        const types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (types.some((t: unknown) => ['Organization', 'Corporation', 'LocalBusiness', 'SoftwareApplication', 'WebSite'].includes(String(t)))) {
          if (node.name && !jsonLd.name) jsonLd.name = String(node.name);
          if (node.description && !jsonLd.description) jsonLd.description = String(node.description);
          if (node.foundingDate && !jsonLd.founding_date) jsonLd.founding_date = String(node.foundingDate);
          if (node.logo && !jsonLd.logo) {
            const rawLogo = typeof node.logo === 'object' ? node.logo.url : node.logo;
            if (rawLogo) jsonLd.logo = resolveRelativeUrl(String(rawLogo), pageUrl);
          }
          if (Array.isArray(node.sameAs)) {
            for (const s of node.sameAs) {
              if (typeof s === 'string' && s.toLowerCase().includes('linkedin.com/company/')) {
                linkedinUrl = s;
              }
            }
          }
        }
      }
    } catch {
      // skip malformed JSON-LD
    }
  }

  if (!linkedinUrl) {
    const liMatch = html.match(/https?:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9\-_%]+/i);
    if (liMatch) linkedinUrl = liMatch[0];
  }

  // RSS / Atom feeds
  const rssFeeds: string[] = [];
  for (const linkEl of Array.from(doc.querySelectorAll('link[type*="rss"], link[type*="atom"]'))) {
    const href = linkEl.getAttribute('href');
    if (href) {
      const resolved = resolveRelativeUrl(href, pageUrl);
      if (resolved) rssFeeds.push(resolved);
    }
  }

  // Extract same-origin & nav links before Readability mutates the DOM
  const links: Array<{ url: string; anchor: string }> = [];
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href') || '';
    const resolved = resolveRelativeUrl(href, pageUrl);
    if (resolved) {
      links.push({
        url: resolved.split('#')[0].replace(/\/$/, '') || resolved,
        anchor: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
      });
    }
  }

  // Convert clean content to Markdown via Readability -> Turndown (fallback to main/body)
  let markdown = '';
  try {
    const clonedDom = new JSDOM(html || '<html></html>', { url: pageUrl });
    const reader = new Readability(clonedDom.window.document);
    const article = reader.parse();
    if (article?.content && article.textContent && article.textContent.trim().length > 180) {
      markdown = turndown.turndown(article.content);
    }
  } catch {
    // fallback below
  }

  if (markdown.trim().length < 220) {
    // Strip nav/footer/cookie clutter and convert body/main
    const bodyClone = (doc.querySelector('main') || doc.body)?.cloneNode(true) as HTMLElement | null;
    if (bodyClone) {
      bodyClone
        .querySelectorAll('script, style, noscript, svg, iframe, footer, nav, [role="dialog"], [class*="cookie"], [id*="cookie"]')
        .forEach((el) => el.remove());
      const fallbackMd = turndown.turndown(bodyClone.innerHTML || '');
      if (fallbackMd.trim().length > markdown.trim().length) {
        markdown = fallbackMd;
      }
    }
  }

  // Collapse excess blank lines
  markdown = markdown
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxChars);

  return {
    title: title || String(jsonLd.name || ''),
    description: description || String(jsonLd.description || ''),
    markdown,
    textLength: markdown.length,
    jsonLd,
    linkedinUrl,
    rssFeeds: Array.from(new Set(rssFeeds)),
    links,
  };
}
