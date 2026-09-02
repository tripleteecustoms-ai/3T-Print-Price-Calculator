// server/routes/customer.js - PHASE 2A ADDITIONS
// Add these 5 new endpoints to your existing customer.js file
// (Place these after your existing endpoints, starting around line 517)

const express = require('express');
const db = require('../db');
const upsellService = require('../services/upsellService');
const router = express.Router();

// ============================================================
// PHASE 2A UPSELL FLOW ENDPOINTS
// ============================================================

/**
 * POST /api/quotes/:id/finalize
 * Starts the upsell flow by creating a session
 * Called when customer clicks "Finalize" on the quote confirmation page
 */
router.post('/api/quotes/:id/finalize', (req, res) => {
  try {
    const quoteId = parseInt(req.params.id);

    if (!quoteId || isNaN(quoteId)) {
      return res.status(400).json({ error: 'Invalid quote ID' });
    }

    // Verify quote exists
    const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(quoteId);
    if (!quote) {
      return res.status(404).json({ error: 'Quote not found' });
    }

    // Create upsell session
    const session = upsellService.createSession(quoteId);

    res.json({
      success: true,
      sessionId: session.sessionId,
      quoteId: quoteId,
      subtotal: session.subtotal
    });
  } catch (error) {
    console.error('Error finalizing quote:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/upsells/:sessionId
 * Retrieves current session state
 * Called to load the upsell screen and display prices
 */
router.get('/api/upsells/:sessionId', (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    const session = upsellService.getSession(sessionId);

    res.json({
      sessionId: session.sessionId,
      quoteId: session.quoteId,
      selectedAddons: session.selectedAddons,
      subtotal: session.subtotal,
      addonTotal: session.addonTotal,
      finalTotal: session.finalTotal,
      expiresAt: session.expiresAt
    });
  } catch (error) {
    console.error('Error getting session:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/upsells/:sessionId/add-addon
 * Adds an addon to the session and recalculates totals
 * Called when customer clicks "Yes" on an addon screen
 */
router.post('/api/upsells/:sessionId/add-addon', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { addon } = req.body;

    if (!sessionId || !addon) {
      return res.status(400).json({ error: 'Session ID and addon name required' });
    }

    const result = upsellService.addAddon(sessionId, addon);

    res.json({
      sessionId: result.session.sessionId,
      selectedAddons: result.session.selectedAddons,
      subtotal: result.session.subtotal,
      addonTotal: result.session.addonTotal,
      finalTotal: result.session.finalTotal
    });
  } catch (error) {
    console.error('Error adding addon:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/upsells/:sessionId/skip-addon
 * Records that customer declined an addon
 * Called when customer clicks "No" on an addon screen
 */
router.post('/api/upsells/:sessionId/skip-addon', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { addon } = req.body;

    if (!sessionId || !addon) {
      return res.status(400).json({ error: 'Session ID and addon name required' });
    }

    const result = upsellService.skipAddon(sessionId, addon);

    res.json({
      sessionId: result.session.sessionId,
      selectedAddons: result.session.selectedAddons,
      subtotal: result.session.subtotal,
      addonTotal: result.session.addonTotal,
      finalTotal: result.session.finalTotal
    });
  } catch (error) {
    console.error('Error skipping addon:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/checkout/shopify
 * Finalizes the checkout and saves addon records
 * Called when customer clicks "Proceed to Checkout"
 */
router.post('/api/checkout/shopify', (req, res) => {
  try {
    const { sessionId } = req.body;

    if (!sessionId) {
      return res.status(400).json({ error: 'Session ID required' });
    }

    const result = upsellService.finalizeCheckout(sessionId);

    // In Phase 2A, redirect to checkout-mock.html
    // In Phase 2B, this will create a Shopify Draft Order and redirect there
    const redirectUrl = `/checkout-mock.html?quoteId=${result.quoteId}&total=${result.finalTotal}`;

    res.json({
      success: true,
      quoteId: result.quoteId,
      sessionId: result.sessionId,
      selectedAddons: result.selectedAddons,
      finalTotal: result.finalTotal,
      redirect_url: redirectUrl,
      ready_for_shopify: result.ready_for_shopify
    });
  } catch (error) {
    console.error('Error during checkout:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// END PHASE 2A ENDPOINTS
// ============================================================

module.exports = router;
