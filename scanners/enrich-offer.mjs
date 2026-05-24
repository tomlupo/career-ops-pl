/**
 * Offer enrichment — visits individual job pages to extract full JD details.
 * Returns structured sections: responsibilities, requirements, niceToHave, benefits, salary.
 */

// Section patterns for Polish and English JDs
const SECTION_PATTERNS = [
  ['responsibilities', /(Zakres obowiązków|Twoje zadania|Obowiązki|Responsibilities|Your tasks|What you.ll do|Do Twoich zadań będzie należeć|Czym będziesz się zajmować)[:\s]*/i],
  ['requirements', /(Nasze wymagania|Wymagania|Requirements|Oczekujemy|What we expect|Your profile|Czego oczekujemy|Profil kandydata)[:\s]*/i],
  ['niceToHave', /(Mile widziane|Nice to have|Dodatkowe atuty|Będzie dodatkowym atutem|Dodatkowo)[:\s]*/i],
  ['benefits', /(Oferujemy|Co oferujemy|Benefits|What we offer|Benefity|To oferujemy)[:\s]*/i],
  ['salary', /(Wynagrodzenie|Salary|Stawka)[:\s]*/i],
];

// Content-based rejection patterns — roles that slip through title filter
// but are clearly wrong based on JD content
const REJECT_PATTERNS = [
  /social media|media społecznościowe/i,  // Social media roles disguised as comms
  /SEO|SEM|Google Ads|Meta Ads/i,
  /e-commerce|sklep internetowy/i,
  /grafik|graphic design/i,
];

// Strong fit signals for Sara's profile
const FIT_SIGNALS = [
  { pattern: /crisis|kryzys/i, label: 'crisis comms' },
  { pattern: /media relations|relacje z mediami|kontakt z mediami/i, label: 'media relations' },
  { pattern: /press release|komunikat prasowy|informacja prasowa/i, label: 'press releases' },
  { pattern: /strategic|strategia komunikacji|communication strategy/i, label: 'strategy' },
  { pattern: /stakeholder|interesariusz/i, label: 'stakeholder mgmt' },
  { pattern: /international|międzynarodow/i, label: 'international' },
  { pattern: /government|rząd|instytucj/i, label: 'gov/institutional' },
  { pattern: /financial|finansow|capital market|rynek kapitałowy|giełd/i, label: 'financial comms' },
  { pattern: /public affairs|rzecznictwo|advocacy/i, label: 'public affairs' },
  { pattern: /English|angielski/i, label: 'English required' },
  { pattern: /Italian|włosk/i, label: 'Italian (advantage!)' },
];

export async function enrichOffer(page, offer) {
  try {
    // Random delay 2-5s to avoid Cloudflare rate limiting
    await page.waitForTimeout(2000 + Math.random() * 3000);

    await page.goto(offer.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(4000);

    // Check for Cloudflare block
    const isBlocked = await page.evaluate(() =>
      document.body.innerText.includes('weryfikacji zabezpieczeń') ||
      document.body.innerText.includes('security check') ||
      document.body.innerText.includes('Cloudflare')
    );
    if (isBlocked) {
      // Wait longer and retry once
      await page.waitForTimeout(8000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(5000);
    }

    // Dismiss cookie consent if present
    try {
      const cookieBtn = await page.$('[data-test="button-submitCookie"], #onetrust-accept-btn-handler');
      if (cookieBtn) await cookieBtn.click();
      await page.waitForTimeout(500);
    } catch (_) { /* ignore */ }

    const result = await page.evaluate((patterns) => {
      const text = document.body.innerText;
      const sections = {};

      for (const [key, patternStr] of patterns) {
        const pattern = new RegExp(patternStr);
        const match = text.match(pattern);
        if (match) {
          const start = match.index + match[0].length;
          // Extract until next section or 1000 chars
          const chunk = text.substring(start, start + 1000).trim();
          // Take lines until we hit another section header or empty gap
          const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean);
          const sectionLines = [];
          for (const line of lines) {
            // Stop at next section header
            if (sectionLines.length > 0 && /^(Zakres|Nasze|Wymagania|Oferujemy|Mile|Benefits|Requirements|Responsibilities|What we|About|O firmie)/i.test(line)) break;
            if (sectionLines.length >= 12) break;
            sectionLines.push(line);
          }
          sections[key] = sectionLines.join('\n');
        }
      }

      return { sections, fullTextLength: text.length };
    }, SECTION_PATTERNS.map(([key, re]) => [key, re.source]));

    // Analyze fit
    const fullText = Object.values(result.sections).join('\n');
    const fitSignals = [];
    const rejectSignals = [];

    for (const { pattern, label } of FIT_SIGNALS) {
      if (pattern.test(fullText)) fitSignals.push(label);
    }

    for (const pattern of REJECT_PATTERNS) {
      if (pattern.test(fullText) && !fitSignals.length) {
        rejectSignals.push(pattern.source);
      }
    }

    return {
      ...offer,
      jd: result.sections,
      fitSignals,
      rejected: rejectSignals.length > 0 && fitSignals.length === 0,
      rejectReason: rejectSignals.length ? 'Content mismatch' : null,
    };
  } catch (err) {
    return {
      ...offer,
      jd: {},
      fitSignals: [],
      rejected: false,
      enrichError: err.message?.split('\n')[0],
    };
  }
}
