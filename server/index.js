import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import sqlite3 from 'sqlite3';
import { v4 as uuidv4 } from 'uuid';
import nodemailer from 'nodemailer';
import fs from 'fs/promises';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const app = express();

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

// EMAIL SERVICE
let emailConfig = { provider: 'mock' };

async function sendEmail(to, subject, html) {
  try {
    if (emailConfig.provider === 'mock') {
      console.log(`[MOCK EMAIL] To: ${to}`);
      console.log(`[MOCK EMAIL] Subject: ${subject}`);
      await dbRun(
        'INSERT INTO emails_sent (to_email, subject, body_html, provider, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [to, subject, html, 'mock']
      );
      return { success: true };
    }
    
    if (emailConfig.provider === 'gmail' && emailConfig.user && emailConfig.pass) {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: emailConfig.user,
          pass: emailConfig.pass
        }
      });
      
      const info = await transporter.sendMail({
        from: emailConfig.user,
        to,
        subject,
        html
      });
      
      await dbRun(
        'INSERT INTO emails_sent (to_email, subject, body_html, provider, sent_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)',
        [to, subject, html, 'gmail']
      );
      
      return { success: true, messageId: info.messageId };
    }
    
    return { success: false, error: 'Email provider not configured' };
  } catch (err) {
    console.error('Email error:', err);
    return { success: false, error: err.message };
  }
}

// QUOTE CALCULATION ENGINE
async function calculateQuotePrice(garmentId, colorQtys, locationIds, artworkOption = null) {
  const garment = await dbGet('SELECT internal_cost FROM garments WHERE id = ?', [garmentId]);
  const tiers = await dbAll('SELECT * FROM pricing_tiers ORDER BY quantity');
  const locations = await dbAll('SELECT * FROM print_locations WHERE id IN (' + locationIds.join(',') + ')');
  
  let totalQty = 0;
  let totalCost = 0;
  const itemDetails = [];
  
  // Calculate quantities and base cost
  for (const [color, sizes] of Object.entries(colorQtys)) {
    for (const [size, qty] of Object.entries(sizes)) {
      if (qty > 0) {
        totalQty += qty;
        const sizeData = await dbGet('SELECT surcharge FROM garment_sizes WHERE label = ? AND garment_id = ?', [size, garmentId]);
        const baseCost = garment.internal_cost + (sizeData?.surcharge || 0);
        itemDetails.push({ color, size, qty, baseCost });
      }
    }
  }
  
  // Find applicable tier
  let applicableTier = tiers[0];
  for (const tier of tiers) {
    if (totalQty >= tier.quantity) {
      applicableTier = tier;
    }
  }
  
  const unitPrice = applicableTier.standard_price;
  const hardFloor = applicableTier.hard_floor_price;
  
  // Calculate print location costs
  let locationCosts = 0;
  for (const locId of locationIds) {
    const pricing = await dbGet(
      'SELECT addon_price FROM print_location_pricing WHERE print_location_id = ? AND quantity = ? ORDER BY quantity DESC LIMIT 1',
      [locId, totalQty]
    );
    if (pricing) {
      locationCosts += pricing.addon_price * totalQty;
    }
  }
  
  // Artwork cost
  let artworkCost = 0;
  if (artworkOption === 'adjust') artworkCost = 25;
  if (artworkOption === 'concept') artworkCost = 50;
  if (artworkOption === 'create') artworkCost = 150;
  
  // Calculate subtotal
  const garmentCost = (unitPrice * totalQty);
  const subtotal = garmentCost + locationCosts + artworkCost;
  
  // Apply hard floor
  const total = Math.max(subtotal, hardFloor * totalQty);
  
  return {
    quantity: totalQty,
    unitPrice,
    garmentCost: garmentCost.toFixed(2),
    locationCosts: locationCosts.toFixed(2),
    artworkCost: artworkCost.toFixed(2),
    subtotal: subtotal.toFixed(2),
    total: total.toFixed(2),
    tier: `${applicableTier.quantity}+`,
    itemDetails
  };
}

