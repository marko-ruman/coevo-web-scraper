import { foldAccents } from './i18n.js';
import type { RegistryData, ScrapedPerson } from './types.js';

const ARES_BASE = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest';

const LEGAL_FORM_NAMES: Record<string, string> = {
  '101': 'Fyzická osoba podnikající (OSVČ)',
  '111': 'Veřejná obchodní společnost (v.o.s.)',
  '112': 'Společnost s ručením omezeným (s.r.o.)',
  '113': 'Komanditní společnost (k.s.)',
  '121': 'Akciová společnost (a.s.)',
  '141': 'Obecně prospěšná společnost (o.p.s.)',
  '161': 'Ústav (z.ú.)',
  '205': 'Družstvo',
  '301': 'Státní podnik',
  '325': 'Organizační složka státu',
  '331': 'Příspěvková organizace',
  '421': 'Odštěpný závod zahraniční osoby',
  '706': 'Spolek (z.s.)',
  '721': 'Církevní organizace',
  '736': 'Pobočný spolek',
  '801': 'Obec',
};

/**
 * Validates a Czech IČO (7 or 8 digits, padded left to 8) using the official weighted modulo-11 checksum.
 */
export function isValidCzechIco(raw: string): boolean {
  const digits = String(raw || '').replace(/\s+/g, '').trim();
  if (!/^\d{7,8}$/.test(digits)) return false;
  const padded = digits.padStart(8, '0');
  if (/^0+$/.test(padded)) return false;

  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    sum += Number(padded[i]) * weights[i];
  }
  const rem = sum % 11;
  const check = rem === 0 ? 1 : rem === 1 ? 0 : 11 - rem;
  return Number(padded[7]) === check;
}

/**
 * Extracts labeled Czech IČO / DIČ identifiers from page text/footer/impressum.
 */
export function extractCzechIcoAndDic(text: string): { ico?: string; dic?: string } {
  const sourceText = String(text || '');
  if (!sourceText) return {};

  let ico: string | undefined;
  const icoRegex = /(?:^|[^a-zA-Z])(?:IČO|IČ|ICO)\s*(?:[:.\-]|je)?\s*(\d[\d\s]{5,10}\d)(?=\D|$)/giu;
  for (const m of sourceText.matchAll(icoRegex)) {
    const rawDigits = String(m[1] || '').replace(/\s+/g, '');
    if (isValidCzechIco(rawDigits)) {
      ico = rawDigits.padStart(8, '0');
      break;
    }
  }

  let dic: string | undefined;
  const dicRegex = /(?:^|[^a-zA-Z])(?:DIČ|DIC)\s*(?:[:.\-]|je)?\s*(CZ\s*\d{8,10})(?=\D|$)/giu;
  for (const m of sourceText.matchAll(dicRegex)) {
    const cleanDic = String(m[1] || '').replace(/\s+/g, '').toUpperCase();
    if (/^CZ\d{8,10}$/.test(cleanDic)) {
      dic = cleanDic;
      // Corporate Czech DIČ (8 digits) equals IČO when IČO wasn't explicitly printed
      if (!ico && cleanDic.length === 10) {
        const candidateIco = cleanDic.slice(2);
        if (isValidCzechIco(candidateIco)) {
          ico = candidateIco;
        }
      }
      break;
    }
  }

  return { ico, dic };
}

function titleCaseCzechWord(word: string): string {
  const lower = word.toLocaleLowerCase('cs-CZ');
  if (!lower) return '';
  return lower.charAt(0).toLocaleUpperCase('cs-CZ') + lower.slice(1);
}

function titleCaseCzechSegment(raw: string): string {
  return String(raw || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part
        .split('-')
        .map((sub) => titleCaseCzechWord(sub))
        .join('-')
    )
    .join(' ');
}

export function formatCzechPersonName(fo: {
  jmeno?: string;
  prijmeni?: string;
  titulPredJmenem?: string;
  titulZaJmenem?: string;
}): string {
  const first = titleCaseCzechSegment(fo?.jmeno || '');
  const last = titleCaseCzechSegment(fo?.prijmeni || '');
  const core = [first, last].filter(Boolean).join(' ').trim();
  if (!core) return '';
  const prefix = String(fo?.titulPredJmenem || '').replace(/\s+/g, ' ').trim();
  const suffix = String(fo?.titulZaJmenem || '').replace(/\s+/g, ' ').trim();
  let out = prefix ? `${prefix} ${core}` : core;
  if (suffix) out = `${out}, ${suffix}`;
  return out;
}

