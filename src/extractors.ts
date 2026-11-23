import { JSDOM } from 'jsdom';
import { BUCKET_SYNONYMS, foldAccents, PERSON_ROLE_REGEX } from './i18n.js';
import type { ArticleItem, ScrapedContacts, ScrapedPerson } from './types.js';

const GENERIC_EMAIL_LOCAL_PREFIXES = new Set([
  'noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster', 'webmaster', 'bounce',
]);

function normalizeAbsoluteHttpUrl(raw: string, baseUrl: string): string {
  const cleaned = String(raw || '').trim();
  if (!cleaned || cleaned.startsWith('#') || /^(?:javascript|mailto|tel|data):/i.test(cleaned)) {
    return '';
  }
  try {
    const abs = new URL(cleaned, baseUrl);
    if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return '';
    abs.hash = '';
    return abs.toString().replace(/\/+$/, '') || abs.toString();
  } catch {
    return '';
  }
}

/**
 * Checks whether a candidate string looks like a plausible human full name.
 */
function isPlausibleHumanName(raw: string): boolean {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 4 || cleaned.length > 72) return false;
  if (/[@\/\\|{}[\]<>_=+*]/.test(cleaned)) return false;
  if (/\d/.test(cleaned)) return false;

  const stripped = cleaned
    .replace(/\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|bc|dis|phd|mba|csc|dr|mr|mrs|ms|herr|frau|monsieur|madame)\.?/gi, '')
    .replace(/[,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = stripped.split(' ').filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  const particles = new Set(['de', 'del', 'della', 'di', 'da', 'dos', 'van', 'von', 'zu', 'der', 'den', 'la', 'le']);
  let capitalizedCount = 0;
  for (const w of words) {
    if (particles.has(w.toLowerCase())) continue;
    if (/^\p{Lu}/u.test(w)) capitalizedCount++;
  }
  if (capitalizedCount < 2) return false;

  const folded = foldAccents(stripped);
  const blockedPhrases = [
    'cookie', 'privacy', 'policy', 'terms', 'gdpr', 'read more', 'learn more', 'contact us',
    'vice informaci', 'vice o', 'napsat nam', 'objednat', 'klinika', 'ordinace', 'praha',
    'brno', 'ostrava', 'ceska republika', 'czech republic', 'all rights', 'home page',
    'uvodni strana', 'caste dotazy', 'volna mista', 'oteviraci doba', 'nase sluzby',
  ];
  for (const bp of blockedPhrases) {
    if (folded.includes(bp)) return false;
  }
  return true;
}

function cleanPersonName(raw: string): string {
  return String(raw || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*[–—\-|,]\s*$/, '')
    .trim()
    .slice(0, 80);
}

function cleanRoleText(raw: string, personName: string): string {
  let txt = String(raw || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (personName && txt.toLowerCase().startsWith(personName.toLowerCase())) {
    txt = txt.slice(personName.length).replace(/^[\s\-–—,:|]+/, '').trim();
  }
  if (txt.length > 140) txt = txt.slice(0, 140).trim();
  return txt;
}

function normalizePersonKey(rawName: string): string {
  return foldAccents(
    rawName
      .replace(/\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|bc|dis|phd|mba|dr)\.?/gi, '')
      .replace(/[,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function extractPeopleAndContactsFromHtml(
  html: string,
  pageUrl: string,
  pageText = ''
): { people: ScrapedPerson[]; contacts: ScrapedContacts } {
  const dom = new JSDOM(html || '');
  try {
    const doc = dom.window.document;
    const emails = new Set<string>();
    const phones = new Set<string>();
    const socialLinks = new Set<string>();
    const addresses = new Set<string>();
    const peopleMap = new Map<string, ScrapedPerson>();

    const addPerson = (candidate: Partial<ScrapedPerson>) => {
      const rawName = cleanPersonName(candidate.name || '');
      if (!isPlausibleHumanName(rawName)) return;
      const key = normalizePersonKey(rawName);
      if (!key) return;
      const existing = peopleMap.get(key) || { name: rawName, source_url: pageUrl };
      if (rawName.length > existing.name.length) existing.name = rawName;
      if (candidate.role && (!existing.role || candidate.role.length > existing.role.length)) {
        existing.role = candidate.role.slice(0, 120);
      }
      if (candidate.email && !existing.email) existing.email = candidate.email;
      if (candidate.phone && !existing.phone) existing.phone = candidate.phone;
      if (candidate.linkedin_url && !existing.linkedin_url) existing.linkedin_url = candidate.linkedin_url;
      if (candidate.bio && (!existing.bio || candidate.bio.length > existing.bio.length)) {
        existing.bio = candidate.bio.slice(0, 280);
      }
      peopleMap.set(key, existing);
    };

    // 1. JSON-LD schema.org Person / Organization / LocalBusiness / MedicalClinic
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
      try {
        const parsed = JSON.parse(el.textContent || '');
        const stack: any[] = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (stack.length > 0) {
          const node = stack.shift();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node['@graph'])) stack.push(...node['@graph']);

          const typeVal = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
          if (/Person/i.test(typeVal) && node.name) {
            addPerson({
              name: String(node.name),
              role: node.jobTitle || node.roleName || node.hasOccupation?.name || undefined,
              email: node.email ? String(node.email).replace(/^mailto:/i, '').trim() : undefined,
              phone: node.telephone ? String(node.telephone).trim() : undefined,
              linkedin_url: Array.isArray(node.sameAs)
                ? node.sameAs.find((u: string) => /linkedin\.com\/in\//i.test(u))
                : (typeof node.sameAs === 'string' && /linkedin\.com\/in\//i.test(node.sameAs) ? node.sameAs : undefined),
              bio: typeof node.description === 'string' ? node.description : undefined,
            });
          }
          if (node.founder) stack.push(...(Array.isArray(node.founder) ? node.founder : [node.founder]));
          if (node.employee) stack.push(...(Array.isArray(node.employee) ? node.employee : [node.employee]));
          if (node.member) stack.push(...(Array.isArray(node.member) ? node.member : [node.member]));

          if (node.email && typeof node.email === 'string') {
            const cleanMail = node.email.replace(/^mailto:/i, '').trim().toLowerCase();
            if (cleanMail.includes('@')) emails.add(cleanMail);
          }
          if (node.telephone && typeof node.telephone === 'string') {
            const tel = node.telephone.trim();
            if (tel.length >= 6 && tel.length <= 32) phones.add(tel);
          }
          if (node.address && typeof node.address === 'object') {
            const addr = node.address;
            const formatted = [addr.streetAddress, addr.postalCode, addr.addressLocality, addr.addressCountry]
              .filter(Boolean)
              .join(', ')
              .trim();
            if (formatted.length >= 8) addresses.add(formatted);
          } else if (typeof node.address === 'string' && node.address.trim().length >= 8) {
            addresses.add(node.address.trim());
          }
        }
      } catch {
        // ignore invalid JSON-LD
      }
    });

    // 2. Contact links: mailto:, tel:, social links
    doc.querySelectorAll('a[href]').forEach((el) => {
      const href = String(el.getAttribute('href') || '').trim();
      if (!href) return;
      const lower = href.toLowerCase();
      if (lower.startsWith('mailto:')) {
        const addr = href.slice(7).split('?')[0].trim().toLowerCase();
        const local = addr.split('@')[0] || '';
        if (addr.includes('@') && addr.includes('.') && !GENERIC_EMAIL_LOCAL_PREFIXES.has(local)) {
          emails.add(addr);
        }
      } else if (lower.startsWith('tel:')) {
        const phone = href.slice(4).split('?')[0].replace(/\s+/g, ' ').trim();
        if (phone.replace(/\D/g, '').length >= 7 && phone.length <= 30) {
          phones.add(phone);
        }
      } else if (/^https?:\/\//i.test(href)) {
        if (
          /(?:linkedin\.com\/(?:company|in|school)|facebook\.com|instagram\.com|youtube\.com|youtu\.be|twitter\.com|x\.com)\//i.test(href) &&
          !/\/(?:share|sharer|intent|login)\b/i.test(href)
        ) {
          socialLinks.add(href.replace(/\/+$/, ''));
        }
      }
    });

    // 3. Regex scan for visible emails & European phone numbers in footer, contact blocks, and page text
    const footerText = Array.from(doc.querySelectorAll('footer'))
      .map((f) => f.textContent || '')
      .join('\n');
    const contactBlockText = Array.from(doc.querySelectorAll('[class*="contact"],[id*="contact"],[class*="kontakt"],[id*="kontakt"]'))
      .map((c) => c.textContent || '')
      .join('\n');
    const combinedText = `${footerText}\n${contactBlockText}\n${pageText || doc.body?.textContent || ''}`;

    const emailMatches = combinedText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,12}/g) || [];
    for (const em of emailMatches) {
      const low = em.toLowerCase();
      const local = low.split('@')[0] || '';
      if (!/\.(png|jpg|jpeg|svg|webp|gif|css|js)$/i.test(low) && !GENERIC_EMAIL_LOCAL_PREFIXES.has(local)) {
        emails.add(low);
      }
    }

    const phoneMatches = combinedText.match(/(?:\+|00)\d{1,3}[\s.-]?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g) || [];
    for (const ph of phoneMatches) {
      const digits = ph.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15) {
        phones.add(ph.replace(/\s+/g, ' ').trim());
      }
    }

    // Extract <address> elements
    doc.querySelectorAll('address').forEach((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length >= 8 && txt.length <= 220) addresses.add(txt);
    });

    // 4. DOM Card & Heading/Paragraph Heuristic for People
    const cardSelector = [
      '[class*="team"]',
      '[class*="staff"]',
      '[class*="doctor"]',
      '[class*="lekar"]',
      '[class*="tym"]',
      '[class*="person"]',
      '[class*="member"]',
      '[class*="leader"]',
      '[class*="author"]',
      '[class*="profile"]',
      '[class*="card"]',
      'article',
      'li',
    ].join(',');

    doc.querySelectorAll(cardSelector).forEach((card) => {
      const fullCardText = (card.textContent || '').replace(/\s+/g, ' ').trim();
      if (!fullCardText || fullCardText.length < 6 || fullCardText.length > 900) return;

      const headingEl = card.querySelector('h1,h2,h3,h4,h5,strong,.name,[class*="name"],[class*="title"]');
      const rawHeading = (headingEl?.textContent || '').replace(/\s+/g, ' ').trim();
      if (!rawHeading) return;

      const hasAcademicPrefix = /\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|ing|mgr|dr)\b\.?/i.test(rawHeading);
      const hasRoleInCard = PERSON_ROLE_REGEX.test(fullCardText);
      const hasPersonLink = card.querySelector('a[href*="linkedin.com/in/"], a[href^="mailto:"]') !== null;

      if ((hasAcademicPrefix || hasRoleInCard || hasPersonLink) && isPlausibleHumanName(rawHeading)) {
        let roleRaw = '';
        const roleCandidates = card.querySelectorAll('[class*="role"],[class*="position"],[class*="title"],[class*="function"],[class*="job"],p,span,small');
        for (const r of Array.from(roleCandidates)) {
          const t = (r.textContent || '').replace(/\s+/g, ' ').trim();
          if (t.length >= 2 && t.length <= 120 && foldAccents(t) !== foldAccents(rawHeading) && !/@/.test(t)) {
            roleRaw = t;
            break;
          }
        }

        const emailHref = card.querySelector('a[href^="mailto:"]')?.getAttribute('href') || '';
        const telHref = card.querySelector('a[href^="tel:"]')?.getAttribute('href') || '';
        const liHref = card.querySelector('a[href*="linkedin.com/in/"]')?.getAttribute('href') || '';

        let roleText = cleanRoleText(roleRaw, rawHeading);
        if (!roleText && hasRoleInCard) {
          roleText = cleanRoleText(fullCardText.slice(0, 140), rawHeading);
        }

        addPerson({
          name: rawHeading,
          role: roleText || undefined,
          email: emailHref ? emailHref.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase() : undefined,
          phone: telHref ? telHref.replace(/^tel:/i, '').trim() : undefined,
          linkedin_url: liHref || undefined,
        });
      }
    });

    // 5. Fallback heading scan: standalone `<h3>MUDr. Jan Novák</h3><p>Primář rehabilitace</p>`
    doc.querySelectorAll('h2,h3,h4').forEach((el) => {
      const headingText = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!isPlausibleHumanName(headingText)) return;
      const sibling = el.nextElementSibling;
      const siblingText = sibling && /^(P|DIV|SPAN)$/i.test(sibling.tagName)
        ? (sibling.textContent || '').replace(/\s+/g, ' ').trim()
        : '';
      const hasDegree = /\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|dr|phd|mba)\b\.?/i.test(headingText);
      const hasRole = PERSON_ROLE_REGEX.test(siblingText) || PERSON_ROLE_REGEX.test(headingText);
      if (hasDegree || hasRole) {
        addPerson({
          name: headingText,
          role: siblingText && siblingText.length <= 120 ? cleanRoleText(siblingText, headingText) : undefined,
        });
      }
    });

    return {
      people: Array.from(peopleMap.values()).slice(0, 40),
      contacts: {
        emails: Array.from(emails).slice(0, 20),
        phones: Array.from(phones).slice(0, 20),
        social_links: Array.from(socialLinks).slice(0, 20),
        addresses: Array.from(addresses).slice(0, 15),
      },
    };
  } finally {
    dom.window.close();
  }
}

