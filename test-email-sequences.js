// Automated email sequences (server/services/emailSequences.js): what is due
// and when, the on/off switches, one email per customer per order, no backlog
// when sequences are switched on, unsubscribe, and the settings some emails
// need before they send. Runs in-process against a throwaway copy of the
// database (no server needed); time is simulated by passing "now".
const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), '3t-seq-test-'));
const source = path.join(__dirname, 'data', '3tprint.sqlite');
if (fs.existsSync(source)) fs.copyFileSync(source, path.join(tmp, '3tprint.sqlite'));
process.env.DATA_DIR = tmp;
process.env.RENDER_EXTERNAL_URL = 'https://shop.example.com';

const HOUR = 3600 * 1000, DAY = 24 * HOUR;

async function main() {
  console.log('=== EMAIL SEQUENCES ===');
  const db = require('./server/db');
  await db.ready;
  require('./server/seed')();
  const seq = require('./server/services/emailSequences');

  const set = (key, value) => db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`).run(key, String(value), new Date().toISOString());
  set('email_provider', 'mock');
  for (const key of ['email_sequences_enabled', 'seq_review_link', 'seq_offer_code', 'seq_cutoff_22']) set(key, key === 'email_sequences_enabled' ? '0' : '');
  db.prepare('DELETE FROM sequence_emails').run();
  db.prepare("UPDATE quotes SET status='cancelled'").run(); // only the orders made below count

  const garmentId = db.prepare('SELECT id FROM garments LIMIT 1').get().id;
  let n = 0;
  const customer = (first) => db.prepare('INSERT INTO customers (first_name,last_name,email,phone) VALUES (?,?,?,?)')
    .run(first, 'Seq', `seq.${Date.now()}.${++n}@example.com`, '4785550000').lastInsertRowid;
  const quote = (customerId, fields) => {
    const code = `3T-SEQ-${Date.now()}-${++n}`;
    const f = { status: 'quote_generated', created_at: new Date().toISOString(), paid_at: null, event_name: null, ...fields };
    const id = db.prepare(`INSERT INTO quotes (quote_code, customer_id, status, garment_id, pricing_snapshot, subtotal, total, expires_at, paid_at, event_name, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(code, customerId, f.status, garmentId,
      JSON.stringify({ totalQty: 24, total: 528, garment: { name: 'Standard Quality T-Shirt' } }), 528, 528,
      new Date(Date.now() + 7 * DAY).toISOString(), f.paid_at, f.event_name, f.created_at, f.updated_at || f.created_at).lastInsertRowid;
    return { id, code };
  };
  const idsFor = (customerId, now) => seq.dueEmails(now).filter(d => d.customer.id === customerId).map(d => d.template.id).sort();
  const sentTo = (customerId) => db.prepare("SELECT template_id FROM sequence_emails WHERE customer_id=? AND status='sent' ORDER BY id").all(customerId).map(r => r.template_id);

  const t0 = Date.now();

  // ---- abandoned quote: off by default, then one email per step, never twice ----
  const amy = customer('Amy');
  const amyQuote = quote(amy, { created_at: new Date(t0).toISOString() });
  assert.strictEqual(await seq.run(t0 + 2 * HOUR), 0, 'nothing sends while sequences are switched off');
  set('email_sequences_enabled', '1');
  assert.deepStrictEqual(idsFor(amy, t0 + 30 * 60 * 1000), [], 'not due before an hour has passed');
  assert.deepStrictEqual(idsFor(amy, t0 + 2 * HOUR), ['01'], '#01 is due an hour after the quote');
  await seq.run(t0 + 2 * HOUR);
  await seq.run(t0 + 2 * HOUR + 15 * 60 * 1000);
  assert.deepStrictEqual(sentTo(amy), ['01'], '#01 goes out once');
  const mail = db.prepare('SELECT * FROM emails_sent WHERE quote_id = ? ORDER BY id DESC').get(amyQuote.id);
  assert.strictEqual(mail.subject, 'Your quote is saved');
  assert.ok(mail.body_html.includes(`https://shop.example.com/quote.html?id=${amyQuote.code}`), 'links to the saved quote');
  assert.ok(mail.body_html.includes('24 Standard Quality T-Shirt'), 'merge tags are filled');
  assert.ok(/\/unsubscribe\?c=\d+&amp;t=[0-9a-f]{32}/.test(mail.body_html), 'marketing emails carry an unsubscribe link');
  assert.ok(!mail.body_html.includes('{{'), 'no unfilled tags');
  console.log('  ok: off by default; #01 an hour after a quote, once, with the quote link and unsubscribe link');

  assert.deepStrictEqual(idsFor(amy, t0 + 26 * HOUR), [], '#02 waits for a mockup image');
  assert.deepStrictEqual(idsFor(amy, t0 + 3 * DAY + HOUR), [], '#03 waits for an offer code');
  db.prepare("INSERT INTO discount_codes (code, type, value, active) VALUES ('SEQTEST10', 'percent', 10, 1) ON CONFLICT(code) DO UPDATE SET active=1, expires_at=NULL, usage_limit=NULL").run();
  set('seq_offer_code', 'seqtest10');
  assert.deepStrictEqual(idsFor(amy, t0 + 3 * DAY + HOUR), ['03'], '#03 is due once an active offer code is set');
  await seq.run(t0 + 3 * DAY + HOUR);
  const offerMail = db.prepare('SELECT * FROM emails_sent WHERE quote_id = ? ORDER BY id DESC').get(amyQuote.id);
  assert.strictEqual(offerMail.subject, '10% off if you lock it in this week');
  assert.ok(offerMail.body_html.includes('SEQTEST10'));
  assert.deepStrictEqual(idsFor(amy, t0 + 7 * DAY + HOUR), ['04']);
  console.log('  ok: #02 needs a mockup, #03 needs an offer code, #04 at 7 days');

  // ---- paying stops the sequence; unsubscribing stops marketing ----
  db.prepare("UPDATE quotes SET paid_at=?, status='paid' WHERE id=?").run(new Date(t0 + 4 * DAY).toISOString(), amyQuote.id);
  assert.deepStrictEqual(idsFor(amy, t0 + 7 * DAY + HOUR), [], 'a paid quote gets no more reminders');
  const ben = customer('Ben');
  quote(ben, { created_at: new Date(t0).toISOString() });
  const link = seq.unsubscribeLink(ben);
  const visit = (url) => { const u = new URL(url); const res = { code: 200, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; } }; seq.unsubscribeHandler({ query: Object.fromEntries(u.searchParams) }, res); return res; };
  assert.strictEqual(visit(link.replace(/t=\w+/, 't=bad')).code, 400, 'a wrong unsubscribe token is rejected');
  assert.strictEqual(visit(link).code, 200);
  assert.deepStrictEqual(idsFor(ben, t0 + 2 * HOUR), [], 'unsubscribed customers get no marketing emails');
  assert.strictEqual(visit(link + '&undo=1').code, 200);
  assert.deepStrictEqual(idsFor(ben, t0 + 2 * HOUR), ['01'], 'resubscribing works');
  console.log('  ok: paying ends the sequence; unsubscribe and resubscribe links work');

  // ---- switching on never mails a backlog ----
  const old = customer('Old');
  quote(old, { created_at: new Date(t0 - 12 * DAY).toISOString() });
  assert.deepStrictEqual(idsFor(old, t0), [], 'a 12-day-old quote is past every window');
  console.log('  ok: old quotes are left alone');

  // ---- quotes the shop entered follow #05-#07 instead ----
  const cal = customer('Cal');
  const calQuote = quote(cal, { created_at: new Date(t0).toISOString() });
  db.prepare("INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'generated', 'Entered by Trey: 24 pcs')").run(calQuote.id);
  assert.deepStrictEqual(idsFor(cal, t0 + 2 * HOUR), [], 'no abandoned-quote email for a quote the shop sent');
  assert.deepStrictEqual(idsFor(cal, t0 + 2 * DAY + HOUR), ['05']);
  assert.deepStrictEqual(idsFor(cal, t0 + 5 * DAY + HOUR), ['06']);
  assert.deepStrictEqual(idsFor(cal, t0 + 10 * DAY + HOUR), ['07']);
  console.log('  ok: shop-entered quotes get #05, #06, #07');

  // ---- mockup reminders are status emails: they ignore unsubscribe ----
  const dee = customer('Dee');
  const deeOrder = quote(dee, { status: 'paid', paid_at: new Date(t0).toISOString(), created_at: new Date(t0).toISOString() });
  db.prepare("INSERT INTO mockups (quote_id, original_filename, stored_filename, approval_token, uploaded_at) VALUES (?,?,?,?,?)")
    .run(deeOrder.id, 'm.png', 'm.png', `tok-${Date.now()}`, new Date(t0).toISOString());
  db.prepare('UPDATE customers SET marketing_opt_out=1 WHERE id=?').run(dee);
  assert.deepStrictEqual(idsFor(dee, t0 + 25 * HOUR), ['11']);
  assert.deepStrictEqual(idsFor(dee, t0 + 49 * HOUR), ['12']);
  const reminder = seq.dueEmails(t0 + 25 * HOUR).find(d => d.customer.id === dee);
  const rendered = seq.render(reminder.template, reminder.tags);
  assert.ok(rendered.html.includes('/mockup-approval.html?token=tok-'), 'links to the mockup approval page');
  assert.ok(!rendered.html.includes('Unsubscribe'), 'status emails have no unsubscribe line');
  db.prepare("UPDATE mockups SET status='approved' WHERE quote_id=?").run(deeOrder.id);
  assert.deepStrictEqual(idsFor(dee, t0 + 25 * HOUR), [], 'an approved mockup gets no reminder');
  console.log('  ok: mockup reminders at 24 and 48 hours, even when unsubscribed, until approved');

  // ---- after completion: review (needs the link) and photo request ----
  const eve = customer('Eve');
  const eveOrder = quote(eve, { status: 'completed', paid_at: new Date(t0 - 5 * DAY).toISOString(), created_at: new Date(t0 - 6 * DAY).toISOString(), updated_at: new Date(t0).toISOString() });
  db.prepare("INSERT INTO quote_events (quote_id, event_type, detail, created_at) VALUES (?, 'status_change', 'in_production -> completed (by Trey)', ?)").run(eveOrder.id, new Date(t0).toISOString());
  assert.deepStrictEqual(idsFor(eve, t0 + 3 * DAY + HOUR), [], '#17 waits for the Google review link');
  set('seq_review_link', 'https://g.page/r/test-review');
  assert.deepStrictEqual(idsFor(eve, t0 + 3 * DAY + HOUR), ['17']);
  assert.deepStrictEqual(idsFor(eve, t0 + 14 * DAY + HOUR), ['18']);
  const photo = seq.dueEmails(t0 + 14 * DAY + HOUR).find(d => d.customer.id === eve);
  assert.ok(!seq.render(photo.template, photo.tags).html.includes('referral') && !/When they place their first order/.test(seq.render(photo.template, photo.tags).html), 'the referral paragraph is left out when no reward is set');
  console.log('  ok: review request 3 days after completion, photo request at 14 days');

  // ---- by order purpose, win-back, and the dated mailings ----
  const fay = customer('Fay');
  quote(fay, { status: 'completed', paid_at: new Date(t0).toISOString(), created_at: new Date(t0).toISOString(), event_name: 'Staff Uniforms, Special Event', updated_at: new Date(t0 - 60 * DAY).toISOString() });
  assert.deepStrictEqual(idsFor(fay, t0 + 75 * DAY + HOUR), ['19']);
  assert.ok(idsFor(fay, t0 + 90 * DAY + HOUR).includes('26'), 'win-back at 90 days');
  assert.ok(idsFor(fay, t0 + 180 * DAY + HOUR).includes('27'), 'win-back with the offer at 180 days');
  assert.ok(idsFor(fay, t0 + 300 * DAY + HOUR).includes('21'), 'event anniversary at 10 months');
  const july = Date.UTC(2031, 6, 16, 16), august1 = Date.UTC(2031, 7, 3, 16);
  assert.ok(!idsFor(fay, july).includes('22'), 'the back-to-school mailing waits for a cutoff date');
  set('seq_cutoff_22', 'July 25');
  assert.ok(idsFor(fay, july).includes('22'));
  assert.ok(idsFor(fay, august1).includes('08'), 'the monthly note goes out in the first week of a month');
  assert.ok(!idsFor(fay, Date.UTC(2031, 7, 12, 16)).includes('08'));
  set('seq_22_enabled', '0');
  assert.ok(!idsFor(fay, july).includes('22'), 'an email that is switched off does not send');
  set('seq_22_enabled', '1');
  await seq.run(july);
  await seq.run(july + DAY);
  assert.strictEqual(sentTo(fay).filter(id => id === '22').length, 1, 'a seasonal mailing goes to a customer once a year');
  console.log('  ok: reorder, win-back, anniversary, monthly and seasonal emails');

  // ---- admin view ----
  const state = seq.adminState(t0);
  assert.strictEqual(state.templates.length, seq.TEMPLATES.length);
  assert.ok(state.templates.find(t => t.id === '23').missing.length, 'admin shows what an email still needs');
  for (const t of seq.TEMPLATES) {
    const s = seq.sample(t.id, t0);
    assert.ok(s && s.subject && !s.subject.includes('{{') && !s.html.includes('{{'), `#${t.id} previews with no unfilled tags`);
  }
  console.log(`  ok: all ${seq.TEMPLATES.length} emails preview cleanly`);
  console.log('ALL EMAIL SEQUENCE CHECKS PASSED');
}

main().then(() => process.exit(0)).catch(err => { console.error('EMAIL SEQUENCE TEST FAILED:', err); process.exit(1); });
