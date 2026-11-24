import { JSDOM } from 'jsdom';
import { BUCKET_SYNONYMS, foldAccents, PERSON_ROLE_REGEX } from './i18n.js';
import { extractCzechIcoAndDic } from './registries.js';
import type { ArticleItem, ScrapedContacts, ScrapedPerson } from './types.js';

const GENERIC_EMAIL_LOCAL_PREFIXES = new Set([
  'noreply', 'no-reply', 'donotreply', 'mailer-daemon', 'postmaster', 'webmaster', 'bounce',
]);

const ROLELESS_EMAIL_PREFIXES = new Set([
  'info', 'recepce', 'kontakt', 'contact', 'hello', 'hi', 'sales', 'office', 'podpora', 'support',
  'admin', 'billing', 'hr', 'jobs', 'kariera', 'press', 'media', 'pr', 'marketing', 'team',
  'redakce', 'objednavky', 'rezervace', 'faktury', 'fakturace', 'gdpr', 'privacy', 'dpo',
  'noreply', 'no-reply', 'webmaster', 'postmaster', 'servis', 'ambulance', 'ordinace',
]);

const RESERVED_X_SEGMENTS = new Set([
  'share', 'intent', 'home', 'search', 'explore', 'i', 'hashtag', 'status',
  'login', 'signup', 'privacy', 'tos', 'settings', 'notifications', 'messages',
  'compose', 'about', 'help',
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

export function normalizeLinkedInUrl(raw: string): string {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return '';
  try {
    const abs = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
    const host = abs.hostname.toLowerCase();
    if (!host.endsWith('linkedin.com')) return '';
    const parts = abs.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return '';
    const kind = parts[0].toLowerCase();
    if (!['in', 'company', 'school'].includes(kind)) return '';
    return `https://www.linkedin.com/${kind}/${parts[1]}`;
  } catch {
    return '';
  }
}

export function normalizeXUrl(raw: string): { url: string; handle: string } | null {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return null;
  try {
    const abs = new URL(cleaned.startsWith('http') ? cleaned : `https://${cleaned}`);
    const host = abs.hostname.toLowerCase().replace(/^(?:www\.|mobile\.)/, '');
    if (host !== 'x.com' && host !== 'twitter.com') return null;
    const segments = abs.pathname.split('/').filter(Boolean);
    // Reject non-profile URLs such as tweet permalinks (/user/status/123) or intents
    if (segments.length !== 1) return null;
    const handleRaw = segments[0].replace(/^@/, '').trim();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handleRaw)) return null;
    if (RESERVED_X_SEGMENTS.has(handleRaw.toLowerCase())) return null;
    return {
      url: `https://x.com/${handleRaw}`,
      handle: `@${handleRaw}`,
    };
  } catch {
    return null;
  }
}

/**
 * Scores leadership/decision-maker seniority across EN + Central/Western European titles.
 */
export function scorePersonSeniority(
  role?: string,
  name?: string,
  source?: ScrapedPerson['source']
): { seniority_score: number; is_decision_maker: boolean } {
  if (source === 'ares_vr') {
    const roleFold = foldAccents(role || '');
    const score = roleFold.includes('spolecnik') && !roleFold.includes('jednatel') ? 92 : 98;
    return { seniority_score: score, is_decision_maker: true };
  }
  if (source === 'impressum') {
    return { seniority_score: 90, is_decision_maker: true };
  }

  const haystack = foldAccents(`${role || ''} ${name || ''}`);
  if (
    /\b(?:ceo|cfo|cto|coo|cmo|cio|cpo|cso|chief\s+\w+\s+officer|founder|co-founder|cofounder|owner|president|managing\s+director|jednatel(?:ka)?|majitel(?:ka)?|zakladatel(?:ka)?|reditel(?:ka)?|primar(?:ka)?|geschaftsfuhrer(?:in)?|inhaber(?:in)?|vorstand|prezes|konatel(?:ka)?|ugyvezeto|vezerigazgato|direttore\s+generale|directeur\s+general|fondateur|fundador)\b/.test(
      haystack
    )
  ) {
    return { seniority_score: 90, is_decision_maker: true };
  }
  if (
    /\b(?:vp|vice\s+president|director|head\s+of|partner|vedouci|provozni\s+reditel|lekarsky\s+reditel|odborny\s+garant|chefarzt|chefärztin|oberarzt|arztlicher\s+leiter|leiter(?:in)?|dyrektor|kierownik|directeur|directora|direttore|diretor|igazgato|toimitusjohtaja|chief)\b/.test(
      haystack
    )
  ) {
    return { seniority_score: 76, is_decision_maker: true };
  }
  if (/\b(?:manager|lead|manazer(?:ka)?|senior|principal|specialist|specialista|garant)\b/.test(haystack)) {
    return { seniority_score: 52, is_decision_maker: false };
  }
  return { seniority_score: 25, is_decision_maker: false };
}

