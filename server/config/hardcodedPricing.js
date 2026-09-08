// server/config/hardcodedPricing.js
//
// FALLBACK PRICING SYSTEM
// If the database is unavailable or corrupted, the pricing engine falls back
// to these hardcoded values. This ensures quotes can still be generated even
// if SQLite is temporarily down or on initial deployment before seed.js runs.
//
// These values are extracted from seed.js and kept in sync manually.
// Admin changes (via Settings > Pricing) persist to the database and override these.

// All 249 pricing tiers: [quantity, standard_price, hard_floor_price]
const HARDCODED_PRICING_TIERS = [
  [1, 35.00, 32.00], [2, 25.00, 23.00], [3, 25.00, 23.00],
  [4, 22.00, 20.00], [5, 22.00, 20.00], [6, 20.00, 18.00],
  [7, 20.00, 18.00], [8, 20.00, 18.00], [9, 20.00, 18.00],
  [10, 18.00, 16.00], [11, 18.00, 16.00], [12, 18.00, 16.00],
  [13, 18.00, 16.00], [14, 18.00, 16.00], [15, 17.00, 15.00],
  [16, 17.00, 15.00], [17, 17.00, 15.00], [18, 17.00, 15.00],
  [19, 17.00, 15.00], [20, 17.00, 15.00], [21, 17.00, 15.00],
  [22, 17.00, 15.00], [23, 17.00, 15.00], [24, 17.00, 15.00],
  [25, 16.00, 14.00], [26, 16.00, 14.00], [27, 16.00, 14.00],
  [28, 16.00, 14.00], [29, 16.00, 14.00], [30, 16.00, 14.00],
  [31, 16.00, 14.00], [32, 16.00, 14.00], [33, 16.00, 14.00],
  [34, 16.00, 14.00], [35, 16.00, 14.00], [36, 15.00, 13.00],
  [37, 15.00, 13.00], [38, 15.00, 13.00], [39, 15.00, 13.00],
  [40, 15.00, 13.00], [41, 15.00, 13.00], [42, 15.00, 13.00],
  [43, 15.00, 13.00], [44, 15.00, 13.00], [45, 15.00, 13.00],
  [46, 15.00, 13.00], [47, 15.00, 13.00], [48, 15.00, 13.00],
  [49, 15.00, 13.00], [50, 14.00, 12.00],
  // ... [51-74]: 14.00/12.00
  ...(function() {
    const arr = [];
    for (let q = 51; q <= 74; q++) arr.push([q, 14.00, 12.00]);
    return arr;
  })(),
  // [75-99]: 13.00/11.00
  ...(function() {
    const arr = [];
    for (let q = 75; q <= 99; q++) arr.push([q, 13.00, 11.00]);
    return arr;
  })(),
  // [100-149]: 12.00/10.00
  ...(function() {
    const arr = [];
    for (let q = 100; q <= 149; q++) arr.push([q, 12.00, 10.00]);
    return arr;
  })(),
  // [150-199]: 11.00/9.00
  ...(function() {
    const arr = [];
    for (let q = 150; q <= 199; q++) arr.push([q, 11.00, 9.00]);
    return arr;
  })(),
  // [200-249]: 11.00/9.00
  ...(function() {
    const arr = [];
    for (let q = 200; q <= 249; q++) arr.push([q, 11.00, 9.00]);
    return arr;
  })(),
];

