import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import sqlite3 from 'sqlite3';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

// Middleware
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(cors());
app.use(express.static(join(__dirname, '../public')));

// Database
const db = new sqlite3.Database(join(__dirname, '../data/db.sqlite'), (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('✓ Database connected');
});

const dbGet = (sql, params = []) => new Promise((res, rej) => {
  db.get(sql, params, (err, row) => err ? rej(err) : res(row));
});

const dbAll = (sql, params = []) => new Promise((res, rej) => {
  db.all(sql, params, (err, rows) => err ? rej(err) : res(rows || []));
});

const dbRun = (sql, params = []) => new Promise((res, rej) => {
  db.run(sql, params, function(err) {
    if (err) rej(err);
    else res({ id: this.lastID, changes: this.changes });
  });
});

// AUTH ROUTES
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const admin = await dbGet('SELECT * FROM admins WHERE username = ?', [username]);
    
    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    res.json({ id: admin.id, username: admin.username, name: admin.display_name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// SETTINGS ROUTES
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await dbAll('SELECT key, value FROM settings');
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    res.json(obj);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const { key, value } = req.body;
    await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/bulk', async (req, res) => {
  try {
    const settings = req.body;
    for (const [key, value] of Object.entries(settings)) {
      await dbRun('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [key, value]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GARMENTS ROUTES
app.get('/api/garments', async (req, res) => {
  try {
    const garments = await dbAll('SELECT * FROM garments ORDER BY sort_order');
    res.json(garments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/garments/:id', async (req, res) => {
  try {
    const garment = await dbGet('SELECT * FROM garments WHERE id = ?', [req.params.id]);
    const colors = await dbAll('SELECT * FROM garment_colors WHERE garment_id = ? ORDER BY sort_order', [req.params.id]);
    const sizes = await dbAll('SELECT * FROM garment_sizes WHERE garment_id = ? ORDER BY sort_order', [req.params.id]);
    res.json({ ...garment, colors, sizes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/garments/:id', async (req, res) => {
  try {
    const { name, brand, style_number, description, internal_cost, supplier_id } = req.body;
    await dbRun(
      'UPDATE garments SET name=?, brand=?, style_number=?, description=?, internal_cost=?, supplier_id=? WHERE id=?',
      [name, brand, style_number, description, internal_cost, supplier_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PRINT METHODS ROUTES
app.get('/api/print-methods', async (req, res) => {
  try {
    const methods = await dbAll('SELECT * FROM print_methods WHERE active=1 ORDER BY sort_order');
    
    for (const method of methods) {
      method.subtypes = await dbAll('SELECT * FROM print_method_subtypes WHERE print_method_id=? AND active=1 ORDER BY sort_order', [method.id]);
      method.addons = await dbAll('SELECT * FROM print_method_addons WHERE print_method_id=? AND active=1 ORDER BY sort_order', [method.id]);
    }
    
    res.json(methods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/print-methods', async (req, res) => {
  try {
    const { code, name, description, base_cost } = req.body;
    const result = await dbRun(
      'INSERT INTO print_methods (code, name, description, base_cost) VALUES (?, ?, ?, ?)',
      [code, name, description, base_cost]
    );
    res.json({ id: result.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LAYOUT CONFIG ROUTES
app.get('/api/layout', async (req, res) => {
  try {
    const layout = await dbAll('SELECT * FROM layout_config ORDER BY sort_order');
    res.json(layout);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/layout/reorder', async (req, res) => {
  try {
    const { sections } = req.body;
    for (let i = 0; i < sections.length; i++) {
      await dbRun('UPDATE layout_config SET sort_order=? WHERE id=?', [i + 1, sections[i].id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/layout/:id/toggle', async (req, res) => {
  try {
    const { visible } = req.body;
    await dbRun('UPDATE layout_config SET visible=? WHERE id=?', [visible ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/layout/custom-button', async (req, res) => {
  try {
    const { section_name, button_url } = req.body;
    const maxOrder = await dbGet('SELECT MAX(sort_order) as max FROM layout_config');
    await dbRun(
      'INSERT INTO layout_config (section_key, section_name, button_url, is_custom_button, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
      [`custom_${uuidv4()}`, section_name, button_url, 1, 1, (maxOrder.max || 0) + 1]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EMAIL TEMPLATES ROUTES
app.get('/api/email-templates', async (req, res) => {
  try {
    const templates = await dbAll('SELECT * FROM email_templates');
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/email-templates/:status', async (req, res) => {
  try {
    const { subject, body_html } = req.body;
    await dbRun(
      'UPDATE email_templates SET subject=?, body_html=? WHERE status_type=?',
      [subject, body_html, req.params.status]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CUSTOMERS ROUTES
app.get('/api/customers', async (req, res) => {
  try {
    const customers = await dbAll('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, business_name } = req.body;
    const acct_num = `ACCT-${Date.now()}`;
    const result = await dbRun(
      'INSERT INTO customers (first_name, last_name, email, phone, business_name, account_number) VALUES (?, ?, ?, ?, ?, ?)',
      [first_name, last_name, email, phone, business_name, acct_num]
    );
    res.json({ id: result.id, account_number: acct_num });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:id', async (req, res) => {
  try {
    const customer = await dbGet('SELECT * FROM customers WHERE id=?', [req.params.id]);
    const orders = await dbAll('SELECT * FROM quotes WHERE customer_id=? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...customer, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QUOTES ROUTES
app.post('/api/quotes', async (req, res) => {
  try {
    const { customer_id, garment_id, print_method_id, quote_data } = req.body;
    const quote_code = `3T-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;
    
    const settings = await dbAll('SELECT key, value FROM settings WHERE key="quote_expiration_days"');
    const expDays = settings[0]?.value || 7;
    const expiresAt = new Date(Date.now() + expDays * 24 * 60 * 60 * 1000).toISOString();
    
    const result = await dbRun(
      `INSERT INTO quotes (quote_code, customer_id, garment_id, print_method_id, pricing_snapshot, subtotal, total, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [quote_code, customer_id, garment_id, print_method_id, JSON.stringify(quote_data), quote_data.subtotal, quote_data.total, expiresAt, 'pending']
    );
    
    res.json({ id: result.id, quote_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quotes/:id', async (req, res) => {
  try {
    const quote = await dbGet('SELECT * FROM quotes WHERE id=?', [req.params.id]);
    const items = await dbAll('SELECT * FROM quote_items WHERE quote_id=?', [req.params.id]);
    const locations = await dbAll('SELECT * FROM quote_print_locations WHERE quote_id=?', [req.params.id]);
    res.json({ ...quote, items, locations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quotes/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await dbRun('UPDATE quotes SET status=? WHERE id=?', [status, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ANALYTICS ROUTES
app.get('/api/analytics', async (req, res) => {
  try {
    const period = req.query.period || 'month';
    let daysBack = 30;
    if (period === 'week') daysBack = 7;
    if (period === 'year') daysBack = 365;
    
    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
    
    const revenue = await dbGet(
      'SELECT SUM(total) as total FROM quotes WHERE status="paid" AND created_at > ?',
      [since]
    );
    
    const orders = await dbGet(
      'SELECT COUNT(*) as count FROM quotes WHERE status="paid" AND created_at > ?',
      [since]
    );
    
    const visitors = await dbGet(
      'SELECT COUNT(*) as count FROM quotes WHERE created_at > ?',
      [since]
    );
    
    const conversions = orders.count / visitors.count * 100 || 0;
    
    res.json({
      revenue: revenue.total || 0,
      orders: orders.count,
      visitors: visitors.count,
      conversion_rate: conversions.toFixed(2),
      avg_order_value: orders.count > 0 ? (revenue.total / orders.count).toFixed(2) : 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4790;
app.listen(PORT, () => {
  console.log(`\n✓ Server running on port ${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin/login.html`);
  console.log(`  Customer: http://localhost:${PORT}/customer/`);
});
