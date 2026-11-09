// Best texts: templates, reply labels, ranking score.
const test = require('node:test');
const assert = require('node:assert');
const load = () => import('../src/texts-core.js');

test('template swaps names, amounts, links and numbers', async () => {
  const { templateOf, templateKey } = await load();
  const a = templateOf('Hi Mike, Acme Plumbing is approved for $25,000! Apply: https://x.co/a1 or call 508-555-1212 by 5pm', { first: 'Mike', last: 'Jones', company: 'Acme Plumbing' });
  assert.strictEqual(a, 'Hi {name}, {company} is approved for {amount}! Apply: {link} or call {phone} by {n}pm');
  const b = templateOf('hi SARAH, Bob\'s Pizza is approved for $40k! Apply: https://x.co/zz9 or call (617) 555-0000 by 3pm', { first: 'Sarah', company: "Bob's Pizza" });
  assert.strictEqual(templateKey(a), templateKey(b));
  assert.notStrictEqual(templateKey(a), templateKey('Something else entirely'));
});

test('a first name inside another word is left alone', async () => {
  const { templateOf } = await load();
  assert.strictEqual(templateOf('Al, totally normal', { first: 'Al' }), '{name}, totally normal');
  assert.strictEqual(templateOf('totally normal', { first: 'Al' }), 'totally normal');
});

test('reply labels', async () => {
  const { labelReply } = await load();
  const cases = {
    'STOP': 'opt_out', 'Stop.': 'opt_out', 'please remove me from your list': 'opt_out',
    'not interested': 'negative', 'No': 'negative', 'wrong number': 'negative', 'already funded thanks': 'negative',
    'Yes': 'positive', 'yes please call me': 'positive', 'How much can I get?': 'positive', 'send me the application': 'positive', "I'm interested": 'positive', 'Yes send it': 'positive', 'sure, send it over': 'positive',
    'who is this?': 'other', 'ok': 'other', '': 'none',
  };
  for (const [r, want] of Object.entries(cases)) assert.strictEqual(labelReply(r), want, r);
});

test('wilson ranks a solid record above a tiny lucky one', async () => {
  const { wilson } = await load();
  assert.ok(wilson(30, 100) > wilson(2, 3));
  assert.strictEqual(wilson(0, 0), 0);
});

test('AI labels parse and fall back', async () => {
  const { parseAiLabels } = await load();
  assert.deepStrictEqual(parseAiLabels('Here: ["positive","Opt_out","weird"]', 3), ['positive', 'opt_out', 'other']);
  assert.strictEqual(parseAiLabels('["positive"]', 2), null);
});
