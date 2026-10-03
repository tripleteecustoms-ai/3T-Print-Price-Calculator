// server/services/emailSequences.js
//
// Automated follow-up emails (Settings > Sequences): abandoned quotes, quotes
// the shop sent that were never approved, mockup approval reminders, review
// and referral requests, reorder reminders, win-backs, the monthly note and
// the seasonal mailings.
//
// How it stays safe:
//  - Nothing sends until the owner switches sequences on, and each email has
//    its own on/off switch.
//  - Each email goes to a customer once per order (or once per period), kept
//    in the sequence_emails table.
//  - An email is only sent inside a short window after it comes due, so
//    switching sequences on never mails a backlog of old quotes and orders.
//  - Marketing emails (MKT) carry an unsubscribe link, skip customers who
//    unsubscribed, and a customer gets at most one of them per 20 hours.
//    Status emails (mockup reminders) always send.

const crypto = require('crypto');
const db = require('../db');
const { getSetting } = require('../pricingEngine');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MAX_PER_RUN = 40;
const MARKETING_GAP_MS = 20 * HOUR;
const OPEN_QUOTE_STATUSES = ['quote_generated', 'quote_viewed', 'checkout_started'];

// Month by month: the subject, preview and opening line of the monthly note (#08).
const MONTH_TOPICS = [
  ['New year, new staff shirts', 'Start the year with a fresh look for the team.', 'New year, and a good time to get the team in fresh shirts. If your staff shirts are faded or you have new people starting, we can turn a set around quickly.'],
  ['Shirts for your church or nonprofit event', 'Fundraisers, retreats, and volunteer days.', 'Planning a fundraiser, retreat, or volunteer day? Matching shirts make it look organized and give people something to keep.'],
  ['Spring sports are about to start', 'Team shirts, practice gear, and fan wear.', 'Spring sports are right around the corner. Team shirts, practice gear, and something for the parents in the stands: we do all of it.'],
  ['Field days and family reunions', 'Get your shirts handled before it gets busy.', 'Field days and family reunions are coming up. Send me the date and a rough headcount and I can get a quote together.'],
  ['Graduation shirts', 'Class shirts, senior gear, and proud-family tees.', 'Graduation season is here. Class shirts, senior gear, and shirts for the whole proud family are easy to do in small or large runs.'],
  ['Summer camp shirts', 'Camps, VBS, and summer programs.', 'Summer camps, VBS, and summer programs all run smoother when everybody is in the same shirt.'],
  ['Reunions and back-to-school prep', 'Two things worth ordering early.', 'Family reunions are in full swing and school is closer than it feels. Both are worth ordering early.'],
  ['School spirit wear', 'Spirit shirts, staff shirts, clubs, and teams.', 'School is back. Spirit wear, staff shirts, clubs, and teams: tell me what you need and how many.'],
  ['Fall sports and homecoming', 'Shirts, hoodies, and hats for the season.', 'Fall sports and homecoming are here. Shirts, hoodies, and hats for the team and the fans.'],
  ['Company holiday gifts', 'Branded gifts your team will wear.', 'If you give your staff or clients something for the holidays, now is the time to plan it. Branded hoodies, hats, and totes go over well.'],
  ['Holiday order cutoff is coming', 'Get holiday orders in before the rush.', 'Holiday orders fill the schedule fast. If you need something before the break, get it on the calendar now.'],
  ["Plan next year's uniforms", 'A quiet month is a good time to plan.', "The end of the year is a good time to plan next year's uniforms and staff shirts, before everyone is back and busy."],
];

