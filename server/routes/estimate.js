const express = require('express');
const router = express.Router();
const { calculateQuote } = require('../pricingEngine');

router.post('/', (req, res) => {
  try {
    const { garmentId, colorSelections, printLocationIds, discountCode } = req.body;
    
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
    console.error('Estimate error:', err);
    res.status(400).json({ ok: false, error: err.message });
  }
});

module.exports = router;
