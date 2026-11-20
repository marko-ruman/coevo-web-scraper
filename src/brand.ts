import type { Page } from 'playwright';
import type { BrandKit, PaletteSwatch } from './types.js';

interface RGB {
  r: number;
  g: number;
  b: number;
}

function clamp(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function parseColorToRgb(input: string): RGB | null {
  const s = (input || '').trim().toLowerCase();
  if (!s || s === 'transparent' || s === 'none' || s === 'inherit' || s === 'initial') return null;

  // Hex
  const hexMatch = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    let h = hexMatch[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (h.length === 8) {
      const alpha = parseInt(h.slice(6, 8), 16);
      if (alpha < 25) return null;
      h = h.slice(0, 6);
    }
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
    };
  }

  // rgb(...) / rgba(...)
  const rgbMatch = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgbMatch) {
    if (rgbMatch[4] !== undefined) {
      const rawA = rgbMatch[4];
      const a = rawA.endsWith('%') ? parseFloat(rawA) / 100 : parseFloat(rawA);
      if (!Number.isNaN(a) && a < 0.12) return null;
    }
    return {
      r: clamp(parseFloat(rgbMatch[1])),
      g: clamp(parseFloat(rgbMatch[2])),
      b: clamp(parseFloat(rgbMatch[3])),
    };
  }

  return null;
}

