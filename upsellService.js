// server/services/upsellService.js
// Business logic for the upsell flow: session management, addon pricing, conditional flow

const db = require('../db');
const crypto = require('crypto');

// Addon pricing configuration
const ADDON_CONFIG = {
  order_protection: {
    name: 'Order Protection',
    percentage: 0.06,        // 6% of subtotal
    max_price: null,         // No cap
    description: 'Protect your order from shipping issues and production errors.'
  },
  rush_production: {
    name: 'Rush Production',
    percentage: 0.20,        // 20% of subtotal
    max_price: 500,          // $500 max
    description: 'Get your order produced in 0-2 days instead of 7-10 days.'
  },
  priority_service: {
    name: 'Priority Service',
    percentage: 0.04,        // 4% of subtotal
    max_price: 100,          // $100 cap
    description: 'Your order moves higher in our production queue.'
  }
};

// Calculate price for an addon based on subtotal
function calculateAddonPrice(addonKey, subtotal) {
  const addon = ADDON_CONFIG[addonKey];
  if (!addon) return 0;

  let price = subtotal * addon.percentage;
  if (addon.max_price && price > addon.max_price) {
    price = addon.max_price;
  }
  return Math.round(price * 100) / 100; // Round to 2 decimals
}

// Create a new upsell session
function createSession(quoteId) {
  const sessionId = crypto.randomUUID();
  const quote = db.prepare('SELECT subtotal FROM quotes WHERE id = ?').get(quoteId);

  if (!quote) {
    throw new Error(`Quote ${quoteId} not found`);
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now

  db.prepare(`
    INSERT INTO upsell_sessions (session_id, quote_id, selected_addons, subtotal, addon_total, final_total, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    quoteId,
    JSON.stringify([]),      // No addons selected yet
    quote.subtotal,
    0,                        // No addon total yet
    quote.subtotal,           // Total = subtotal initially
    expiresAt
  );

  // Mark quote as "checkout" status
  db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run('checkout', quoteId);

  return { sessionId, subtotal: quote.subtotal };
}

// Get current session state
function getSession(sessionId) {
  const session = db.prepare(`
    SELECT * FROM upsell_sessions WHERE session_id = ?
  `).get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // Check if expired
  if (new Date(session.expires_at) < new Date()) {
    throw new Error('Session expired');
  }

  const selectedAddons = JSON.parse(session.selected_addons || '[]');

  return {
    sessionId,
    quoteId: session.quote_id,
    selectedAddons,
    subtotal: session.subtotal,
    addonTotal: session.addon_total,
    finalTotal: session.final_total,
    expiresAt: session.expires_at
  };
}

// Determine next screen in the flow
function getNextScreen(sessionState) {
  const { selectedAddons } = sessionState;

  // Order: Protection → Rush → Priority (only if Rush declined)
  if (!selectedAddons.includes('order_protection')) {
    return { screen: 'order_protection', condition: 'always' };
  }

  if (!selectedAddons.includes('rush_production') && selectedAddons.rush_declined !== true) {
    return { screen: 'rush_production', condition: 'always' };
  }

  if (selectedAddons.rush_declined && !selectedAddons.includes('priority_service')) {
    return { screen: 'priority_service', condition: 'if_rush_declined' };
  }

  // All addons shown/completed
  return { screen: 'checkout', condition: 'complete' };
}

// Add addon to session and get next screen
function addAddon(sessionId, addonKey) {
  const session = db.prepare(`
    SELECT * FROM upsell_sessions WHERE session_id = ?
  `).get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const selectedAddons = JSON.parse(session.selected_addons || '[]');

  if (!selectedAddons.includes(addonKey)) {
    selectedAddons.push(addonKey);
  }

  // Recalculate total
  let addonTotal = 0;
  selectedAddons.forEach(addon => {
    addonTotal += calculateAddonPrice(addon, session.subtotal);
  });

  const finalTotal = session.subtotal + addonTotal;
  const finalTotal2dp = Math.round(finalTotal * 100) / 100;
  const addonTotal2dp = Math.round(addonTotal * 100) / 100;

  db.prepare(`
    UPDATE upsell_sessions
    SET selected_addons = ?, addon_total = ?, final_total = ?, updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ?
  `).run(
    JSON.stringify(selectedAddons),
    addonTotal2dp,
    finalTotal2dp,
    sessionId
  );

  const updatedSession = {
    sessionId,
    selectedAddons,
    subtotal: session.subtotal,
    addonTotal: addonTotal2dp,
    finalTotal: finalTotal2dp
  };

  return {
    session: updatedSession,
    nextScreen: getNextScreen(updatedSession)
  };
}

// Skip addon (decline) and get next screen
function skipAddon(sessionId, addonKey) {
  const session = db.prepare(`
    SELECT * FROM upsell_sessions WHERE session_id = ?
  `).get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const selectedAddons = JSON.parse(session.selected_addons || '[]');

  // Mark that this addon was declined
  if (addonKey === 'rush_production') {
    selectedAddons.rush_declined = true;
  }

  db.prepare(`
    UPDATE upsell_sessions
    SET selected_addons = ?, updated_at = CURRENT_TIMESTAMP
    WHERE session_id = ?
  `).run(
    JSON.stringify(selectedAddons),
    sessionId
  );

  const updatedSession = {
    sessionId,
    selectedAddons,
    subtotal: session.subtotal,
    addonTotal: session.addon_total,
    finalTotal: session.final_total
  };

  return {
    session: updatedSession,
    nextScreen: getNextScreen(updatedSession)
  };
}

// Finalize checkout: save addon selections to orders_addons table
function finalizeCheckout(sessionId) {
  const session = db.prepare(`
    SELECT * FROM upsell_sessions WHERE session_id = ?
  `).get(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  const selectedAddons = JSON.parse(session.selected_addons || '[]');
  const quoteId = session.quote_id;

  // Save each selected addon to orders_addons table
  selectedAddons.forEach(addonKey => {
    if (addonKey === 'rush_declined') return; // Skip metadata

    const price = calculateAddonPrice(addonKey, session.subtotal);
    const addon = ADDON_CONFIG[addonKey];

    db.prepare(`
      INSERT INTO orders_addons (quote_id, addon_name, addon_price, percentage_of_subtotal)
      VALUES (?, ?, ?, ?)
    `).run(
      quoteId,
      addonKey,
      price,
      addon.percentage * 100  // Store as percentage (6, 20, 4, etc)
    );
  });

  // Update quote status to "checkout"
  db.prepare('UPDATE quotes SET status = ? WHERE id = ?').run('checkout', quoteId);

  return {
    quoteId,
    sessionId,
    selectedAddons: selectedAddons.filter(a => a !== 'rush_declined'),
    finalTotal: session.final_total,
    ready_for_shopify: true
  };
}

// Get all addons with their current pricing
function getAllAddonPricing(subtotal) {
  const pricing = {};

  Object.keys(ADDON_CONFIG).forEach(key => {
    const addon = ADDON_CONFIG[key];
    const price = calculateAddonPrice(key, subtotal);
    pricing[key] = {
      name: addon.name,
      price,
      percentage: addon.percentage * 100,
      maxPrice: addon.max_price,
      description: addon.description
    };
  });

  return pricing;
}

module.exports = {
  createSession,
  getSession,
  getNextScreen,
  addAddon,
  skipAddon,
  finalizeCheckout,
  getAllAddonPricing,
  ADDON_CONFIG
};
