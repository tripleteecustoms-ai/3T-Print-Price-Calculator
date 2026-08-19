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
automatically the first time the server starts. Delete that file (and the
`data/` and `uploads/` folders) to reset to a clean demo state.

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

## What's implemented

**Customer Order Builder** (`/index.html`) — a 6-step mobile-first configurator:
garment → color(s) → size/quantity matrix → print locations → per-location
artwork upload → contact info. Every price shown is fetched live from the
server (`POST /api/estimate`); nothing is calculated or trusted client-side.
Orders over 24 pieces are blocked from continuing and shown a "Get a Bulk
Quote" path instead of being silently priced wrong.

**Customer Quote / Order Review Page** (`/quote.html?id=3T-...`) — itemized,
receipt-style quote (never shows cost/margin/floor), with Pay & Place Order
(primary), Edit My Order (reloads the builder with prior selections), and
Request Review (secondary, clearly optional) actions. Handles quote
expiration with a "Recalculate My Order" path, and redirects to the paid
Order Received page once a quote has been paid.

**Owner/Admin Backend** (`/admin/`) — session-authenticated dashboard covering
Dashboard, Quotes, Paid Orders, Customers, Garments (with colors/sizes/surcharges),
Pricing (the 1–24 matrix + internal cost settings), Print Locations (each with
its own 1–24 pricing matrix), Artwork (status review queue), and Settings
(business info, payment provider, email provider, password). The quote detail
view shows standard price / hard floor / current price / max discount side by
side, lets the owner override pricing down to (or below, with an explicit
confirmation checkbox) the hard floor, and always shows internal cost and
margin — never exposed to the customer-facing views.

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
  unless `shopify_shop_domain` + `shopify_admin_token` are set (Settings >
  Payment, or `.env`). Without those, checkout automatically falls back to a
  clearly-labeled **mock checkout** (`/checkout-mock.html`) so the full
  quote → checkout → paid funnel is testable end-to-end. Square is stubbed
  with the same interface for later.
- `emailService.js` — mock mode logs every quote email to the `emails_sent`
  table (visible under Settings > Email in the admin) and writes a `.html`
  copy to `data/emails/`. Swap in a real provider by implementing
  `sendViaRealProvider()`-style logic and flipping `email_provider`.
- `storageService.js` — artwork is stored on local disk under `/uploads`
  with randomized filenames (never the customer's original filename, so
  URLs aren't guessable). Swap for S3/GCS by changing this one file.

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

Run it yourself:

```bash
node server/index.js &            # start the server
node test-e2e.js                  # run the full E2E suite
```

## Known limitations / what's mocked

This was built as a full working prototype per your instructions, with
Shopify, email, and file storage left pluggable rather than connected to
live accounts:

- **Shopify**: the Draft Order GraphQL integration is real code, but inactive
  until you add your shop domain + Admin API token in Settings. Until then,
  checkout uses the mock flow (clearly labeled on-screen).
- **Email**: mock provider only (logs to DB + `data/emails/*.html`). No SMTP/
  Postmark/SendGrid wiring yet — the interface (`emailService.send()`) is
  ready for it.
- **Square**: interface stubbed, not implemented.
- **Session store**: uses in-memory Express sessions — fine for a single
  server process; swap for a Redis/DB-backed store before scaling to
  multiple server instances.
- **Print compatibility per garment**: all active print locations are
  currently offered for every garment. The `garments` table has room to add
  per-garment restrictions later.
- Not yet built: bulk-quote intake beyond the "email us" handoff, and a
  dedicated abandoned-cart follow-up/reminder email sequence (the data needed
  for both — quote status timestamps, customer capture before quote
  generation — is already tracked and visible in the admin).

## Project structure

```
server/
  index.js              Express app entry point
  db.js                 SQLite schema
  seed.js                Initial pricing matrix, garment, admin login
  pricingEngine.js       Server-authoritative price/margin calculation
  idGen.js                Quote code generator (3T-YYMMDD-####)
  routes/customer.js      Public API (catalog, estimate, quotes, checkout, uploads)
  routes/admin.js         Admin API (auth, quotes, garments, pricing, settings)
  services/paymentService.js   Shopify Draft Order + mock checkout
  services/emailService.js     Quote email (mock provider)
  services/storageService.js   Local-disk artwork storage
public/
  index.html + js/builder.js      Customer Order Builder
  quote.html + js/quote.js        Customer Quote / Order Review page
  checkout-mock.html               Simulated Shopify checkout (fallback)
  order-received.html              Post-payment confirmation
  admin/                            Admin dashboard (login + SPA)
  css/brand.css                     Shared 3T design system
```