// All 11 garments with metadata
const HARDCODED_GARMENTS = [
  {
    id: 1, name: 'Standard Quality T-Shirt', brand: 'Gildan', styleNumber: '5000',
    internalCost: 0, customerPriceAdjustment: 0, description: 'Our everyday 100% cotton tee.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 2, name: 'Premium Soft T-Shirt', brand: 'Bella+Canvas', styleNumber: '3001',
    internalCost: 4.00, customerPriceAdjustment: 3.00, description: 'Ultra-soft ringspun cotton.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 3, name: 'Heavyweight T-Shirt', brand: 'Comfort Colors', styleNumber: '1717',
    internalCost: 4.75, customerPriceAdjustment: 4.50, description: 'Garment-dyed heavyweight.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 4, name: 'Long Sleeve Shirt', brand: 'Gildan', styleNumber: '2400',
    internalCost: 4.25, customerPriceAdjustment: 5.00, description: 'Long sleeve cotton tee.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 5, name: 'Performance Activewear Shirt', brand: 'Sport-Tek', styleNumber: 'ST350',
    internalCost: 4.00, customerPriceAdjustment: 6.00, description: 'Moisture-wicking polyester.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 6, name: 'Polo Shirt', brand: 'Port Authority', styleNumber: 'K500',
    internalCost: 4.50, customerPriceAdjustment: 7.50, description: 'Classic pique polo.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 7, name: 'Hoodie', brand: 'Gildan', styleNumber: '18500',
    internalCost: 6.50, customerPriceAdjustment: 12.00, description: 'Classic pullover hoodie.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 8, name: 'Heavyweight Hoodie', brand: 'Independent Trading Co.', styleNumber: 'IND4000',
    internalCost: 9.00, customerPriceAdjustment: 16.00, description: 'Heavyweight fleece hoodie.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 9, name: 'Sweatshirt', brand: 'Gildan', styleNumber: '18000',
    internalCost: 5.50, customerPriceAdjustment: 9.00, description: 'Classic crewneck sweatshirt.',
    decorationMethods: ['dtf', 'screen_print', 'embroidery'],
    colorPaletteKey: 'core',
  },
  {
    id: 10, name: 'Hat / Cap', brand: 'Yupoong', styleNumber: '6089M',
    internalCost: 3.00, customerPriceAdjustment: -8.00, description: 'Structured 6-panel trucker cap.',
    decorationMethods: ['dtf', 'embroidery'],
    colorPaletteKey: 'hat',
    oneSize: true,
  },
  {
    id: 11, name: 'Tote Bag', brand: 'Q-Tees', styleNumber: 'Q1000',
    internalCost: 2.50, customerPriceAdjustment: -10.00, description: 'Durable canvas tote.',
    decorationMethods: ['dtf', 'screen_print'],
    colorPaletteKey: 'tote',
    oneSize: true,
  },
];

