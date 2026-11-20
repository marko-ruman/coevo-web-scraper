# Coevo Web Scraper Microservice

A lightweight, general-purpose web scraping, clean Markdown extraction, and precision Brand Kit microservice built with **Node.js, TypeScript, Playwright, `@mozilla/readability`, and `turndown`**.

Designed to run as a standalone Docker container (e.g. on Coolify) with **zero database credentials** and **zero Redis dependency** (built-in FIFO queue + webhook callbacks + polling).

## Endpoints

- `GET /health` — Service health, browser status, and active queue stats.
- `POST /v1/scrape` — Scrape a single URL into clean Markdown + metadata + optional Brand Kit (`async: true | false`).
- `POST /v1/brand` — Extract a precision 6-role Semantic Brand Kit (`primary`, `secondary`, `accent`, `background`, `surface`, `text`, `dark_bg`, clickable `palette`, `heading_font`, `body_font`, `logo_url`, `logo_candidates`) using real rendered DOM `getComputedStyle()` + inline SVG logo serialization.
- `POST /v1/crawl` — Multi-page intelligent crawl (Playwright homepage + scored subpages via parallel fetch + Readability Markdown + optional Blog/RSS + optional Google News RSS + optional Brand Kit + optional ClueState episode sync). Supports `async: true` (returns `202 Accepted` with `job_id` + optional `callback_url` webhook) or `async: false`.
- `GET /v1/jobs/:id` — Poll live step-by-step progress and final result for an async job.

## Authentication

Set `SCRAPER_API_SECRET` in your environment. Pass it in requests via either:
- `Authorization: Bearer <SCRAPER_API_SECRET>`
- `X-Scraper-Secret: <SCRAPER_API_SECRET>`

## Running Locally

```bash
cd web_scraper
npm install
npx playwright install chromium
npm run dev
```

## Deploying on Coolify

1. Create a new Dockerfile service pointing to `web_scraper/Dockerfile` (base directory: `web_scraper`).
2. Allocate **1–2 GB RAM** (Chromium needs ~300–500 MB per active page; `MAX_CONCURRENCY=2` keeps RAM predictable).
3. Set `SCRAPER_API_SECRET` on both `web_scraper` and `meta_api`, and set `SCRAPER_SERVICE_URL=https://your-scraper-domain` on `meta_api` (or in Workspace Settings → Scraper & ClueState).