/**
 * Extracts individual blog/news article links and inline article cards from a news hub page
 * (works on Czech `/novinky`, German `/aktuelles`, French `/actualites`, Spanish `/noticias`, etc.).
 */
export function extractNewsArticleLinksFromHtml(
  html: string,
  hubUrl: string,
  maxItems = 12
): { articleUrls: string[]; inlineItems: ArticleItem[] } {
  let hubParsed: URL;
  try {
    hubParsed = new URL(hubUrl);
  } catch {
    return { articleUrls: [], inlineItems: [] };
  }

  const dom = new JSDOM(html || '');
  try {
    const doc = dom.window.document;
    const newsStemWords = new Set(BUCKET_SYNONYMS.news_blog.keywords.map((k) => foldAccents(k)));
    const hubPath = hubParsed.pathname.replace(/\/+$/, '').toLowerCase();
    const hubSegs = hubPath.split('/').filter(Boolean);

    const scored = new Map<string, { url: string; score: number; title: string; summary: string; date: string }>();

    doc.querySelectorAll('a[href]').forEach((el) => {
      const href = String(el.getAttribute('href') || '').trim();
      const absUrl = normalizeAbsoluteHttpUrl(href, hubUrl);
      if (!absUrl) return;

      let parsed: URL;
      try {
        parsed = new URL(absUrl);
      } catch {
        return;
      }
      if (parsed.hostname.replace(/^www\./, '') !== hubParsed.hostname.replace(/^www\./, '')) {
        return;
      }

      const candPath = parsed.pathname.replace(/\/+$/, '').toLowerCase();
      if (!candPath || candPath === '/' || candPath === hubPath) return;
      if (/\.(?:png|jpg|jpeg|gif|svg|webp|pdf|zip|css|js|xml|ico)$/i.test(candPath)) return;
      if (/\/(?:page|strana|tag|stitek|category|kategorie)\/\d*$/i.test(candPath)) return;

      const candSegs = candPath.split('/').filter(Boolean);
      const card = el.closest('article, .post, .news-item, .card, li, [class*="news"], [class*="article"], [class*="blog"]');
      const inArticleContainer = card !== null || el.closest('main, [role="main"]') !== null;
      const isUnderHub = Boolean(hubPath && hubPath !== '/' && candPath.startsWith(hubPath + '/') && candSegs.length > hubSegs.length);
      const sharesNewsStem = candSegs.some((seg) => newsStemWords.has(foldAccents(seg)));
      const slugSegment = candSegs[candSegs.length - 1] || '';
      const looksLikeSlug = slugSegment.includes('-') && slugSegment.length >= 12;

      const innerHeading = el.querySelector('h1,h2,h3,h4')?.textContent || '';
      const cardHeading = card?.querySelector('h1,h2,h3,h4')?.textContent || '';
      const anchorTitle = (innerHeading || el.textContent || cardHeading).replace(/\s+/g, ' ').trim();

      if (/^(?:read more|číst více|více|mehr|lire la suite|leer más|leggi|zobacz więcej|tovább|další|předchozí|\d+)$/i.test(anchorTitle) && !isUnderHub && !looksLikeSlug) {
        return;
      }

      let score = 0;
      if (isUnderHub) score += 60;
      if (sharesNewsStem) score += 30;
      if (looksLikeSlug) score += 25;
      if (inArticleContainer) score += 20;
      if (anchorTitle.length >= 16) score += 15;
      if (el.closest('nav, header, footer') !== null && !isUnderHub) score -= 45;

      if (score >= 45) {
        const timeEl = card?.querySelector('time');
        const dateEl = card?.querySelector('[class*="date"],[class*="datum"]');
        const dateStr = (timeEl?.getAttribute('datetime') || timeEl?.textContent || dateEl?.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        const summary = (card?.querySelector('p')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 320);
        const prev = scored.get(absUrl);
        if (!prev || score > prev.score) {
          scored.set(absUrl, {
            url: absUrl,
            score,
            title: anchorTitle.slice(0, 220),
            summary,
            date: dateStr,
          });
        }
      }
    });

    const ranked = Array.from(scored.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, maxItems);

    const inlineItems: ArticleItem[] = ranked
      .filter((r) => r.title.length >= 10)
      .map((r) => ({
        title: r.title,
        url: r.url,
        published_at: r.date,
        source: hubParsed.hostname.replace(/^www\./, ''),
        summary: r.summary,
      }));

    return {
      articleUrls: ranked.map((r) => r.url),
      inlineItems,
    };
  } finally {
    dom.window.close();
  }
}

export function mergePeopleLists(lists: ScrapedPerson[][]): ScrapedPerson[] {
  const merged = new Map<string, ScrapedPerson>();
  for (const list of lists) {
    for (const p of list || []) {
      const key = normalizePersonKey(p.name);
      if (!key) continue;
      const cur = merged.get(key) || { name: p.name };
      if (p.name.length > cur.name.length) cur.name = p.name;
      if (p.role && (!cur.role || p.role.length > cur.role.length)) cur.role = p.role;
      if (p.email && !cur.email) cur.email = p.email;
      if (p.phone && !cur.phone) cur.phone = p.phone;
      if (p.linkedin_url && !cur.linkedin_url) cur.linkedin_url = p.linkedin_url;
      if (p.source_url && !cur.source_url) cur.source_url = p.source_url;
      if (p.bio && (!cur.bio || p.bio.length > cur.bio.length)) cur.bio = p.bio;
      merged.set(key, cur);
    }
  }
  return Array.from(merged.values()).slice(0, 40);
}

export function mergeContactsLists(lists: ScrapedContacts[]): ScrapedContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const socialLinks = new Set<string>();
  const addresses = new Set<string>();
  for (const c of lists) {
    for (const e of c.emails || []) emails.add(e);
    for (const p of c.phones || []) phones.add(p);
    for (const s of c.social_links || []) socialLinks.add(s);
    for (const a of c.addresses || []) addresses.add(a);
  }
  return {
    emails: Array.from(emails).slice(0, 20),
    phones: Array.from(phones).slice(0, 20),
    social_links: Array.from(socialLinks).slice(0, 20),
    addresses: Array.from(addresses).slice(0, 15),
  };
}
