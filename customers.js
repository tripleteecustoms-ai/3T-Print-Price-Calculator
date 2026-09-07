// server/routes/customers.js
// Customer Profile management (CRM system) endpoints
// All endpoints require admin authentication (handled by middleware in admin.js)

const express = require('express');
const db = require('../db');
const router = express.Router();

function generateCustomerCode() {
  const now = new Date();
  const yymmdd = `${String(now.getYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const random = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  return `3T-CUST-${yymmdd}-${random}`;
}

// ========== GET: List all customers with filters ==========
router.get('/', (req, res) => {
  const { status, search, limit = 50, page = 1 } = req.query;
  
  let sql = 'SELECT * FROM customer_profiles WHERE 1=1';
  const params = [];
  
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  
  if (search) {
    sql += ' AND (email LIKE ? OR company_name LIKE ? OR contact_name LIKE ? OR customer_code LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }
  
  const total = db.prepare(`SELECT COUNT(*) as cnt FROM customer_profiles WHERE 1=1
    ${status ? 'AND status = ?' : ''}
    ${search ? 'AND (email LIKE ? OR company_name LIKE ? OR contact_name LIKE ?)' : ''}`).get(
    status ? [status] : [],
    search ? [`%${search}%`, `%${search}%`, `%${search}%`] : []
  );
  
  sql += ' ORDER BY updated_at DESC LIMIT ? OFFSET ?';
  const offset = (Number(page) - 1) * Number(limit);
  params.push(Number(limit), offset);
  
  const customers = db.prepare(sql).all(...params);
  
  res.json({
    customers,
    total: total.cnt,
    page: Number(page),
    pageSize: Number(limit),
    totalPages: Math.ceil(total.cnt / Number(limit)),
  });
});

// ========== GET: Single customer detail with full history ==========
router.get('/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customer_profiles WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  
  // Get all quotes linked to this customer
  const quotes = db.prepare(`
    SELECT q.* FROM quotes q
    JOIN quote_customer_links qcl ON qcl.quote_id = q.id
    WHERE qcl.customer_id = ?
    ORDER BY q.created_at DESC
  `).all(req.params.id);
  
  // Get all notes for this customer
  const notes = db.prepare(`
    SELECT cn.*, a.display_name as created_by_name
    FROM customer_notes cn
    LEFT JOIN admins a ON a.id = cn.created_by
    WHERE cn.customer_id = ?
    ORDER BY cn.created_at DESC
  `).all(req.params.id);
  
  // Get payment methods
  const paymentMethods = db.prepare('SELECT * FROM customer_payment_methods WHERE customer_id = ? ORDER BY is_default DESC').all(req.params.id);
  
  res.json({
    customer,
    quotes,
    notes,
    paymentMethods,
    totalOrders: quotes.length,
    totalSpent: quotes.reduce((sum, q) => sum + (q.total_price || 0), 0),
  });
});

// ========== POST: Create new customer ==========
router.post('/', (req, res) => {
  const { email, phone, companyName, contactName, status } = req.body;
  
  if (!email) return res.status(400).json({ error: 'Email required.' });
  
  // Check for duplicate email
  const existing = db.prepare('SELECT id FROM customer_profiles WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Customer with this email already exists.' });
  
  const code = generateCustomerCode();
  const info = db.prepare(`
    INSERT INTO customer_profiles (customer_code, email, phone, company_name, contact_name, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(code, email, phone || null, companyName || null, contactName || null, status || 'lead', req.session.adminId);
  
  res.json({
    id: info.lastInsertRowid,
    customerCode: code,
    email,
    status: status || 'lead',
  });
});

// ========== PUT: Update customer profile ==========
router.put('/:id', (req, res) => {
  const { email, phone, companyName, contactName, status, internalNotes } = req.body;
  
  const customer = db.prepare('SELECT id, email FROM customer_profiles WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  
  // If changing email, check for duplicates
  if (email && email !== customer.email) {
    const dup = db.prepare('SELECT id FROM customer_profiles WHERE email = ?').get(email);
    if (dup) return res.status(409).json({ error: 'Email already in use.' });
  }
  
  db.prepare(`
    UPDATE customer_profiles
    SET email = ?, phone = ?, company_name = ?, contact_name = ?, status = ?, internal_notes = ?, updated_at = ?
    WHERE id = ?
  `).run(
    email || customer.email,
    phone || null,
    companyName || null,
    contactName || null,
    status || 'lead',
    internalNotes || null,
    new Date().toISOString(),
    req.params.id
  );
  
  res.json({ ok: true });
});

// ========== POST: Add note to customer ==========
router.post('/:id/notes', (req, res) => {
  const { noteText, noteType } = req.body;
  
  if (!noteText) return res.status(400).json({ error: 'Note text required.' });
  
  const customer = db.prepare('SELECT id FROM customer_profiles WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  
  const info = db.prepare(`
    INSERT INTO customer_notes (customer_id, note_text, note_type, created_by, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(req.params.id, noteText, noteType || 'internal', req.session.adminId, new Date().toISOString());
  
  res.json({ noteId: info.lastInsertRowid });
});

// ========== POST: Add payment method to customer ==========
router.post('/:id/payment-methods', (req, res) => {
  const { provider, providerRef, isDefault } = req.body;
  
  if (!provider || !providerRef) {
    return res.status(400).json({ error: 'Provider and reference required.' });
  }
  
  const customer = db.prepare('SELECT id FROM customer_profiles WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found.' });
  
  // If this is the default, unset others
  if (isDefault) {
    db.prepare('UPDATE customer_payment_methods SET is_default = 0 WHERE customer_id = ?').run(req.params.id);
  }
  
  const info = db.prepare(`
    INSERT INTO customer_payment_methods (customer_id, provider, provider_ref, is_default)
    VALUES (?, ?, ?, ?)
  `).run(req.params.id, provider, providerRef, isDefault ? 1 : 0);
  
  res.json({ methodId: info.lastInsertRowid });
});

// ========== GET: List customer status types ==========
router.get('/statuses/all', (req, res) => {
  const statuses = db.prepare('SELECT * FROM customer_status_types ORDER BY status_key').all();
  res.json({ statuses });
});

module.exports = router;
