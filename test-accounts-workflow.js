// Customer accounts, the artwork review queue, the email viewer, order
// numbers, reorders, User Access and the Shopify / Square webhooks.
// Runs against a server on :4790 with the mock email provider.
const assert = require('assert');
const crypto = require('crypto');

const BASE = 'http://localhost:4790';

function client() {
  let cookie = '';
  return async function call(method, path, body, headers = {}) {
    const raw = typeof body === 'string';
    const resp = await fetch(BASE + path, {
      method, redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? (raw ? body : JSON.stringify(body)) : undefined,
    });
    const sc = resp.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await resp.text();
    let json = {}; try { json = JSON.parse(text); } catch (e) {}
    return { status: resp.status, body: json, text, location: resp.headers.get('location') };
  };
}

async function main() {
  console.log('=== ACCOUNTS, ARTWORK QUEUE, EMAILS, WEBHOOKS ===');
  const admin = client(), guest = client(), customer = client(), stranger = client();
  assert.strictEqual((await admin('POST', '/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASS || '3tprint-admin-2026' })).status, 200);
  const settingsBefore = (await admin('GET', '/api/admin/settings')).body.settings;
  await admin('PUT', '/api/admin/settings', { email_provider: 'mock', payment_provider: 'mock', shopify_client_secret: 'test-shopify-secret', square_webhook_signature_key: 'test-square-key', square_webhook_url: `${BASE}/api/webhooks/square` });

  const latestEmail = async (to, subjectRe) => {
    const { emails } = (await admin('GET', `/api/admin/emails?q=${encodeURIComponent(to)}`)).body;
    const hit = emails.find(e => e.to === to && subjectRe.test(e.subject));
    return hit ? (await admin('GET', `/api/admin/emails/${hit.id}`)).body.email : null;
  };

  // ---- a guest order (no account needed), with two artwork files ----
  const stamp = Date.now();
  const email = `acct.${stamp}@example.com`;
  const { garments } = (await guest('GET', '/api/garments')).body;
  const tee = garments.find(g => g.name === 'Standard Quality T-Shirt');
  const front = (await guest('GET', '/api/print-locations?qty=12')).body.printLocations.find(l => l.included);
  const { draftToken } = (await guest('POST', '/api/draft-token', {})).body;
  const upload = async (name) => {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), name);
    fd.append('draftToken', draftToken);
    fd.append('printLocationCode', front.code);
    const resp = await fetch(`${BASE}/api/uploads`, { method: 'POST', body: fd });
    assert.strictEqual(resp.status, 200, await resp.clone().text());
    return (await resp.json());
  };
  await upload('logo-a.png');
  await upload('logo-b.png');
  const order = await guest('POST', '/api/quotes', {
    firstName: 'Acct', lastName: 'Tester', email, phone: '4785550000', termsAccepted: true, fulfillmentMethod: 'pickup', draftToken,
    garmentId: tee.id, colorSelections: [{ colorName: tee.colors[0].name, colorHex: tee.colors[0].hex, sizes: [{ label: 'M', qty: 12 }] }], printLocationIds: [front.id],
  });
  assert.strictEqual(order.status, 200, order.text);
  const code = order.body.quoteCode;
  assert.ok(/^3T-\d{5}$/.test(code), `order number is 3T- plus exactly five digits (${code})`);
  const adminOrder = (await admin('GET', `/api/admin/quotes/${code}`)).body;
  assert.ok(Number.isInteger(adminOrder.quote.id) && String(adminOrder.quote.id) !== code.slice(3), 'the database id is separate from the order number');
  console.log(`  ok: guest checkout still works; order number ${code}`);

  const ownerMail = (await admin('GET', '/api/admin/emails?q=' + encodeURIComponent(code))).body.emails.find(e => /^New Order Request/.test(e.subject));
  assert.ok(ownerMail, 'the owner notification says "New Order Request"');
  assert.ok(!(await admin('GET', '/api/admin/emails?q=New%20Order%20Submitted')).body.emails.some(e => e.quoteCode === code));
  console.log('  ok: "New Order Request" wording');

  // ---- email viewer ----
  const quoteMail = await latestEmail(email, /quote/i);
  assert.ok(quoteMail && quoteMail.bodyHtml.includes(code), 'the full body of a sent email can be opened');
  assert.strictEqual(quoteMail.quoteCode, code);
  assert.strictEqual(quoteMail.customerName, 'Acct Tester');
  assert.ok(quoteMail.status && quoteMail.sentAt && quoteMail.to === email);
  assert.strictEqual((await stranger('GET', '/api/admin/emails')).status, 401, 'the email log needs an admin login');
  console.log('  ok: email viewer shows customer, order, status and the full message');

  // ---- artwork queue: staged changes only take effect (and email) on Activate ----
  let queue = (await admin('GET', '/api/admin/artwork?filter=active&q=' + code)).body.artwork;
  assert.strictEqual(queue.length, 2, 'both files wait in the active queue');
  const [fileA, fileB] = queue;
  const artworkMails = async () => (await admin('GET', '/api/admin/emails?q=' + encodeURIComponent(email))).body.emails.filter(e => /artwork/i.test(e.subject)).length;
  const before = await artworkMails();
  assert.strictEqual((await admin('POST', '/api/admin/artwork/activate', { changes: [] })).status, 400, 'nothing to activate without changes');
  assert.strictEqual((await admin('POST', '/api/admin/artwork/activate', { changes: [{ id: fileA.id, status: 'bogus' }] })).status, 400);
  assert.strictEqual(await artworkMails(), before, 'no artwork email before Activate Updates');
  const act = await admin('POST', '/api/admin/artwork/activate', { changes: [{ id: fileA.id, status: 'approved' }, { id: fileB.id, status: 'declined' }] });
  assert.strictEqual(act.status, 200, act.text);
  assert.deepStrictEqual([act.body.saved, act.body.orders, act.body.emailed], [2, 1, 1], 'two changes on one order send one email');
  assert.strictEqual(await artworkMails(), before + 1);
  const artMail = await latestEmail(email, /artwork/i);
  assert.ok(/needs a revision/i.test(artMail.subject) && artMail.bodyHtml.includes('Approved') && artMail.bodyHtml.includes('Declined'));
  queue = (await admin('GET', '/api/admin/artwork?filter=active&q=' + code)).body.artwork;
  assert.deepStrictEqual(queue.map(f => f.id), [fileB.id], 'approved artwork leaves the active queue');
  assert.strictEqual(queue[0].statusLabel, 'Declined');
  assert.ok((await admin('GET', '/api/admin/artwork?filter=declined&q=' + code)).body.artwork.length === 1);
  assert.ok((await admin('GET', '/api/admin/artwork?filter=approved&q=' + code)).body.artwork.some(f => f.id === fileA.id), 'approved artwork is still findable');
  const detail = (await admin('GET', `/api/admin/quotes/${code}`)).body;
  assert.ok(detail.artwork.some(f => f.id === fileA.id && f.status === 'approved'), 'approved artwork stays on the order');
  assert.ok(detail.events.some(e => e.event_type === 'artwork_activated') && detail.events.some(e => e.event_type === 'artwork_status') && detail.events.some(e => e.event_type === 'email_sent'), 'activity history records the changes and the email');
  const files = (await admin('GET', `/api/admin/customers/${detail.customer.id}/files`)).body;
  assert.ok(files.artwork.some(f => f.id === fileA.id) && files.emails.length >= 2 && files.activity.length >= 3, 'approved artwork, emails and activity live on the customer');
  assert.strictEqual((await admin('POST', '/api/admin/artwork/activate', { changes: [{ id: fileA.id, status: 'approved' }] })).body.emailed, 0, 'activating a status that did not change emails nobody');
  console.log('  ok: staged artwork updates, one email on Activate, approved leaves the queue but stays on order and customer');

  // ---- deleting artwork ----
  assert.strictEqual((await stranger('DELETE', `/api/admin/artwork/${fileB.id}`)).status, 401);
  assert.strictEqual((await admin('DELETE', `/api/admin/artwork/${fileB.id}`)).status, 200);
  assert.ok(!(await admin('GET', `/api/admin/quotes/${code}`)).body.artwork.some(f => f.id === fileB.id), 'a deleted file is gone from the order');
  assert.strictEqual((await fetch(BASE + fileB.url)).status, 404, 'the stored file is removed');
  await admin('POST', `/api/admin/quotes/${code}/payment`, { amount: 1000, method: 'cash' });
  await admin('PATCH', `/api/admin/quotes/${code}/status`, { status: 'completed' });
  const kept = await admin('DELETE', `/api/admin/artwork/${fileA.id}`);
  assert.strictEqual(kept.status, 409, 'artwork on a completed order is kept');
  assert.strictEqual((await fetch(BASE + fileA.url)).status, 200);
  console.log('  ok: Delete File removes the file; a completed order keeps its artwork');

  // ---- customer account: sign up, verify, log in ----
  assert.strictEqual((await customer('POST', '/api/account/register', { firstName: 'Acct', lastName: 'Tester', email, password: 'short' })).status, 400, 'short passwords are refused');
  const reg = await customer('POST', '/api/account/register', { firstName: 'Acct', lastName: 'Tester', email, password: 'correct horse 42' });
  assert.strictEqual(reg.status, 200, reg.text);
  const early = await customer('POST', '/api/account/login', { email, password: 'correct horse 42' });
  assert.strictEqual(early.status, 400);
  assert.ok(early.body.unverified, 'an unverified account cannot log in');
  assert.strictEqual((await customer('GET', '/api/account/dashboard')).status, 401);
  const verifyMail = await latestEmail(email, /verify your email/i);
  const token = verifyMail.bodyHtml.match(/verify-email\?token=([0-9a-f]+)/)[1];
  assert.strictEqual((await stranger('GET', '/verify-email?token=' + 'f'.repeat(64))).location, '/login?verify=expired', 'a bad link verifies nothing');
  assert.strictEqual((await customer('GET', `/verify-email?token=${token}`)).location, '/account?verified=1');
  assert.strictEqual((await stranger('GET', `/verify-email?token=${token}`)).location, '/login?verify=expired', 'a verification link works once');
  await customer('POST', '/api/account/logout');
  assert.strictEqual((await customer('POST', '/api/account/login', { email, password: 'wrong password' })).status, 400);
  assert.strictEqual((await customer('POST', '/api/account/login', { email: email.toUpperCase(), password: 'correct horse 42' })).status, 200);
  console.log('  ok: account needs a verified email; wrong passwords and reused links are refused');

  // ---- dashboard: the guest order placed earlier with this email is there ----
  const dash = (await customer('GET', '/api/account/dashboard')).body;
  assert.ok(dash.pastOrders.some(o => o.orderNumber === code), 'the earlier guest order shows on the account');
  assert.ok(dash.designs.some(f => f.orderNumber === code && f.name === 'logo-a.png'), 'approved artwork is a saved design linked to its order');
  assert.ok(!JSON.stringify(dash).includes('password'), 'nothing about the password is ever sent');
  const other = client();
  const otherEmail = `other.${stamp}@example.com`;
  await other('POST', '/api/account/register', { firstName: 'Other', lastName: 'Person', email: otherEmail, password: 'another pass 9' });
  await other('GET', `/verify-email?token=${(await latestEmail(otherEmail, /verify your email/i)).bodyHtml.match(/token=([0-9a-f]+)/)[1]}`);
  assert.ok(!(await other('GET', '/api/account/dashboard')).body.pastOrders.length, "another customer's orders are not visible");
  assert.strictEqual((await other('POST', `/api/account/orders/${code}/reorder`, {})).status, 400, "another customer's order cannot be reordered");
  console.log('  ok: dashboard shows only that customer\'s orders, designs and mockups');

  // ---- profile ----
  const prof = await customer('PUT', '/api/account/profile', { firstName: 'Acct', lastName: 'Tester', email, phone: '4785550000', businessName: 'ABC Construction', occupation: 'Owner', birthday: '1990-05-17', bio: 'Hello', address: { line1: '1 Main St', city: 'Macon', state: 'GA', zip: '31204' } });
  assert.strictEqual(prof.status, 200, prof.text);
  assert.strictEqual(prof.body.profile.businessName, 'ABC Construction');
  const newEmail = `acct.new.${stamp}@example.com`;
  const change = await customer('PUT', '/api/account/profile', { ...prof.body.profile, email: newEmail });
  assert.strictEqual(change.body.emailChange, newEmail);
  assert.strictEqual(change.body.profile.email, email, 'the login email does not change until the new one is verified');
  await customer('GET', `/verify-email?token=${(await latestEmail(newEmail, /verify your email/i)).bodyHtml.match(/token=([0-9a-f]+)/)[1]}`);
  assert.strictEqual((await customer('GET', '/api/account/me')).body.profile.email, newEmail, 'verifying the link completes the email change');
  const adminFiles = (await admin('GET', `/api/admin/customers/${detail.customer.id}/files`)).body;
  assert.ok(adminFiles.account.hasAccount && adminFiles.account.verified && adminFiles.account.profile.occupation === 'Owner', 'the admin profile shows the account and profile details');
  assert.ok(!/password|hash/i.test(JSON.stringify(adminFiles.account)), 'the admin never sees a password');
  console.log('  ok: profile fields save; an email change needs verification');

  // ---- reorder: a new order linked to the original, original untouched ----
  const pkg = await customer('POST', `/api/account/orders/${code}/reorder`, {});
  assert.strictEqual(pkg.status, 200, pkg.text);
  assert.strictEqual(pkg.body.payload.reorderOf, code);
  const again = await customer('POST', '/api/quotes', { ...pkg.body.payload, termsAccepted: true });
  assert.strictEqual(again.status, 200, again.text);
  assert.notStrictEqual(again.body.quoteCode, code);
  const reorder = (await admin('GET', `/api/admin/quotes/${again.body.quoteCode}`)).body;
  assert.strictEqual(reorder.quote.reorder_source_quote_id, adminOrder.quote.id, 'the new order records which order it came from');
  assert.ok(reorder.artwork.some(f => f.original_filename === 'logo-a.png' && f.status === 'approved'), 'approved artwork carries over, already approved');
  assert.strictEqual((await admin('GET', `/api/admin/quotes/${code}`)).body.quote.status, 'completed', 'the original order is unchanged');
  assert.ok((await customer('GET', '/api/account/dashboard')).body.quotes.some(o => o.orderNumber === again.body.quoteCode && o.reorderOf === code));
  console.log('  ok: Reorder makes a new linked order request and leaves the original alone');

  // ---- User Access ----
  assert.strictEqual((await stranger('GET', '/api/admin/user-access')).status, 401);
  const users = (await admin('GET', '/api/admin/user-access?q=' + encodeURIComponent(newEmail))).body.users;
  assert.strictEqual(users.length, 1);
  assert.ok(users[0].verified && !('password' in users[0]) && !('passwordHash' in users[0]));
  assert.strictEqual((await admin('POST', '/api/admin/user-access/send', { kind: 'reset', accountIds: [] })).status, 400);
  assert.strictEqual((await admin('POST', '/api/admin/user-access/send', { kind: 'reset', accountIds: [users[0].id] })).body.sent, 1);
  const resetToken = (await latestEmail(newEmail, /reset your/i)).bodyHtml.match(/reset-password\.html\?token=([0-9a-f]+)/)[1];
  assert.strictEqual((await stranger('POST', '/api/account/reset-password', { token: resetToken, password: 'brand new pass 7' })).status, 200);
  assert.strictEqual((await stranger('POST', '/api/account/reset-password', { token: resetToken, password: 'second try pass 8' })).status, 400, 'a reset link works once');
  assert.strictEqual((await client()('POST', '/api/account/login', { email: newEmail, password: 'correct horse 42' })).status, 400, 'the old password stops working');
  assert.strictEqual((await client()('POST', '/api/account/login', { email: newEmail, password: 'brand new pass 7' })).status, 200);
  assert.deepStrictEqual((await admin('POST', '/api/admin/user-access/send', { kind: 'verification', accountIds: [users[0].id] })).body.skipped, [newEmail], 'no verification email for an already verified user');
  console.log('  ok: User Access sends reset emails; passwords are never exposed');

  // ---- public pages: no Admin link ----
  for (const page of ['/', '/index.html', '/print.html?type=stickers']) {
    const html = (await stranger('GET', page)).text;
    assert.ok(!/href="\/admin"/.test(html) && />Login</.test(html), `${page} shows Login, not Admin`);
  }
  assert.strictEqual((await stranger('GET', '/login')).status, 200);
  assert.strictEqual((await stranger('GET', '/admin')).location, '/admin/login.html', 'the admin still needs its own login');
  assert.strictEqual((await stranger('GET', '/api/admin/quotes')).status, 401);
  console.log('  ok: the public site links to Login; admin stays behind its own login');

  // ---- webhooks: Shopify ----
  const fresh = await guest('POST', '/api/quotes', {
    firstName: 'Hook', lastName: 'Tester', email: `hook.${stamp}@example.com`, phone: '4785550001', termsAccepted: true, fulfillmentMethod: 'shipping',
    shippingAddress: { line1: '1 Main St', city: 'Macon', state: 'GA', zip: '31204' }, artworkPending: true,
    garmentId: tee.id, colorSelections: [{ colorName: tee.colors[0].name, sizes: [{ label: 'M', qty: 12 }] }], printLocationIds: [front.id],
  });
  const hookCode = fresh.body.quoteCode;
  const shopify = (topic, payload, { eventId, secret = 'test-shopify-secret' } = {}) => {
    const body = JSON.stringify(payload);
    return stranger('POST', '/api/webhooks/shopify', body, {
      'x-shopify-topic': topic, 'x-shopify-event-id': eventId || crypto.randomUUID(),
      'x-shopify-hmac-sha256': crypto.createHmac('sha256', secret).update(body).digest('base64'),
    });
  };
  const shopOrder = { id: 990000 + (stamp % 9000), admin_graphql_api_id: undefined, name: '#1042', financial_status: 'paid', total_price: '300.00', total_outstanding: '0.00', customer: { id: 555 }, note_attributes: [{ name: 'quote_id', value: hookCode }] };
  assert.strictEqual((await shopify('orders/paid', shopOrder, { secret: 'wrong' })).status, 401, 'a wrongly signed webhook is rejected');
  assert.ok(!(await admin('GET', `/api/admin/quotes/${hookCode}`)).body.quote.paid_at);
  const paidEvent = crypto.randomUUID();
  assert.strictEqual((await shopify('orders/paid', shopOrder, { eventId: paidEvent })).body.result, 'paid');
  let hooked = (await admin('GET', `/api/admin/quotes/${hookCode}`)).body;
  assert.strictEqual(hooked.quote.payment_provider, 'shopify');
  assert.strictEqual(hooked.quote.amount_paid, 300);
  assert.strictEqual(hooked.quote.shopify_order_number, '#1042');
  assert.strictEqual(hooked.quote.shopify_customer_id, '555');
  assert.ok(['paid', 'deposit_paid'].includes(hooked.quote.status));
  assert.strictEqual((await shopify('orders/paid', shopOrder, { eventId: paidEvent })).body.duplicate, true, 'a repeated delivery is ignored');
  await shopify('orders/updated', shopOrder);
  hooked = (await admin('GET', `/api/admin/quotes/${hookCode}`)).body;
  assert.strictEqual(hooked.events.filter(e => e.event_type === 'paid').length, 1, 'the payment is recorded once');
  const paidMails = (await admin('GET', '/api/admin/emails?q=' + encodeURIComponent(`hook.${stamp}@example.com`))).body.emails.filter(e => /thank you for your order/i.test(e.subject)).length;
  assert.strictEqual(paidMails, 1, 'one payment email, however many times Shopify sends the event');
  await shopify('fulfillments/create', { order_id: shopOrder.id, status: 'success', tracking_company: 'UPS', tracking_number: '1Z999', tracking_url: 'https://ups.example/1Z999' });
  hooked = (await admin('GET', `/api/admin/quotes/${hookCode}`)).body;
  assert.strictEqual(hooked.quote.status, 'shipped');
  assert.strictEqual(hooked.quote.tracking_number, '1Z999');
  assert.strictEqual((await shopify('refunds/create', { order_id: shopOrder.id, transactions: [{ kind: 'refund', status: 'success', amount: '300.00' }] })).body.result, 'refunded');
  hooked = (await admin('GET', `/api/admin/quotes/${hookCode}`)).body;
  assert.strictEqual(hooked.quote.status, 'refunded');
  assert.strictEqual(hooked.quote.amount_refunded, 300);
  assert.strictEqual((await admin('GET', `/api/admin/quotes?q=${hookCode}`)).body.quotes.length, 1, 'Shopify never creates a second internal order');
  console.log('  ok: Shopify webhooks: signed, de-duplicated, payment once, shipment and refund update the one order');

  // ---- webhooks: Square ----
  const sq = await guest('POST', '/api/quotes', {
    firstName: 'Square', lastName: 'Tester', email: `square.${stamp}@example.com`, phone: '4785550002', termsAccepted: true, fulfillmentMethod: 'pickup', artworkPending: true,
    garmentId: tee.id, colorSelections: [{ colorName: tee.colors[0].name, sizes: [{ label: 'M', qty: 12 }] }], printLocationIds: [front.id],
  });
  const sqCode = sq.body.quoteCode;
  const square = (event, { key = 'test-square-key' } = {}) => {
    const body = JSON.stringify(event);
    return stranger('POST', '/api/webhooks/square', body, { 'x-square-hmacsha256-signature': crypto.createHmac('sha256', key).update(`${BASE}/api/webhooks/square` + body).digest('base64') });
  };
  const payment = { id: `pay_${stamp}`, order_id: `sqo_${stamp}`, customer_id: 'sqc_1', status: 'COMPLETED', total_money: { amount: 25000, currency: 'USD' }, note: `Order ${sqCode}` };
  const sqEvent = { event_id: crypto.randomUUID(), type: 'payment.updated', data: { object: { payment } } };
  assert.strictEqual((await square(sqEvent, { key: 'wrong' })).status, 401);
  assert.strictEqual((await square(sqEvent)).body.result, 'paid');
  assert.strictEqual((await square(sqEvent)).body.duplicate, true);
  assert.strictEqual((await square({ ...sqEvent, event_id: crypto.randomUUID() })).body.result, 'already paid', 'a second event for the same payment does not pay twice');
  let sqOrder = (await admin('GET', `/api/admin/quotes/${sqCode}`)).body;
  assert.deepStrictEqual([sqOrder.quote.payment_provider, sqOrder.quote.amount_paid, sqOrder.quote.square_payment_id, sqOrder.quote.square_order_id, sqOrder.quote.square_customer_id], ['square', 250, payment.id, payment.order_id, 'sqc_1']);
  assert.strictEqual(sqOrder.events.filter(e => e.event_type === 'paid').length, 1);
  await square({ event_id: crypto.randomUUID(), type: 'refund.updated', data: { object: { refund: { payment_id: payment.id, status: 'COMPLETED', amount_money: { amount: 5000 } } } } });
  sqOrder = (await admin('GET', `/api/admin/quotes/${sqCode}`)).body;
  assert.strictEqual(sqOrder.quote.amount_refunded, 50, 'a partial refund is recorded');
  assert.notStrictEqual(sqOrder.quote.status, 'refunded');
  console.log('  ok: Square webhooks: signed, de-duplicated, payment and refund update the one order');

  // ---- restore settings ----
  await admin('PUT', '/api/admin/settings', {
    shopify_client_secret: settingsBefore.shopify_client_secret || '', square_webhook_signature_key: '', square_webhook_url: '',
    email_provider: settingsBefore.email_provider || 'mock', payment_provider: settingsBefore.payment_provider || 'mock',
  });
  console.log('ALL ACCOUNT / WORKFLOW / WEBHOOK CHECKS PASSED');
}

main().then(() => process.exit(0)).catch(err => { console.error('TEST FAILED:', err); process.exit(1); });
