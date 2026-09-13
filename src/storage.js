import { S3Client, GetObjectCommand, ListObjectsV2Command, CopyObjectCommand, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable, Transform } from 'node:stream';
import { q } from './db.js';
import { getToken } from './ghl.js';

export const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const BUCKET = process.env.R2_BUCKET;

// Always drain/cancel a response we won't read, otherwise the socket stays open (ephemeral-port exhaustion).
export const discard = r => r?.body?.cancel().catch(() => {}) ?? Promise.resolve();

const safe = s => String(s || '').replace(/[^\w.\-()+ ]+/g, '_').slice(0, 150);

function filenameFrom(url, headers, fallback) {
  const cd = headers?.get?.('content-disposition') || '';
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) return safe(decodeURIComponent(m[1]));
  if (fallback) return safe(fallback);
  try { return safe(decodeURIComponent(new URL(url).pathname.split('/').pop())) || 'file'; } catch { return 'file'; }
}

/**
 * Register a discovered file in the manifest (idempotent on location+url) and download it
 * straight away, since some GHL URLs are short-lived signed links.
 * `meta` = { source, contactId, opportunityId, conversationId, messageId, submissionId, documentId,
 *            fieldId, fieldName, originalFilename, mimeType, size, authenticated }
 * `authenticated` = true when the URL is a GHL API endpoint needing the Bearer token (recordings).
 */
export async function ingest(jobId, locationId, url, meta = {}) {
  const { rows: [existing] } = await q(
    `INSERT INTO files (location_id, job_id, source, contact_id, opportunity_id, conversation_id, message_id,
        submission_id, document_id, field_id, field_name, original_filename, mime_type, size_bytes, source_url, cdn_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (location_id, source_url) DO UPDATE SET job_id = EXCLUDED.job_id, cdn_url = COALESCE(files.cdn_url, EXCLUDED.cdn_url)
     RETURNING *`,
    [locationId, jobId, meta.source, meta.contactId, meta.opportunityId, meta.conversationId, meta.messageId,
     meta.submissionId, meta.documentId, meta.fieldId, meta.fieldName, meta.originalFilename, meta.mimeType, meta.size, url, meta.altUrl || null]);

  if (existing.status === 'done') return existing; // already in R2 from a previous run

  try {
    // Candidate URLs in order: public CDN link (if any), then the API link with the bearer token.
    const isApi = u => /^https:\/\/services\.leadconnectorhq\.com\//.test(u);
    const candidates = [];
    if (meta.altUrl) candidates.push({ u: meta.altUrl, auth: false });
    candidates.push({ u: url, auth: meta.authenticated || isApi(url) });

    let res, lastErr;
    outer: for (const c of candidates) {
      const headers = c.auth ? { Authorization: `Bearer ${await getToken(locationId)}`, Version: process.env.GHL_API_VERSION || '2021-07-28' } : {};
      // Connection-level errors (reset, DNS, timeout) get 3 attempts with backoff; HTTP errors fall through to the next candidate.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(c.u, { headers, redirect: 'follow', signal: AbortSignal.timeout(5 * 60_000) });
          if (r.ok && r.body) { res = r; break outer; }
          await discard(r);
          lastErr = new Error(`HTTP ${r.status} from ${new URL(c.u).host}`);
          if (r.status < 500 && r.status !== 429) break;          // 4xx: don't retry this candidate
        } catch (e) { lastErr = new Error(`${e.cause?.code || e.name || 'fetch failed'}: ${e.message}`); }
        await new Promise(r => setTimeout(r, 1500 * 2 ** attempt));
      }
    }
    if (!res) {
      // Recording endpoint answers 422 when the call has no recording: that's "nothing to fetch", not a failure.
      if (meta.source === 'recording' && /HTTP 422/.test(lastErr?.message || '')) {
        await q(`UPDATE files SET status='skipped', error='no recording' WHERE id=$1`, [existing.id]);
        return { ...existing, status: 'skipped' };
      }
      throw lastErr || new Error('no download candidates');
    }

    let bytes = 0;
    const counter = new Transform({ transform(chunk, _enc, cb) { bytes += chunk.length; cb(null, chunk); } });

    const filename = filenameFrom(url, res.headers, meta.originalFilename);
    const owner = meta.contactId || meta.conversationId || meta.submissionId || meta.documentId || 'unowned';
    const sub = meta.fieldName ? safe(meta.fieldName) : (meta.messageId || meta.opportunityId || '');
    const key = [locationId, meta.source, safe(owner), sub, `${existing.id}_${filename}`].filter(Boolean).join('/');

    const upload = new Upload({
      client: r2,
      params: {
        Bucket: BUCKET, Key: key,
        Body: Readable.fromWeb(res.body).pipe(counter),
        ContentType: res.headers.get('content-type') || meta.mimeType || 'application/octet-stream',
        Metadata: { sourceUrl: url.slice(0, 1000), locationId, source: meta.source || '' },
      },
    });
    const result = await upload.done();
    const size = bytes || Number(res.headers.get('content-length')) || meta.size || null;

    const lm = res.headers.get('last-modified'); const uploadedAt = lm && !isNaN(Date.parse(lm)) ? new Date(lm) : null;
    await q(`UPDATE files SET status='done', r2_key=$2, original_filename=COALESCE(original_filename,$3),
             mime_type=COALESCE(mime_type,$4), size_bytes=COALESCE($5, size_bytes), uploaded_at=COALESCE($6, uploaded_at), downloaded_at=now(), error=NULL WHERE id=$1`,
      [existing.id, key, filename, res.headers.get('content-type'), size, uploadedAt]);
    return { ...existing, status: 'done', r2_key: key, etag: result.ETag };
  } catch (err) {
    await q(`UPDATE files SET status='failed', error=$2 WHERE id=$1`, [existing.id, String(err.message).slice(0, 500)]);
    return { ...existing, status: 'failed', error: err.message };
  }
}