// Color palettes by key
const HARDCODED_COLOR_PALETTES = {
  core: [
    { name: 'Black', hex: '#111111' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Royal Blue', hex: '#1E3A8A' },
    { name: 'Red', hex: '#B91C1C' },
    { name: 'Navy', hex: '#1F2937' },
    { name: 'Sport Gray', hex: '#9CA3AF' },
    { name: 'Soft Pink', hex: '#F4B8C6' },
    { name: 'Safety Orange', hex: '#FF6A13' },
    { name: 'Safety Yellow', hex: '#EEFF00' },
    { name: 'Safety Green', hex: '#C1F11D' },
  ],
  hat: [
    { name: 'Black', hex: '#111111' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Navy', hex: '#1F2937' },
    { name: 'Red', hex: '#B91C1C' },
  ],
  tote: [
    { name: 'Natural', hex: '#F1E7D0' },
    { name: 'Black', hex: '#111111' },
  ],
};

// Size adjustments by garment
const HARDCODED_GARMENT_SIZES = {
  1: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  2: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  3: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  4: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  5: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  6: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  7: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  8: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  9: { S: 0, M: 0, L: 0, XL: 0, '2XL': 2.00, '3XL': 3.00, '4XL': 4.00, '5XL': 5.00 },
  10: { 'One Size': 0 },
  11: { 'One Size': 0 },
};

// All 7 print locations with pricing matrices
// Format: [quantity, addon_price]
const BACKADD = [
  [1, 5.00], [2, 5.00], [3, 5.00], [4, 4.50], [5, 4.50],
  [6, 4.00], [7, 4.00], [8, 4.00], [9, 4.00], [10, 3.50],
  [11, 3.50], [12, 3.50], [13, 3.50], [14, 3.50], [15, 3.00],
  [16, 3.00], [17, 3.00], [18, 3.00], [19, 3.00], [20, 3.00],
  [21, 3.00], [22, 3.00], [23, 3.00], [24, 3.00], [25, 2.75],
  ...(function() {
    const arr = [];
    for (let q = 26; q <= 50; q++) arr.push([q, 2.75]);
    for (let q = 51; q <= 75; q++) arr.push([q, 2.50]);
    for (let q = 76; q <= 100; q++) arr.push([q, 2.25]);
    for (let q = 101; q <= 150; q++) arr.push([q, 2.00]);
    for (let q = 151; q <= 200; q++) arr.push([q, 1.75]);
    for (let q = 201; q <= 249; q++) arr.push([q, 1.75]);
    return arr;
  })(),
];

const LEFT_CHEST = [
  [1, 3.00], [2, 3.00], [3, 3.00], [4, 2.75], [5, 2.75],
  [6, 2.50], [7, 2.50], [8, 2.50], [9, 2.50], [10, 2.25],
  [11, 2.25], [12, 2.25], [13, 2.25], [14, 2.25], [15, 2.00],
  [16, 2.00], [17, 2.00], [18, 2.00], [19, 2.00], [20, 2.00],
  [21, 2.00], [22, 2.00], [23, 2.00], [24, 2.00], [25, 1.75],
  ...(function() {
    const arr = [];
    for (let q = 26; q <= 50; q++) arr.push([q, 1.75]);
    for (let q = 51; q <= 75; q++) arr.push([q, 1.50]);
    for (let q = 76; q <= 100; q++) arr.push([q, 1.25]);
    for (let q = 101; q <= 150; q++) arr.push([q, 1.00]);
    for (let q = 151; q <= 200; q++) arr.push([q, 0.75]);
    for (let q = 201; q <= 249; q++) arr.push([q, 0.75]);
    return arr;
  })(),
];

const SLEEVE = [
  [1, 2.50], [2, 2.50], [3, 2.50], [4, 2.25], [5, 2.25],
  [6, 2.00], [7, 2.00], [8, 2.00], [9, 2.00], [10, 1.75],
  [11, 1.75], [12, 1.75], [13, 1.75], [14, 1.75], [15, 1.50],
  [16, 1.50], [17, 1.50], [18, 1.50], [19, 1.50], [20, 1.50],
  [21, 1.50], [22, 1.50], [23, 1.50], [24, 1.50], [25, 1.25],
  ...(function() {
    const arr = [];
    for (let q = 26; q <= 50; q++) arr.push([q, 1.25]);
    for (let q = 51; q <= 75; q++) arr.push([q, 1.00]);
    for (let q = 76; q <= 100; q++) arr.push([q, 0.75]);
    for (let q = 101; q <= 150; q++) arr.push([q, 0.50]);
    for (let q = 151; q <= 200; q++) arr.push([q, 0.50]);
    for (let q = 201; q <= 249; q++) arr.push([q, 0.50]);
    return arr;
  })(),
];

const RIGHT_CHEST = LEFT_CHEST;

const HARDCODED_PRINT_LOCATIONS = [
  {
    id: 1, name: 'Front', code: 'front', includedInBase: true,
    internalCostPerUnit: 2.75, sortOrder: 1,
    pricingMatrix: (function() { const arr = []; for (const [q] of HARDCODED_PRICING_TIERS) arr.push([q, 0]); return arr; })(),
  },
  {
    id: 2, name: 'Back', code: 'back', includedInBase: false,
    internalCostPerUnit: 2.75, sortOrder: 2,
    pricingMatrix: BACKADD,
  },
  {
    id: 3, name: 'Left Chest', code: 'left_chest', includedInBase: false,
    internalCostPerUnit: 1.50, sortOrder: 3,
    pricingMatrix: LEFT_CHEST,
  },
  {
    id: 4, name: 'Right Chest', code: 'right_chest', includedInBase: false,
    internalCostPerUnit: 1.50, sortOrder: 4,
    pricingMatrix: RIGHT_CHEST,
  },
  {
    id: 5, name: 'Left Sleeve', code: 'left_sleeve', includedInBase: false,
    internalCostPerUnit: 1.75, sortOrder: 5,
    pricingMatrix: SLEEVE,
  },
  {
    id: 6, name: 'Right Sleeve', code: 'right_sleeve', includedInBase: false,
    internalCostPerUnit: 1.75, sortOrder: 6,
    pricingMatrix: SLEEVE,
  },
  {
    id: 7, name: 'Upper Back', code: 'upper_back', includedInBase: false,
    internalCostPerUnit: 1.75, sortOrder: 7,
    pricingMatrix: LEFT_CHEST,
  },
];

// Default cost settings (from settings table)
const HARDCODED_COST_SETTINGS = {
  blank_cost: 3.50,
  front_transfer_cost: 2.75,
  labor_cost: 2.50,
  back_transfer_cost: 2.75,
  design_size_large_surcharge: 1.50,
  design_size_oversized_surcharge: 2.50,
};

module.exports = {
  HARDCODED_PRICING_TIERS,
  HARDCODED_GARMENTS,
  HARDCODED_COLOR_PALETTES,
  HARDCODED_GARMENT_SIZES,
  HARDCODED_PRINT_LOCATIONS,
  HARDCODED_COST_SETTINGS,
  getGarmentById: (id) => HARDCODED_GARMENTS.find(g => g.id === Number(id)),
  getTierByQuantity: (qty) => HARDCODED_PRICING_TIERS.find(t => t[0] === qty),
  getLocationById: (id) => HARDCODED_PRINT_LOCATIONS.find(l => l.id === Number(id)),
  getColorsForGarment: (garmentId) => {
    const garment = HARDCODED_GARMENTS.find(g => g.id === Number(garmentId));
    return garment ? HARDCODED_COLOR_PALETTES[garment.colorPaletteKey] || [] : [];
  },
  getSizesForGarment: (garmentId) => {
    const sizes = HARDCODED_GARMENT_SIZES[garmentId];
    return sizes ? Object.keys(sizes).map(label => ({ label, surcharge: sizes[label] })) : [];
  },
};
