#!/usr/bin/env node

/**
 * standalone-scan.mjs — Headless portal scanner for career-ops
 *
 * Runs without Claude. Reads portals.yml, scrapes career pages and APIs,
 * filters by title, deduplicates, and writes a markdown report.
 *
 * Usage:
 *   node standalone-scan.mjs                          # report to stdout
 *   node standalone-scan.mjs --out /path/to/vault     # report to Obsidian vault
 *   node standalone-scan.mjs --out ./reports           # report to local dir
 *
 * The report filename is: career-scan-YYYY-MM-DD.md
 *
 * Environment variables:
 *   OBSIDIAN_VAULT  — default output directory (overridden by --out)
 *
 * Designed to run as a daily cron job:
 *   0 7 * * * cd /path/to/career-ops && node standalone-scan.mjs --out /path/to/obsidian/vault
 */

import { readFile, writeFile, appendFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TODAY = new Date().toISOString().slice(0, 10);

// ── CLI args ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let outDir = process.env.OBSIDIAN_VAULT || null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) outDir = args[i + 1];
  if (args[i] === '--help' || args[i] === '-h') {
    console.log(`Usage: node standalone-scan.mjs [--out /path/to/dir]`);
    console.log(`  --out   Directory for the markdown report (default: stdout)`);
    console.log(`  Env:    OBSIDIAN_VAULT sets default output dir`);
    process.exit(0);
  }
}

// ── Load config ───────────────────────────────────────────────────────────

async function loadConfig() {
  const portalsPath = join(__dirname, 'portals.yml');
  if (!existsSync(portalsPath)) {
    console.error('Error: portals.yml not found. Copy from templates/portals.example.yml');
    process.exit(1);
  }
  const raw = await readFile(portalsPath, 'utf-8');
  return yaml.load(raw);
}

async function loadScanHistory() {
  const histPath = join(__dirname, 'data', 'scan-history.tsv');
  if (!existsSync(histPath)) return new Set();
  const raw = await readFile(histPath, 'utf-8');
  const urls = new Set();
  for (const line of raw.split('\n').slice(1)) { // skip header
    const url = line.split('\t')[0];
    if (url) urls.add(url);
  }
  return urls;
}

async function loadPipelineUrls() {
  const urls = new Set();
  const pipePath = join(__dirname, 'data', 'pipeline.md');
  const appPath = join(__dirname, 'data', 'applications.md');

  for (const path of [pipePath, appPath]) {
    if (!existsSync(path)) continue;
    const raw = await readFile(path, 'utf-8');
    const matches = raw.matchAll(/https?:\/\/[^\s|)]+/g);
    for (const m of matches) urls.add(m[0].replace(/\/$/, ''));
  }
  return urls;
}

// ── Title filtering ───────────────────────────────────────────────────────

function matchesFilter(title, filter) {
  const lower = title.toLowerCase();
  const hasPositive = filter.positive.some(kw => lower.includes(kw.toLowerCase()));
  const hasNegative = filter.negative.some(kw => lower.includes(kw.toLowerCase()));
  return hasPositive && !hasNegative;
}

function hasSeniorityBoost(title, filter) {
  const lower = title.toLowerCase();
  return (filter.seniority_boost || []).some(kw => lower.includes(kw.toLowerCase()));
}

// ── Greenhouse API scanner ────────────────────────────────────────────────

async function scanGreenhouseApi(company) {
  const results = [];
  try {
    const resp = await fetch(company.api, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) return results;

    const data = await resp.json();
    const jobs = data.jobs || data || [];

    for (const job of jobs) {
      const title = job.title || '';
      const url = job.absolute_url || (job.url ? `https://job-boards.greenhouse.io${job.url}` : null);
      if (title && url) {
        results.push({
          title,
          url: url.split('?')[0], // strip tracking params
          company: company.name,
          source: `API: ${company.name}`,
        });
      }
    }
  } catch (err) {
    console.error(`  [API] ${company.name}: ${err.message.split('\n')[0]}`);
  }
  return results;
}

// ── Playwright page scanner ───────────────────────────────────────────────