// The owner's email copy, word for word, with merge tags in {{double_braces}}.
// A paragraph whose tag has no value for this customer is left out.
const TEMPLATES = [
  { id: '01', kind: 'MKT', name: 'Abandoned Quote: 1 Hour', trigger: 'Quote made on the site, not paid after 1 hour',
    subject: 'Your quote is saved', preview: 'Pick up right where you left off.',
    body: `Hey {{first_name}},

You started a quote for {{quantity}} {{garment}} and didn't finish. No problem, it's saved.

Pick up where you left off: {{quote_link}}

If something on the form was unclear or you want to talk it through, reply here or text me at 478-207-7959.` },
  { id: '02', kind: 'MKT', name: 'Abandoned Quote: 24 Hours', trigger: 'Still not paid 24 hours after #01. Only sends when the order has an approved mockup image',
    subject: "Here's what your order could look like", preview: 'Your design on the {{garment}}, mocked up.',
    body: `Hey {{first_name}},

I put your design on the {{garment}} so you can see it before you commit.

{{mockup_image}}

Quote total: {{quote_total}} for {{quantity}} pieces.

Finish your order: {{quote_link}}

Want a different color, placement, or garment? Just reply and tell me what to change.` },
  { id: '03', kind: 'MKT', name: 'Abandoned Quote: 3 Days', trigger: 'Still not paid 3 days after the quote. Needs an offer code', needs: ['offer'],
    subject: '{{offer}} if you lock it in this week', preview: 'Code {{offer_code}} is good through {{offer_expires}}.',
    body: `Hey {{first_name}},

Your quote for {{quantity}} {{garment}} is still open. If you place it by {{offer_expires}}, use code **{{offer_code}}** for {{offer}}.

Finish your order: {{quote_link}}

If the timing isn't right or the budget changed, let me know. I can usually adjust the garment or print locations to hit a number.` },
  { id: '04', kind: 'MKT', name: 'Abandoned Quote: 7 Days', trigger: 'Still not paid 7 days after the quote (last in this sequence)',
    subject: 'Should I close out your quote?', preview: 'One last check before I clear it.',
    body: `Hey {{first_name}},

I'm cleaning up open quotes and yours is still sitting there: {{quantity}} {{garment}}, {{quote_total}}.

If you still want it, here's the link: {{quote_link}}

If not, no worries. When you need shirts, hats, or anything branded down the road, I'm here.` },
  { id: '05', kind: 'MKT', name: 'Quote Sent, Not Approved: Day 2', trigger: 'Quote you entered in admin, not paid after 2 days',
    subject: 'Any questions on your quote?', preview: 'Quote #{{quote_number}} is ready when you are.',
    body: `Hey {{first_name}},

Wanted to make sure quote #{{quote_number}} came through. Total is {{quote_total}} for {{quantity}} pieces.

Review and approve: {{approval_link}}

If anything needs changing, reply and I'll update it today.` },
  { id: '06', kind: 'MKT', name: 'Quote Sent, Not Approved: Day 5', trigger: 'Quote you entered in admin, not paid after 5 days',
    subject: 'Need this by a certain date?', preview: 'Turnaround is {{turnaround}} once approved.',
    body: `Hey {{first_name}},

Following up on quote #{{quote_number}}. If you have an event or deadline coming up, our turnaround is {{turnaround}} from approval, so the sooner we lock it in the better.

Approve here: {{approval_link}}

Got a date in mind? Reply with it and I'll tell you if we can make it.` },
  { id: '07', kind: 'MKT', name: 'Quote Sent, Not Approved: Day 10', trigger: 'Quote you entered in admin, not paid after 10 days (last in this sequence)',
    subject: 'Closing out quote #{{quote_number}}', preview: 'Last check-in on this one.',
    body: `Hey {{first_name}},

Haven't heard back on quote #{{quote_number}}, so I'll close it out on {{close_date}}.

Still want it? {{approval_link}}

If plans changed, that's fine. Keep my number for next time: 478-207-6684.` },
  { id: '08', kind: 'MKT', name: 'Lead Nurture: Monthly', trigger: 'First week of each month, to contacts with no order in the last 60 days and no open quote',
    subject: '{{month_subject}}', preview: '{{month_preview}}',
    body: `Hey {{first_name}},

{{month_intro}}

What we do: DTF transfers, screen printing, embroidery, and branded merch. Small runs or a few hundred pieces, all handled here in Macon.

Get a price in about two minutes: {{calculator_link}}` },
  { id: '11', kind: 'STATUS', name: 'Mockup Reminder: 24 Hours', trigger: 'Mockup sent, not approved after 24 hours',
    subject: 'Your order is waiting on approval', preview: 'Production starts as soon as you sign off.',
    body: `Hey {{first_name}},

Order #{{order_number}} is on hold until you approve the mockup.

Approve here: {{approval_link}}

Need a change? Use the same link or just reply.` },
  { id: '12', kind: 'STATUS', name: 'Mockup Reminder: 48 Hours', trigger: 'Mockup still not approved after 48 hours',
    subject: 'Heads up: this may push your date', preview: 'Order #{{order_number}} still needs approval.',
    body: `Hey {{first_name}},

Still need your approval on order #{{order_number}}. Every day it waits pushes your ready date back.

Approve here: {{approval_link}}

If something's off with the design, call or text me and we'll fix it fast.` },
  { id: '17', kind: 'MKT', name: 'Thank You + Review: Day 3', trigger: '3 days after an order is marked Completed. Needs your Google review link', needs: ['review_link'],
    subject: 'How did everything turn out?', preview: '30 seconds helps a small Macon shop a lot.',
    body: `Hey {{first_name}},

Hope the {{garment}} came out the way you pictured. If they did, a quick Google review helps us more than you'd think:

{{review_link}}

If something wasn't right, reply and tell me. I'd rather fix it than have you stuck with it.` },
  { id: '18', kind: 'MKT', name: 'Photo + Referral: Day 14', trigger: '14 days after an order is marked Completed. The referral part shows when a referral reward is set',
    subject: 'Got a photo of your order in action?', preview: 'We love sharing customer work.',
    body: `Hey {{first_name}},

If you've got a picture of your team, crew, or event in the shirts, send it over. We love sharing customer work (and we'll tag you).

Also, if you know anyone who needs custom apparel, send them our way. When they place their first order, you get **{{referral_reward}}** off your next one.

Send them here: {{referral_link}}` },
  { id: '19', kind: 'MKT', name: 'Reorder Reminder: Staff/Uniforms', trigger: '75 days after a paid order whose "What\'s this order for?" mentions staff or uniforms',
    subject: 'Time to restock?', preview: 'Your design and sizes are saved.',
    body: `Hey {{first_name}},

It's been a couple months since your last uniform order. New hires, worn-out shirts, missing sizes, it adds up.

Your last order: {{last_order_summary}}

**Start your reorder:** {{reorder_link}}

Need to change quantities or add a new item? Reply with what you need and I'll quote it.` },
  { id: '20', kind: 'MKT', name: 'Recurring Account Check-In: Day 25', trigger: '25 days after the latest paid order whose "What\'s this order for?" mentions recurring or monthly',
    subject: "Next month's order", preview: 'Want me to run the same thing again?',
    body: `Hey {{first_name}},

Checking in before next month. Want me to run the same order again?

Last time: {{last_order_summary}}

Reply **"same"** and I'll get it moving. Reply with changes if anything's different.` },
  { id: '21', kind: 'MKT', name: 'Event Anniversary', trigger: '10 months after a paid order marked as a special event',
    subject: '{{event_name}} is coming back around', preview: 'Get your shirts handled early this year.',
    body: `Hey {{first_name}},

Last year we did an order for {{event_name_lower}}. If it's happening again, now's a good time to start so there's no rush at the end.

Last year's order: {{last_order_summary}}

**Start this year's order:** {{reorder_link}}

Want to update the design or the year on the shirt? Reply and send the changes.` },
  { id: '22', kind: 'MKT', name: 'Seasonal: Back to School', trigger: 'July 15 to 21, to every contact. Needs a cutoff date', needs: ['cutoff'],
    subject: 'School shirts, handled before August', preview: 'Spirit wear, staff shirts, clubs, and teams.',
    body: `Hey {{first_name}},

School's back in a few weeks. If you need spirit wear, staff shirts, club tees, or team gear, get your order in by **{{cutoff_date}}** to have it before the first day.

Get a price: {{calculator_link}}

Schools and PTOs: ask about bulk pricing for 100+ pieces.` },
  { id: '23', kind: 'MKT', name: 'Seasonal: Fall Sports + Homecoming', trigger: 'August 25 to 31, to every contact. Needs a cutoff date', needs: ['cutoff'],
    subject: 'Fall sports and homecoming gear', preview: 'Order by {{cutoff_date}} for homecoming week.',
    body: `Hey {{first_name}},

Football, volleyball, cheer, band, homecoming. If your team or school needs shirts, hoodies, or hats this fall, order by **{{cutoff_date}}** to have them for homecoming week.

Get a price: {{calculator_link}}` },
  { id: '24', kind: 'MKT', name: 'Seasonal: Holiday Gifts + Cutoff', trigger: 'October 25 to 31, and again November 12 to 18, to every contact. Needs a cutoff date', needs: ['cutoff'],
    subject: 'Holiday orders close {{cutoff_date}}', preview: 'Branded gifts for your team or clients.',
    body: `Hey {{first_name}},

Branded hoodies, hats, and totes make solid gifts for staff and clients. To have them before the holidays, orders need to be in by **{{cutoff_date}}**.

Get a price: {{calculator_link}}

After that date we can't promise delivery before the break.` },
  { id: '25', kind: 'MKT', name: 'Seasonal: Spring Events', trigger: 'February 22 to 28, to every contact',
    subject: 'Spring is booked up fast', preview: 'Reunions, field days, spring sports, graduations.',
    body: `Hey {{first_name}},

Spring fills up quick: family reunions, field days, spring sports, church events, graduations. Get on the schedule early so you're not rushed.

Get a price: {{calculator_link}}

Planning a reunion? Send me the date and headcount and I'll put together a quote with sizes.` },
  { id: '26', kind: 'MKT', name: 'Win-Back: 90 Days', trigger: '90 days since the last paid order, no open quote',
    subject: 'Been a minute, {{first_name}}', preview: 'Anything coming up we can help with?',
    body: `Hey {{first_name}},

It's been about three months since your last order. Anything coming up? Events, new staff, giveaways, merch?

Your last order: {{last_order_summary}}

Start a new one: {{calculator_link}}` },
  { id: '27', kind: 'MKT', name: 'Win-Back: 180 Days', trigger: '180 days since the last paid order, no open quote (last in this sequence). Needs an offer code', needs: ['offer'],
    subject: '{{offer}} on your next order', preview: 'Code {{offer_code}}, good through {{offer_expires}}.',
    body: `Hey {{first_name}},

It's been a while. If you've got something coming up, here's **{{offer}}** on your next order with code **{{offer_code}}**, good through {{offer_expires}}.

Get a price: {{calculator_link}}

If you went somewhere else, I'd like to know why. Reply and tell me. It helps.` },
];
const TEMPLATE_BY_ID = Object.fromEntries(TEMPLATES.map(t => [t.id, t]));

