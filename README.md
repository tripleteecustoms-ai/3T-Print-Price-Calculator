# 3T Print Solutions — Custom Apparel Quote & Checkout System

A working prototype of the full quoting/checkout application: a customer-facing
order builder, an owner/admin pricing backend, and a customer quote/order-review
page — wired together with a server-authoritative pricing engine, artwork
uploads, mock email delivery, and a Shopify-shaped checkout handoff (with a
clearly-labeled mock fallback so the whole funnel works without live credentials).

This is a **runnable prototype**, not a production deployment. See
[Known limitations](#known-limitations--whats-mocked) before going live.

## Quick start

```bash
npm install
npm run seed      # optional — the server also seeds automatically on boot
npm start
```

Then open:

- **Customer order builder:** http://localhost:4790/
- **Admin dashboard:** http://localhost:4790/admin/login.html
  — username `admin`, password `3tprint-admin-2026` (change it under Settings > Account)

The database is a local SQLite file at `data/3tprint.sqlite`, created and seeded
automatically the first time the server starts. Uploaded artwork lives at
`data/uploads/`, and sent-email copies at `data/emails/` — everything the app
needs to keep is under the single `data/` folder on purpose (see
[Deploying](#deploying-to-a-host) below). Delete that folder to reset to a
clean demo state.

**No compiler or build tools required.** The database engine is
[sql.js](https://sql.js.org) — SQLite compiled to WebAssembly — rather than a
native Node module. Native database modules (like `better-sqlite3`) have to be
specially compiled for each computer's exact OS/CPU/Node version, which is a
common source of install failures on Windows machines without developer tools
installed (crashes like `Assertion failed: (env) != nullptr` deep in Node's
native module loader are a symptom of exactly that). sql.js sidesteps this
entirely — `npm install` never needs to compile anything, on any platform.
The tradeoff is that sql.js runs the database fully in memory and this app
writes a fresh snapshot to `data/3tprint.sqlite` after every change — plenty
fast at this app's scale, and the file itself is still completely standard
SQLite, so any normal SQLite viewer can open it directly.

## Deploying to a host

This app needs to run continuously on a server — it can't be dropped into a
static website file manager. [Render](https://render.com) is a simple option:
connect this repo as a Web Service (Build Command `npm install`, Start
Command `npm start`), then attach a **persistent disk** mounted at
`data` (Render requires a paid instance type for disks — the free tier
doesn't support them). Everything the app needs to survive a restart or
redeploy — the database, uploaded artwork, and mock email log — lives under
that one `data/` folder, so a single disk covers all of it.

### Embedding it on your existing website

Once it's deployed and has its own link (see above), embed it directly on
your site with an iframe:

```html
<iframe src="https://order.yoursite.com" style="width:100%;height:900px;border:none;"></iframe>
```

Most site builders (Wix, Squarespace, WordPress, Shopify's own theme editor)
have an "Embed" / "Custom HTML" block where this snippet goes. Two things
are already handled so this works smoothly:

- The server sends no `X-Frame-Options` or `frame-ancestors` header, so
  nothing blocks it from being framed on another domain.
- Clicking **Confirm Order** always escapes to the full browser tab
  (`window.top.location.href`) before handing off to Shopify or the mock
  checkout, rather than trying to load that page inside the nested iframe.
  Real payment pages (Shopify's included) refuse to render inside someone
  else's iframe as a security measure, so without this the Pay step would
  look broken once embedded.

One tradeoff to know about: an iframe has a fixed height, but this app's
content height changes a lot between steps (a short contact form vs. a tall
garment grid vs. a checkout page). `height:900px` above is a reasonable
one-size default, but on some steps it'll leave dead space and on others it
may require scrolling inside the box. If that bothers you, ask about adding
auto-resize (the embedded page can report its real height to the parent page
so the iframe grows/shrinks to fit) — it's a small addition on top of this.

## What's implemented

**Customer Order Builder** (`/index.html`) — a 6-step mobile-first configurator:
garment → color(s) → size/quantity matrix → print locations → per-location
artwork upload → contact info. Every price shown is fetched live from the
server (`POST /api/estimate`); nothing is calculated or trusted client-side.
Orders over 24 pieces are blocked from continuing and shown a "Get a Bulk
Quote" path instead of being silently priced wrong. The **order of these six
steps itself is admin-configurable** — see Settings > Layout below. Each
print location also lets the customer pick a **design size** — Standard
(11in wide), Large Graphic (13in wide, +$1.50/shirt), or Oversized (15.5in
wide, +$2.50/shirt) — priced server-side like everything else.

**Customer Quote / Order Review Page** (`/quote.html?id=3T-...`) — itemized,
receipt-style quote (never shows cost/margin/floor), with Confirm Order
(primary), Edit My Order (reloads the builder with prior selections), and
Request Review (secondary, clearly optional) actions, plus a discount-code
box the customer can apply or remove themselves (validated server-side —
inactive/expired/usage-exhausted codes are rejected with a clear message,
and a code can never push the total below $0). Handles quote expiration with
a "Recalculate My Order" path, and redirects to the paid Order Received page
once a quote has been paid.

**Owner/Admin Backend** (`/admin/`) — session-authenticated dashboard covering
Dashboard, Quotes, Paid Orders, Customers, Garments (with colors/sizes/surcharges,
and a direct image-upload field per garment — no more pasting URLs), Pricing
(the 1–24 matrix + internal cost settings), Print Locations (each with its
own 1–24 pricing matrix), Artwork (status review queue), **Mockups** (a
dedicated tab for uploading a design mockup against any order — it emails the
customer a no-login approval link where they can Approve or Request Changes
with a note, and you get notified either way), **Discounts** (create/edit
percent-off or flat-$-off codes, with a one-click random code generator,
usage limits, and expiration dates), **Analytics** (visitor/funnel tracking
from page load through paid, UTM traffic-source attribution with conversion
rates, revenue-by-day, top-selling garments, and repeat-customer rate — all
first-party, no cookies/no external tracker), and Settings (business info,
payment provider, email provider, **Layout** — drag-and-drop or arrow-button
reordering of the customer builder's 6 steps — and password). The quote
detail view shows standard price / hard floor / current price / max discount
side by side, lets the owner override pricing down to (or below, with an
explicit confirmation checkbox) the hard floor, send a one-click reminder
email on any unpaid order, always shows internal cost and margin (never
exposed to the customer-facing views), lists each garment color as its own
row with a color swatch next to the size breakdown, and every uploaded
artwork file is clickable (opens full-size in a new tab) with an explicit
Download link. Color swatches include 4 recent additions: Soft Pink, Safety
Orange, Safety Yellow, and Safety Green.

**Customer email notifications** — the customer automatically gets an
itemized quote email the moment a quote is generated *and* again the moment
they click Confirm Order (so they have a record of the price even if they
don't finish paying), plus a status update email any time the owner changes
an order's status in the admin (needs review, artwork issue, approved, in
production, ready for pickup, shipped, completed, cancelled, refunded) or the
order is marked paid. The owner can also send a manual reminder email on any
unpaid order at any time (Quotes/Orders > Send Reminder), and a mockup
approval email with Approve/Request Changes links whenever one is uploaded.
All of this goes through the same swappable `emailService` — **mock by
default** (logged + saved to `data/emails/*.html`), or **real Gmail SMTP**
once you connect a Gmail address + app password under Settings > Email (see
below).

**Gmail email delivery** — Settings > Email lets you switch the active
provider to Gmail and enter your Gmail address plus a 16-character **App
Password** (Google Account > Security > 2-Step Verification > App Passwords
— this is not your regular Gmail password, and 2-Step Verification has to be
turned on first). A "Send Test Email" button confirms it's wired up correctly
before you rely on it for real orders.

**First-party analytics** — a small script (`public/js/analytics.js`) tracks
page views, which builder step each visitor reaches, quote generation, and
checkout starts, tagged with a random visitor/session ID (no cookies, no
third-party tracker, nothing that identifies a person) and any `utm_source`
/`utm_medium`/`utm_campaign` on the incoming link. "Paid" is always read from
the order record itself, never a client-side event, so it can't be missed
just because a customer's browser didn't stay on the page through checkout.

**Pricing engine** (`server/pricingEngine.js`) is the single source of truth.
It is re-run **server-side** at quote generation, at checkout, and again if a
quote is edited — the browser can never dictate a price. Every quote stores a
frozen `pricing_snapshot` (matrix version, garment, sizes, colors, print
locations, unit prices, totals) so changing pricing tomorrow never rewrites
yesterday's quote.

**Payment / email / storage are built as swappable service modules**
(`server/services/*.js`), matching what this session was scoped to build —
a full prototype with those three integrations left pluggable rather than
wired to real accounts:

- `paymentService.js` — `createShopifyDraftOrder()` is a real, complete
  Shopify Admin GraphQL `draftOrderCreate` call. It's simply never invoked
  unless `shopify_shop_domain` + `shopify_client_id` + `shopify_client_secret`
  are set (Settings > Payment, or `.env`) — see **Shopify setup** below for
  exactly how to get those. Without them, checkout automatically falls back
  to a clearly-labeled **mock checkout** (`/checkout-mock.html`) so the full
  quote → checkout → paid funnel is testable end-to-end. Square is stubbed
  with the same interface for later.
- `emailService.js` — mock mode logs every quote email to the `emails_sent`
  table (visible under Settings > Email in the admin) and writes a `.html`
  copy to `data/emails/`. Swap in a real provider by implementing
  `sendViaRealProvider()`-style logic and flipping `email_provider`.
- `storageService.js` — artwork is stored on local disk under `data/uploads/`
  with randomized filenames (never the customer's original filename, so
  URLs aren't guessable). Swap for S3/GCS by changing this one file.

## Shopify setup

Shopify retired the old "create a custom app in your store's Settings, copy
one token" flow for new apps in January 2026. The current path for a
single-store custom app is the **Client Credentials Grant**, via Shopify's
Dev Dashboard:

1. In your Shopify admin, go to **Settings → Apps**, click **Develop apps**,
   then **"Build apps using Dev Dashboard."**
2. In the Dev Dashboard, click **Create app**, name it (e.g. "3T Print
   Solutions"), and create it.
3. On the app's configuration page, set an App URL (any placeholder is fine —
   this app never needs one), and under **Scopes**, select only
   `write_draft_orders` and `read_draft_orders` (no need for anything
   broader). Click **Release**.
4. Under **Distribution**, choose **Custom distribution**, enter your store
   domain, and click **Generate Link**. Open that link and click **Install**
   on your store.
5. Back in the Dev Dashboard, open the app's settings — you'll see a
   **Client ID** and **Client Secret**. Copy both.
6. Paste your store domain, Client ID, and Client Secret into this app's
   Settings > Payment tab (or `SHOPIFY_SHOP_DOMAIN` / `SHOPIFY_CLIENT_ID` /
   `SHOPIFY_CLIENT_SECRET` in `.env`), then set Active Provider to Shopify.

Behind the scenes, `paymentService.js` exchanges that Client ID/Secret for a
real access token on demand and caches it — Shopify's tokens expire every 24
hours, so the app automatically fetches a fresh one shortly before the old
one expires. You never need to touch this again once the Client ID/Secret
are saved.

## Data model

SQLite tables (see `server/db.js` for full schema): `customers`, `quotes`,
`quote_items` (color × size lines), `quote_print_locations`, `garments`,
`garment_colors`, `garment_sizes`, `pricing_tiers`, `print_locations`,
`print_location_pricing`, `artwork_files`, `quote_events` (full audit trail
per quote — generated/viewed/checkout started/paid/review requested/status
changes/overrides), `emails_sent`, `admins`, `settings`.

Quote codes are human-readable and never expose a raw DB id:
`3T-YYMMDD-####` (e.g. `3T-260819-1042`).

## Verifying the pricing math

The base matrix, hard-floor matrix, and back-print add-on matrix are seeded
exactly as specified. An automated Playwright run (`test-e2e.js`) drives the
full customer → checkout → admin flow and asserts, among other things:

- 24 pcs, front + back, with 2XL/3XL surcharges → **$609.00** (matches the
  worked example: $480 base + $120 back + $9 size adjustments)
- 24 pcs, front only, standard pricing → **$480.00**
- Standard price $20.00 / hard floor $16.67 at qty 24 tiles correctly in the
  admin quote view
- An owner override below the hard floor is **blocked until explicitly
  confirmed**, then applied and flagged as a below-floor exception
- A tampered client request (`total: 1` injected into the payload) is
  **ignored** — the server recalculates the real total independently

There are four companion suites: `test-newfeatures.js` (garment catalog,
clickable step tabs, per-garment pricing), `test-notifications.js` (the
pay-click and status-change customer emails, plus the admin color-swatch and
artwork-link UI), `test-shopify-auth.js` (the Shopify Client Credentials
Grant token exchange — caching, automatic refresh, and the missing-credentials
fallback — using a faked network response, so it needs no real Shopify store),
and `test-embed.js` (confirms the app can be framed on another site, and that
the Pay step correctly escapes the iframe).

Run them yourself:

```bash
node server/index.js &            # start the server
node test-e2e.js                  # full E2E suite
node test-newfeatures.js          # garments / tabs / pricing
node test-notifications.js        # email notifications + admin UI
node test-shopify-auth.js         # Shopify token exchange (standalone, no server needed)
node test-embed.js                # iframe embedding + payment-redirect escape
```

## Known limitations / what's mocked

This was built as a full working prototype per your instructions, with
Shopify, email, and file storage left pluggable rather than connected to
live accounts:

- **Shopify**: the Draft Order GraphQL integration is real code, but inactive
  until you add your shop domain + Client ID/Secret in Settings > Payment.
  Until then, checkout uses the mock flow (clearly labeled on-screen).
- **Email**: real delivery works via **Gmail SMTP** (Settings > Email, using
  an app password — see above) or the mock provider (logs to DB +
  `data/emails/*.html`). No Postmark/SendGrid/other-ESP wiring yet — the
  interface (`emailService.send()`) is ready for it.
- **Square**: interface stubbed, not implemented.
- **Session store**: uses in-memory Express sessions — fine for a single
  server process; swap for a Redis/DB-backed store before scaling to
  multiple server instances.
- **Print compatibility per garment**: all active print locations are
  currently offered for every garment. The `garments` table has room to add
  per-garment restrictions later.
- **Reminders are manual, not automatic**: Settings has no "send a reminder
  after N days automatically" scheduler yet — the owner clicks "Send
  Reminder" on an unpaid order from Quotes/Orders. The data needed for a
  future automatic drip (quote status timestamps, customer capture before
  quote generation) is already tracked and visible in the admin.
- Not yet built: bulk-quote intake beyond the "email us" handoff.

## Project structure

```
server/
  index.js              Express app entry point
  db.js                 SQLite schema + migrations (backfills new columns/settings on an existing DB)
  seed.js                Initial pricing matrix, garment, admin login, default settings
  pricingEngine.js       Server-authoritative price/margin calculation + step-order validation
  idGen.js                Quote code generator (3T-YYMMDD-####)
  routes/customer.js      Public API (catalog, estimate, quotes, checkout, discounts, mockups, analytics)
  routes/admin.js         Admin API (auth, quotes, garments, pricing, settings, mockups, discounts, analytics, layout)
  services/paymentService.js   Shopify Draft Order + mock checkout
  services/emailService.js     Quote/reminder/mockup emails — mock provider or real Gmail SMTP
  services/storageService.js   Local-disk storage (artwork, garment images, mockups)
public/
  index.html + js/builder.js      Customer Order Builder (step order driven by /api/business-info)
  quote.html + js/quote.js        Customer Quote / Order Review page (discount box, itemized breakdown)
  mockup-approval.html + js/mockup-approval.js   No-login mockup Approve/Request-Changes page
  js/analytics.js                  First-party visitor/funnel tracking, fired from builder.js + quote.js
  checkout-mock.html               Simulated Shopify checkout (fallback)
  order-received.html              Post-payment confirmation
  admin/                            Admin dashboard (login + SPA) — see admin/js/admin.js for all admin-side logic
  css/brand.css                     Shared 3T design system
```
