#!/usr/bin/env node

/**
 * standalone-scan.mjs — Career portal scanner for career-ops
 *
 * Reads portals.yml, routes each portal to the appropriate handler
 * (API, cheerio, playwright, linkedin), filters by title, deduplicates,
 * and writes a markdown report.
 *
 * Usage:
 *   node standalone-scan.mjs                          # report to stdout
 *   node standalone-scan.mjs --out /path/to/vault     # report to Obsidian vault
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
  for (const line of raw.split('\n').slice(1)) {
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

function kwToRegex(kw) {
  // If keyword contains regex metacharacters like \b, use as regex
  // Otherwise treat as case-insensitive literal
  if (kw.includes('\\b') || kw.includes('\\.') || kw.includes('\\s')) {
    return new RegExp(kw, 'i');
  }
  // Escape special regex chars, then do case-insensitive includes
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
}

function matchesFilter(title, filter) {
  const hasPositive = filter.positive.some(kw => kwToRegex(kw).test(title));
  const hasNegative = filter.negative.some(kw => kwToRegex(kw).test(title));
  return hasPositive && !hasNegative;
}

function hasSeniorityBoost(title, filter) {
  return (filter.seniority_boost || []).some(kw => kwToRegex(kw).test(title));
}

// ── Scan method routing ──────────────────────────────────────────────────

function resolveScanMethod(company) {
  // Explicit scan_method in config takes priority
  if (company.scan_method === 'api' || company.api) return 'api';
  if (company.scan_method === 'cheerio') return 'cheerio';
  if (company.scan_method === 'linkedin') return 'linkedin';
  if (company.scan_method === 'playwright') return 'playwright';
  // Default: websearch entries use playwright
  if (company.scan_method === 'websearch') return 'playwright';
  // Fallback: if it has a careers_url, use playwright
  if (company.careers_url) return 'playwright';
  return 'skip';
}

// ── Dedup & history ───────────────────────────────────────────────────────

async function appendScanHistory(entries) {
  const histPath = join(__dirname, 'data', 'scan-history.tsv');
  await mkdir(join(__dirname, 'data'), { recursive: true });

  if (!existsSync(histPath)) {
    await writeFile(histPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\twork_mode\tcontract\tstatus\n');
  }

  const lines = entries.map(e =>
    `${e.url}\t${TODAY}\t${e.source}\t${e.title}\t${e.company}\t${e.location || ''}\t${e.workMode || ''}\t${e.contract || ''}\t${e.status}`
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
    lines.push('| Company | Role | Location | Mode | Contract | Link |');
    lines.push('|---------|------|----------|------|----------|------|');
    for (const m of matched) {
      const senior = m.seniorityBoost ? ' *' : '';
      const loc = m.location || '—';
      const mode = m.workMode || '—';
      const contract = m.contract || '—';
      lines.push(`| ${m.company} | ${m.title}${senior} | ${loc} | ${mode} | ${contract} | [Open](${m.url}) |`);
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

  const companies = (config.tracked_companies || []).filter(c => c.enabled);

  // Group by scan method
  const apiCompanies = [];
  const cheerioCompanies = [];
  const playwrightCompanies = [];
  let hasLinkedin = false;

  for (const c of companies) {
    const method = resolveScanMethod(c);
    if (method === 'api') apiCompanies.push(c);
    else if (method === 'cheerio') cheerioCompanies.push(c);
    else if (method === 'playwright') playwrightCompanies.push(c);
    else if (method === 'linkedin') { hasLinkedin = true; }
  }

  // ── Phase 1: API scanners (fast, no browser) ──
  if (apiCompanies.length) {
    console.log(`[API] Scanning ${apiCompanies.length} Greenhouse APIs...`);
    const { scan } = await import('./scanners/greenhouse-api.mjs');
    const results = await Promise.all(apiCompanies.map(c => scan(c)));
    for (const batch of results) allCandidates.push(...batch);
    console.log(`[API] Found ${allCandidates.length} listings\n`);
  }

  // ── Phase 2: Cheerio scanners (fast, no browser) ──
  if (cheerioCompanies.length) {
    console.log(`[Cheerio] Scanning ${cheerioCompanies.length} static pages...`);
    const { scan } = await import('./scanners/cheerio-scraper.mjs');
    const results = await Promise.all(cheerioCompanies.map(c => scan(c)));
    let count = 0;
    for (const batch of results) { allCandidates.push(...batch); count += batch.length; }
    console.log(`[Cheerio] Found ${count} listings\n`);
  }

  // ── Phase 3: Playwright SPA scanners ──
  if (playwrightCompanies.length) {
    console.log(`[Playwright] Scanning ${playwrightCompanies.length} career pages...`);
    const pw = await import('./scanners/playwright-spa.mjs');

    try {
      await pw.initBrowser();

      // Sequential to avoid overwhelming VPS
      for (const company of playwrightCompanies) {
        process.stdout.write(`  ${company.name}...`);
        try {
          const results = await pw.scan(company);
          allCandidates.push(...results);
          console.log(` ${results.length} listings`);
        } catch (err) {
          const msg = `${company.name}: ${err.message?.split('\n')[0] || err}`;
          errors.push(msg);
          console.log(` ERROR`);
        }
      }
    } finally {
      await pw.closeBrowser();
    }
    console.log('');
  }

  // ── Phase 4: LinkedIn ──
  // Disabled by default: anonymous scraping returns 999 as of 2026-04.
  // Set linkedin_enabled: true in portals.yml to force-enable.
  if (config.linkedin_enabled === true) {
    console.log('[LinkedIn] Scanning public job listings...');
    try {
      const { scan } = await import('./scanners/linkedin-scraper.mjs');
      const keywords = (filter.positive || [])
        .filter(kw => kw.length > 3) // skip short keywords like "PR"
        .slice(0, 5);

      if (keywords.length) {
        const results = await scan({
          keywords,
          location: 'Poland',
          limit: 20,
        });
        allCandidates.push(...results);
        console.log(`[LinkedIn] Found ${results.length} listings\n`);
      }
    } catch (err) {
      const msg = `LinkedIn: ${err.message?.split('\n')[0] || err}`;
      errors.push(msg);
      console.error(`[LinkedIn] ${msg}\n`);
    }
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

  // ── Phase 5: Content-based filtering using title + metadata ──
  // Pracuj.pl individual pages are Cloudflare-protected, so we filter
  // using the card metadata we already have (title, company, location, mode)
  const contentRejectPatterns = [
    /komunikacj[ię] satelitarn/i,     // satellite communications, not PR
    /komunikacj[ię] CRM/i,            // CRM comms, not PR
    /komunikacj[ię] sprzedaży/i,      // sales comms
    /komunikacj[ię] katalog/i,        // catalog comms
    /Analityk Kredytowy/i,             // credit analyst
    /Bankowości Elektronicznej/i,      // e-banking
    /dokumentacji IT/i,                // IT documentation
    /administracji i komunikacji/i,    // admin + comms combo
    /biura i wsparcia/i,              // office support
  ];

  for (let i = matched.length - 1; i >= 0; i--) {
    const offer = matched[i];
    const isContentReject = contentRejectPatterns.some(p => p.test(offer.title));
    if (isContentReject) {
      const rej = matched.splice(i, 1)[0];
      filtered.push(rej);
      const histEntry = historyEntries.find(h => h.url === rej.url);
      if (histEntry) histEntry.status = 'skipped_content';
    }
  }

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
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
