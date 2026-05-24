/**
 * Playwright SPA scanner — uses rebrowser-playwright via Crawlee
 * for sites that require JavaScript rendering.
 *
 * Per-site extraction functions handle different career page structures.
 * Falls back to improved generic link extraction.
 */

// Try rebrowser-playwright first (stealth), fall back to regular playwright
let chromium;
try {
  ({ chromium } = await import('rebrowser-playwright'));
} catch (_) {
  ({ chromium } = await import('playwright'));
}

// ── Per-site extractors ──────────────────────────────────────────────────

const siteExtractors = {
  // Pracuj.pl — extract structured offer cards with metadata
  'pracuj.pl': async (page, company) => {
    const jobs = [];

    await page.waitForTimeout(5000);

    // Try to dismiss cookie consent
    try {
      const cookieBtn = await page.$('[data-test="button-submitCookie"], #onetrust-accept-btn-handler, [id*="cookie"] button, .cookies-policy__button');
      if (cookieBtn) await cookieBtn.click();
      await page.waitForTimeout(1000);
    } catch (_) { /* ignore */ }

    // Extract from offer links + walk up to parent card for metadata
    const domJobs = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      const offerLinks = document.querySelectorAll('a[href*=",oferta,"]');

      for (const a of offerLinks) {
        const title = a.innerText.trim();
        if (!title || title.length < 5 || title.length > 200) continue;
        const href = a.href.split('?')[0];
        if (seen.has(href)) continue;
        seen.add(href);

        // Walk up DOM to find card with rich content (title + company + metadata)
        let cardText = '';
        let el = a.parentElement;
        for (let i = 0; i < 8 && el; i++) {
          const t = el.innerText.trim();
          if (t.length > title.length + 20 && t.length < 600) {
            cardText = t;
          }
          el = el.parentElement;
        }

        // Parse card text lines, strip noise
        const lines = cardText.split('\n').map(l => l.trim()).filter(l =>
          l && l !== 'reklama' && l !== 'Aplikuj szybko'
          && !l.startsWith('Opublikowana') && l !== 'Sprawdź profil firmy'
          && !l.startsWith('Praca od zaraz')
          && !/^\d[\d\s]*[–-][\d\s]*zł/.test(l)
        );

        // Company: first line after title that isn't metadata
        let detectedCompany = '';
        for (let i = 1; i < Math.min(lines.length, 4); i++) {
          const l = lines[i];
          if (l === title) continue;
          if (/Warszawa|Kraków|Wrocław|Poznań|Gdańsk|Katowice|Łódź|Cała Polska|Miejsce pracy|Siedziba/i.test(l)) continue;
          if (/Pełny etat|Umowa|Kontrakt|Praca zdalna|Praca stacjonarna|Praca hybrydowa/i.test(l)) continue;
          if (/Menedżer|mid \/ Regular|Specjalista \/ Specjalistka \(|Ekspert/i.test(l)) continue;
          detectedCompany = l;
          break;
        }
        let location = '';
        let workMode = '';
        let contract = '';

        const fullText = cardText;

        // Extract location
        const locMatch = fullText.match(/(?:Miejsce pracy:)?([^,\n]*(?:Warszawa|Kraków|Wrocław|Poznań|Gdańsk|Katowice|Łódź|Cała Polska)[^,\n]*(?:,[^,\n]{3,20})?)/i);
        if (locMatch) location = locMatch[1].trim().replace('Miejsce pracy:', '').trim();
        // Fallback: line 2 if it looks like a location
        if (!location && lines[2] && /Warszawa|Kraków|Wrocław|Poznań|Gdańsk|Katowice|Łódź|Cała Polska|Siedziba/i.test(lines[2])) {
          location = lines[2].replace('Siedziba firmy:', '').trim();
        }

        // Extract work mode (deduplicate case-insensitive)
        const modes = fullText.match(/(Praca zdalna|Praca hybrydowa|Praca stacjonarna)/gi);
        if (modes) {
          const seen = new Set();
          workMode = modes.filter(m => { const k = m.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(', ');
        }

        // Extract contract type
        const contracts = fullText.match(/(Umowa o pracę|Kontrakt B2B|Umowa zlecenie|Pełny etat|Część etatu)/gi);
        if (contracts) contract = [...new Set(contracts)].join(', ');

        results.push({
          title,
          url: href,
          detectedCompany,
          location,
          workMode,
          contract,
        });
      }
      return results;
    });

    for (const job of domJobs) {
      jobs.push({
        title: job.title,
        url: job.url,
        company: job.detectedCompany || company.name,
        location: job.location,
        workMode: job.workMode,
        contract: job.contract,
        source: `Playwright: ${company.name}`,
      });
    }

    return jobs;
  },

  // Google Careers — SPA with job cards
  'google.com': async (page, company) => {
    const jobs = [];
    await page.waitForTimeout(4000);

    // Google Careers renders job cards with role titles
    const domJobs = await page.evaluate(() => {
      const results = [];
      // Try JSON-LD structured data first
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of scripts) {
        try {
          const data = JSON.parse(script.textContent);
          const postings = Array.isArray(data) ? data : (data['@graph'] || [data]);
          for (const item of postings) {
            if (item['@type'] === 'JobPosting' && item.title && item.url) {
              results.push({ title: item.title, url: item.url });
            }
          }
        } catch (_) { /* ignore */ }
      }
      if (results.length > 0) return results;

      // Fallback: parse job card elements
      const cards = document.querySelectorAll('[class*="job-card"], [class*="lc-card"], li[data-id]');
      for (const card of cards) {
        const titleEl = card.querySelector('h3, h2, [class*="title"]');
        const linkEl = card.querySelector('a[href*="jobs"]');
        if (titleEl && linkEl) {
          results.push({
            title: titleEl.textContent.trim(),
            url: linkEl.href,
          });
        }
      }
      return results;
    });

    for (const job of domJobs) {
      jobs.push({
        title: job.title,
        url: job.url.split('?')[0],
        company: company.name,
        source: `Playwright: ${company.name}`,
      });
    }
    return jobs;
  },

  // NoFluffJobs — clean extraction of job cards
  'nofluffjobs.com': async (page, company) => {
    const jobs = [];
    await page.waitForTimeout(4000);

    // Try to dismiss cookie consent
    try {
      const cookieBtn = await page.$('#onetrust-accept-btn-handler, [data-cy="accept-cookies"]');
      if (cookieBtn) await cookieBtn.click();
      await page.waitForTimeout(1000);
    } catch (_) { /* ignore */ }

    const domJobs = await page.evaluate(() => {
      const results = [];
      // NoFluffJobs job postings are a[href*="/job/"] but we need to extract
      // just the job title, not the surrounding UI text
      const postings = document.querySelectorAll('a[href*="/job/"]');
      for (const a of postings) {
        const href = a.href;
        if (!href || !href.includes('/job/')) continue;

        // The first heading inside the card is the job title
        const titleEl = a.querySelector('h3, h2, [class*="title"], [class*="posting-title"]');
        let title = '';
        if (titleEl) {
          title = titleEl.textContent.trim();
        } else {
          // Fallback: take text but strip known UI patterns
          title = (a.textContent || '').trim().split('\n')[0].trim();
        }

        // Clean up common NoFluffJobs UI artifacts
        title = title
          .replace(/\s*(NOWA|NEW)\s*/g, '')
          .replace(/\s*Zapisz ofertę\s*/g, '')
          .replace(/\s*Sprawdź wynagrodzenie\s*/g, '')
          .replace(/\s*\d[\d\s]*–[\d\s]*PLN\s*/g, '')
          .replace(/\s*\d[\d\s]*-[\d\s]*PLN\s*/g, '')
          .replace(/\s*(Zdalnie|Remote|Hybrid)(\s*\+\d+)?$/i, '')
          .trim();

        // Try to extract company from the card
        const companyEl = a.querySelector('[class*="company"], [class*="employer"]');
        const detectedCompany = companyEl ? companyEl.textContent.trim() : '';

        if (title && title.length > 5 && title.length < 200) {
          results.push({ title, url: href.split('?')[0], detectedCompany });
        }
      }
      return results;
    });

    for (const job of domJobs) {
      jobs.push({
        title: job.title,
        url: job.url,
        company: job.detectedCompany || company.name,
        source: `Playwright: ${company.name}`,
      });
    }
    return jobs;
  },

  // Proto.pl (Polish PR industry portal)
  'proto.pl': async (page, company) => {
    const jobs = [];
    await page.waitForTimeout(3000);

    const domJobs = await page.evaluate(() => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/praca/"], a[href*="oferta"], .job-listing a, .offer a');
      for (const a of links) {
        const title = (a.textContent || '').trim().split('\n')[0].trim();
        if (title && title.length > 5 && title.length < 200) {
          results.push({ title, url: a.href });
        }
      }
      return results;
    });

    for (const job of domJobs) {
      jobs.push({
        title: job.title,
        url: job.url.split('?')[0],
        company: company.name,
        source: `Playwright: ${company.name}`,
      });
    }
    return jobs;
  },
};

