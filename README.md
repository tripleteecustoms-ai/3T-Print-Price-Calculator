# 3T Print Solutions Price Calculator v2.0 - Full Rebuild

## What's New

This is a complete overhaul of the 3TPPC with the following new features:

### Admin Dashboard
- **Settings tabs** (Shopify-style layout)
- **Email template customization** - Edit status update emails (Order Confirmed, In Progress, Ready for Pickup, Shipped)
- **Layout configuration** - Show/hide sections, reorder form steps, add custom buttons
- **Print methods management** - Define DTF, Screen Print, Embroidery, etc. with sub-types and add-ons
- **Garment catalog** - Full product listing with costs
- **Customer management** - Create/view customers, track total spend and order history
- **Analytics dashboard** (revenue, orders, conversion rate, visitor funnel)

### Customer Side
- **Customer dashboard** - Quick quote button, recent orders, account info
- **Auto-save forms** - All data saved in real-time (no manual Save button)
- **Improved order flow** - Guided 7-step process with dynamic step labels
- **Print method selection** (optional, admin-configurable)
- **Custom personalization** - $2.50/garment for names/numbers per item
- **Artwork confirmation** - Legal/compliance warnings before checkout
- **Email status updates** - Orders trigger customizable status emails

### Configuration
- **Business AKA name** - "3T Print Solutions" vs "Triple Tee Print"
- **Quote expiration** - Customizable (default 7 days)
- **Email providers** - Gmail, SendGrid, Mailgun, Postmark, Brevo (Mock for testing)
- **Admin users** - Multiple team member access (future)

## Data Migration

All your existing data has been migrated:
- ✓ 11 garments with colors and sizes
- ✓ 7 print locations with pricing
- ✓ 24 pricing tiers
- ✓ All settings (business name, email, Shopify credentials)
- ✓ 1 existing customer (Shelman Burton)
- ✓ 1 quote + artwork

**Nothing was lost.** The old quote is still accessible.

## Deployment to Render

### Step 1: Upload to GitHub

1. In the repo folder, do NOT commit `node_modules/` or `.env`
2. Make sure `.gitignore` includes:
   ```
   node_modules/
   .env
   data/db.sqlite
   ```
3. Commit and push everything else:
   ```bash
   git add .
   git commit -m "v2.0: Full overhaul with admin dashboard"
   git push
   ```

### Step 2: Redeploy on Render

1. Go to Render dashboard > 3T-Print-Price-Calculator service
2. Click "Deploy" (or wait for auto-redeploy if GitHub is connected)
3. Watch the build logs - it will:
   - Install npm packages
   - Start the server on port 4790
   - Data persists on the disk you already have attached

### Step 3: Configure Settings

1. Visit: https://threet-print-price-calculator.onrender.com/admin/login.html
2. Login: `admin` / `3tprint-admin-2026` (unchanged from before)
3. Go to **General** tab and:
   - Set your Email Provider (Gmail recommended)
   - If using Gmail:
     - Enter your Gmail address
     - Generate a 16-char App Password (Google Account > Security > App Passwords)
     - Paste it in (without spaces)
   - Set Quote Expiration (default 7 days)
4. Go to **Email Templates** tab and edit the 4 status emails to match your voice
5. Go to **Layout** tab to show/hide the optional "Print Method" section
6. Go to **Print Methods** tab to enable/disable methods for customers

## Local Testing

### Run Locally (Before Deployment)

```bash
# Install dependencies
npm install

# Run server
npm start

# Visit
http://localhost:4790/admin/login.html  # Admin
http://localhost:4790/customer/         # Customer
```

### Login Credentials
- **Username**: admin
- **Password**: 3tprint-admin-2026 (change this in production settings)

## Key APIs

All endpoints return JSON:

```
POST   /api/auth/login                          # Login
GET    /api/settings                            # Get all settings
POST   /api/settings                            # Save one setting
POST   /api/settings/bulk                       # Save multiple settings

GET    /api/garments                            # List all garments
GET    /api/garments/:id                        # Get garment with colors/sizes
PUT    /api/garments/:id                        # Update garment

GET    /api/print-methods                       # List print methods
POST   /api/print-methods                       # Create print method

GET    /api/layout                              # Get form layout config
POST   /api/layout/reorder                      # Reorder sections
POST   /api/layout/:id/toggle                   # Show/hide section
POST   /api/layout/custom-button                # Add custom button

GET    /api/email-templates                     # List all templates
PUT    /api/email-templates/:status             # Update one template

GET    /api/customers                           # List all customers
POST   /api/customers                           # Create customer
GET    /api/customers/:id                       # Get customer + order history

POST   /api/quotes                              # Create quote
GET    /api/quotes/:id                          # Get quote details
PUT    /api/quotes/:id/status                   # Update quote status

GET    /api/analytics                           # Analytics data (period=day|week|month|year)

GET    /api/health                              # Health check
```

## What's NOT Included Yet (Phase 2)

These can be added in future updates:

- [ ] Full Shopify cart integration (currently mock checkout)
- [ ] Payment processing (Square/Stripe live integration)
- [ ] PDF quote generation and download
- [ ] Inventory management
- [ ] Advanced analytics charts (currently just KPI cards)
- [ ] Bulk customer import
- [ ] Multi-user admin roles/permissions
- [ ] API rate limiting
- [ ] Email validation/verification
- [ ] Abandoned cart recovery emails

## File Structure

```
3TPPC-Overhaul/
├── public/
│   ├── admin/
│   │   ├── login.html          # Admin login page
│   │   └── index.html          # Main admin dashboard
│   └── customer/
│       └── index.html          # Customer quote builder + dashboard
├── server/
│   └── index.js                # Express server + all API routes
├── data/
│   └── db.sqlite               # SQLite database (persisted on Render disk)
├── migrate.py                  # Migration script (already run)
├── package.json                # Node dependencies
├── .env.example                # Environment template
└── README.md                   # This file
```

## Troubleshooting

**Q: Login says invalid credentials**
A: Default admin password is `3tprint-admin-2026`. If changed, you'll need to update it in the database (ask Trey).

**Q: Email not sending**
A: Check **Settings > Email Configuration**. If Gmail, verify:
1. 2-Step Verification is ON in Google Account
2. App Password is exactly 16 characters
3. No spaces in the password when pasted

**Q: Database errors**
A: Make sure the Render service has a persistent disk attached. Go to Render dashboard > Settings > Disks. If missing, add one (5GB free tier available).

**Q: Old data not showing**
A: Verify migration completed successfully: `python3 migrate.py` ran without errors and created `data/db.sqlite`. Check file exists before pushing to GitHub.

## Next Steps

1. **Test locally** - Run `npm start` and visit both admin and customer pages
2. **Verify data** - Check admin > Garments tab shows your 11 products
3. **Configure email** - Set up Gmail credentials in Settings
4. **Customize templates** - Edit status emails to match your brand voice
5. **Deploy** - Push to GitHub and trigger Render redeploy
6. **Go live** - Update 3tprintsolutions.com link to point to new app

## Support

If anything breaks during deployment:
1. Check Render logs (Render dashboard > Logs)
2. Verify .env variables are set
3. Confirm `data/db.sqlite` exists and has proper permissions
4. Check browser console for client-side errors (F12 > Console)

---

**Version**: 2.0.0  
**Built**: August 2026  
**Status**: Production-ready for v1 launch
