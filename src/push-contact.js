// How one vault contact lands in the target sub-account. Kept free of db/network imports so it
// can be tested with a fake `api(method, path, body)`.
//
// Rules (several vault records can be the same person, and GHL merges them by email/phone):
// - Fields: the record is sent with only its non-empty values, and the copy goes oldest record
//   first, so the newest record's value is the one left standing.
// - Tags are never sent with the contact (PUT and upsert both REPLACE the tag list). They are
//   added afterwards through the add-tags endpoint, so every record's tags end up combined.
// - GHL rejects malformed emails/phones with a 422. The contact is then saved without that value
//   instead of being skipped.

export const isBadValue = (err, field) => /\b422\b/.test(err?.message || '') && new RegExp(field, 'i').test(err.message);

// -> { id, kind: 'created' | 'merged' | 'updated', dropped: ['email'?, 'phone'?] }
export async function saveContact(api, { body, tags = [], existing }) {
  const b = { ...body }; delete b.tags;
  const dropped = [];
  const attempt = async (fn) => {
    for (;;) {
      try { return await fn(); }
      catch (err) {
        const field = ['email', 'phone'].find((f) => b[f] && isBadValue(err, f));
        if (!field) throw err;
        delete b[field]; dropped.push(field);
        if (!b.email && !b.phone && !b.firstName && !b.lastName && !b.companyName) b.firstName = body.email || body.phone || 'Unknown';
      }
    }
  };

  let id = null, kind;
  if (existing) {
    try { await attempt(() => api('PUT', `/contacts/${existing}`, { ...b, locationId: undefined })); id = existing; kind = 'updated'; }
    catch (err) { if (!/\b404\b/.test(err.message)) throw err; }     // deleted in target since: recreate below
  }
  if (!id) {
    // Upsert matches on email/phone and refuses a contact with neither; those are created instead.
    const data = await attempt(() => (b.email || b.phone ? api('POST', '/contacts/upsert', b) : api('POST', '/contacts/', b)));
    id = data?.contact?.id || data?.id;
    if (!id) throw new Error('GHL returned no contact id');
    kind = data.new === false ? 'merged' : 'created';
  }
  if (tags.length) await api('POST', `/contacts/${id}/tags`, { tags });
  return { id, kind, dropped };
}