// ── Generic SPA extractor (improved) ─────────────────────────────────────

async function genericExtract(page, company) {
  const jobs = [];
  await page.waitForTimeout(3000);

  const domJobs = await page.evaluate(() => {
    const results = [];
    const anchors = document.querySelectorAll('a[href]');

    // Common nav/footer text to skip
    const skipTexts = /^(careers?|jobs?|home|about|contact|login|sign ?in|read more|learn more|view all|see all|apply now?|back|privacy|cookie|terms|join|talent|search|menu|close|open|filter|sort|share|save|eeo|equal|disability|accommodation)/i;
    const skipIcons = /^[\s\u200B\uFEFF]*$/; // empty or whitespace-only

    // Job URL patterns
    const jobPatterns = /\/(jobs?|positions?|openings?|roles?|career|vacancy|vacancies|oferta|praca|stellenangebot)\//i;
    const jobBoardDomains = /greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|smartrecruiters\.com|myworkday|taleo/i;

    for (const a of anchors) {
      const href = a.href || '';
      const text = (a.innerText || '').trim().replace(/\s+/g, ' ');

      // Filter: meaningful title
      if (!text || text.length < 10 || text.length > 200) continue;
      if (skipTexts.test(text)) continue;
      if (skipIcons.test(text)) continue;

      // Filter: looks like a job URL
      if (/\.(css|js|png|jpg|svg|pdf|ico)$/i.test(href)) continue;
      const isJobUrl = jobPatterns.test(href) || jobBoardDomains.test(href);
      if (!isJobUrl) continue;

      // Filter: not a generic page link (must have specific path depth)
      const path = new URL(href).pathname;
      if (path.split('/').filter(Boolean).length < 2) continue;

      results.push({ title: text.split('\n')[0].trim(), url: href });
    }
    return results;
  });

  for (const job of domJobs) {
    jobs.push({
      title: job.title,
      url: job.url.split('?')[0],
      company: company.name,
      source: `Playwright: ${company.name}`,
    });
  }
  return jobs;
}

// ── Main scan function ───────────────────────────────────────────────────

let sharedBrowser = null;

export async function initBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return sharedBrowser;
}

export async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

export async function scan(company) {
  const browser = await initBrowser();
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'pl-PL',
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  try {
    await page.goto(company.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Find matching extractor by domain
    const domain = new URL(company.careers_url).hostname;
    for (const [pattern, extractor] of Object.entries(siteExtractors)) {
      if (domain.includes(pattern)) {
        return await extractor(page, company);
      }
    }

    return await genericExtract(page, company);
  } catch (err) {
    console.error(`  [Playwright] ${company.name}: ${err.message.split('\n')[0]}`);
    return [];
  } finally {
    await context.close();
  }
}