function stripCzechLegalSuffixes(name: string): string {
  return foldAccents(name)
    .replace(/\b(?:spol\.\s*s\s*r\.o\.|s\.r\.o\.|s\s*r\s*o|a\.s\.|v\.o\.s\.|k\.s\.|z\.s\.|z\.u\.|o\.p\.s\.)/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeCompanySearchCandidates(rawName?: string): string[] {
  const raw = String(rawName || '').trim();
  if (!raw) return [];
  const candidates = new Set<string>();
  const primary = raw.split(/[|–—•]/)[0].trim();
  if (primary.length >= 3) candidates.add(primary);
  const noLegal = primary
    .replace(/,?\s*\b(?:spol\.?\s*s\s*r\.?o\.?|s\.?r\.?o\.?|a\.?s\.?|v\.?o\.?s\.?|k\.?s\.?|z\.?s\.?|z\.?ú\.?|o\.?p\.?s\.?)\s*$/i, '')
    .trim();
  if (noLegal.length >= 3) candidates.add(noLegal);
  return Array.from(candidates);
}

async function fetchAresJson(path: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(`${ARES_BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeExecDedupeKey(name: string): string {
  return foldAccents(
    name
      .replace(/\b(?:prof|doc|mudr|mddr|mvdr|phdr|judr|rndr|paeddr|pharmdr|ing|mgr|mga|bca|bc|dis|phd|ph\.d|mba|csc|dr)\.?/gi, '')
      .replace(/[,]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Queries official Czech ARES v2 REST API (zero auth, 100% free) to retrieve verified
 * corporate metadata and active statutory executives (`statutární orgán`, `jednatel`, `společník`).
 */
export async function lookupCzechAres(params: {
  ico?: string;
  companyName?: string;
  host?: string;
  detectedLang?: string;
}): Promise<RegistryData | null> {
  const host = String(params.host || '').toLowerCase();
  const lang = String(params.detectedLang || '').toLowerCase();
  let ico = params.ico && isValidCzechIco(params.ico) ? params.ico.replace(/\s+/g, '').padStart(8, '0') : '';

  if (!ico && !(host.endsWith('.cz') || lang === 'cs')) {
    return null;
  }

  if (!ico) {
    const searchCandidates = sanitizeCompanySearchCandidates(params.companyName);
    for (const term of searchCandidates) {
      const searchRes = await fetchAresJson('/ekonomicke-subjekty/vyhledat', {
        method: 'POST',
        body: JSON.stringify({ obchodniJmeno: term, start: 0, pocet: 5 }),
      });
      const list: any[] = Array.isArray(searchRes?.ekonomickeSubjekty) ? searchRes.ekonomickeSubjekty : [];
      if (list.length === 0) continue;

      const ourNorm = stripCzechLegalSuffixes(term);
      if (ourNorm.length < 3) continue;

      // Require clear legal-name correspondence to avoid false-positive company matches
      let matchedIco = '';
      for (const item of list) {
        const candName = String(item?.obchodniJmeno || '');
        const candNorm = stripCzechLegalSuffixes(candName);
        if (!candNorm || !item?.ico) continue;
        if (
          candNorm === ourNorm ||
          (ourNorm.length >= 5 && (candNorm.startsWith(ourNorm + ' ') || ourNorm.startsWith(candNorm + ' ')))
        ) {
          matchedIco = String(item.ico).padStart(8, '0');
          break;
        }
      }
      if (!matchedIco && list.length === 1 && ourNorm.length >= 6) {
        const onlyNorm = stripCzechLegalSuffixes(String(list[0]?.obchodniJmeno || ''));
        if (onlyNorm && (onlyNorm.includes(ourNorm) || ourNorm.includes(onlyNorm))) {
          matchedIco = String(list[0].ico || '').padStart(8, '0');
        }
      }
      if (matchedIco && isValidCzechIco(matchedIco)) {
        ico = matchedIco;
        break;
      }
    }
  }

  if (!ico) return null;

  const [subject, vr] = await Promise.all([
    fetchAresJson(`/ekonomicke-subjekty/${encodeURIComponent(ico)}`),
    fetchAresJson(`/ekonomicke-subjekty-vr/${encodeURIComponent(ico)}`),
  ]);

  if (!subject || !subject.obchodniJmeno) return null;

  const aresSourceUrl = `https://ares.gov.cz/ekonomicke-subjekty?ico=${ico}`;
  const execMap = new Map<string, ScrapedPerson>();

  const upsertExec = (person: ScrapedPerson) => {
    const key = normalizeExecDedupeKey(person.name);
    if (!key) return;
    const prev = execMap.get(key);
    if (!prev) {
      execMap.set(key, person);
      return;
    }
    if (person.name.length > prev.name.length) prev.name = person.name;
    if (person.role && prev.role && !prev.role.toLowerCase().includes(person.role.toLowerCase())) {
      prev.role = `${prev.role} / ${person.role}`.slice(0, 120);
    } else if (person.role && !prev.role) {
      prev.role = person.role;
    }
    if ((person.seniority_score ?? 0) > (prev.seniority_score ?? 0)) {
      prev.seniority_score = person.seniority_score;
    }
  };

  const vrRecords: any[] = Array.isArray(vr?.zaznamy) ? vr.zaznamy : [];
  for (const rec of vrRecords) {
    if (!rec || rec.datumVymazu) continue;

    const organs: any[] = Array.isArray(rec.statutarniOrgany) ? rec.statutarniOrgany : [];
    for (const organ of organs) {
      if (!organ || organ.datumVymazu) continue;
      const members: any[] = Array.isArray(organ.clenoveOrganu) ? organ.clenoveOrganu : [];
      for (const m of members) {
        // Critical: skip historical/removed executives
        if (!m || m.datumVymazu) continue;
        const fo = m.fyzickaOsoba;
        if (!fo) continue;
        const fullName = formatCzechPersonName(fo);
        if (!fullName) continue;
        const roleName =
          String(m?.clenstvi?.funkce?.nazev || m?.nazevAngazma || organ?.nazevOrganu || 'Statutární orgán').trim();
        upsertExec({
          name: fullName,
          role: roleName.slice(0, 120),
          source: 'ares_vr',
          is_decision_maker: true,
          seniority_score: 98,
          source_url: aresSourceUrl,
        });
      }
    }

    const spolecniciGroups: any[] = Array.isArray(rec.spolecnici) ? rec.spolecnici : [];
    for (const grp of spolecniciGroups) {
      if (!grp || grp.datumVymazu) continue;
      const list: any[] = Array.isArray(grp.spolecnik) ? grp.spolecnik : [];
      for (const sp of list) {
        if (!sp || sp.datumVymazu) continue;
        const fo = sp?.osoba?.fyzickaOsoba;
        if (!fo) continue;
        const fullName = formatCzechPersonName(fo);
        if (!fullName) continue;
        upsertExec({
          name: fullName,
          role: 'Společník',
          source: 'ares_vr',
          is_decision_maker: true,
          seniority_score: 92,
          source_url: aresSourceUrl,
        });
      }
    }
  }

  const pfCode = String(subject.pravniForma || '').trim();
  const legalForm = LEGAL_FORM_NAMES[pfCode] || (pfCode ? `Právní forma ${pfCode}` : undefined);
  const naceCodes = Array.isArray(subject.czNace)
    ? subject.czNace.map((c: unknown) => String(c || '').trim()).filter(Boolean).slice(0, 8)
    : undefined;

  return {
    source: 'cz_ares',
    ico,
    dic: subject.dic ? String(subject.dic).trim() : undefined,
    legal_name: String(subject.obchodniJmeno || '').trim(),
    legal_form: legalForm,
    founded_at: subject.datumVzniku ? String(subject.datumVzniku).trim() : undefined,
    address: subject?.sidlo?.textovaAdresa ? String(subject.sidlo.textovaAdresa).trim() : undefined,
    nace_codes: naceCodes && naceCodes.length > 0 ? naceCodes : undefined,
    executives: Array.from(execMap.values()).sort((a, b) => (b.seniority_score ?? 0) - (a.seniority_score ?? 0)),
  };
}
