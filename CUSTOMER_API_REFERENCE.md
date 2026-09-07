# Customer Profiles API — Quick Reference

All endpoints require admin authentication (session cookie from login).

---

## Endpoints

### 1. GET /api/admin/customers
**List customers with filters and pagination**

```bash
# Basic (first 50):
curl https://site.com/api/admin/customers

# With filters:
curl "https://site.com/api/admin/customers?status=active&page=1&limit=25"

# Search by email/company/name:
curl "https://site.com/api/admin/customers?search=acme"
```

**Response:**
```json
{
  "customers": [
    {
      "id": 1,
      "customer_code": "3T-CUST-260907-0001",
      "email": "john@acme.com",
      "phone": "478-555-1234",
      "company_name": "Acme Corp",
      "contact_name": "John Smith",
      "status": "active",
      "internal_notes": "Loves rush orders",
      "created_at": "2026-09-07T10:30:00.000Z",
      "updated_at": "2026-09-07T14:45:00.000Z",
      "created_by": 1
    }
  ],
  "total": 234,
  "page": 1,
  "pageSize": 50,
  "totalPages": 5
}
```

---

### 2. GET /api/admin/customers/:id
**Get single customer with full order history**

```bash
curl https://site.com/api/admin/customers/1
```

**Response:**
```json
{
  "customer": {
    "id": 1,
    "customer_code": "3T-CUST-260907-0001",
    "email": "john@acme.com",
    "status": "active",
    ...
  },
  "quotes": [
    {
      "id": 42,
      "quote_code": "Q-260907-001",
      "status": "paid",
      "total_price": 850.00,
      "created_at": "2026-08-15T...",
      ...
    }
  ],
  "notes": [
    {
      "id": 10,
      "note_text": "Called to discuss bulk order",
      "note_type": "internal",
      "created_by_name": "Trey",
      "created_at": "2026-09-07T14:30:00.000Z"
    }
  ],
  "paymentMethods": [
    {
      "id": 5,
      "provider": "stripe",
      "provider_ref": "pm_1234567",
      "is_default": true,
      "created_at": "2026-08-20T..."
    }
  ],
  "totalOrders": 12,
  "totalSpent": 4250.00
}
```

---

### 3. POST /api/admin/customers
**Create new customer**

```bash
curl -X POST https://site.com/api/admin/customers \
  -H "Content-Type: application/json" \
  -d '{
    "email": "john@acme.com",
    "phone": "478-555-1234",
    "companyName": "Acme Corp",
    "contactName": "John Smith",
    "status": "lead"
  }'
```

**Request Body:**
```json
{
  "email": "john@acme.com",           // REQUIRED, must be unique
  "phone": "478-555-1234",            // optional
  "companyName": "Acme Corp",         // optional
  "contactName": "John Smith",        // optional
  "status": "lead"                    // optional (default: 'lead')
}
```

**Response:**
```json
{
  "id": 123,
  "customerCode": "3T-CUST-260907-1234",
  "email": "john@acme.com",
  "status": "lead"
}
```

**Status:** `400` if email missing, `409` if email already exists

---

### 4. PUT /api/admin/customers/:id
**Update customer profile**

```bash
curl -X PUT https://site.com/api/admin/customers/1 \
  -H "Content-Type: application/json" \
  -d '{
    "status": "vip",
    "internalNotes": "High-value recurring customer"
  }'
```

**Request Body (all optional):**
```json
{
  "email": "new@email.com",
  "phone": "478-555-5678",
  "companyName": "Updated Corp",
  "contactName": "New Contact",
  "status": "active",              // lead|active|vip|inactive|blocked
  "internalNotes": "Some notes"
}
```

**Response:**
```json
{ "ok": true }
```

**Status:** `404` if customer not found, `409` if new email already in use

---

### 5. POST /api/admin/customers/:id/notes
**Add internal note to customer**

```bash
curl -X POST https://site.com/api/admin/customers/1/notes \
  -H "Content-Type: application/json" \
  -d '{
    "noteText": "Customer wants to discuss bulk pricing",
    "noteType": "internal"
  }'
```

**Request Body:**
```json
{
  "noteText": "Customer wants to discuss bulk pricing",  // REQUIRED
  "noteType": "internal"                                // optional
}
```

**Response:**
```json
{ "noteId": 456 }
```

**Status:** `400` if noteText missing, `404` if customer not found

---

### 6. POST /api/admin/customers/:id/payment-methods
**Add payment method to customer**

```bash
curl -X POST https://site.com/api/admin/customers/1/payment-methods \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "stripe",
    "providerRef": "pm_1234567",
    "isDefault": true
  }'
```

**Request Body:**
```json
{
  "provider": "stripe",              // stripe|square|paypal|clover (REQUIRED)
  "providerRef": "pm_1234567",       // ref from payment system (REQUIRED)
  "isDefault": true                  // set as default? (optional)
}
```

**Response:**
```json
{ "methodId": 789 }
```

**Status:** `400` if provider/providerRef missing, `404` if customer not found

---

## Query Parameters

