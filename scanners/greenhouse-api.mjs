/**
 * Greenhouse API scanner — fetches job listings from Greenhouse boards API.
 * Returns normalized { title, url, company, source } objects.
 */

export async function scan(company) {
  const results = [];
  try {
    const resp = await fetch(company.api, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'career-ops-scanner/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.error(`  [API] ${company.name}: HTTP ${resp.status}`);
      return results;
    }

    const data = await resp.json();
    const jobs = data.jobs || data || [];

    for (const job of jobs) {
      const title = job.title || '';
      const location = job.location?.name || '';
      const url = job.absolute_url
        || (job.url ? `https://job-boards.greenhouse.io${job.url}` : null);

      if (title && url) {
        results.push({
          title: title.trim(),
          url: url.split('?')[0],
          company: company.name,
          location,
          source: `API: ${company.name}`,
        });
      }
    }
  } catch (err) {
    console.error(`  [API] ${company.name}: ${err.message.split('\n')[0]}`);
  }
  return results;
}
