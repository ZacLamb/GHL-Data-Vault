// Copying a contact: tags are added (never replaced), bad emails are dropped instead of failing.
const test = require('node:test');
const assert = require('node:assert');
const load = () => import('../src/push-contact.js');

const fakeApi = (handlers) => {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body: body && JSON.parse(JSON.stringify(body)) });
    const h = handlers[`${method} ${path}`];
    return typeof h === 'function' ? h(body) : h;
  };
  return { api, calls };
};

test('upsert merge: tags go through add-tags, not the contact body', async () => {
  const { saveContact } = await load();
  const { api, calls } = fakeApi({ 'POST /contacts/upsert': { new: false, contact: { id: 'T1' } }, 'POST /contacts/T1/tags': {} });
  const r = await saveContact(api, { body: { email: 'a@x.com', firstName: 'A', tags: ['x'] }, tags: ['lead', 'xf'] });
  assert.deepStrictEqual(r, { id: 'T1', kind: 'merged', dropped: [] });
  assert.strictEqual(calls[0].body.tags, undefined);
  assert.deepStrictEqual(calls[1], { method: 'POST', path: '/contacts/T1/tags', body: { tags: ['lead', 'xf'] } });
});

test('already copied: PUT without tags, then add tags', async () => {
  const { saveContact } = await load();
  const { api, calls } = fakeApi({ 'PUT /contacts/T9': {}, 'POST /contacts/T9/tags': {} });
  const r = await saveContact(api, { body: { email: 'a@x.com', locationId: 'L' }, tags: ['a'], existing: 'T9' });
  assert.strictEqual(r.kind, 'updated');
  assert.strictEqual(calls[0].body.tags, undefined);
  assert.strictEqual(calls[0].body.locationId, undefined);
  assert.strictEqual(calls[1].path, '/contacts/T9/tags');
});

test('bad email: retried without it, keeping the phone', async () => {
  const { saveContact } = await load();
  const { api, calls } = fakeApi({
    'POST /contacts/upsert': (b) => { if (b.email) throw new Error('GHL POST /contacts/upsert -> 422: {"message":["email must be an email"]}'); return { new: true, contact: { id: 'N1' } }; },
  });
  const r = await saveContact(api, { body: { email: 'bob@', phone: '+15550001111', firstName: 'Bob' } });
  assert.deepStrictEqual(r, { id: 'N1', kind: 'created', dropped: ['email'] });
  assert.strictEqual(calls[1].body.email, undefined);
  assert.strictEqual(calls[1].body.phone, '+15550001111');
});

test('bad email and nothing else: created by name instead of upserted', async () => {
  const { saveContact } = await load();
  const { api, calls } = fakeApi({
    'POST /contacts/upsert': () => { throw new Error('GHL -> 422: email must be an email'); },
    'POST /contacts/': { contact: { id: 'N2' } },
  });
  const r = await saveContact(api, { body: { email: 'nope' } });
  assert.strictEqual(r.id, 'N2');
  assert.strictEqual(calls[1].path, '/contacts/');
  assert.strictEqual(calls[1].body.firstName, 'nope');
});

test('other errors still fail', async () => {
  const { saveContact } = await load();
  const { api } = fakeApi({ 'POST /contacts/upsert': () => { throw new Error('GHL -> 400: something else'); } });
  await assert.rejects(saveContact(api, { body: { email: 'a@x.com' } }), /400/);
});