function rgbToHex({ r, g, b }: RGB): string {
  return (
    '#' +
    [r, g, b]
      .map((n) => clamp(n).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

function luminance({ r, g, b }: RGB): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function saturation({ r, g, b }: RGB): number {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const delta = max - min;
  if (delta === 0) return 0;
  const l = (max + min) / 2;
  return delta / (1 - Math.abs(2 * l - 1));
}

function colorDistance(a: RGB, b: RGB): number {
  return Math.sqrt(Math.pow(a.r - b.r, 2) + Math.pow(a.g - b.g, 2) + Math.pow(a.b - b.b, 2));
}

function isBrandChromatic(rgb: RGB): boolean {
  const sat = saturation(rgb);
  const lum = luminance(rgb);
  return sat >= 0.18 && lum > 0.015 && lum < 0.92;
}

function cleanFontFamily(raw: string): string {
  if (!raw) return '';
  const first = raw
    .split(',')
    .map((p) => p.trim().replace(/^["']|["']$/g, ''))
    .find(
      (f) =>
        f &&
        !['system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'sans-serif', 'serif', 'monospace', 'inherit'].includes(
          f.toLowerCase()
        )
    );
  return first || raw.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

interface RawDomBrandScan {
  bodyBg: string;
  bodyColor: string;
  bodyFont: string;
  headingFont: string;
  headerBg: string;
  fontUrls: string[];
  themeColor: string;
  cssVars: Array<{ name: string; value: string }>;
  ctaColors: Array<{ color: string; weight: number; source: string }>;
  surfaceColors: Array<{ color: string; weight: number; source: string }>;
  accentColors: Array<{ color: string; weight: number; source: string }>;
  darkBgColors: Array<{ color: string; weight: number; source: string }>;
  logoCandidates: Array<{ url: string; kind: 'svg' | 'img' | 'jsonld' | 'apple_touch' | 'og' | 'favicon'; width?: number; height?: number }>;
  linkedinUrl: string;
}

/**
 * Extracts a precision 6-role Semantic Brand Kit directly from a live Playwright page
 * using rendered getComputedStyle(), CSS custom properties, inline SVG logo serialization,
 * and typography inspection.
 */
export async function extractBrandKitFromPage(
  page: Page,
  domain: string,
  jsonLdLogo?: string,
  jsonLdLinkedin?: string
): Promise<BrandKit> {
  const raw: RawDomBrandScan = await page.evaluate(() => {
    const bodyStyle = window.getComputedStyle(document.body);
    const docStyle = window.getComputedStyle(document.documentElement);
    const bodyBg =
      bodyStyle.backgroundColor && bodyStyle.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? bodyStyle.backgroundColor
        : docStyle.backgroundColor || '#FFFFFF';
    const bodyColor = bodyStyle.color || '#111110';
    const bodyFont = bodyStyle.fontFamily || '';

    const h1 = document.querySelector('h1') || document.querySelector('h2');
    const headingFont = h1 ? window.getComputedStyle(h1).fontFamily : bodyFont;

    const headerEl = document.querySelector('header') || document.querySelector('nav');
    const headerBg = headerEl ? window.getComputedStyle(headerEl).backgroundColor : '';

    const themeColor =
      document.querySelector('meta[name="theme-color"]')?.getAttribute('content')?.trim() || '';

    const fontUrls: string[] = [];
    document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="font"]').forEach((l) => {
      const href = l.getAttribute('href') || '';
      if (href.includes('fonts.googleapis.com') || href.includes('use.typekit.net') || href.includes('fonts.bunny.net')) {
        fontUrls.push(href);
      }
    });

    // Scan :root CSS custom properties from accessible stylesheets
    const cssVars: Array<{ name: string; value: string }> = [];
    try {
      const rootComputed = window.getComputedStyle(document.documentElement);
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          for (const rule of Array.from(sheet.cssRules || [])) {
            const cssText = rule.cssText || '';
            if (!cssText.includes('--')) continue;
            const matches = cssText.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}{]+)/g);
            for (const m of matches) {
              const name = m[1];
              if (/(brand|primary|secondary|accent|theme|color|bg|background|surface|ink|text|cta|button)/i.test(name)) {
                const resolved = rootComputed.getPropertyValue(name).trim() || m[2].trim();
                if (resolved.startsWith('#') || resolved.startsWith('rgb')) {
                  cssVars.push({ name, value: resolved });
                }
              }
            }
          }
        } catch {
          // Cross-origin stylesheet skipped gracefully
        }
      }
    } catch {
      // ignore
    }

    const ctaColors: Array<{ color: string; weight: number; source: string }> = [];
    const surfaceColors: Array<{ color: string; weight: number; source: string }> = [];
    const accentColors: Array<{ color: string; weight: number; source: string }> = [];
    const darkBgColors: Array<{ color: string; weight: number; source: string }> = [];

    // Sample primary buttons / CTA links
    const ctaSelectors = 'button, a[class*="btn"], a[class*="button"], a[class*="cta"], [role="button"], input[type="submit"]';
    document.querySelectorAll(ctaSelectors).forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 24 || rect.height < 16) return;
      const st = window.getComputedStyle(el);
      const area = Math.min(rect.width * rect.height, 40000);
      if (st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        ctaColors.push({ color: st.backgroundColor, weight: area * 2, source: 'cta_button' });
      }
      if (st.borderColor && st.borderWidth && parseFloat(st.borderWidth) >= 1) {
        accentColors.push({ color: st.borderColor, weight: area * 0.5, source: 'cta_border' });
      }
    });

    // Sample links, badges, SVG fills, headings for brand/accent colors
    document.querySelectorAll('a, h1, h2, [class*="badge"], [class*="tag"], [class*="accent"], header svg path, nav svg path').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      const st = window.getComputedStyle(el);
      const area = Math.min(rect.width * rect.height, 25000);
      if (st.color) {
        accentColors.push({ color: st.color, weight: area * 0.4, source: 'text_link' });
      }
      if (st.fill && st.fill !== 'none' && st.fill.startsWith('rgb')) {
        ctaColors.push({ color: st.fill, weight: area * 1.5, source: 'logo_svg_fill' });
      }
    });

    // Sample sections, cards, header, footer for surface & dark hero colors
    document.querySelectorAll('section, article, header, footer, [class*="card"], [class*="hero"], [class*="panel"], main > div').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 120 || rect.height < 60) return;
      const st = window.getComputedStyle(el);
      if (!st.backgroundColor || st.backgroundColor === 'rgba(0, 0, 0, 0)') return;
      const area = Math.min(rect.width * rect.height, 300000);
      surfaceColors.push({ color: st.backgroundColor, weight: area, source: el.tagName.toLowerCase() });
      darkBgColors.push({ color: st.backgroundColor, weight: area, source: el.tagName.toLowerCase() });
    });

    // Logo candidates: inline SVG in header/nav, <img> in header/nav, apple-touch-icon, og:image, favicon
    const logoCandidates: Array<{ url: string; kind: 'svg' | 'img' | 'jsonld' | 'apple_touch' | 'og' | 'favicon'; width?: number; height?: number }> = [];
    const seenLogo = new Set<string>();

    const headerScope = document.querySelector('header') || document.querySelector('nav') || document.body;

    // 1. Header/Nav <img> logos
    headerScope.querySelectorAll('img').forEach((img) => {
      const src = img.currentSrc || img.getAttribute('src') || '';
      if (!src || src.startsWith('data:image/gif')) return;
      const rect = img.getBoundingClientRect();
      const attrs = `${img.className} ${img.id} ${img.alt} ${src} ${img.closest('a')?.getAttribute('href') || ''}`.toLowerCase();
      const isLogoLike = attrs.includes('logo') || attrs.includes('brand') || img.closest('a')?.getAttribute('href') === '/';
      if (isLogoLike && rect.width >= 20 && rect.height >= 12 && rect.height <= 180) {
        if (!seenLogo.has(src)) {
          seenLogo.add(src);
          logoCandidates.push({ url: src, kind: 'img', width: Math.round(rect.width), height: Math.round(rect.height) });
        }
      }
    });

    // 2. Inline <svg> logos inside header/nav (serialized cleanly to data URI)
    headerScope.querySelectorAll('a svg, [class*="logo"] svg, [id*="logo"] svg').forEach((svg) => {
      if (logoCandidates.filter((c) => c.kind === 'svg').length >= 2) return;
      const rect = svg.getBoundingClientRect();
      if (rect.width < 28 || rect.height < 14 || rect.width > 420 || rect.height > 140) return;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('viewBox')) {
        clone.setAttribute('viewBox', `0 0 ${Math.round(rect.width)} ${Math.round(rect.height)}`);
      }
      const serialized = new XMLSerializer().serializeToString(clone);
      if (serialized.length > 60 && serialized.length < 32000) {
        const dataUri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
        if (!seenLogo.has(dataUri)) {
          seenLogo.add(dataUri);
          logoCandidates.push({ url: dataUri, kind: 'svg', width: Math.round(rect.width), height: Math.round(rect.height) });
        }
      }
    });

    // 3. Meta icons
    const apple = document.querySelector('link[rel*="apple-touch-icon"]')?.getAttribute('href');
    if (apple) {
      try {
        const abs = new URL(apple, window.location.href).toString();
        if (!seenLogo.has(abs)) {
          seenLogo.add(abs);
          logoCandidates.push({ url: abs, kind: 'apple_touch' });
        }
      } catch {}
    }

    const favicon = document.querySelector('link[rel*="icon"]')?.getAttribute('href');
    if (favicon) {
      try {
        const abs = new URL(favicon, window.location.href).toString();
        if (!seenLogo.has(abs)) {
          seenLogo.add(abs);
          logoCandidates.push({ url: abs, kind: 'favicon' });
        }
      } catch {}
    }

    const ogImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content');
    if (ogImg) {
      try {
        const abs = new URL(ogImg, window.location.href).toString();
        if (!seenLogo.has(abs)) {
          seenLogo.add(abs);
          logoCandidates.push({ url: abs, kind: 'og' });
        }
      } catch {}
    }

    let linkedinUrl = '';
    const liEl = document.querySelector('a[href*="linkedin.com/company/"]');
    if (liEl) linkedinUrl = liEl.getAttribute('href') || '';

    return {
      bodyBg,
      bodyColor,
      bodyFont,
      headingFont,
      headerBg,
      fontUrls: Array.from(new Set(fontUrls)),
      themeColor,
      cssVars: cssVars.slice(0, 120),
      ctaColors,
      surfaceColors,
      accentColors,
      darkBgColors,
      logoCandidates,
      linkedinUrl,
    };
  });

  // Merge JSON-LD logo if present
  const logoCandidates = [...raw.logoCandidates];
  if (jsonLdLogo && !logoCandidates.some((c) => c.url === jsonLdLogo)) {
    logoCandidates.unshift({ url: jsonLdLogo, kind: 'jsonld' });
  }

  // Pick cleanest primary logo (prefer img -> jsonld -> svg -> apple_touch -> favicon)
  const logoPriority: Array<'img' | 'jsonld' | 'svg' | 'apple_touch' | 'favicon' | 'og'> = [
    'img',
    'jsonld',
    'svg',
    'apple_touch',
    'favicon',
    'og',
  ];
  let primaryLogo = '';
  for (const kind of logoPriority) {
    const match = logoCandidates.find((c) => c.kind === kind);
    if (match) {
      primaryLogo = match.url;
      break;
    }
  }
  const iconUrl =
    logoCandidates.find((c) => c.kind === 'apple_touch')?.url ||
    logoCandidates.find((c) => c.kind === 'favicon')?.url ||
    (domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : '');

  // Cluster chromatic brand colors with perceptual dedup
  const brandScoreMap = new Map<string, { rgb: RGB; weight: number; source: string }>();
  const addBrandCandidate = (colorStr: string, weight: number, source: string, requireChromatic = true) => {
    const rgb = parseColorToRgb(colorStr);
    if (!rgb) return;
    if (requireChromatic && !isBrandChromatic(rgb)) return;
    const hex = rgbToHex(rgb);
    // Merge very close shades (distance < 26)
    for (const [, existing] of brandScoreMap) {
      if (colorDistance(existing.rgb, rgb) < 26) {
        existing.weight += weight;
        return;
      }
    }
    brandScoreMap.set(hex, { rgb, weight, source });
  };

  if (raw.themeColor) addBrandCandidate(raw.themeColor, 500000, 'meta_theme_color', true);
  for (const v of raw.cssVars) {
    if (/(primary|brand)/i.test(v.name)) addBrandCandidate(v.value, 450000, `css_var:${v.name}`, true);
    else if (/(secondary)/i.test(v.name)) addBrandCandidate(v.value, 320000, `css_var:${v.name}`, true);
    else if (/(accent|cta|highlight)/i.test(v.name)) addBrandCandidate(v.value, 300000, `css_var:${v.name}`, true);
  }
  for (const c of raw.ctaColors) addBrandCandidate(c.color, c.weight, c.source, true);
  for (const c of raw.accentColors) addBrandCandidate(c.color, c.weight * 0.6, c.source, true);
  for (const c of raw.surfaceColors) addBrandCandidate(c.color, c.weight * 0.35, c.source, true);

  const rankedChromatic = Array.from(brandScoreMap.entries())
    .sort((a, b) => b[1].weight - a[1].weight)
    .map(([hex, info]) => ({ hex, ...info }));

  // Background & Text from actual body computed style
  const bodyBgRgb = parseColorToRgb(raw.bodyBg) || { r: 255, g: 255, b: 255 };
  const backgroundColor = rgbToHex(bodyBgRgb);
  const isDarkSite = luminance(bodyBgRgb) < 0.22;

  const bodyTextRgb = parseColorToRgb(raw.bodyColor) || (isDarkSite ? { r: 248, g: 250, b: 252 } : { r: 17, g: 17, b: 16 });
  const textColor = rgbToHex(bodyTextRgb);

  // Surface color (distinct from body background, subtle elevation)
  let surfaceColor = isDarkSite ? '#161B26' : '#F6F7F9';
  const surfaceScores = new Map<string, { rgb: RGB; weight: number }>();
  for (const s of raw.surfaceColors) {
    const rgb = parseColorToRgb(s.color);
    if (!rgb) continue;
    const dist = colorDistance(rgb, bodyBgRgb);
    if (dist < 10 || dist > 110) continue;
    const samePolarity = isDarkSite ? luminance(rgb) < 0.35 : luminance(rgb) > 0.7;
    if (!samePolarity) continue;
    const hex = rgbToHex(rgb);
    const prev = surfaceScores.get(hex);
    surfaceScores.set(hex, { rgb, weight: (prev?.weight || 0) + s.weight });
  }
  const bestSurface = Array.from(surfaceScores.entries()).sort((a, b) => b[1].weight - a[1].weight)[0];
  if (bestSurface) surfaceColor = bestSurface[0];

  // Dark Hero / Contrast Section background
  let darkBgColor = '#0F172A';
  const darkScores = new Map<string, number>();
  for (const d of raw.darkBgColors) {
    const rgb = parseColorToRgb(d.color);
    if (!rgb) continue;
    if (luminance(rgb) < 0.14) {
      const hex = rgbToHex(rgb);
      darkScores.set(hex, (darkScores.get(hex) || 0) + d.weight);
    }
  }
  const bestDark = Array.from(darkScores.entries()).sort((a, b) => b[1] - a[1])[0];
  if (bestDark) darkBgColor = bestDark[0];

  // Primary, Secondary, Accent (only assign if actually found — never fabricate fake blue/green!)
  const primaryColor = rankedChromatic[0]?.hex || '';
  const secondaryColor =
    rankedChromatic.find((c) => c.hex !== primaryColor && colorDistance(c.rgb, rankedChromatic[0].rgb) >= 40)?.hex ||
    rankedChromatic[1]?.hex ||
    '';
  const accentColor =
    rankedChromatic.find(
      (c) =>
        c.hex !== primaryColor &&
        c.hex !== secondaryColor &&
        colorDistance(c.rgb, rankedChromatic[0].rgb) >= 45
    )?.hex ||
    secondaryColor ||
    '';

  // Full clickable palette swatches (top 10 unique colors including dark/surface)
  const palette: PaletteSwatch[] = [];
  const pushSwatch = (hex: string, role_hint: PaletteSwatch['role_hint'], source: string, weight?: number) => {
    if (!hex || palette.some((p) => p.hex === hex)) return;
    palette.push({ hex, role_hint, source, weight });
  };
  if (primaryColor) pushSwatch(primaryColor, 'primary', rankedChromatic[0]?.source || 'detected', rankedChromatic[0]?.weight);
  if (secondaryColor) pushSwatch(secondaryColor, 'secondary', 'detected');
  if (accentColor) pushSwatch(accentColor, 'accent', 'detected');
  pushSwatch(backgroundColor, 'background', 'body_bg');
  pushSwatch(surfaceColor, 'surface', 'section_surface');
  pushSwatch(darkBgColor, 'dark_bg', 'dark_section');
  pushSwatch(textColor, 'text', 'body_text');
  for (const c of rankedChromatic) {
    if (palette.length >= 10) break;
    pushSwatch(c.hex, 'swatch', c.source, c.weight);
  }

  return {
    status: primaryColor || primaryLogo ? 'extracted' : 'unset',
    source: 'playwright',
    domain,
    logo_url: primaryLogo || iconUrl,
    icon_url: iconUrl,
    logo_candidates: logoCandidates.slice(0, 6),
    primary_color: primaryColor,
    secondary_color: secondaryColor,
    accent_color: accentColor,
    background_color: backgroundColor,
    surface_color: surfaceColor,
    text_color: textColor,
    dark_bg_color: darkBgColor,
    palette,
    heading_font: cleanFontFamily(raw.headingFont),
    body_font: cleanFontFamily(raw.bodyFont),
    font_urls: raw.fontUrls.slice(0, 4),
    linkedin_company_url: jsonLdLinkedin || raw.linkedinUrl || '',
    extracted_at: new Date().toISOString(),
  };
}