async function scanWithPlaywright(browser, company) {
  const results = [];
  const page = await browser.newPage();

  try {
    await page.goto(company.careers_url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000); // let SPAs hydrate

    // Extract all links that look like job postings
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      const jobs = [];
      for (const a of anchors) {
        const href = a.href;
        const text = (a.innerText || '').trim();
        // Skip nav/footer links, keep links with meaningful text
        if (!text || text.length < 5 || text.length > 200) continue;
        if (/\.(css|js|png|jpg|svg)$/i.test(href)) continue;
        jobs.push({ title: text, url: href });
      }
      return jobs;
    });

    // Filter: keep links that look like job listings (heuristic)
    for (const link of links) {
      const url = link.url.split('?')[0].replace(/\/$/, '');
      // Common job URL patterns
      const isJobUrl = /\/(jobs?|positions?|openings?|careers?|roles?)\//i.test(url)
        || /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|pracuj\.pl\/praca/i.test(url)
        || /linkedin\.com\/jobs\/view/i.test(url);

      if (isJobUrl && link.title.length > 5) {
        results.push({
          title: link.title.replace(/\n/g, ' ').trim(),
          url,
          company: company.name,
          source: `Playwright: ${company.name}`,
        });
      }
    }
  } catch (err) {
    console.error(`  [Playwright] ${company.name}: ${err.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
  return results;
}

// ── Pracuj.pl scraper ─────────────────────────────────────────────────────

async function scanPracujPl(browser, keywords) {
  const results = [];
  const page = await browser.newPage();

  // Build search URL from positive keywords (top 5 most relevant)
  const searchTerms = keywords.slice(0, 5).join('%20OR%20');
  const searchUrl = `https://www.pracuj.pl/praca/${encodeURIComponent(keywords[0])};kw?rd=30&wp=remote%2Cwarszawa`;

  try {
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // Accept cookies if banner appears
    try {
      const cookieBtn = await page.$('[data-test="button-submitCookie"], #onetrust-accept-btn-handler');
      if (cookieBtn) await cookieBtn.click();
    } catch (_) { /* ignore */ }

    await page.waitForTimeout(1000);

    // Extract job listings
    const jobs = await page.evaluate(() => {
      const listings = [];
      // Pracuj.pl uses data-test attributes and structured offer tiles
      const offerLinks = document.querySelectorAll('a[href*="/praca/"]');
      for (const a of offerLinks) {
        const href = a.href;
        const text = (a.innerText || '').trim();
        if (href.includes(',oferta,') && text.length > 5 && text.length < 200) {
          listings.push({ title: text.split('\n')[0].trim(), url: href.split('?')[0] });
        }
      }
      return listings;
    });

    for (const job of jobs) {
      // Try to extract company from URL pattern: /praca/title,company,id.html
      const urlMatch = job.url.match(/\/praca\/[^,]+,([^,]+),/);
      const company = urlMatch ? urlMatch[1].replace(/-/g, ' ') : 'Unknown';

      results.push({
        title: job.title,
        url: job.url,
        company,
        source: 'Pracuj.pl',
      });
    }
  } catch (err) {
    console.error(`  [Pracuj.pl] ${err.message.split('\n')[0]}`);
  } finally {
    await page.close();
  }
  return results;
}

// ── Dedup & history ───────────────────────────────────────────────────────

async function appendScanHistory(entries) {
  const histPath = join(__dirname, 'data', 'scan-history.tsv');
  await mkdir(join(__dirname, 'data'), { recursive: true });

  if (!existsSync(histPath)) {
    await writeFile(histPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n');
  }

  const lines = entries.map(e =>
    `${e.url}\t${TODAY}\t${e.source}\t${e.title}\t${e.company}\t${e.status}`
  );
  if (lines.length) {
    await appendFile(histPath, lines.join('\n') + '\n');
  }
}

// ── Report generation ─────────────────────────────────────────────────────

function generateReport(matched, filtered, duped, errors) {
  const lines = [
    `# Career Scan Report -- ${TODAY}`,
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Offers found | ${matched.length + filtered.length + duped.length} |`,
    `| Matched title filter | ${matched.length + duped.length} |`,
    `| Duplicates (already seen) | ${duped.length} |`,
    `| **New relevant offers** | **${matched.length}** |`,
    `| Filtered out (title) | ${filtered.length} |`,
    `| Scan errors | ${errors.length} |`,
    '',
  ];

  if (matched.length > 0) {
    lines.push('## New Offers', '');
    lines.push('| Company | Role | Source | Link |');
    lines.push('|---------|------|--------|------|');
    for (const m of matched) {
      const senior = m.seniorityBoost ? ' *' : '';
      lines.push(`| ${m.company} | ${m.title}${senior} | ${m.source} | [Open](${m.url}) |`);
    }
    lines.push('', '\\* = seniority match', '');
  } else {
    lines.push('## No new offers found today.', '');
  }

  if (duped.length > 0) {
    lines.push(`<details><summary>Duplicates (${duped.length})</summary>`, '');
    for (const d of duped) lines.push(`- ${d.company} -- ${d.title}`);
    lines.push('', '</details>', '');
  }

  if (filtered.length > 0) {
    lines.push(`<details><summary>Filtered out (${filtered.length})</summary>`, '');
    for (const f of filtered) lines.push(`- ${f.company} -- ${f.title}`);
    lines.push('', '</details>', '');
  }

  if (errors.length > 0) {
    lines.push(`<details><summary>Errors (${errors.length})</summary>`, '');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('', '</details>', '');
  }

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`career-ops standalone scan -- ${TODAY}\n`);

  const config = await loadConfig();
  const seenUrls = await loadScanHistory();
  const pipelineUrls = await loadPipelineUrls();
  const allSeen = new Set([...seenUrls, ...pipelineUrls]);
  const filter = config.title_filter;

  const allCandidates = [];
  const errors = [];

  // ── Level 2: Greenhouse APIs (fast, no browser needed) ──
  const apiCompanies = (config.tracked_companies || []).filter(c => c.enabled && c.api);
  if (apiCompanies.length) {
    console.log(`[API] Scanning ${apiCompanies.length} Greenhouse APIs...`);
    const apiResults = await Promise.all(apiCompanies.map(c => scanGreenhouseApi(c)));
    for (const batch of apiResults) allCandidates.push(...batch);
    console.log(`[API] Found ${allCandidates.length} listings\n`);
  }

  // ── Level 1: Playwright scraping ──
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });

    // Scrape tracked companies with careers_url (no API)
    const playwrightCompanies = (config.tracked_companies || [])
      .filter(c => c.enabled && c.careers_url && !c.api);

    if (playwrightCompanies.length) {
      console.log(`[Playwright] Scanning ${playwrightCompanies.length} career pages...`);
      // Sequential -- avoid overwhelming targets
      for (const company of playwrightCompanies) {
        process.stdout.write(`  ${company.name}...`);
        const results = await scanWithPlaywright(browser, company);
        allCandidates.push(...results);
        console.log(` ${results.length} listings`);
      }
      console.log('');
    }

    // Pracuj.pl direct scrape with PR/comms keywords
    const prKeywords = (filter.positive || []).slice(0, 8);
    if (prKeywords.length) {
      console.log('[Pracuj.pl] Scanning with title keywords...');
      const pracujResults = await scanPracujPl(browser, prKeywords);
      allCandidates.push(...pracujResults);
      console.log(`[Pracuj.pl] Found ${pracujResults.length} listings\n`);
    }
  } catch (err) {
    errors.push(`Playwright: ${err.message.split('\n')[0]}`);
    console.error(`[Playwright] Failed: ${err.message.split('\n')[0]}\n`);
  } finally {
    if (browser) await browser.close();
  }

  // ── Dedup by URL ──
  const uniqueByUrl = new Map();
  for (const c of allCandidates) {
    const normUrl = c.url.replace(/\/$/, '').split('?')[0];
    if (!uniqueByUrl.has(normUrl)) uniqueByUrl.set(normUrl, { ...c, url: normUrl });
  }

  // ── Filter & classify ──
  const matched = [];
  const filtered = [];
  const duped = [];
  const historyEntries = [];

  for (const [url, candidate] of uniqueByUrl) {
    if (allSeen.has(url)) {
      duped.push(candidate);
      continue;
    }

    if (!matchesFilter(candidate.title, filter)) {
      filtered.push(candidate);
      historyEntries.push({ ...candidate, status: 'skipped_title' });
      continue;
    }

    candidate.seniorityBoost = hasSeniorityBoost(candidate.title, filter);
    matched.push(candidate);
    historyEntries.push({ ...candidate, status: 'added' });
  }

  // Sort: seniority boost first, then alphabetical
  matched.sort((a, b) => {
    if (a.seniorityBoost !== b.seniorityBoost) return b.seniorityBoost - a.seniorityBoost;
    return a.company.localeCompare(b.company);
  });

  // ── Write scan history ──
  await appendScanHistory(historyEntries);

  // ── Generate report ──
  const report = generateReport(matched, filtered, duped, errors);

  // ── Output ──
  if (outDir) {
    await mkdir(outDir, { recursive: true });
    const reportPath = join(outDir, `career-scan-${TODAY}.md`);
    await writeFile(reportPath, report, 'utf-8');
    console.log(`Report written to: ${reportPath}`);
  } else {
    console.log('\n' + report);
  }

  // ── Summary ──
  console.log(`\nDone: ${matched.length} new, ${duped.length} duped, ${filtered.length} filtered, ${errors.length} errors`);

  if (matched.length === 0) process.exit(0);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