// SETTINGS ROUTES
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await dbAll('SELECT key, value FROM settings');
    const obj = {};
    settings.forEach(s => obj[s.key] = s.value);
    emailConfig = {
      provider: obj.email_provider || 'mock',
      user: obj.email_address || '',
      pass: obj.email_app_password || ''
    };
    res.json(obj);
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
    emailConfig = {
      provider: settings.email_provider || 'mock',
      user: settings.email_address || '',
      pass: settings.email_app_password || ''
    };
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GARMENTS ROUTES
app.get('/api/garments', async (req, res) => {
  try {
    const garments = await dbAll('SELECT * FROM garments WHERE active=1 ORDER BY sort_order');
    for (const g of garments) {
      g.colors = await dbAll('SELECT * FROM garment_colors WHERE garment_id = ? ORDER BY sort_order', [g.id]);
      g.sizes = await dbAll('SELECT * FROM garment_sizes WHERE garment_id = ? ORDER BY sort_order', [g.id]);
    }
    res.json(garments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/garments/:id', async (req, res) => {
  try {
    const g = await dbGet('SELECT * FROM garments WHERE id = ?', [req.params.id]);
    g.colors = await dbAll('SELECT * FROM garment_colors WHERE garment_id = ?', [req.params.id]);
    g.sizes = await dbAll('SELECT * FROM garment_sizes WHERE garment_id = ?', [req.params.id]);
    res.json(g);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PRINT LOCATIONS ROUTES
app.get('/api/print-locations', async (req, res) => {
  try {
    const locs = await dbAll('SELECT * FROM print_locations WHERE active=1 ORDER BY sort_order');
    for (const loc of locs) {
      loc.pricing = await dbAll('SELECT * FROM print_location_pricing WHERE print_location_id = ? ORDER BY quantity', [loc.id]);
    }
    res.json(locs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PRINT METHODS ROUTES
app.get('/api/print-methods', async (req, res) => {
  try {
    const methods = await dbAll('SELECT * FROM print_methods WHERE active=1 AND visible_to_customers=1 ORDER BY sort_order');
    res.json(methods);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LAYOUT CONFIG
app.get('/api/layout', async (req, res) => {
  try {
    const layout = await dbAll('SELECT * FROM layout_config ORDER BY sort_order');
    res.json(layout);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/layout/:id/toggle', async (req, res) => {
  try {
    const { visible } = req.body;
    await dbRun('UPDATE layout_config SET visible = ? WHERE id = ?', [visible ? 1 : 0, req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// EMAIL TEMPLATES
app.get('/api/email-templates', async (req, res) => {
  try {
    const tpls = await dbAll('SELECT * FROM email_templates');
    res.json(tpls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/email-templates/:status', async (req, res) => {
  try {
    const { subject, body_html } = req.body;
    await dbRun('UPDATE email_templates SET subject = ?, body_html = ? WHERE status_type = ?',
      [subject, body_html, req.params.status]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CUSTOMERS
app.get('/api/customers', async (req, res) => {
  try {
    const custs = await dbAll('SELECT * FROM customers ORDER BY created_at DESC');
    res.json(custs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, business_name } = req.body;
    const acct = `ACCT-${Date.now()}`;
    const result = await dbRun(
      'INSERT INTO customers (first_name, last_name, email, phone, business_name, account_number) VALUES (?, ?, ?, ?, ?, ?)',
      [first_name, last_name, email, phone, business_name, acct]
    );
    res.json({ id: result.id, account_number: acct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/customers/:id', async (req, res) => {
  try {
    const cust = await dbGet('SELECT * FROM customers WHERE id = ?', [req.params.id]);
    const quotes = await dbAll('SELECT * FROM quotes WHERE customer_id = ? ORDER BY created_at DESC', [req.params.id]);
    res.json({ ...cust, quotes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// QUOTES - THE CORE
app.post('/api/quotes/calculate', async (req, res) => {
  try {
    const { garmentId, colorQtys, locationIds, artworkOption } = req.body;
    const pricing = await calculateQuotePrice(garmentId, colorQtys, locationIds, artworkOption);
    res.json(pricing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/quotes', async (req, res) => {
  try {
    const {
      firstName, lastName, email, phone, businessName,
      garmentId, colorQtys, locationIds, artworkOption, designNotes,
      printMethodId, personalizationTotal
    } = req.body;

    // Create or get customer
    let cust = await dbGet('SELECT id FROM customers WHERE email = ?', [email]);
    let customerId;
    if (!cust) {
      const acct = `ACCT-${Date.now()}`;
      const result = await dbRun(
        'INSERT INTO customers (first_name, last_name, email, phone, business_name, account_number) VALUES (?, ?, ?, ?, ?, ?)',
        [firstName, lastName, email, phone, businessName, acct]
      );
      customerId = result.id;
    } else {
      customerId = cust.id;
    }

    // Calculate pricing
    const pricing = await calculateQuotePrice(garmentId, colorQtys, locationIds, artworkOption);
    const totalWithPersonalization = parseFloat(pricing.total) + (personalizationTotal || 0);

    // Get expiration
    const settings = await dbGet('SELECT value FROM settings WHERE key = "quote_expiration_days"');
    const expDays = parseInt(settings?.value || 7);
    const expiresAt = new Date(Date.now() + expDays * 24 * 60 * 60 * 1000).toISOString();

    const quoteCode = `3T-${Date.now()}-${Math.random().toString(36).substr(2, 4).toUpperCase()}`;

    const result = await dbRun(
      `INSERT INTO quotes (quote_code, customer_id, garment_id, print_method_id, design_notes, artwork_option, artwork_cost,
        pricing_snapshot, subtotal, total, expires_at, status, payment_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'mock')`,
      [quoteCode, customerId, garmentId, printMethodId || null, designNotes, artworkOption,
        pricing.artworkCost, JSON.stringify(pricing), pricing.subtotal, totalWithPersonalization.toFixed(2), expiresAt]
    );

    const quoteId = result.id;

    // Save quote items (colors/sizes)
    for (const item of pricing.itemDetails) {
      await dbRun(
        'INSERT INTO quote_items (quote_id, color_name, size_label, quantity, unit_surcharge) VALUES (?, ?, ?, ?, ?)',
        [quoteId, item.color, item.size, item.qty, item.baseCost]
      );
    }

    // Save print locations
    for (const locId of locationIds) {
      const loc = await dbGet('SELECT name FROM print_locations WHERE id = ?', [locId]);
      await dbRun(
        'INSERT INTO quote_print_locations (quote_id, print_location_id, location_name) VALUES (?, ?, ?)',
        [quoteId, locId, loc.name]
      );
    }

    // Send quote email
    const settings2 = await dbGet('SELECT value FROM settings WHERE key = "business_email"');
    const businessEmail = settings2?.value || 'orders@3tprintsolutions.com';
    const garment = await dbGet('SELECT name FROM garments WHERE id = ?', [garmentId]);

    const emailHtml = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#111;">
        <div style="background:#000;color:#C4FF00;padding:20px;font-weight:800;font-size:18px;text-align:center;">3T PRINT SOLUTIONS</div>
        <div style="padding:20px;border:1px solid #E5E5E5;border-top:none;">
          <h2 style="margin-top:0;">Your quote is ready — #${quoteCode}</h2>
          <p>Hi ${firstName}, thanks for building your order! Here's your summary:</p>
          <table style="width:100%;border-collapse:collapse;margin:20px 0;">
            <tr><td style="padding:8px 0;color:#999;">Garment</td><td style="padding:8px 0;text-align:right;font-weight:600;">${garment.name}</td></tr>
            <tr><td style="padding:8px 0;color:#999;">Quantity</td><td style="padding:8px 0;text-align:right;font-weight:600;">${pricing.quantity}</td></tr>
            <tr><td style="padding:8px 0;color:#999;">Unit Price</td><td style="padding:8px 0;text-align:right;font-weight:600;">$${pricing.unitPrice}</td></tr>
            <tr style="border-top:2px solid #C4FF00;"><td style="padding:12px 0;font-size:16px;font-weight:700;">Order Total</td><td style="padding:12px 0;text-align:right;font-size:16px;font-weight:700;">$${totalWithPersonalization.toFixed(2)}</td></tr>
          </table>
          <p style="font-size:13px;color:#666;margin-top:20px;">This quote is valid for ${expDays} days. Reply to this email with any questions or changes.</p>
        </div>
      </div>
    `;

    await sendEmail(email, `Your 3T Print Solutions Quote - #${quoteCode}`, emailHtml);

    res.json({
      id: quoteId,
      quote_code: quoteCode,
      total: totalWithPersonalization.toFixed(2),
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('Quote error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/quotes/:id', async (req, res) => {
  try {
    const q = await dbGet('SELECT * FROM quotes WHERE id = ?', [req.params.id]);
    q.items = await dbAll('SELECT * FROM quote_items WHERE quote_id = ?', [req.params.id]);
    q.locations = await dbAll('SELECT * FROM quote_print_locations WHERE quote_id = ?', [req.params.id]);
    res.json(q);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/quotes/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    await dbRun('UPDATE quotes SET status = ? WHERE id = ?', [status, req.params.id]);

    const quote = await dbGet('SELECT * FROM quotes WHERE id = ?', [req.params.id]);
    const cust = await dbGet('SELECT * FROM customers WHERE id = ?', [quote.customer_id]);
    const template = await dbGet('SELECT * FROM email_templates WHERE status_type = ?', [status]);

    if (template && cust.email) {
      const html = template.body_html
        .replace('{{order_number}}', quote.quote_code)
        .replace('{{customer_name}}', cust.first_name);
      await sendEmail(cust.email, template.subject.replace('{{order_number}}', quote.quote_code), html);
    }

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// HEALTH
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4790;
app.listen(PORT, () => {
  console.log(`\n✓ 3TPPC v2.0 Server running on port ${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin/login.html`);
  console.log(`  Customer: http://localhost:${PORT}/customer/`);
});
