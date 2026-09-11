// Form + survey submissions: catches uploads that never landed on a contact field.
import { ghl, harvestUrls } from '../ghl.js';
import { ingest, limiter } from '../storage.js';

function make(kind, path) {
  return async function crawl(ctx) {
    const { jobId, locationId, progress, save } = ctx;
    const run = limiter();
    progress.submissions ??= 0; progress.filesFound ??= 0;
    let page = progress.page || 1;

    while (true) {
      const data = await ghl(locationId, 'GET', path, { query: { locationId, limit: 100, page } });
      const subs = data.submissions || [];
      if (!subs.length) break;
      const tasks = [];
      for (const s of subs) {
        const payload = s.others ?? s.data ?? s;
        for (const url of new Set(harvestUrls(payload))) {
          if (/\/(forms|surveys)\//.test(url) && /\/embed|\/preview/.test(url)) continue; // form links, not uploads
          progress.filesFound++;
          tasks.push(run(() => ingest(jobId, locationId, url, {
            source: kind, submissionId: s.id, contactId: s.contactId, fieldName: s.formId || s.surveyId,
          })));
        }
      }
      await Promise.all(tasks);
      progress.submissions += subs.length;
      page++; progress.page = page;
      await save();
      if (!data.meta?.nextPage) break;
    }
  };
}

export const forms = make('form', '/forms/submissions');
export const surveys = make('survey', '/surveys/submissions');
