# Scanner Rewrite — Crawlee + rebrowser-playwright

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite standalone-scan.mjs to use Crawlee framework with per-site handlers that actually extract real job listings instead of navigation links.

**Architecture:** Scanner registry routes each portal to a handler by `scan_method` field in portals.yml. Four handler types: `api` (Greenhouse JSON), `cheerio` (static HTML), `playwright` (SPA with rebrowser-playwright), `linkedin` (linkedin-jobs-scraper). Crawlee orchestrates browser-based scrapers with retry/queuing/autoscaling.

**Tech Stack:** crawlee, rebrowser-playwright, cheerio, linkedin-jobs-scraper, js-yaml

---

### Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new dependencies**

```bash
cd /home/tom/workspace/projects/career-ops-pl
npm install crawlee cheerio linkedin-jobs-scraper
npm install rebrowser-playwright
```

Note: rebrowser-playwright is a drop-in replacement for playwright. We keep both for now (existing scripts use playwright).

- [ ] **Step 2: Verify installs**

```bash
node -e "import('crawlee').then(m => console.log('crawlee OK'))"
node -e "import('cheerio').then(m => console.log('cheerio OK'))"
node -e "import('rebrowser-playwright').then(m => console.log('rebrowser OK'))"
```

---

### Task 2: Greenhouse API handler

**Files:**
- Create: `scanners/greenhouse-api.mjs`

- [ ] **Step 1: Create the handler**

Plain fetch() to Greenhouse boards API. Returns normalized job objects.

- [ ] **Step 2: Test with CD Projekt / Allegro**

```bash
node -e "import('./scanners/greenhouse-api.mjs').then(m => m.scan({ name: 'CD Projekt', api: 'https://boards-api.greenhouse.io/v1/boards/cdprojektred/jobs' }).then(console.log))"
```

---

### Task 3: Cheerio static HTML handler

**Files:**
- Create: `scanners/cheerio-scraper.mjs`

- [ ] **Step 1: Create the handler**

HTTP fetch + cheerio parse. Site-specific selectors in a registry object keyed by domain.

- [ ] **Step 2: Test with EuroBrussels**

```bash
node -e "import('./scanners/cheerio-scraper.mjs').then(m => m.scan({ name: 'EuroBrussels', careers_url: 'https://www.eurobrussels.com/job_search?field=Communications%20/%20Press' }).then(r => console.log(r.length, 'jobs')))"
```

---

### Task 4: Playwright SPA handler

**Files:**
- Create: `scanners/playwright-spa.mjs`

- [ ] **Step 1: Create the handler**

Uses rebrowser-playwright via Crawlee's PlaywrightCrawler. Per-site extraction functions keyed by domain. For Pracuj.pl: intercept XHR responses. For Google Careers: parse JSON-LD or wait for job cards. For generic career pages: improved link heuristics (filter nav/footer, require job-like URL patterns + meaningful title length).

- [ ] **Step 2: Test with Pracuj.pl**

```bash
node -e "import('./scanners/playwright-spa.mjs').then(m => m.scan({ name: 'Pracuj.pl', careers_url: 'https://www.pracuj.pl/praca/pr;kw/warszawa;wp?rd=30' }).then(r => console.log(JSON.stringify(r, null, 2))))"
```

---

### Task 5: LinkedIn handler

**Files:**
- Create: `scanners/linkedin-scraper.mjs`

- [ ] **Step 1: Create the handler**

Wraps linkedin-jobs-scraper in anonymous mode. Searches for PR/communications roles in Poland.

- [ ] **Step 2: Test**

```bash
node -e "import('./scanners/linkedin-scraper.mjs').then(m => m.scan({ keywords: ['PR Manager', 'Communications Manager'], location: 'Poland' }).then(r => console.log(r.length, 'jobs')))"
```

---

### Task 6: Rewrite standalone-scan.mjs

**Files:**
- Modify: `standalone-scan.mjs`

- [ ] **Step 1: Replace scanner internals**

Keep: CLI args, config loading, scan history, dedup, title filter, report generation.
Replace: scanning logic. Route each portal to the right handler based on `scan_method`. Run API + cheerio handlers first (fast), then playwright handlers via Crawlee, then LinkedIn.

- [ ] **Step 2: Update portals.yml scan_method fields**

Ensure every enabled portal has a valid `scan_method`: `api`, `cheerio`, `playwright`, or `linkedin`.

- [ ] **Step 3: Full test run**

```bash
node standalone-scan.mjs
```

Verify: real job titles (not nav links), no crashes on failed sites, proper error reporting.

---

### Task 7: Clean up scan-history.tsv

**Files:**
- Modify: `data/scan-history.tsv`

- [ ] **Step 1: Remove garbage entries from initial broken scan**

The current history has nav link entries like "Careers", "Jobs Jobs", "How we hire" that should be purged.