### Status Filter
```
?status=lead        # new prospect
?status=active      # currently ordering
?status=vip         # high-value recurring
?status=inactive    # 60+ days no orders
?status=blocked     # do not contact
```

### Pagination
```
?limit=50&page=1    # default: 50 per page
?limit=100&page=2
```

### Search
```
?search=acme            # searches email, company_name, contact_name, customer_code
?search=john@example    # email search
?search=3T-CUST-260907  # customer code search
```

---

## Status Types (Pre-seeded)

| Key | Display Name | Color | Description |
|-----|--------------|-------|-------------|
| `lead` | Lead | #6366F1 (indigo) | New prospect |
| `active` | Active | #10B981 (green) | Actively ordering |
| `vip` | VIP | #F59E0B (amber) | High-value recurring |
| `inactive` | Inactive | #EF4444 (red) | 60+ days no orders |
| `blocked` | Blocked | #6B7280 (gray) | Do not contact |

---

## Auto-Generated Fields

These are set automatically (don't include in requests):

**customer_code**
- Format: `3T-CUST-YYMMDD-####`
- Example: `3T-CUST-260907-1234`
- Generated on create, never changes
- Unique identifier for customer

**created_at / updated_at**
- Timestamps set automatically
- ISO 8601 format

**created_by**
- Set to authenticated admin's ID
- Tracks who created the customer

---

## Error Responses

```json
// 400 Bad Request
{ "error": "Email required." }

// 401 Unauthorized (not logged in)
{ "error": "Not authenticated." }

// 404 Not Found
{ "error": "Customer not found." }

// 409 Conflict (email already exists)
{ "error": "Customer with this email already exists." }

// 500 Server Error
{ "error": "Database error message" }
```

---

## Linking Quotes to Customers

When creating a quote, use this to link it to a customer:

**Database Insert:**
```sql
INSERT INTO quote_customer_links (quote_id, customer_id)
VALUES (?, ?)
```

**REST API (manual assignment):**
```javascript
// Option A: Auto-create customer if new email
const email = req.body.email;
let customerId = db.prepare('SELECT id FROM customer_profiles WHERE email = ?').get(email)?.id;

if (!customerId) {
  // Generate code and create customer
  const code = `3T-CUST-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.random().toString().slice(2, 6).padStart(4, '0')}`;
  const info = db.prepare(`
    INSERT INTO customer_profiles (customer_code, email, phone, status)
    VALUES (?, ?, ?, 'lead')
  `).run(code, email, req.body.phone || null);
  customerId = info.lastInsertRowid;
}

// Link quote to customer
db.prepare('INSERT INTO quote_customer_links (quote_id, customer_id) VALUES (?, ?)')
  .run(quoteId, customerId);
```

---

## Example Workflow

### 1. Customer gets a quote
Customer builds order in quote builder, submits quote with email.

### 2. System creates customer (or finds existing)
If email is new → auto-create customer profile with status "lead"
If email exists → link quote to existing customer

### 3. Admin views customer
Admin goes to "Customers" page, clicks customer
Sees:
- All their past quotes
- Order history (total count, total $)
- Any internal notes
- Payment methods on file

### 4. Admin updates customer
Changes status from "lead" → "active" after first order
Adds note: "Great communication, prefers rush orders"

### 5. Admin tracks customer
Over time, customer profile builds history
VIP customers get bumped to "vip" status for priority
Inactive customers flagged for re-engagement campaign

---

## JavaScript Examples

```javascript
// List all customers
async function getCustomers(status = null) {
  const url = new URL('/api/admin/customers', window.location);
  if (status) url.searchParams.set('status', status);
  
  const res = await fetch(url);
  return res.json();
}

// Get single customer with history
async function getCustomerDetail(id) {
  const res = await fetch(`/api/admin/customers/${id}`);
  return res.json();
}

// Create new customer
async function createCustomer(email, company, name, status = 'lead') {
  const res = await fetch('/api/admin/customers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email, companyName: company, contactName: name, status
    })
  });
  return res.json();
}

// Update customer status
async function updateCustomerStatus(id, newStatus) {
  const res = await fetch(`/api/admin/customers/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus })
  });
  return res.json();
}

// Add note to customer
async function addCustomerNote(id, noteText) {
  const res = await fetch(`/api/admin/customers/${id}/notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ noteText, noteType: 'internal' })
  });
  return res.json();
}
```

---

## Rate Limiting

No rate limits on admin endpoints (authenticated users only).
Database handles concurrent writes safely.

---

## Deployment Checklist

- [ ] `/server/routes/customers.js` exists
- [ ] `admin.js` imports customers route: `const customerRoutes = require('./customers')`
- [ ] `admin.js` mounts route: `router.use('/customers', customerRoutes)`
- [ ] `db.js` has all 5 new tables in schema
- [ ] Database migrates on server boot (check Render logs)
- [ ] Test: `GET /api/admin/customers` returns empty array
- [ ] Test: `POST /api/admin/customers` with valid email creates customer
- [ ] Test: Created customer appears in list

Done! All endpoints ready to use.
