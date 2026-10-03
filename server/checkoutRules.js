// server/checkoutRules.js
//
// Checkout money rules layered on top of a quote's order total (the
// pricing engine's `total`: merchandise after any discount). All rates are
// admin-editable in Settings > Checkout.
//
//   rush fee    = rush_fee_pct of the order total, only if the customer ticks Rush
//   sales tax   = tax_rate_pct of (order total + rush fee)
//   shipping    = shipping_flat_rate, once per order, only when the customer
//                 chose Shipping (Local Pickup is free). Not taxed.
//   grand total = order total + rush fee + sales tax + shipping
//   deposit     = offered when the grand total is at least deposit_threshold;
//                 the customer then pays deposit_pct now and the rest later
//
// Always recomputed on the server from stored choices; nothing the browser
// sends about amounts is trusted.

const { getSettingNum } = require('./pricingEngine');
const { round2 } = require('./pricingTables');

const DEFAULTS = { tax_rate_pct: 8, rush_fee_pct: 20, deposit_threshold: 1000, deposit_pct: 50, shipping_flat_rate: 11.99 };

function pctSetting(key, max) {
  const v = getSettingNum(key, DEFAULTS[key]);
  return Number.isFinite(v) && v >= 0 && v <= max ? v : DEFAULTS[key];
}

function checkoutSettings() {
  return {
    taxRatePct: pctSetting('tax_rate_pct', 100),
    rushFeePct: pctSetting('rush_fee_pct', 500),
    depositThreshold: pctSetting('deposit_threshold', 1e9),
    depositPct: Math.min(100, Math.max(1, pctSetting('deposit_pct', 100))),
    shippingFlatRate: pctSetting('shipping_flat_rate', 10000),
  };
}

/**
 * @param {number} orderTotal  pricing engine total (after discount)
 * @param {{rush?: boolean, paymentOption?: 'full'|'deposit', shipping?: boolean}} choices
 */
function computeCheckout(orderTotal, choices = {}) {
  const s = checkoutSettings();
  const rush = !!choices.rush;
  const rushFee = rush ? round2(orderTotal * s.rushFeePct / 100) : 0;
  const taxAmount = round2((orderTotal + rushFee) * s.taxRatePct / 100);
  const shippingFee = choices.shipping ? round2(s.shippingFlatRate) : 0;
  const grandTotal = round2(orderTotal + rushFee + taxAmount + shippingFee);
  const depositAvailable = grandTotal >= s.depositThreshold;
  const paymentOption = depositAvailable && choices.paymentOption === 'deposit' ? 'deposit' : 'full';
  const amountDueNow = paymentOption === 'deposit' ? round2(grandTotal * s.depositPct / 100) : grandTotal;
  return {
    orderTotal: round2(orderTotal), rush, rushFeePct: s.rushFeePct, rushFee,
    taxRatePct: s.taxRatePct, taxAmount, shippingFee, shippingFlatRate: round2(s.shippingFlatRate), grandTotal,
    depositAvailable, depositThreshold: s.depositThreshold, depositPct: s.depositPct,
    paymentOption, amountDueNow, balanceDue: round2(grandTotal - amountDueNow),
  };
}

module.exports = { computeCheckout, checkoutSettings, CHECKOUT_DEFAULTS: DEFAULTS };
