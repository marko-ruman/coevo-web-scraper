export type StepState = 'pending' | 'running' | 'completed' | 'warning' | 'skipped' | 'failed';

export interface JobStep {
  key: string;
  label: string;
  status: StepState;
  detail?: string;
  updated_at: string;
}

export interface PaletteSwatch {
  hex: string;
  role_hint?: 'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text' | 'dark_bg' | 'swatch';
  source?: string;
  weight?: number;
}

export interface BrandKit {
  status: 'unset' | 'extracted' | 'manual';
  source: 'playwright' | 'css' | 'screenshot' | 'manual' | 'none';
  domain: string;
  logo_url: string;
  logo_dark_url?: string;
  icon_url?: string;
  logo_candidates?: Array<{ url: string; kind: 'svg' | 'img' | 'jsonld' | 'apple_touch' | 'og' | 'favicon'; width?: number; height?: number }>;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  background_color: string;
  surface_color: string;
  text_color: string;
  dark_bg_color: string;
  palette: PaletteSwatch[];
  heading_font: string;
  body_font: string;
  font_urls?: string[];
  linkedin_company_url?: string;
  extracted_at?: string;
}

export interface CrawledPage {
  url: string;
  category: string;
  title: string;
  description?: string;
  chars: number;
  method: 'playwright' | 'fetch';
  markdown?: string;
}

export interface ArticleItem {
  title: string;
  url: string;
  published_at: string;
  source: string;
  summary: string;
}

export interface ScrapedPerson {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  source_url?: string;
  bio?: string;
}

export interface ScrapedContacts {
  emails: string[];
  phones: string[];
  social_links: string[];
  addresses: string[];
}

export interface EpisodePayload {
  key: string;
  category: string;
  title: string;
  url?: string;
  source_type: string;
  occurred_at: string;
  content: string;
}

export interface ScrapeOptions {
  url: string;
  render_js?: boolean;
  extract_brand?: boolean;
  max_chars?: number;
}

export interface CrawlOptions {
  url: string;
  name?: string;
  max_pages?: number;
  max_articles?: number;
  include_sitemap?: boolean;
  include_blog_and_news?: boolean;
  include_external_news?: boolean;
  extract_brand?: boolean;
  render_js?: boolean;
  profile_header?: string;
  callback_url?: string;
  callback_secret?: string;
  callback_meta?: Record<string, unknown>;
  async?: boolean;
}

export interface CrawlResult {
  ok: boolean;
  partial: boolean;
  blocked: boolean;
  http_status: number;
  blocked_reason: string | null;
  error: string | null;
  url: string;
  final_url: string;
  title: string;
  description: string;
  markdown: string;
  brand_kit: BrandKit | null;
  json_ld: Record<string, unknown>;
  detected_language?: string;
  detected_language_confidence?: number;
  detected_language_source?: string;
  people?: ScrapedPerson[];
  contacts?: ScrapedContacts;
  pages_crawled: CrawledPage[];
  articles: ArticleItem[];
  external_news: ArticleItem[];
  episodes: EpisodePayload[];
  source_pages: string[];
  duration_ms: number;
}

export type JobStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed';

export interface JobRecord {
  job_id: string;
  kind: 'scrape' | 'brand' | 'crawl';
  status: JobStatus;
  current_step: string;
  progress_pct: number;
  steps: JobStep[];
  result: CrawlResult | Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
