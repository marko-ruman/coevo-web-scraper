export interface DetectedLanguageResult {
  code: string;
  confidence: number;
  source: 'html_lang' | 'meta' | 'path' | 'lexical' | 'tld' | 'fallback';
  rawLangTag?: string;
  googleNews: {
    hl: string;
    gl: string;
    ceid: string;
  };
}

export type PageBucketKey =
  | 'homepage'
  | 'about'
  | 'leadership'
  | 'products_services'
  | 'customers'
  | 'news_blog'
  | 'contact'
  | 'careers'
  | 'legal'
  | 'general';

export function foldAccents(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

const GOOGLE_NEWS_LOCALE_BY_LANG: Record<string, { hl: string; gl: string; ceid: string }> = {
  cs: { hl: 'cs', gl: 'CZ', ceid: 'CZ:cs' },
  sk: { hl: 'sk', gl: 'SK', ceid: 'SK:sk' },
  de: { hl: 'de', gl: 'DE', ceid: 'DE:de' },
  pl: { hl: 'pl', gl: 'PL', ceid: 'PL:pl' },
  fr: { hl: 'fr', gl: 'FR', ceid: 'FR:fr' },
  es: { hl: 'es', gl: 'ES', ceid: 'ES:es' },
  it: { hl: 'it', gl: 'IT', ceid: 'IT:it' },
  nl: { hl: 'nl', gl: 'NL', ceid: 'NL:nl' },
  pt: { hl: 'pt-PT', gl: 'PT', ceid: 'PT:pt-150' },
  sv: { hl: 'sv', gl: 'SE', ceid: 'SE:sv' },
  no: { hl: 'no', gl: 'NO', ceid: 'NO:no' },
  da: { hl: 'da', gl: 'DK', ceid: 'DK:da' },
  fi: { hl: 'fi', gl: 'FI', ceid: 'FI:fi' },
  hu: { hl: 'hu', gl: 'HU', ceid: 'HU:hu' },
  ro: { hl: 'ro', gl: 'RO', ceid: 'RO:ro' },
  bg: { hl: 'bg', gl: 'BG', ceid: 'BG:bg' },
  hr: { hl: 'hr', gl: 'HR', ceid: 'HR:hr' },
  sl: { hl: 'sl', gl: 'SI', ceid: 'SI:sl' },
  el: { hl: 'el', gl: 'GR', ceid: 'GR:el' },
  lt: { hl: 'lt', gl: 'LT', ceid: 'LT:lt' },
  lv: { hl: 'lv', gl: 'LV', ceid: 'LV:lv' },
  et: { hl: 'et', gl: 'EE', ceid: 'EE:et' },
  uk: { hl: 'uk', gl: 'UA', ceid: 'UA:uk' },
  en: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
};

const TLD_LANGUAGE_PRIORS: Array<{ suffix: string; lang: string; gl?: string; weight: number }> = [
  { suffix: '.cz', lang: 'cs', gl: 'CZ', weight: 4 },
  { suffix: '.sk', lang: 'sk', gl: 'SK', weight: 4 },
  { suffix: '.de', lang: 'de', gl: 'DE', weight: 4 },
  { suffix: '.at', lang: 'de', gl: 'AT', weight: 4 },
  { suffix: '.ch', lang: 'de', gl: 'CH', weight: 1.5 },
  { suffix: '.pl', lang: 'pl', gl: 'PL', weight: 4 },
  { suffix: '.fr', lang: 'fr', gl: 'FR', weight: 4 },
  { suffix: '.es', lang: 'es', gl: 'ES', weight: 4 },
  { suffix: '.it', lang: 'it', gl: 'IT', weight: 4 },
  { suffix: '.nl', lang: 'nl', gl: 'NL', weight: 4 },
  { suffix: '.be', lang: 'nl', gl: 'BE', weight: 1.5 },
  { suffix: '.pt', lang: 'pt', gl: 'PT', weight: 4 },
  { suffix: '.se', lang: 'sv', gl: 'SE', weight: 4 },
  { suffix: '.no', lang: 'no', gl: 'NO', weight: 4 },
  { suffix: '.dk', lang: 'da', gl: 'DK', weight: 4 },
  { suffix: '.fi', lang: 'fi', gl: 'FI', weight: 4 },
  { suffix: '.hu', lang: 'hu', gl: 'HU', weight: 4 },
  { suffix: '.ro', lang: 'ro', gl: 'RO', weight: 4 },
  { suffix: '.bg', lang: 'bg', gl: 'BG', weight: 4 },
  { suffix: '.hr', lang: 'hr', gl: 'HR', weight: 4 },
  { suffix: '.si', lang: 'sl', gl: 'SI', weight: 4 },
  { suffix: '.gr', lang: 'el', gl: 'GR', weight: 4 },
  { suffix: '.lt', lang: 'lt', gl: 'LT', weight: 4 },
  { suffix: '.lv', lang: 'lv', gl: 'LV', weight: 4 },
  { suffix: '.ee', lang: 'et', gl: 'EE', weight: 4 },
  { suffix: '.ua', lang: 'uk', gl: 'UA', weight: 3.5 },
  { suffix: '.co.uk', lang: 'en', gl: 'GB', weight: 4 },
  { suffix: '.uk', lang: 'en', gl: 'GB', weight: 4 },
  { suffix: '.ie', lang: 'en', gl: 'IE', weight: 4 },
];

export function getGoogleNewsLocale(langCode?: string, host = ''): { hl: string; gl: string; ceid: string } {
  const lowerHost = String(host || '').toLowerCase().trim();
  const base = normalizeLangTag(langCode) || '';

  if (base === 'de' && lowerHost.endsWith('.at')) return { hl: 'de', gl: 'AT', ceid: 'AT:de' };
  if (base === 'de' && lowerHost.endsWith('.ch')) return { hl: 'de', gl: 'CH', ceid: 'CH:de' };
  if (base === 'fr' && lowerHost.endsWith('.ch')) return { hl: 'fr', gl: 'CH', ceid: 'CH:fr' };
  if (base === 'fr' && lowerHost.endsWith('.be')) return { hl: 'fr', gl: 'BE', ceid: 'BE:fr' };
  if (base === 'nl' && lowerHost.endsWith('.be')) return { hl: 'nl', gl: 'BE', ceid: 'BE:nl' };
  if (base === 'en' && (lowerHost.endsWith('.co.uk') || lowerHost.endsWith('.uk'))) {
    return { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' };
  }
  if (base === 'en' && lowerHost.endsWith('.ie')) {
    return { hl: 'en-IE', gl: 'IE', ceid: 'IE:en' };
  }

  if (base && GOOGLE_NEWS_LOCALE_BY_LANG[base]) {
    return GOOGLE_NEWS_LOCALE_BY_LANG[base];
  }

  for (const tld of TLD_LANGUAGE_PRIORS) {
    if (lowerHost.endsWith(tld.suffix)) {
      if (tld.gl && tld.lang === 'en') return { hl: `en-${tld.gl}`, gl: tld.gl, ceid: `${tld.gl}:en` };
      if (tld.gl && tld.lang === 'de') return { hl: 'de', gl: tld.gl, ceid: `${tld.gl}:de` };
      return GOOGLE_NEWS_LOCALE_BY_LANG[tld.lang] || GOOGLE_NEWS_LOCALE_BY_LANG.en;
    }
  }

  return GOOGLE_NEWS_LOCALE_BY_LANG.en;
}

export function normalizeLangTag(tag?: string): string | null {
  if (!tag) return null;
  const clean = tag.trim().toLowerCase().replace(/_/g, '-');
  if (!clean) return null;
  const primary = clean.split('-')[0];
  const aliases: Record<string, string> = {
    cz: 'cs',
    ces: 'cs',
    slk: 'sk',
    deu: 'de',
    ger: 'de',
    pol: 'pl',
    fra: 'fr',
    fre: 'fr',
    spa: 'es',
    ita: 'it',
    nld: 'nl',
    dut: 'nl',
    por: 'pt',
    swe: 'sv',
    nb: 'no',
    nn: 'no',
    nor: 'no',
    dan: 'da',
    fin: 'fi',
    hun: 'hu',
    ron: 'ro',
    rum: 'ro',
    bul: 'bg',
    hrv: 'hr',
    slv: 'sl',
    ell: 'el',
    gre: 'el',
    lit: 'lt',
    lav: 'lv',
    est: 'et',
    ukr: 'uk',
    eng: 'en',
  };
  const resolved = aliases[primary] || primary;
  return GOOGLE_NEWS_LOCALE_BY_LANG[resolved] ? resolved : null;
}

/**
 * High-signal stopwords and unmistakable orthography per European language.
 * Used as a zero-cost lexical classifier when `<html lang>` is missing or stale (e.g. WordPress default "en").
 */
const LANGUAGE_STOPWORDS: Record<string, { words: string[]; markers?: RegExp }> = {
  cs: {
    words: [
      'jsou', 'jste', 'jsme', 'bude', 'můžete', 'nabízíme', 'služby', 'společnost', 'kontakt',
      'novinky', 'více', 'nebo', 'také', 'jako', 'jsou', 'který', 'která', 'které', 'před',
      'při', 'vás', 'naše', 'naší', 'pro', 'od', 'bez', 'podle', 'praha', 'ordinace', 'péče',
    ],
    markers: /[ěřů]/g,
  },
  sk: {
    words: [
      'sme', 'ste', 'bude', 'môžete', 'ponúkame', 'služby', 'spoločnosť', 'kontakt', 'novinky',
      'viac', 'alebo', 'tiež', 'ako', 'ktorý', 'ktorá', 'ktoré', 'pred', 'pri', 'vás', 'naše',
      'pre', 'podľa', 'bratislava', 'starostlivosť', 'sme', 'nie', 'len', 'aby',
    ],
    markers: /[ľŕôä]/g,
  },
  pl: {
    words: [
      'jest', 'są', 'jesteśmy', 'możesz', 'oferujemy', 'usługi', 'firma', 'kontakt', 'aktualności',
      'więcej', 'lub', 'również', 'jako', 'który', 'która', 'które', 'przed', 'przy', 'nasze',
      'dla', 'bez', 'według', 'warszawa', 'opieka', 'zespół', 'o nas',
    ],
    markers: /[łżźąęśń]/g,
  },
  de: {
    words: [
      'und', 'der', 'die', 'das', 'wir', 'für', 'mit', 'sind', 'über', 'unsere', 'leistungen',
      'kontakt', 'aktuelles', 'mehr', 'oder', 'auch', 'durch', 'bei', 'von', 'nach', 'ihre',
      'unternehmen', 'team', 'impressum', 'datenschutz', 'gmbh',
    ],
    markers: /[ßäöü]/g,
  },
  fr: {
    words: [
      'nous', 'vous', 'avec', 'pour', 'dans', 'les', 'des', 'une', 'est', 'sont', 'notre', 'votre',
      'services', 'entreprise', 'contact', 'actualités', 'plus', 'aussi', 'comme', 'qui', 'que',
      'sur', 'par', 'sans', 'équipe', 'mentions', 'société',
    ],
    markers: /[àâçéèêëîïôùûüœ]/g,
  },
  es: {
    words: [
      'nosotros', 'nuestros', 'nuestra', 'para', 'con', 'por', 'los', 'las', 'una', 'unos',
      'servicios', 'empresa', 'contacto', 'noticias', 'más', 'como', 'también', 'sobre', 'equipo',
      'somos', 'clientes', 'soluciones', 'desde', 'hasta', 'aviso',
    ],
    markers: /[ñ¿¡áéíóú]/g,
  },
  it: {
    words: [
      'noi', 'nostri', 'nostra', 'per', 'con', 'degli', 'delle', 'della', 'sono', 'siamo',
      'servizi', 'azienda', 'contatti', 'notizie', 'più', 'come', 'anche', 'chi siamo', 'squadra',
      'clienti', 'soluzioni', 'dove', 'dalla', 'lavora',
    ],
    markers: /[àèéìòóù]/g,
  },
  nl: {
    words: [
      'wij', 'onze', 'ons', 'voor', 'met', 'van', 'een', 'zijn', 'het', 'ook', 'meer', 'over ons',
      'diensten', 'bedrijf', 'contact', 'nieuws', 'klanten', 'oplossingen', 'werken', 'waarom',
      'bij', 'naar', 'door', 'tot', 'geen',
    ],
    markers: /\b(het|een|wij|onze|van|voor|naar|nieuws|diensten)\b/g,
  },
  pt: {
    words: [
      'nós', 'nossos', 'nossa', 'para', 'com', 'por', 'dos', 'das', 'uma', 'são', 'somos',
      'serviços', 'empresa', 'contato', 'contacto', 'notícias', 'mais', 'também', 'sobre',
      'equipa', 'equipe', 'clientes', 'soluções', 'quem',
    ],
    markers: /[ãõçâêô]/g,
  },
  sv: {
    words: [
      'och', 'för', 'med', 'som', 'det', 'är', 'vi', 'vår', 'våra', 'oss', 'om oss', 'tjänster',
      'nyheter', 'kontakt', 'företag', 'mer', 'också', 'från', 'till', 'hos', 'kunder', 'medarbetare',
    ],
    markers: /[åäö]/g,
  },
  no: {
    words: [
      'og', 'for', 'med', 'som', 'det', 'er', 'vi', 'vår', 'våre', 'oss', 'om oss', 'tjenester',
      'nyheter', 'kontakt', 'bedrift', 'mer', 'også', 'fra', 'til', 'hos', 'kunder', 'ansatte',
    ],
    markers: /[øæå]/g,
  },
  da: {
    words: [
      'og', 'for', 'med', 'som', 'det', 'er', 'vi', 'vores', 'os', 'om os', 'ydelser', 'tjenester',
      'nyheder', 'kontakt', 'virksomhed', 'mere', 'også', 'fra', 'til', 'hos', 'kunder', 'medarbejdere',
    ],
    markers: /[øæå]/g,
  },
  fi: {
    words: [
      'ja', 'on', 'ovat', 'meidän', 'kanssa', 'palvelut', 'yhteystiedot', 'ajankohtaista', 'uutiset',
      'yritys', 'myös', 'lisää', 'sekä', 'että', 'mutta', 'asiakkaat', 'tiimi', 'ratkaisut', 'tietoa',
    ],
    markers: /\b(meidän|yhteystiedot|palvelut|ajankohtaista|tietoa|yritys|sekä)\b/g,
  },
  hu: {
    words: [
      'és', 'hogy', 'egy', 'nem', 'vagy', 'van', 'vannak', 'szolgáltatások', 'kapcsolat', 'hírek',
      'rólunk', 'több', 'is', 'mint', 'cég', 'ügyfelek', 'csapat', 'megoldások', 'tovább',
    ],
    markers: /[őű]/g,
  },
  ro: {
    words: [
      'și', 'sau', 'pentru', 'cu', 'din', 'sunt', 'suntem', 'noastră', 'noștri', 'servicii',
      'contact', 'noutăți', 'știri', 'despre noi', 'echipa', 'clienți', 'soluții', 'mai mult',
    ],
    markers: /[ăîșț]/g,
  },
  hr: {
    words: [
      'smo', 'ste', 'su', 'za', 'naše', 'usluge', 'kontakt', 'novosti', 'vijesti', 'o nama',
      'više', 'ili', 'također', 'kao', 'koji', 'koja', 'tvrtka', 'klijenti', 'tim',
    ],
    markers: /[čćđšž]/g,
  },
  sl: {
    words: [
      'smo', 'ste', 'so', 'za', 'naše', 'storitve', 'kontakt', 'novice', 'aktualno', 'o nas',
      'več', 'ali', 'tudi', 'kot', 'kateri', 'katera', 'podjetje', 'stranke', 'ekipa',
    ],
    markers: /[čšž]/g,
  },
  lt: {
    words: [
      'ir', 'kad', 'su', 'už', 'mūsų', 'paslaugos', 'kontaktai', 'naujienos', 'apie mus',
      'daugiau', 'arba', 'taip pat', 'kaip', 'įmonė', 'klientai', 'komanda',
    ],
    markers: /[ąčęėįšųūž]/g,
  },
  lv: {
    words: [
      'un', 'ka', 'ar', 'par', 'mūsu', 'pakalpojumi', 'kontakti', 'jaunumi', 'par mums',
      'vairāk', 'vai', 'arī', 'kā', 'uzņēmums', 'klienti', 'komanda',
    ],
    markers: /[āčēģīķļņšūž]/g,
  },
  et: {
    words: [
      'ja', 'on', 'kui', 'meie', 'teenused', 'kontakt', 'uudised', 'meist', 'rohkem',
      'või', 'ka', 'nagu', 'ettevõte', 'kliendid', 'meeskond',
    ],
    markers: /[õäöü]/g,
  },
  en: {
    words: [
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'our', 'your', 'about', 'services',
      'solutions', 'company', 'team', 'contact', 'news', 'blog', 'more', 'learn', 'clients',
    ],
  },
};

export function detectSiteLanguage(params: {
  html?: string;
  text?: string;
  url?: string;
}): DetectedLanguageResult {
  const html = String(params.html || '');
  const text = String(params.text || '');
  const urlStr = String(params.url || '');

  let host = '';
  let pathSeg = '';
  try {
    const parsed = new URL(urlStr);
    host = parsed.hostname.toLowerCase();
    pathSeg = parsed.pathname.split('/').filter(Boolean)[0]?.toLowerCase() || '';
  } catch {
    // ignore malformed URL
  }

  // 1. Explicit HTML / Meta / JSON-LD signals
  const htmlLangMatch = html.match(/<html[^>]*\s(?:xml:)?lang=["']([a-zA-Z0-9_-]{2,15})["']/i);
  const ogLocaleMatch = html.match(/<meta[^>]+(?:property=["']og:locale["']|http-equiv=["']content-language["']|name=["']language["'])[^>]+content=["']([a-zA-Z0-9_-]{2,15})["']/i)
    || html.match(/<meta[^>]+content=["']([a-zA-Z0-9_-]{2,15})["'][^>]+(?:property=["']og:locale["']|http-equiv=["']content-language["']|name=["']language["'])/i);
  const ldLangMatch = html.match(/"inLanguage"\s*:\s*"([a-zA-Z0-9_-]{2,15})"/i);

  const rawHtmlLang = htmlLangMatch?.[1];
  const rawMetaLang = ogLocaleMatch?.[1] || ldLangMatch?.[1];
  const htmlLangNorm = normalizeLangTag(rawHtmlLang);
  const metaLangNorm = normalizeLangTag(rawMetaLang);
  const pathLangNorm = pathSeg.length <= 5 ? normalizeLangTag(pathSeg) : null;

  // 2. Non-Latin script instant checks (Greek, Ukrainian / Bulgarian Cyrillic)
  const sampleText = text.slice(0, 12000);
  const greekChars = (sampleText.match(/[\u0370-\u03FF]/g) || []).length;
  if (greekChars > 25) {
    return {
      code: 'el',
      confidence: 0.99,
      source: htmlLangNorm === 'el' ? 'html_lang' : 'lexical',
      rawLangTag: rawHtmlLang || rawMetaLang,
      googleNews: getGoogleNewsLocale('el', host),
    };
  }
  const cyrillicChars = (sampleText.match(/[\u0400-\u04FF]/g) || []).length;
  if (cyrillicChars > 25) {
    const ukMarkers = (sampleText.match(/[іїєґІЇЄҐ]/g) || []).length;
    const code = ukMarkers > 2 || host.endsWith('.ua') ? 'uk' : 'bg';
    return {
      code,
      confidence: 0.96,
      source: htmlLangNorm === code ? 'html_lang' : 'lexical',
      rawLangTag: rawHtmlLang || rawMetaLang,
      googleNews: getGoogleNewsLocale(code, host),
    };
  }

  // 3. Lexical stopword + diacritic scoring
  const lowerSample = sampleText.toLowerCase();
  const scores: Record<string, number> = {};
  for (const [lang, cfg] of Object.entries(LANGUAGE_STOPWORDS)) {
    let score = 0;
    for (const word of cfg.words) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = lowerSample.match(new RegExp(`(?:^|[^\\p{L}])${escaped}(?=[^\\p{L}]|$)`, 'giu'));
      if (m) score += Math.min(m.length, 6) * (word.length >= 4 ? 1.4 : 1.0);
    }
    if (cfg.markers) {
      const markerMatches = lowerSample.match(cfg.markers) || [];
      score += Math.min(markerMatches.length, 30) * 0.45;
    }
    scores[lang] = score;
  }

  // Add subtle ccTLD prior
  let tldLang: string | null = null;
  for (const tld of TLD_LANGUAGE_PRIORS) {
    if (host.endsWith(tld.suffix)) {
      tldLang = tld.lang;
      scores[tld.lang] = (scores[tld.lang] || 0) + tld.weight;
      break;
    }
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const topLang = ranked[0]?.[0] || 'en';
  const topScore = ranked[0]?.[1] || 0;
  const secondScore = ranked[1]?.[1] || 0;

  // Decide between explicit HTML/Meta tag vs lexical signal:
  // If explicit <html lang> agrees with meta or top lexical, or top lexical score isn't strong, trust explicit tag.
  // If <html lang="en"> is contradicted by overwhelming non-English lexical score (common CMS default bug), prefer lexical!
  const explicitLang = metaLangNorm || htmlLangNorm || pathLangNorm;
  const explicitScore = explicitLang ? (scores[explicitLang] || 0) : 0;

  let finalCode = explicitLang || topLang || tldLang || 'en';
  let source: DetectedLanguageResult['source'] = htmlLangNorm
    ? 'html_lang'
    : metaLangNorm
    ? 'meta'
    : pathLangNorm
    ? 'path'
    : 'lexical';
  let confidence = 0.7;

  if (pathLangNorm && pathLangNorm !== htmlLangNorm) {
    finalCode = pathLangNorm;
    source = 'path';
    confidence = 0.9;
  } else if (explicitLang && topScore >= 12 && topLang !== explicitLang && topScore > explicitScore * 2.2) {
    // Broken starter template <html lang="en"> override
    finalCode = topLang;
    source = 'lexical';
    confidence = Math.min(0.96, 0.65 + (topScore - secondScore) / 40);
  } else if (explicitLang) {
    finalCode = explicitLang;
    source = htmlLangNorm ? 'html_lang' : metaLangNorm ? 'meta' : 'path';
    confidence = topLang === explicitLang ? 0.98 : 0.86;
  } else if (topScore >= 5) {
    finalCode = topLang;
    source = 'lexical';
    confidence = Math.min(0.95, 0.55 + (topScore - secondScore) / 35);
  } else if (tldLang) {
    finalCode = tldLang;
    source = 'tld';
    confidence = 0.65;
  } else {
    finalCode = 'en';
    source = 'fallback';
    confidence = 0.4;
  }

  return {
    code: finalCode,
    confidence: Number(confidence.toFixed(2)),
    source,
    rawLangTag: rawHtmlLang || rawMetaLang,
    googleNews: getGoogleNewsLocale(finalCode, host),
  };
}

/**
 * Comprehensive pan-European bucket synonym keywords (matched accent-folded against path segments and link anchors).
 */
export const BUCKET_SYNONYMS: Record<
  Exclude<PageBucketKey, 'homepage' | 'general'>,
  { keywords: string[]; urlScore: number; anchorScore: number }
> = {
  leadership: {
    urlScore: 100,
    anchorScore: 48,
    keywords: [
      // EN
      'team', 'our-team', 'leadership', 'management', 'executive', 'executives', 'founders', 'people', 'staff', 'experts', 'specialists', 'doctors', 'physicians', 'board', 'authors',
      // CS / SK
      'tym', 'nas-tym', 'lide', 'nasi-lide', 'vedeni', 'management', 'lekari', 'nasi-lekari', 'doktori', 'odbornici', 'specialiste', 'zakladatele', 'personal', 'tym-lekaru', 'terapeuti', 'fyzioterapeuti', 'kolektiv',
      // DE
      'unser-team', 'mitarbeiter', 'geschaftsfuhrung', 'geschaftsleitung', 'vorstand', 'leitung', 'fuhrung', 'aerzte', 'arzte', 'facharzte', 'spezialisten', 'gründer', 'grunder', 'personen',
      // FR
      'equipe', 'notre-equipe', 'direction', 'dirigeants', 'fondateurs', 'medecins', 'praticiens', 'specialistes', 'membres',
      // ES / PT
      'equipo', 'nuestro-equipo', 'directiva', 'dirección', 'fundadores', 'medicos', 'especialistas', 'profesionales', 'equipa', 'nossa-equipa', 'direcao', 'lideranca',
      // IT
      'il-nostro-team', 'direzione', 'fondatori', 'medici', 'professionisti', 'dottori', 'chi-siamo', 'staff-medico',
      // NL / Nordics
      'ons-team', 'medewerkers', 'directie', 'bestuur', 'artsen', 'specialisten', 'vart-team', 'vårt-team', 'ledelse', 'ledarskap', 'ansatte', 'medarbetare', 'lakare', 'leger', 'tiimi', 'johto', 'laakarit',
      // PL / HU / RO / HR / SL / Baltics
      'zespol', 'nasz-zespol', 'zarzad', 'kierownictwo', 'lekarze', 'specjalisci', 'csapat', 'vezetoseg', 'orvosok', 'szakorvosok', 'echipa', 'conducere', 'medici', 'echipa-medicala', 'strucnjaci', 'tim', 'ekipa', 'vodstvo', 'zdravniki', 'komanda', 'vadiba', 'gydytojai', 'arsti', 'meeskond', 'komanda',
    ],
  },
  contact: {
    urlScore: 95,
    anchorScore: 45,
    keywords: [
      'contact', 'contacts', 'contact-us', 'get-in-touch', 'locations', 'offices', 'branches', 'find-us', 'address',
      'kontakt', 'kontakty', 'napiste-nam', 'kde-nas-najdete', 'pobocky', 'ordinace', 'kliniky', 'pracoviste', 'adresa', 'spojeni',
      'kontaktieren', 'anfahrt', 'standorte', 'niederlassungen', 'impressum', 'adresse', 'kontaktdaten',
      'nous-contacter', 'coordonnees', 'agences', 'bureaux', 'acces',
      'contacto', 'contactanos', 'ubicacion', 'sucursales', 'oficinas', 'donde-estamos', 'contato', 'fale-conosco', 'enderecos', 'unidades',
      'contatti', 'contattaci', 'dove-siamo', 'sedi', 'uffici',
      'contactgegevens', 'vestigingen', 'locaties', 'route',
      'kontaktai', 'kontakti', 'kontaktinfo', 'yhteystiedot', 'toimipisteet',
      'kapcsolat', 'elerhetoseg', 'kapcsolatok', 'rendelok', 'cím',
      'contacte', 'sedii', 'adresa', 'adrese', 'kontakti', 'poslovnice', 'lokacije', 'adresy', 'kontaktni', 'kancelar',
    ],
  },
  news_blog: {
    urlScore: 92,
    anchorScore: 44,
    keywords: [
      'news', 'blog', 'articles', 'press', 'newsroom', 'media', 'insights', 'stories', 'journal', 'updates', 'resources', 'publications', 'announcements', 'events',
      'novinky', 'aktuality', 'clanky', 'zpravy', 'tiskove-zpravy', 'pro-media', 'magazin', 'poradna', 'osveta', 'akce', 'udalosti', 'spravy', 'tlacove-spravy', 'prispevky',
      'aktuelles', 'neuigkeiten', 'nachrichten', 'presse', 'pressemitteilungen', 'beitraege', 'beitrage', 'magazin', 'ratgeber', 'wissen', 'neu',
      'actualites', 'nouvelles', 'communiques', 'presse', 'dossiers', 'ressources',
      'noticias', 'actualidad', 'articulos', 'prensa', 'sala-de-prensa', 'novedades', 'novidades', 'imprensa', 'artigos',
      'notizie', 'comunicati', 'stampa', 'articoli', 'approfondimenti', 'eventi', 'novita',
      'nieuws', 'actueel', 'pers', 'artikelen', 'kennisbank', 'inzichten',
      'nyheter', 'aktuelt', 'pressrum', 'artiklar', 'artikler', 'nyheder', 'presse', 'ajankohtaista', 'uutiset', 'artikkelit',
      'hirek', 'aktualis', 'cikkek', 'sajto', 'esemenyek',
      'noutati', 'stiri', 'articole', 'presa', 'comunicate',
      'wiadomosci', 'aktualnosci', 'artykuly', 'baza-wiedzy', 'informacje',
      'novosti', 'vijesti', 'clanci', 'aktualnosti', 'novice', 'objave',
      'naujienos', 'straipsniai', 'jaunumi', 'raksti', 'uudised', 'artiklid', 'novyny',
    ],
  },
  products_services: {
    urlScore: 90,
    anchorScore: 42,
    keywords: [
      'product', 'products', 'service', 'services', 'solution', 'solutions', 'platform', 'pricing', 'plans', 'features', 'capabilities', 'treatments', 'specialties', 'departments', 'care', 'offer', 'offerings', 'procedures', 'diagnostics',
      'sluzby', 'produkty', 'reseni', 'nabidka', 'cenik', 'ceny', 'specializace', 'obory', 'oddeleni', 'pece', 'zakroky', 'vysetreni', 'metody', 'programy', 'pro-firmy', 'sluzby-a-obory',
      'leistungen', 'angebot', 'angebote', 'losungen', 'loesungen', 'produkte', 'preise', 'behandlungen', 'fachbereiche', 'therapien', 'medizin', 'kompetenzen',
      'produits', 'solutions', 'offre', 'offres', 'tarifs', 'prestations', 'soins', 'specialites', 'expertises', 'traitements',
      'productos', 'servicios', 'soluciones', 'precios', 'planes', 'especialidades', 'tratamientos', 'servicos', 'produtos', 'solucoes', 'especialidades',
      'prodotti', 'servizi', 'soluzioni', 'prezzi', 'tariffe', 'prestazioni', 'specializzazioni', 'trattamenti', 'visite',
      'producten', 'diensten', 'oplossingen', 'tarieven', 'behandelingen', 'specialismen',
      'tjanster', 'tjenester', 'produkter', 'losninger', 'priser', 'behandlinger', 'palvelut', 'tuotteet', 'ratkaisut', 'hinnasto',
      'szolgaltatasok', 'termekek', 'megoldasok', 'arak', 'szakteruletek', 'kezelesek',
      'servicii', 'produse', 'solutii', 'preturi', 'specialitati', 'tratamente',
      'uslugi', 'produkty', 'rozwiazania', 'cennik', 'zabiegi', 'specjalizacje', 'oferta',
      'usluge', 'proizvodi', 'rjesenja', 'storitve', 'paslaugos', 'pakalpojumi', 'teenused', 'posluhy',
    ],
  },
  about: {
    urlScore: 82,
    anchorScore: 38,
    keywords: [
      'about', 'about-us', 'company', 'who-we-are', 'story', 'our-story', 'mission', 'vision', 'values', 'history', 'profile', 'overview', 'clinic',
      'o-nas', 'o-spolecnosti', 'o-firme', 'o-klinice', 'o-centru', 'o-projektu', 'kdo-jsme', 'historie', 'nase-mise', 'hodnoty', 'pobocka', 'nase-klinika', 'profil',
      'uber-uns', 'ueber-uns', 'wir-uber-uns', 'unternehmen', 'firma', 'geschichte', 'mission', 'philosophie', 'profil', 'klinik', 'standort',
      'a-propos', 'qui-sommes-nous', 'entreprise', 'societe', 'notre-histoire', 'valeurs', 'clinique', 'cabinet',
      'sobre-nosotros', 'quienes-somos', 'empresa', 'historia', 'mision', 'nosotros', 'sobre-nos', 'quem-somos', 'sobre',
      'chi-siamo', 'azienda', 'storia', 'valori', 'missione', 'profilo', 'clinica',
      'over-ons', 'wie-zijn-wij', 'bedrijf', 'missie', 'om-oss', 'om-os', 'om-foretaget', 'tietoa-meista', 'yritys',
      'o-nas', 'o-firmie', 'kim-jestesmy', 'o-klinice', 'rolunk', 'cegunk', 'rolunk-szol', 'despre-noi', 'despre', 'cine-suntem', 'o-nama', 'tko-smo', 'o-podjetju', 'apie-mus', 'par-mums', 'meist',
    ],
  },
  customers: {
    urlScore: 76,
    anchorScore: 36,
    keywords: [
      'customer', 'customers', 'clients', 'case-study', 'case-studies', 'testimonials', 'reviews', 'references', 'portfolio', 'stories', 'partners', 'success-stories',
      'klienti', 'zakaznici', 'reference', 'pripadove-studie', 'zkusenosti', 'recenze', 'ohlas', 'ohlasy', 'pacienti', 'partneri', 'pribehy', 'spoluprace',
      'kunden', 'referenzen', 'fallstudien', 'erfahrungsberichte', 'bewertungen', 'patienten', 'partner', 'erfolgsgeschichten',
      'clients', 'temoignages', 'etudes-de-cas', 'references', 'avis', 'patients', 'partenaires', 'realisations',
      'clientes', 'casos-de-exito', 'casos', 'testimonios', 'resenas', 'referencias', 'pacientes', 'parceiros',
      'clienti', 'casi-di-studio', 'recensioni', 'testimonianze', 'referenze', 'pazienti', 'partner',
      'klanten', 'referenties', 'casestudy', 'beoordelingen', 'kunder', 'kundcase', 'asiakkaat', 'referenssit',
      'ugyfelek', 'referenciak', 'esettanulmanyok', 'velemenyek', 'klienci', 'referencje', 'opinie', 'realizacje',
      'clienti', 'studii-de-caz', 'recenzii', 'klijenti', 'stranke', 'klientai', 'atsiliepimai',
    ],
  },
  careers: {
    urlScore: 35,
    anchorScore: 20,
    keywords: [
      'career', 'careers', 'jobs', 'hiring', 'join-us', 'vacancies', 'openings',
      'kariera', 'volna-mista', 'prace', 'pracovni-pozice', 'hledame', 'pridejte-se',
      'karriere', 'stellenangebote', 'jobs', 'offene-stellen',
      'carriere', 'carrieres', 'recrutement', 'emplois', 'rejoindre',
      'carrera', 'empleo', 'trabaja-con-nosotros', 'vacantes', 'carreira', 'vagas',
      'lavora-con-noi', 'carriere', 'posizioni-aperte',
      'werken-bij', 'vacatures', 'karriar', 'lediga-jobb', 'ura', 'tyopaikat',
      'karrier', 'allas', 'cariere', 'praca', 'oferty-pracy', 'posao', 'karijera', 'kariera',
    ],
  },
  legal: {
    urlScore: 5,
    anchorScore: 5,
    keywords: [
      'privacy', 'terms', 'cookie', 'cookies', 'gdpr', 'legal', 'compliance', 'security',
      'soukromi', 'ochrana-udaju', 'podminky', 'zasady', 'cookies', 'pravni',
      'datenschutz', 'agb', 'nutzungsbedingungen', 'rechtliches',
      'confidentialite', 'mentions-legales', 'cgu', 'cgv', 'donnees',
      'privacidad', 'terminos', 'aviso-legal', 'privacidade', 'termos',
      'trattamento-dati', 'note-legali', 'termini', 'condizioni',
      'integritetspolicy', 'villkor', 'personvern', 'tietosuoja', 'adatvedelem', 'polityka-prywatnosci', 'regulamin',
    ],
  },
};

export const PERSON_ROLE_REGEX = new RegExp(
  [
    // Academic / Medical / Professional Prefixes & Degrees
    '\\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|bc|dis|mba|phd|dr|med|sc\\.d|msc|bsc)\\.?',
    // C-suite & executive roles (EN + EU)
    '(?:chief\\s+(?:executive|medical|technology|financial|operating|marketing|information|clinical|revenue)\\s+officer)',
    '(?:ceo|cfo|cto|coo|cmo|cio|cpo|cso|founder|co-founder|president|vice\\s+president|managing\\s+director|director|head\\s+of|partner)',
    // Slavic / Central EU
    '(?:primář|primar|zástupce\\s+primáře|zastupce\\s+primare|vedoucí|vedouci|garant|odborný\\s+garant|ředitel(?:ka)?|reditel(?:ka)?|jednatel(?:ka)?|zakladatel(?:ka)?|předseda|predseda|lékař(?:ka)?|lekar(?:ka)?|fyzioterapeut(?:ka)?|specialista|terapeut(?:ka)?|konzultant(?:ka)?|ordinář|ordinar|konateľ)',
    // German
    '(?:geschäftsführer(?:in)?|geschaftsfuhrer(?:in)?|vorstand|chefarzt|chefärztin|oberarzt|oberärztin|facharzt|fachärztin|ärztlicher?\\s+leiter|leiter(?:in)?|gründer(?:in)?|grunder(?:in)?|prokurist(?:in)?|arzt|ärztin)',
    // Romance (FR / ES / IT / PT / RO)
    '(?:directeur|directrice|dirigeant|fondateur|fondatrice|gérant|gérante|médecin|chirurgien|kinésithérapeute|responsable)',
    '(?:director(?:a)?|fundador(?:a)?|gerente|médico|médica|especialista|jefe|responsable)',
    '(?:direttore|direttrice|fondatore|amministratore|dottor(?:e|essa)?|medico|primario|responsabile)',
    '(?:diretor(?:a)?|fundador(?:a)?|sóci[oa]|médic[oa]|gestor(?:a)?|diretoria)',
    '(?:director|fondator|administrator|medic|șef)',
    // Polish / Hungarian / Nordics / Dutch
    '(?:prezes|wiceprezes|dyrektor|założyciel|współzałożyciel|kierownik|ordynator|lekarz|fizjoterapeuta)',
    '(?:ügyvezető|vezérigazgató|igazgató|alapító|társalapító|főorvos|orvos|vezető)',
    '(?:directeur|oprichter|bestuurder|arts|hoofd|specialist|verkställande|vd|ordförande|överläkare|läkare|overlege|lege|toimitusjohtaja|lääkäri|johtaja)',
  ].join('|'),
  'iu'
);
