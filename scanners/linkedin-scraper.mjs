/**
 * LinkedIn job scraper — uses linkedin-jobs-scraper in anonymous mode.
 * No login required; scrapes public job listing pages.
 */

import {
  LinkedinScraper,
  relevanceFilter,
  timeFilter,
  experienceLevelFilter,
  onSiteOrRemoteFilter,
} from 'linkedin-jobs-scraper';

export async function scan({ keywords, location, limit = 25, enabled = true }) {
  if (!enabled) {
    console.log('  [LinkedIn] Disabled (anonymous mode blocked by LinkedIn). Skipping.');
    return [];
  }
  const jobs = [];

  const scraper = new LinkedinScraper({
    headless: true,
    slowMo: 200,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  scraper.on('data', (data) => {
    if (data.title && data.link) {
      jobs.push({
        title: data.title.trim(),
        url: data.link.split('?')[0],
        company: data.company || 'Unknown',
        location: data.place || location,
        source: 'LinkedIn',
      });
    }
  });

  scraper.on('error', (err) => {
    console.error(`  [LinkedIn] Error: ${err.message?.split('\n')[0] || err}`);
  });

  try {
    const queries = keywords.map(kw => ({
      query: kw,
      options: {
        locations: [location],
        limit,
        filters: {
          relevance: relevanceFilter.RELEVANT,
          time: timeFilter.WEEK,
          experience: [experienceLevelFilter.MID_SENIOR, experienceLevelFilter.DIRECTOR],
          onSiteOrRemote: [onSiteOrRemoteFilter.ON_SITE, onSiteOrRemoteFilter.REMOTE, onSiteOrRemoteFilter.HYBRID],
        },
      },
    }));

    await scraper.run(queries);
  } catch (err) {
    console.error(`  [LinkedIn] ${err.message?.split('\n')[0] || err}`);
  } finally {
    await scraper.close();
  }

  return jobs;
}
