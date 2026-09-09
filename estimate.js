// server/routes/estimate.js
// Live price preview route — calculates quotes for the customer builder's preview

const express = require('express');
const { calculateQuote, PricingError } = require('../pricingEngine');

const router = express.Router();

router.post('/', (req, res) => {
  try {
    const { garmentId, colorSelections, printLocationIds, discountCode } = req.body;
    
    if (!garmentId) {
      return res.status(400).json({ ok: false, error: 'Garment ID is required' });
    }
    
    const quote = calculateQuote({
      garmentId: Number(garmentId),
      colorSelections: colorSelections || [],
      printLocationIds: printLocationIds || [],
      discountCode: discountCode || null,
      discretionaryAdjustment: 0,
      floorOverride: false,
    });

    res.json({
      ok: true,
      quote: {
        total: quote.total,
        subtotal: quote.subtotal,
        baseLineTotal: quote.baseLineTotal,
        addonLinesTotal: quote.addonLinesTotal,
        sizeSurchargeTotal: quote.sizeSurchargeTotal,
        designSizeSurchargeTotal: quote.designSizeSurchargeTotal,
        lines: quote.lines,
        addonLines: quote.addonLines,
        discountAmount: quote.discountAmount,
        discountError: quote.discountError,
      }
    });
  } catch (err) {
    if (err instanceof PricingError) {
      console.warn('Pricing error:', err.message);
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('Estimate error:', err);
    res.status(500).json({ ok: false, error: 'Could not calculate price. Please try again.' });
  }
});

module.exports = router;
