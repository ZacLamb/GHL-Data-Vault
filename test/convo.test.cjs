// Conversation export and share page.
const test = require('node:test');
const assert = require('node:assert');
const load = () => import('../src/convo.js');
const msgs = [
  { channel: 'SMS', direction: 'outbound', body: 'Hi <b>Dean</b>, approved for $25k', date_added: '2026-10-26T14:05:00Z', sent_by: 'bulk_actions' },
  { channel: 'SMS', direction: 'inbound', body: '=HYPERLINK("http://x")', date_added: '2026-10-27T09:30:00Z' },
  { channel: 'CALL', direction: 'outbound', body: null, call_duration: 151, date_added: '2026-10-27T10:00:00Z' },
  { channel: 'EMAIL', direction: 'inbound', body: null, date_added: '2026-10-28T10:00:00Z' },
  { channel: 'SMS', direction: 'inbound', body: null, date_added: '2026-10-28T11:00:00Z' },
];
const d = { title: 'Dean G', sub: 'AMG', messages: msgs, total: 9 };

test('page escapes message wording and shows events and gaps', async () => {
  const { renderPage } = await load();
  const h = renderPage(d);
  assert.ok(!h.includes('<b>Dean</b>') && h.includes('&lt;b&gt;Dean&lt;/b&gt;'));
  assert.match(h, /Call \(outgoing, 2:31\)/);
  assert.match(h, /Email received \(wording not saved\)/);
  assert.match(h, /Text \(wording not saved\)/);
  assert.match(h, /Showing the latest 5 of 9 messages/);
  assert.ok(!/<script>addEventListener/.test(h) && /<script>addEventListener/.test(renderPage({ ...d, autoPrint: true })));
});

test('text and CSV exports; CSV neutralises spreadsheet formulas', async () => {
  const { toText, toCsv } = await load();
  const t = toText(d);
  assert.match(t, /^Dean G\nAMG\n5 of 9 messages/);
  assert.match(t, /\[2026-10-26 14:05 UTC\] Us · Text: Hi <b>Dean<\/b>/);
  assert.match(t, /Them · Text: =HYPERLINK/);
  const c = toCsv(d);
  assert.ok(c.startsWith('﻿Date (UTC),Direction,Channel,Message,Sent by'));
  assert.ok(c.includes(`"'=HYPERLINK(""http://x"")"`) || c.includes(`'=HYPERLINK`));
  assert.ok(!/,=HYPERLINK/.test(c));
});