// Settings the owner fills in under Settings > Sequences.
const SETTING_KEYS = ['email_sequences_enabled', 'seq_turnaround', 'seq_review_link', 'seq_offer_code', 'seq_referral_reward',
  'seq_cutoff_22', 'seq_cutoff_23', 'seq_cutoff_24', ...TEMPLATES.map(t => `seq_${t.id}_enabled`)];

// ------------------------------------------------------------------ helpers
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => '$' + Number(n || 0).toFixed(2);
// SQLite's CURRENT_TIMESTAMP ("2026-10-03 14:00:00", UTC) and ISO strings both parse here.
function ms(stamp) {
  if (!stamp) return NaN;
  const s = String(stamp);
  return Date.parse(/T/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}
function longDate(date) { return new Date(date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/New_York' }); }
function shopDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}
function setting(key, fallback = '') { const v = getSetting(key, null); return v == null ? fallback : String(v); }
function enabled() { return setting('email_sequences_enabled', '0') === '1'; }
function templateEnabled(id) { return setting(`seq_${id}_enabled`, '1') === '1'; }
function baseUrl() {
  return (process.env.RENDER_EXTERNAL_URL || setting('public_base_url') || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

function secret() {
  let s = getSetting('unsubscribe_secret', null);
  if (!s) {
    s = crypto.randomBytes(24).toString('hex');
    db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES ('unsubscribe_secret',?,?)
      ON CONFLICT(key) DO NOTHING`).run(s, new Date().toISOString());
    s = getSetting('unsubscribe_secret', s);
  }
  return s;
}
function unsubscribeToken(customerId) { return crypto.createHmac('sha256', secret()).update(String(customerId)).digest('hex').slice(0, 32); }
function unsubscribeLink(customerId) { return `${baseUrl()}/unsubscribe?c=${customerId}&t=${unsubscribeToken(customerId)}`; }

/** The discount code offered in #03 and #27: must exist, be active and not expired. */
function currentOffer(now) {
  const code = setting('seq_offer_code').trim().toUpperCase();
  if (!code) return null;
  const row = db.prepare('SELECT * FROM discount_codes WHERE code = ?').get(code);
  if (!row || !row.active) return null;
  if (row.expires_at && ms(row.expires_at) < now) return null;
  if (row.usage_limit != null && row.times_used >= row.usage_limit) return null;
  return {
    code: row.code,
    text: row.type === 'percent' ? `${Number(row.value)}% off` : `${money(row.value).replace(/\.00$/, '')} off`,
    expires: longDate(row.expires_at ? ms(row.expires_at) : now + 7 * DAY),
  };
}

/** What a template still needs before it can send: shown in admin, and checked before every send. */
function missingFor(template, now = Date.now()) {
  const missing = [];
  for (const need of template.needs || []) {
    if (need === 'offer' && !currentOffer(now)) missing.push('an active discount code in "Offer code"');
    if (need === 'review_link' && !/^https?:\/\//i.test(setting('seq_review_link').trim())) missing.push('your Google review link');
    if (need === 'cutoff' && !setting(`seq_cutoff_${template.id}`).trim()) missing.push('a cutoff date');
  }
  return missing;
}

// ------------------------------------------------------------------ rendering
/** Fills {{tags}}. Returns null when a tag has no value (the caller drops that paragraph). */
function fill(text, tags) {
  let missing = false;
  const out = String(text).replace(/\{\{(\w+)\}\}/g, (m, key) => {
    const v = tags[key];
    if (v == null || v === '') { missing = true; return ''; }
    return String(v);
  });
  return missing ? null : out;
}

function paragraphHtml(raw, tags) {
  if (raw.trim() === '{{mockup_image}}') {
    return tags.mockup_image ? `<img src="${esc(tags.mockup_image)}" alt="Your mockup" style="width:100%;border-radius:8px;border:1px solid #E5E5E5;margin:4px 0 16px;">` : null;
  }
  const filled = fill(raw, tags);
  if (filled == null) return null;
  const bold = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // "Finish your order: https://…" becomes a button; a bare link stays a link.
  const link = filled.match(/^([\s\S]*?)[:?]?\s*(https?:\/\/\S+)$/);
  if (link) {
    const label = link[1].replace(/\*\*/g, '').trim();
    if (label && label.length <= 45) {
      return `<a href="${esc(link[2])}" style="display:block;text-align:center;background:#CCFF00;color:#000;text-decoration:none;font-weight:800;padding:14px;border-radius:8px;margin:0 0 16px;">${esc(label)}</a>`;
    }
    return `<p style="margin:0 0 16px;line-height:1.5;">${label ? bold(link[1].trim()) + '<br>' : ''}<a href="${esc(link[2])}" style="color:#000;font-weight:700;">${esc(link[2])}</a></p>`;
  }
  return `<p style="margin:0 0 16px;line-height:1.5;">${bold(filled).replace(/\n/g, '<br>')}</p>`;
}

/** { subject, html } for a template and its merge tags, or null when the subject cannot be filled. */
function render(template, tags) {
  const subject = fill(template.subject, tags);
  if (subject == null) return null;
  const preview = fill(template.preview, tags) || '';
  const body = template.body.split(/\n\s*\n/).map(p => paragraphHtml(p, tags)).filter(Boolean).join('\n');
  const footer = template.kind === 'MKT' && tags.unsubscribe_link
    ? `<p style="font-size:12px;color:#777;margin:18px 0 0;">Don't want these? <a href="${esc(tags.unsubscribe_link)}" style="color:#777;">Unsubscribe</a></p>` : '';
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preview)}</div>
    <div style="background:#000;color:#CCFF00;padding:24px 28px;font-weight:800;font-size:20px;">3T PRINT SOLUTIONS</div>
    <div style="padding:28px;border:1px solid #E5E5E5;border-top:none;font-size:15px;background:#fff;">
      ${body}
      <p style="margin:24px 0 0;line-height:1.5;">Trey<br>3T Print Solutions<br>Call 478-207-6684 | Text 478-207-7959<br>2719 Sheraton Dr. STE C-100A, Macon, GA 31204</p>
      ${footer}
    </div>
  </div>`;
  return { subject, html };
}

// ------------------------------------------------------------------ merge tags
function commonTags(customer, now) {
  const offer = currentOffer(now);
  const { month } = shopDate(now);
  const topic = MONTH_TOPICS[month - 1];
  const reward = setting('seq_referral_reward').trim();
  return {
    first_name: customer.first_name,
    turnaround: setting('seq_turnaround', '7 to 10 business days').trim() || '7 to 10 business days',
    calculator_link: baseUrl() + '/',
    reorder_link: baseUrl() + '/',
    review_link: /^https?:\/\//i.test(setting('seq_review_link').trim()) ? setting('seq_review_link').trim() : null,
    referral_reward: reward || null,
    referral_link: reward ? baseUrl() + '/' : null,
    offer: offer ? offer.text : null, offer_code: offer ? offer.code : null, offer_expires: offer ? offer.expires : null,
    month_subject: topic[0], month_preview: topic[1], month_intro: topic[2],
    unsubscribe_link: unsubscribeLink(customer.id),
  };
}
function snapshotOf(quote) { try { return JSON.parse(quote.pricing_snapshot); } catch (e) { return {}; } }
function orderSummary(quote) {
  const snap = snapshotOf(quote);
  return `${snap.totalQty || ''} × ${(snap.garment && snap.garment.name) || 'your order'} (order #${quote.quote_code})`.trim();
}
function quoteTags(quote, now) {
  const snap = snapshotOf(quote);
  const link = `${baseUrl()}/quote.html?id=${encodeURIComponent(quote.quote_code)}`;
  const mockup = db.prepare("SELECT stored_filename FROM artwork_files WHERE quote_id = ? AND location_name LIKE '%Approved Mockup' ORDER BY id LIMIT 1").get(quote.id);
  const purposes = String(quote.event_name || '');
  return {
    quantity: snap.totalQty, garment: snap.garment && snap.garment.name,
    quote_link: link, approval_link: link, order_status_link: link,
    quote_total: money(quote.grand_total != null ? quote.grand_total : snap.total),
    quote_number: quote.quote_code, order_number: quote.quote_code,
    close_date: longDate(ms(quote.created_at) + 12 * DAY),
    mockup_image: mockup ? `${baseUrl()}${require('./storageService').fileUrl(mockup.stored_filename)}` : null,
    last_order_summary: orderSummary(quote),
    event_name: /event/i.test(purposes) ? 'Your event' : null, event_name_lower: 'your event',
    cutoff_date: null,
  };
}

// ------------------------------------------------------------------ who is due
function inWindow(anchorMs, delayMs, windowMs, now) {
  const due = anchorMs + delayMs;
  return Number.isFinite(due) && now >= due && now < due + windowMs;
}
const QUOTE_COLUMNS = `q.*, c.first_name, c.last_name, c.email, c.id AS cust_id, COALESCE(c.marketing_opt_out,0) AS opt_out, COALESCE(c.archived,0) AS cust_archived`;
function customerOf(row) { return { id: row.cust_id, first_name: row.first_name, last_name: row.last_name, email: row.email, opt_out: row.opt_out, archived: row.cust_archived }; }

/** Every email that is due right now: [{ template, customer, quote?, periodKey, tags }]. */
function dueEmails(now = Date.now()) {
  const due = [];
  const add = (id, customer, quote, periodKey, extraTags = {}) => {
    const template = TEMPLATE_BY_ID[id];
    if (!templateEnabled(id) || missingFor(template, now).length) return;
    if (!customer.email || customer.archived) return;
    if (template.kind === 'MKT' && customer.opt_out) return;
    due.push({ template, customer, quote: quote || null, periodKey: periodKey || '', tags: { ...commonTags(customer, now), ...(quote ? quoteTags(quote, now) : {}), ...extraTags } });
  };

  // ---- open quotes: #01-#04 (made on the site) and #05-#07 (entered by the shop) ----
  const openQuotes = db.prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes q JOIN customers c ON c.id = q.customer_id
    WHERE q.paid_at IS NULL AND q.status IN (${OPEN_QUOTE_STATUSES.map(() => '?').join(',')}) AND q.created_at >= ?`)
    .all(...OPEN_QUOTE_STATUSES, new Date(now - 15 * DAY).toISOString().slice(0, 10));
  const shopEntered = new Set(db.prepare("SELECT quote_id FROM quote_events WHERE event_type = 'generated' AND detail LIKE 'Entered by %'").all().map(r => r.quote_id));
  const boughtSince = db.prepare('SELECT 1 FROM quotes WHERE customer_id = ? AND paid_at IS NOT NULL AND paid_at >= ? LIMIT 1');
  for (const q of openQuotes) {
    const created = ms(q.created_at);
    if (boughtSince.get(q.customer_id, new Date(created).toISOString())) continue; // they ordered another way
    const customer = customerOf(q);
    const steps = shopEntered.has(q.id)
      ? [['05', 2 * DAY, DAY], ['06', 5 * DAY, DAY], ['07', 10 * DAY, DAY]]
      : [['01', HOUR, 12 * HOUR], ['02', 25 * HOUR, DAY], ['03', 3 * DAY, DAY], ['04', 7 * DAY, DAY]];
    for (const [id, delay, window] of steps) {
      if (!inWindow(created, delay, window, now)) continue;
      if (id === '02' && !quoteTags(q, now).mockup_image) continue;
      add(id, customer, q);
    }
  }

  // ---- mockups waiting on the customer: #11, #12 ----
  const waiting = db.prepare(`SELECT m.id AS mockup_id, m.approval_token, m.uploaded_at, ${QUOTE_COLUMNS}
    FROM mockups m JOIN quotes q ON q.id = m.quote_id JOIN customers c ON c.id = q.customer_id
    WHERE m.status = 'pending_customer' AND q.status NOT IN ('cancelled','refunded','completed')
      AND m.id = (SELECT MAX(id) FROM mockups WHERE quote_id = m.quote_id)`).all();
  for (const m of waiting) {
    const approval = `${baseUrl()}/mockup-approval.html?token=${encodeURIComponent(m.approval_token)}`;
    for (const [id, delay] of [['11', DAY], ['12', 2 * DAY]]) {
      if (inWindow(ms(m.uploaded_at), delay, DAY, now)) add(id, customerOf(m), m, `mockup-${m.mockup_id}`, { approval_link: approval });
    }
  }

  // ---- after an order is completed: #17, #18 ----
  const completed = db.prepare(`SELECT ${QUOTE_COLUMNS},
      (SELECT MAX(created_at) FROM quote_events e WHERE e.quote_id = q.id AND e.event_type = 'status_change' AND e.detail LIKE '%-> completed%') AS completed_at
    FROM quotes q JOIN customers c ON c.id = q.customer_id WHERE q.status = 'completed' AND q.updated_at >= ?`)
    .all(new Date(now - 30 * DAY).toISOString().slice(0, 10));
  for (const q of completed) {
    const at = ms(q.completed_at || q.updated_at);
    if (inWindow(at, 3 * DAY, 2 * DAY, now)) add('17', customerOf(q), q);
    if (inWindow(at, 14 * DAY, 2 * DAY, now)) add('18', customerOf(q), q);
  }

  // ---- paid orders by what they were for: #19 staff/uniforms, #20 recurring, #21 events ----
  const paid = db.prepare(`SELECT ${QUOTE_COLUMNS} FROM quotes q JOIN customers c ON c.id = q.customer_id
    WHERE q.paid_at IS NOT NULL AND q.status NOT IN ('cancelled','refunded') ORDER BY q.paid_at`).all();
  const lastPaid = new Map(); // customer id -> their latest paid order
  for (const q of paid) lastPaid.set(q.customer_id, q);
  for (const q of paid) {
    const purposes = String(q.event_name || '');
    const at = ms(q.paid_at);
    if (/staff|uniform/i.test(purposes) && inWindow(at, 75 * DAY, 2 * DAY, now)) add('19', customerOf(q), q);
    if (/recurring|monthly/i.test(purposes) && lastPaid.get(q.customer_id) === q && inWindow(at, 25 * DAY, 2 * DAY, now)) add('20', customerOf(q), q);
    if (/event/i.test(purposes) && inWindow(at, 300 * DAY, 3 * DAY, now)) add('21', customerOf(q), q);
  }

  // ---- win-back: #26 (90 days), #27 (180 days) since the last paid order ----
  const recentOpen = new Set(db.prepare(`SELECT DISTINCT customer_id FROM quotes WHERE paid_at IS NULL AND status IN (${OPEN_QUOTE_STATUSES.map(() => '?').join(',')}) AND created_at >= ?`)
    .all(...OPEN_QUOTE_STATUSES, new Date(now - 30 * DAY).toISOString().slice(0, 10)).map(r => r.customer_id));
  for (const q of lastPaid.values()) {
    if (recentOpen.has(q.customer_id)) continue;
    const at = ms(q.paid_at);
    const key = `last-${q.quote_code}`;
    if (inWindow(at, 90 * DAY, 2 * DAY, now)) add('26', customerOf(q), null, key, { last_order_summary: orderSummary(q) });
    if (inWindow(at, 180 * DAY, 2 * DAY, now)) add('27', customerOf(q), null, key, { last_order_summary: orderSummary(q) });
  }

  // ---- mailings by date: #08 monthly, #22-#25 seasonal ----
  const { year, month, day } = shopDate(now);
  const between = (m, from, to) => month === m && day >= from && day <= to;
  const mailings = [];
  if (day <= 7) mailings.push(['08', `${year}-${String(month).padStart(2, '0')}`]);
  if (between(7, 15, 21)) mailings.push(['22', String(year)]);
  if (between(8, 25, 31)) mailings.push(['23', String(year)]);
  if (between(10, 25, 31)) mailings.push(['24', `${year}-a`]);
  if (between(11, 12, 18)) mailings.push(['24', `${year}-b`]);
  if (between(2, 22, 28)) mailings.push(['25', String(year)]);
  if (mailings.some(([id]) => templateEnabled(id))) {
    const seen = new Set();
    const contacts = db.prepare('SELECT id, first_name, last_name, email, COALESCE(marketing_opt_out,0) AS opt_out, COALESCE(archived,0) AS archived FROM customers ORDER BY id DESC').all()
      .filter(c => { const key = String(c.email || '').trim().toLowerCase(); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    for (const [id, key] of mailings) {
      for (const c of contacts) {
        if (id === '08') {
          const last = lastPaid.get(c.id);
          if ((last && now - ms(last.paid_at) < 60 * DAY) || recentOpen.has(c.id)) continue; // has an active order or quote
        }
        add(id, c, null, key, { cutoff_date: setting(`seq_cutoff_${id}`).trim() || null });
      }
    }
  }
  return due;
}

// ------------------------------------------------------------------ sending
/** Sends everything that is due (at most MAX_PER_RUN). Returns how many went out. */
async function run(now = Date.now()) {
  if (!enabled()) return 0;
  const emailService = require('./emailService');
  const already = db.prepare('SELECT 1 FROM sequence_emails WHERE template_id=? AND customer_id=? AND quote_id=? AND period_key=?');
  const recentMarketing = db.prepare("SELECT 1 FROM sequence_emails WHERE customer_id=? AND kind='MKT' AND sent_at >= ? LIMIT 1");
  const record = db.prepare('INSERT INTO sequence_emails (template_id, kind, customer_id, quote_id, period_key, to_email, status, sent_at) VALUES (?,?,?,?,?,?,?,?)');
  const setStatus = db.prepare('UPDATE sequence_emails SET status=? WHERE id=?');
  let sent = 0;
  for (const item of dueEmails(now)) {
    if (sent >= MAX_PER_RUN) break;
    const quoteId = item.quote ? item.quote.id : 0;
    if (already.get(item.template.id, item.customer.id, quoteId, item.periodKey)) continue;
    if (item.template.kind === 'MKT' && recentMarketing.get(item.customer.id, new Date(now - MARKETING_GAP_MS).toISOString())) continue;
    const message = render(item.template, item.tags);
    if (!message) continue;
    // Recorded before sending: a crash or a mail error can never cause a second copy.
    const rowId = record.run(item.template.id, item.template.kind, item.customer.id, quoteId, item.periodKey, item.customer.email, 'sending', new Date(now).toISOString()).lastInsertRowid;
    try {
      await emailService.send({ quoteId: quoteId || null, to: item.customer.email, subject: message.subject, html: message.html });
      setStatus.run('sent', rowId);
      if (quoteId) db.prepare("INSERT INTO quote_events (quote_id, event_type, detail) VALUES (?, 'sequence_email', ?)").run(quoteId, `Automatic email #${item.template.id} (${item.template.name}) sent to ${item.customer.email}`);
      sent++;
    } catch (err) {
      setStatus.run('failed', rowId);
      console.error(`[sequences] #${item.template.id} to ${item.customer.email} failed:`, err.message);
    }
  }
  return sent;
}

// ------------------------------------------------------------------ admin
const SAMPLE_CUSTOMER = { id: 0, first_name: 'Jordan', last_name: 'Sample', email: 'sample@example.com' };
/** A template filled with sample values, for the admin preview and test send. */
function sample(id, now = Date.now()) {
  const template = TEMPLATE_BY_ID[id];
  if (!template) return null;
  const offer = currentOffer(now);
  const link = `${baseUrl()}/quote.html?id=3T-SAMPLE-0001`;
  const tags = {
    ...commonTags(SAMPLE_CUSTOMER, now),
    quantity: 24, garment: 'Standard Quality T-Shirt', quote_link: link, approval_link: link, order_status_link: link,
    quote_total: '$528.00', quote_number: '3T-SAMPLE-0001', order_number: '3T-SAMPLE-0001', close_date: longDate(now + 2 * DAY),
    mockup_image: null, last_order_summary: '24 × Standard Quality T-Shirt (order #3T-SAMPLE-0001)',
    event_name: 'Your event', event_name_lower: 'your event',
    cutoff_date: setting(`seq_cutoff_${id}`).trim() || '(your cutoff date)',
    offer: offer ? offer.text : '(your offer)', offer_code: offer ? offer.code : '(CODE)', offer_expires: offer ? offer.expires : longDate(now + 7 * DAY),
    review_link: /^https?:\/\//i.test(setting('seq_review_link').trim()) ? setting('seq_review_link').trim() : 'https://g.page/r/your-review-link',
    unsubscribe_link: `${baseUrl()}/unsubscribe`,
  };
  return render(template, tags);
}

function adminState(now = Date.now()) {
  const counts = Object.fromEntries(db.prepare("SELECT template_id, COUNT(*) n FROM sequence_emails WHERE status='sent' AND sent_at >= ? GROUP BY template_id")
    .all(new Date(now - 30 * DAY).toISOString()).map(r => [r.template_id, r.n]));
  return {
    enabled: enabled(),
    settings: {
      turnaround: setting('seq_turnaround', '7 to 10 business days'), reviewLink: setting('seq_review_link'), offerCode: setting('seq_offer_code'),
      referralReward: setting('seq_referral_reward'), cutoff22: setting('seq_cutoff_22'), cutoff23: setting('seq_cutoff_23'), cutoff24: setting('seq_cutoff_24'),
    },
    offer: currentOffer(now),
    unsubscribed: db.prepare('SELECT COUNT(*) n FROM customers WHERE COALESCE(marketing_opt_out,0) = 1').get().n,
    templates: TEMPLATES.map(t => ({ id: t.id, name: t.name, kind: t.kind, trigger: t.trigger, subject: t.subject, enabled: templateEnabled(t.id), missing: missingFor(t, now), sent30d: counts[t.id] || 0 })),
  };
}

function saveAdminState(body) {
  const upsert = db.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`);
  const now = new Date().toISOString();
  const text = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  const s = (body && body.settings) || {};
  if (body && body.enabled !== undefined) upsert.run('email_sequences_enabled', body.enabled ? '1' : '0', now);
  const fields = { turnaround: 'seq_turnaround', reviewLink: 'seq_review_link', offerCode: 'seq_offer_code', referralReward: 'seq_referral_reward', cutoff22: 'seq_cutoff_22', cutoff23: 'seq_cutoff_23', cutoff24: 'seq_cutoff_24' };
  for (const [field, key] of Object.entries(fields)) if (s[field] !== undefined) upsert.run(key, text(s[field], 300), now);
  for (const t of (body && Array.isArray(body.templates) ? body.templates : [])) {
    if (t && TEMPLATE_BY_ID[t.id]) upsert.run(`seq_${t.id}_enabled`, t.enabled ? '1' : '0', now);
  }
  return adminState();
}

// ------------------------------------------------------------------ unsubscribe page
function unsubscribeHandler(req, res) {
  const id = Number(req.query.c);
  const ok = Number.isInteger(id) && id > 0 && String(req.query.t || '') === unsubscribeToken(id)
    && db.prepare('SELECT id FROM customers WHERE id = ?').get(id);
  const page = (title, text) => res.status(ok ? 200 : 400).send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;background:#f5f5f5;margin:0;padding:40px 16px;color:#111;">
    <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5E5E5;border-radius:10px;overflow:hidden;">
    <div style="background:#000;color:#CCFF00;padding:20px 24px;font-weight:800;font-size:18px;">3T PRINT SOLUTIONS</div>
    <div style="padding:24px;"><h1 style="font-size:20px;margin:0 0 10px;">${title}</h1><p style="line-height:1.5;margin:0;">${text}</p></div></div></body></html>`);
  if (!ok) return page('This link is not valid', 'Reply to any of our emails and we will take you off the list.');
  const resubscribe = req.query.undo === '1';
  db.prepare('UPDATE customers SET marketing_opt_out = ? WHERE id = ?').run(resubscribe ? 0 : 1, id);
  if (resubscribe) return page('You are back on the list', 'You will get our occasional emails again.');
  return page('You are unsubscribed', `You will not get marketing emails from us anymore. Emails about an order you place still come through. <a href="/unsubscribe?c=${id}&t=${unsubscribeToken(id)}&undo=1" style="color:#111;">Unsubscribed by mistake?</a>`);
}

module.exports = { TEMPLATES, SETTING_KEYS, run, dueEmails, render, sample, adminState, saveAdminState, unsubscribeHandler, unsubscribeLink, enabled };
