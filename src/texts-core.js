// Best texts, the pure parts: turn a sent text into a template, label a reply, score a template.
// No db/network imports so it can be tested directly.
import crypto from 'node:crypto';

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Hi Mike, Acme can get $25,000 today: https://x.co/a1" → "Hi {name}, {company} can get {amount} today: {link}"
export function templateOf(body, { first, last, company } = {}) {
  let t = String(body || '');
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\b[\w-]+\.(?:com|net|org|co|io|ly|link|me|us|biz|info|app|to|gl)\/\S*/gi, '{link}');
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '{email}');
  t = t.replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '{phone}');
  t = t.replace(/\$\s?\d[\d,]*(?:\.\d+)?\s?(?:k|K|m|M|mm|MM)?\b/g, '{amount}');
  const swap = (v, ph) => {
    const s = String(v || '').trim();
    if (s.length < 2 || /^\d+$/.test(s)) return;
    t = t.replace(new RegExp(`(^|[^\\w{])${escRe(s)}(?=$|[^\\w}])`, 'gi'), `$1${ph}`);
  };
  swap(company, '{company}');                      // company first: it often contains the person's name
  const full = [first, last].filter(Boolean).join(' ');
  if (first && last) swap(full, '{name}');
  swap(first, '{name}'); swap(last, '{name}');
  t = t.replace(/(?<![\w{])\d+(?:[,./:-]\d+)*/g, '{n}');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}
// Same template whatever the punctuation, case or emoji: "Hi {name}!" and "hi {name}" are one key.
export function templateKey(template) {
  const k = String(template).toLowerCase().replace(/[^a-z0-9{} ]+/g, ' ').replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha1').update(k).digest('hex').slice(0, 16);
}

// Reply → positive | negative | opt_out | other. Rules catch the clear-cut ones; "other" can go to AI.
const OPT_OUT = /^\W*(stop|stop all|stopall|unsubscribe|unsub|cancel|end|quit|optout|opt out|remove|remove me)\W*$|\b(remove me|take me off|stop (texting|messaging|contacting)|do not (text|contact|message)|don'?t (text|contact|message) me|unsubscribe|lose my number|delete my number)\b/i;
const NEGATIVE = /^\W*(no|nope|nah|n)\W*$|\b(not interested|no thanks|no thank you|no thx|no ty|not at this time|not right now|not now|not looking|don'?t need|do not need|no need|wrong number|wrong person|already (funded|got|have|approved)|leave me alone|scam|spam|go away|f+u+c*k+ (off|you)|stfu|never)\b/i;
const POSITIVE = /^\W*(y|ya|ye|yes+|yeah|yea|yep|yup|sure|absolutely|definitely|of course|interested|i'?m interested|call me|go ahead|let'?s do it|sounds good)\W*$|^\W*(yes+|yeah|yea|yep|yup|sure|absolutely|definitely)\b|(?<!not |no |isn'?t |wasn'?t )\b(send (it|it over|them|that)|interested|call me|give me a call|call (me )?(now|asap|today|tomorrow)|how much|what'?s the rate|what (are|is) the (rate|terms|payment|factor)|send (me )?(the |an |more )?(info|details|application|app|link|offer)|i need|we need|i'?m looking|we'?re looking|looking for|can you (call|send|help)|when can (i|we|you)|what do (i|you) need|how (does it|do i|long)|let'?s talk|sounds good|i'?m in|count me in|tell me more|more info)\b/i;

export function labelReply(reply) {
  const r = String(reply || '').trim();
  if (!r) return 'none';
  if (OPT_OUT.test(r)) return 'opt_out';
  if (NEGATIVE.test(r)) return 'negative';
  if (POSITIVE.test(r)) return 'positive';
  return 'other';
}

// Lower bound of the 95% Wilson interval: ranks 30/100 above 2/3, so tiny samples can't top the list.
export function wilson(hits, n) {
  if (!n) return 0;
  const z = 1.96, p = hits / n, d = 1 + (z * z) / n;
  return (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n)) / d;
}

export const AI_PROMPT = `You label SMS replies that a business received after texting a lead (mostly small-business owners being offered funding or services).
Each numbered item shows the text that was sent and the reply. Judge the reply in light of the text (e.g. "ok" to "Want me to send the offer?" is positive).
For each item, answer with one label:
- positive: interested, wants a call, asks how much / what's needed / how it works, asks for info or the application
- negative: not interested, no, already has it, wrong number, annoyed
- opt_out: asks to stop texting / unsubscribe / be removed
- other: neutral or unclear (e.g. "who is this?", an emoji, "ok thanks", an unrelated message)
Reply with only a JSON array of labels in the same order, e.g. ["positive","other"].`;

export function parseAiLabels(text, n) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr; try { arr = JSON.parse(m[0]); } catch { return null; }
  if (!Array.isArray(arr) || arr.length !== n) return null;
  const ok = new Set(['positive', 'negative', 'opt_out', 'other']);
  return arr.map((x) => (ok.has(String(x).toLowerCase()) ? String(x).toLowerCase() : 'other'));
}