/**
 * Checks whether a candidate string looks like a plausible human full name.
 */
function isPlausibleHumanName(raw: string): boolean {
  const cleaned = raw.replace(/\s+/g, ' ').trim();
  if (cleaned.length < 4 || cleaned.length > 72) return false;
  if (/[@\/\\|{}[\]<>_=+*]/.test(cleaned)) return false;
  if (/\d/.test(cleaned)) return false;
  if (/\b(?:gmbh|s\.?r\.?o\.?|a\.?s\.?|spol\.?|v\.?o\.?s\.?|k\.?s\.?|z\.?s\.?|ltd|llc|inc|ag|kg|ohg)\b/i.test(cleaned)) {
    return false;
  }

  const stripped = cleaned
    .replace(/\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|mga|bca|bc|dis|phd|ph\.d|mba|csc|drsc|dr|mr|mrs|ms|herr|frau|monsieur|madame)\.?/gi, '')
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

export function normalizePersonKey(rawName: string): string {
  return foldAccents(
    rawName
      .replace(/\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|mga|bca|bc|dis|phd|ph\.d|mba|csc|drsc|dr|md|dds)\.?/gi, '')
      .replace(/[,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function extractNameTokens(rawName: string): { first: string; last: string; tokens: string[] } {
  const norm = normalizePersonKey(rawName);
  const tokens = norm.split(' ').filter((t) => t.length >= 2);
  return {
    first: tokens[0] || '',
    last: tokens.length > 1 ? tokens[tokens.length - 1] : '',
    tokens,
  };
}

function pickPreferredName(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const aAllCaps = a === a.toUpperCase() && a !== a.toLowerCase();
  const bAllCaps = b === b.toUpperCase() && b !== b.toLowerCase();
  if (aAllCaps && !bAllCaps) return b;
  if (bAllCaps && !aAllCaps) return a;
  return b.length > a.length ? b : a;
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

    let linkedinCompanyUrl = '';
    let companyXUrl = '';
    let companyXHandle = '';
    let facebookUrl = '';
    let instagramUrl = '';
    let youtubeUrl = '';
    let githubUrl = '';

    const addPerson = (candidate: Partial<ScrapedPerson>) => {
      const rawName = cleanPersonName(candidate.name || '');
      if (!isPlausibleHumanName(rawName)) return;
      const key = normalizePersonKey(rawName);
      if (!key) return;

      const scored = scorePersonSeniority(candidate.role, rawName, candidate.source);
      const candScore = candidate.seniority_score ?? scored.seniority_score;
      const candDm = candidate.is_decision_maker ?? scored.is_decision_maker;

      const existing = peopleMap.get(key) || { name: rawName, source_url: pageUrl };
      existing.name = pickPreferredName(existing.name, rawName);
      if (candidate.role && (!existing.role || candidate.role.length > existing.role.length)) {
        existing.role = candidate.role.slice(0, 120);
      }
      if (candidate.email && !existing.email) existing.email = candidate.email;
      if (candidate.phone && !existing.phone) existing.phone = candidate.phone;
      if (candidate.linkedin_url && !existing.linkedin_url) {
        existing.linkedin_url = normalizeLinkedInUrl(candidate.linkedin_url) || candidate.linkedin_url;
      }
      if (candidate.x_url && !existing.x_url) {
        const xNorm = normalizeXUrl(candidate.x_url);
        if (xNorm) existing.x_url = xNorm.url;
      }
      if (candidate.source && (!existing.source || candidate.source === 'ares_vr' || candidate.source === 'impressum')) {
        existing.source = candidate.source;
      }
      existing.seniority_score = Math.max(existing.seniority_score ?? 0, candScore);
      existing.is_decision_maker = Boolean(existing.is_decision_maker || candDm);
      if (candidate.bio && (!existing.bio || candidate.bio.length > existing.bio.length)) {
        existing.bio = candidate.bio.slice(0, 280);
      }
      peopleMap.set(key, existing);
    };

    const classifySocialUrl = (href: string) => {
      const li = normalizeLinkedInUrl(href);
      if (li) {
        socialLinks.add(li);
        if (/\/company\//i.test(li) && !linkedinCompanyUrl) {
          linkedinCompanyUrl = li;
        }
        return;
      }
      const xNorm = normalizeXUrl(href);
      if (xNorm) {
        socialLinks.add(xNorm.url);
        if (!companyXUrl) {
          companyXUrl = xNorm.url;
          companyXHandle = xNorm.handle;
        }
        return;
      }
      if (/^https?:\/\/(?:www\.)?facebook\.com\/[^/?#]+/i.test(href) && !/\/(?:sharer|share|login|tr)\b/i.test(href)) {
        const clean = href.split('?')[0].replace(/\/+$/, '');
        socialLinks.add(clean);
        if (!facebookUrl) facebookUrl = clean;
      } else if (/^https?:\/\/(?:www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/i.test(href.split('?')[0])) {
        const clean = href.split('?')[0].replace(/\/+$/, '');
        socialLinks.add(clean);
        if (!instagramUrl) instagramUrl = clean;
      } else if (/^https?:\/\/(?:www\.)?(?:youtube\.com\/(?:@|channel\/|c\/|user\/)|youtu\.be\/)/i.test(href)) {
        const clean = href.split('?')[0].replace(/\/+$/, '');
        socialLinks.add(clean);
        if (!youtubeUrl) youtubeUrl = clean;
      } else if (/^https?:\/\/(?:www\.)?github\.com\/[A-Za-z0-9_-]+\/?$/i.test(href.split('?')[0])) {
        const clean = href.split('?')[0].replace(/\/+$/, '');
        if (!/github\.com\/(?:features|pricing|enterprise|login|signup|about|topics|explore|sponsors)$/i.test(clean)) {
          socialLinks.add(clean);
          if (!githubUrl) githubUrl = clean;
        }
      }
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

          const sameAsList: string[] = Array.isArray(node.sameAs)
            ? node.sameAs.filter((u: unknown): u is string => typeof u === 'string')
            : typeof node.sameAs === 'string'
              ? [node.sameAs]
              : [];

          const typeVal = Array.isArray(node['@type']) ? node['@type'].join(',') : String(node['@type'] || '');
          if (/Person/i.test(typeVal) && node.name) {
            const liUrl = sameAsList.map((u) => normalizeLinkedInUrl(u)).find((u) => u.includes('/in/'));
            const xMatch = sameAsList.map((u) => normalizeXUrl(u)).find(Boolean);
            addPerson({
              name: String(node.name),
              role: node.jobTitle || node.roleName || node.hasOccupation?.name || undefined,
              email: node.email ? String(node.email).replace(/^mailto:/i, '').trim().toLowerCase() : undefined,
              phone: node.telephone ? String(node.telephone).trim() : undefined,
              linkedin_url: liUrl || undefined,
              x_url: xMatch?.url || undefined,
              source: 'json_ld',
              bio: typeof node.description === 'string' ? node.description : undefined,
            });
          } else {
            for (const sa of sameAsList) {
              classifySocialUrl(sa);
            }
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
        classifySocialUrl(href);
      }
    });

    // 3. Scan visible emails, Czech IČO/DIČ, and European phone numbers in footer, contact blocks, and page text
    const footerText = Array.from(doc.querySelectorAll('footer'))
      .map((f) => f.textContent || '')
      .join('\n');
    const contactBlockText = Array.from(doc.querySelectorAll('[class*="contact"],[id*="contact"],[class*="kontakt"],[id*="kontakt"]'))
      .map((c) => c.textContent || '')
      .join('\n');
    const combinedText = `${footerText}\n${contactBlockText}\n${pageText || doc.body?.textContent || ''}`;

    const regIds = extractCzechIcoAndDic(combinedText);

    const emailMatches = combinedText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,12}/g) || [];
    for (const em of emailMatches) {
      const low = em.toLowerCase();
      const local = low.split('@')[0] || '';
      if (!/\.(png|jpg|jpeg|svg|webp|gif|css|js)$/i.test(low) && !GENERIC_EMAIL_LOCAL_PREFIXES.has(local)) {
        emails.add(low);
      }
    }

    const blockedDigits = new Set<string>();
    if (regIds.ico) blockedDigits.add(regIds.ico);
    if (regIds.dic) blockedDigits.add(regIds.dic.replace(/\D/g, ''));

    const phoneMatches = combinedText.match(/(?:\+|00)\d{1,3}[\s.-]?(?:\(?\d{2,4}\)?[\s.-]?){2,4}\d{2,4}/g) || [];
    for (const ph of phoneMatches) {
      const digits = ph.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 15 && !blockedDigits.has(digits)) {
        phones.add(ph.replace(/\s+/g, ' ').trim());
      }
    }

    // Czech/SK 9-digit local phones without +420 in footer/contact sections (avoid IČO/DIČ collisions)
    const contactCueText = `${footerText}\n${contactBlockText}`;
    const czLocalCueRegex = /(?:tel(?:efon)?|mobil|recepce|kontakt|phone|linka)[^\n\r]{0,24}?((?:\+420|\+421)?[\s.-]?\b\d{3}[\s.-]\d{3}[\s.-]\d{3}\b)/gi;
    for (const m of contactCueText.matchAll(czLocalCueRegex)) {
      const ph = String(m[1] || '').replace(/\s+/g, ' ').trim();
      const digits = ph.replace(/\D/g, '');
      if (digits.length >= 9 && digits.length <= 12 && !blockedDigits.has(digits)) {
        phones.add(ph);
      }
    }

    // Extract <address> elements
    doc.querySelectorAll('address').forEach((el) => {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length >= 8 && txt.length <= 220) addresses.add(txt);
    });

    // 4. Impressum / statutory footer executive parsing (DE / AT / CH / CZ)
    const impressumText = `${footerText}\n${contactBlockText}\n${pageText || ''}`;
    const impressumRegex =
      /\b(Geschäftsführer(?:in)?|Geschaftsfuhrer(?:in)?|Vertreten\s+durch|Inhaber(?:in)?|Vorstand|Jednatel(?:ka|é)?|Statutární\s+orgán)\s*[:\-–]\s*([^\n\r|;•]{4,120})/giu;
    for (const m of impressumText.matchAll(impressumRegex)) {
      const label = String(m[1] || '').trim();
      const tail = String(m[2] || '').trim();
      const parts = tail.split(/\s*(?:,|&|\bund\b|\ba\b)\s*/i).filter(Boolean);
      for (const candidateName of parts.slice(0, 4)) {
        if (isPlausibleHumanName(candidateName)) {
          addPerson({
            name: candidateName,
            role: label,
            source: 'impressum',
            is_decision_maker: true,
            seniority_score: 90,
          });
        }
      }
    }

    // 5. DOM Card & Heading/Paragraph Heuristic for People
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
      const hasPersonLink = card.querySelector('a[href*="linkedin.com/in/"], a[href^="mailto:"], a[href*="x.com/"], a[href*="twitter.com/"]') !== null;

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
        const xHref = card.querySelector('a[href*="x.com/"], a[href*="twitter.com/"]')?.getAttribute('href') || '';
        const xNorm = xHref ? normalizeXUrl(xHref) : null;

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
          x_url: xNorm?.url || undefined,
          source: 'website_team',
        });
      }
    });

    // 6. Fallback heading scan: standalone `<h3>MUDr. Jan Novák</h3><p>Primář rehabilitace</p>`
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
          source: 'website_team',
        });
      }
    });

    const sortedPeople = Array.from(peopleMap.values())
      .sort((a, b) => {
        const scoreDiff = (b.seniority_score ?? 0) - (a.seniority_score ?? 0);
        if (scoreDiff !== 0) return scoreDiff;
        const aRich = (a.email ? 2 : 0) + (a.linkedin_url ? 1 : 0);
        const bRich = (b.email ? 2 : 0) + (b.linkedin_url ? 1 : 0);
        return bRich - aRich;
      })
      .slice(0, 40);

    return {
      people: sortedPeople,
      contacts: {
        emails: Array.from(emails).slice(0, 20),
        phones: Array.from(phones).slice(0, 20),
        social_links: Array.from(socialLinks).slice(0, 20),
        addresses: Array.from(addresses).slice(0, 15),
        ...(regIds.ico ? { company_ico: regIds.ico } : {}),
        ...(regIds.dic ? { company_dic: regIds.dic } : {}),
        ...(linkedinCompanyUrl ? { linkedin_company_url: linkedinCompanyUrl } : {}),
        ...(companyXUrl ? { x_url: companyXUrl, x_handle: companyXHandle } : {}),
        ...(facebookUrl ? { facebook_url: facebookUrl } : {}),
        ...(instagramUrl ? { instagram_url: instagramUrl } : {}),
        ...(youtubeUrl ? { youtube_url: youtubeUrl } : {}),
        ...(githubUrl ? { github_url: githubUrl } : {}),
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
  const merged: ScrapedPerson[] = [];
  const byEmail = new Map<string, number>();
  const byLinkedIn = new Map<string, number>();
  const byNameKey = new Map<string, number>();

  for (const list of lists) {
    for (const p of list || []) {
      const nameKey = normalizePersonKey(p.name);
      if (!nameKey) continue;
      const emailKey = (p.email || '').trim().toLowerCase();
      const liKey = normalizeLinkedInUrl(p.linkedin_url || '');

      let idx: number | undefined;
      if (emailKey && byEmail.has(emailKey)) idx = byEmail.get(emailKey);
      if (idx === undefined && liKey && byLinkedIn.has(liKey)) idx = byLinkedIn.get(liKey);
      if (idx === undefined && byNameKey.has(nameKey)) idx = byNameKey.get(nameKey);

      const scored = scorePersonSeniority(p.role, p.name, p.source);
      const incomingScore = p.seniority_score ?? scored.seniority_score;
      const incomingDm = p.is_decision_maker ?? scored.is_decision_maker;

      if (idx === undefined) {
        const entry: ScrapedPerson = {
          ...p,
          ...(liKey ? { linkedin_url: liKey } : {}),
          ...(emailKey ? { email: emailKey } : {}),
          seniority_score: incomingScore,
          is_decision_maker: incomingDm,
        };
        idx = merged.push(entry) - 1;
      } else {
        const cur = merged[idx];
        cur.name = pickPreferredName(cur.name, p.name);
        if (p.role && (!cur.role || p.role.length > cur.role.length)) cur.role = p.role;
        if (emailKey && !cur.email) cur.email = emailKey;
        if (p.phone && !cur.phone) cur.phone = p.phone;
        if (liKey && !cur.linkedin_url) cur.linkedin_url = liKey;
        if (p.x_url && !cur.x_url) cur.x_url = p.x_url;
        if (p.source_url && !cur.source_url) cur.source_url = p.source_url;
        if (p.source === 'ares_vr' || (!cur.source && p.source)) {
          cur.source = p.source;
        }
        cur.seniority_score = Math.max(cur.seniority_score ?? 0, incomingScore);
        cur.is_decision_maker = Boolean(cur.is_decision_maker || incomingDm);
        if (p.bio && (!cur.bio || p.bio.length > cur.bio.length)) cur.bio = p.bio;
      }

      byNameKey.set(nameKey, idx);
      if (emailKey) byEmail.set(emailKey, idx);
      if (liKey) byLinkedIn.set(liKey, idx);
    }
  }

  return merged
    .sort((a, b) => {
      const scoreDiff = (b.seniority_score ?? 0) - (a.seniority_score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      const aRich = (a.email ? 2 : 0) + (a.linkedin_url ? 1 : 0);
      const bRich = (b.email ? 2 : 0) + (b.linkedin_url ? 1 : 0);
      return bRich - aRich;
    })
    .slice(0, 40);
}

/**
 * Matches personal website emails (e.g. `jan.novak@clinic.cz`, `j.novak@clinic.cz`, `novak@clinic.cz`)
 * onto discovered people who don't yet have a direct email attached.
 */
export function enrichPeopleWithSiteEmails(people: ScrapedPerson[], siteEmails: string[]): ScrapedPerson[] {
  if (!Array.isArray(people) || people.length === 0 || !Array.isArray(siteEmails) || siteEmails.length === 0) {
    return people;
  }

  const assigned = new Set<string>(
    people.map((p) => (p.email || '').trim().toLowerCase()).filter(Boolean)
  );
  const tokenized = people.map((p) => extractNameTokens(p.name));

  for (const rawEmail of siteEmails) {
    const email = String(rawEmail || '').trim().toLowerCase();
    if (!email || assigned.has(email) || !email.includes('@')) continue;
    const local = foldAccents(email.split('@')[0] || '');
    if (!local || ROLELESS_EMAIL_PREFIXES.has(local)) continue;

    let bestIdx = -1;
    let bestScore = 0;

    for (let i = 0; i < people.length; i++) {
      if (people[i].email) continue;
      const { first, last } = tokenized[i];
      if (!first || !last) continue;

      const cleanLocal = local.replace(/[^a-z]/g, '');
      const fullConcat = `${first}${last}`;
      const revConcat = `${last}${first}`;
      const initLast = `${first[0]}${last}`;

      let matchScore = 0;
      if (
        local === `${first}.${last}` ||
        local === `${first}_${last}` ||
        local === `${first}-${last}` ||
        local === `${last}.${first}` ||
        cleanLocal === fullConcat ||
        cleanLocal === revConcat
      ) {
        matchScore = 100;
      } else if (local === `${first[0]}.${last}` || cleanLocal === initLast) {
        matchScore = 85;
      } else if (last.length >= 4 && local === last) {
        // Unique surname check across the discovered team
        const sameSurnameCount = tokenized.filter((t) => t.last === last).length;
        if (sameSurnameCount === 1) matchScore = 70;
      }

      if (matchScore > bestScore) {
        bestScore = matchScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0 && bestScore >= 70) {
      people[bestIdx].email = email;
      assigned.add(email);
    }
  }

  return people;
}

export function mergeContactsLists(lists: ScrapedContacts[]): ScrapedContacts {
  const emails = new Set<string>();
  const phones = new Set<string>();
  const socialLinks = new Set<string>();
  const addresses = new Set<string>();

  let companyIco = '';
  let companyDic = '';
  let linkedinCompanyUrl = '';
  let xUrl = '';
  let xHandle = '';
  let facebookUrl = '';
  let instagramUrl = '';
  let youtubeUrl = '';
  let githubUrl = '';

  for (const c of lists) {
    for (const e of c.emails || []) emails.add(e);
    for (const p of c.phones || []) phones.add(p);
    for (const s of c.social_links || []) socialLinks.add(s);
    for (const a of c.addresses || []) addresses.add(a);
    if (!companyIco && c.company_ico) companyIco = c.company_ico;
    if (!companyDic && c.company_dic) companyDic = c.company_dic;
    if (!linkedinCompanyUrl && c.linkedin_company_url) linkedinCompanyUrl = c.linkedin_company_url;
    if (!xUrl && c.x_url) xUrl = c.x_url;
    if (!xHandle && c.x_handle) xHandle = c.x_handle;
    if (!facebookUrl && c.facebook_url) facebookUrl = c.facebook_url;
    if (!instagramUrl && c.instagram_url) instagramUrl = c.instagram_url;
    if (!youtubeUrl && c.youtube_url) youtubeUrl = c.youtube_url;
    if (!githubUrl && c.github_url) githubUrl = c.github_url;
  }

  return {
    emails: Array.from(emails).slice(0, 20),
    phones: Array.from(phones).slice(0, 20),
    social_links: Array.from(socialLinks).slice(0, 20),
    addresses: Array.from(addresses).slice(0, 15),
    ...(companyIco ? { company_ico: companyIco } : {}),
    ...(companyDic ? { company_dic: companyDic } : {}),
    ...(linkedinCompanyUrl ? { linkedin_company_url: linkedinCompanyUrl } : {}),
    ...(xUrl ? { x_url: xUrl } : {}),
    ...(xHandle ? { x_handle: xHandle } : {}),
    ...(facebookUrl ? { facebook_url: facebookUrl } : {}),
    ...(instagramUrl ? { instagram_url: instagramUrl } : {}),
    ...(youtubeUrl ? { youtube_url: youtubeUrl } : {}),
    ...(githubUrl ? { github_url: githubUrl } : {}),
  };
}
