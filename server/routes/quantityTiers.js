const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    tiers: [
      { id: 1, label: '1-24 units', minQty: 1, maxQty: 24, checkoutBehavior: 'checkout' },
      { id: 2, label: '25-50 units', minQty: 25, maxQty: 50, checkoutBehavior: 'checkout' },
      { id: 3, label: '51-100 units', minQty: 51, maxQty: 100, checkoutBehavior: 'checkout' },
      { id: 4, label: '101-249 units', minQty: 101, maxQty: 249, checkoutBehavior: 'checkout' },
      { id: 5, label: '250+ units', minQty: 250, maxQty: 999999, checkoutBehavior: 'review' },
    ]
  });
});

module.exports = router;
