/**
 * Cheerio-based scraper for sites that return server-rendered HTML.
 * Per-site extraction functions keyed by domain pattern.
 */

import * as cheerio from 'cheerio';

// ── Per-site extractors ──────────────────────────────────────────────────

const extractors = {
  'eurobrussels.com': ($, company) => {
    const jobs = [];
    // EuroBrussels uses job listing blocks with title links
    $('a[href*="/job_display/"]').each((_, el) => {
      const $a = $(el);
      const title = $a.text().trim();
      const href = $a.attr('href');
      if (title && href && title.length > 5 && title.length < 200) {
        const url = href.startsWith('http') ? href : `https://www.eurobrussels.com${href}`;
        jobs.push({
          title,
          url: url.split('?')[0],
          company: company.name,
          source: `Cheerio: ${company.name}`,
        });
      }
    });
    return jobs;
  },

  'nofluffjobs.com': ($, company) => {
    const jobs = [];
    // NoFluffJobs renders job cards with links to /pl/job/ or /job/
    $('a[href*="/job/"]').each((_, el) => {
      const $a = $(el);
      const title = $a.text().trim().split('\n')[0].trim();
      const href = $a.attr('href');
      if (title && href && title.length > 5 && title.length < 200) {
        const url = href.startsWith('http') ? href : `https://nofluffjobs.com${href}`;
        jobs.push({
          title,
          url: url.split('?')[0],
          company: company.name,
          source: `Cheerio: ${company.name}`,
        });
      }
    });
    return jobs;
  },
};

// ── Generic fallback extractor ───────────────────────────────────────────

function genericExtract($, company) {
  const jobs = [];
  const jobUrlPatterns = /\/(jobs?|positions?|openings?|roles?|career|oferta|praca)\//i;
  const jobBoardDomains = /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com/i;

  // Skip common nav/footer text
  const skipTexts = new Set([
    'careers', 'jobs', 'home', 'about', 'contact', 'login', 'sign in',
    'read more', 'learn more', 'view all', 'see all', 'apply now',
    'back to top', 'privacy', 'cookie', 'terms', 'join talent network',
  ]);

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    const title = $a.text().trim().replace(/\s+/g, ' ');

    if (!title || title.length < 10 || title.length > 200) return;
    if (skipTexts.has(title.toLowerCase())) return;
    if (/\.(css|js|png|jpg|svg|pdf)$/i.test(href)) return;

    const isJobUrl = jobUrlPatterns.test(href) || jobBoardDomains.test(href);
    if (!isJobUrl) return;

    const url = href.startsWith('http') ? href : new URL(href, company.careers_url).href;
    jobs.push({
      title,
      url: url.split('?')[0],
      company: company.name,
      source: `Cheerio: ${company.name}`,
    });
  });

  return jobs;
}

// ── Main scan function ───────────────────────────────────────────────────

export async function scan(company) {
  try {
    const resp = await fetch(company.careers_url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      console.error(`  [Cheerio] ${company.name}: HTTP ${resp.status}`);
      return [];
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    // Find matching extractor by domain
    const domain = new URL(company.careers_url).hostname;
    for (const [pattern, extractor] of Object.entries(extractors)) {
      if (domain.includes(pattern)) {
        return extractor($, company);
      }
    }

    return genericExtract($, company);
  } catch (err) {
    console.error(`  [Cheerio] ${company.name}: ${err.message.split('\n')[0]}`);
    return [];
  }
}