// Small concurrency helper so crawlers can fire off several downloads at once.
export function limiter(n = Number(process.env.DOWNLOAD_CONCURRENCY || 16)) {
  let active = 0; const queue = [];
  const next = () => { if (active < n && queue.length) { active++; const { fn, res, rej } = queue.shift(); fn().then(res, rej).finally(() => { active--; next(); }); } };
  return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
}

export async function* listObjects(prefix) {
  let ContinuationToken;
  do {
    const page = await r2.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken }));
    for (const o of page.Contents || []) yield o;
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
}

export async function getObjectStream(key) {
  const res = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return res.Body;
}

export async function copyObject(fromKey, toKey) {
  await r2.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `/${BUCKET}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`, Key: toKey }));
}
export async function putText(key, body, contentType = 'text/csv') {
  await r2.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }));
}

export async function deletePrefix(prefix) {
  let batch = [], n = 0;
  const flush = async () => { if (!batch.length) return; await r2.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: batch } })); n += batch.length; batch = []; };
  for await (const o of listObjects(prefix)) { batch.push({ Key: o.Key }); if (batch.length === 1000) await flush(); }
  await flush();
  return n;
}

export function presign(key, filename, expiresIn = 24 * 3600) {
  return getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${filename}"` }), { expiresIn });
}
// Upload an arbitrary readable stream (e.g. an archiver zip) to R2 via multipart. Returns bytes written.
export async function uploadStream(key, stream, contentType = 'application/zip') {
  let bytes = 0;
  const counter = new Transform({ transform(c, _e, cb) { bytes += c.length; cb(null, c); } });
  const up = new Upload({ client: r2, params: { Bucket: BUCKET, Key: key, Body: stream.pipe(counter), ContentType: contentType }, partSize: 64 * 1024 * 1024, queueSize: 2 });
  await up.done();
  return bytes;
}
