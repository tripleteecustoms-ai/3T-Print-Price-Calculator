# 3T Print Price Calculator v2.1 - PRODUCTION READY

## What's Working

### Customer Side (COMPLETE)
- ✓ 8-step quote builder with live price calculations
- ✓ Garment selection (all 11 products)
- ✓ Color & size selection with quantity entry
- ✓ Print location selection (all 7 locations)
- ✓ Print method selection (7 methods, optional)
- ✓ Custom personalization ($2.50/garment)
- ✓ Artwork upload & confirmation
- ✓ Order review & summary
- ✓ Quote email generation
- ✓ All pricing tiers working (1→5000+ items)
- ✓ Form validation and error handling
- ✓ Mobile responsive design

### Admin Dashboard (COMPLETE)
- ✓ Business settings (name, AKA, email, expiration)
- ✓ Email provider configuration (Gmail, Mock)
- ✓ Email template customization (4 status emails)
- ✓ Layout section visibility toggle
- ✓ Garment catalog view
- ✓ Customer management (create, view, list)
- ✓ Admin login with credentials

### Backend/API (COMPLETE)
- ✓ Quote calculation engine
- ✓ Email sending (Gmail + Mock)
- ✓ Status update email triggers
- ✓ 20+ API endpoints
- ✓ Database persistence
- ✓ Error handling

### Data (COMPLETE - Migrated from v1)
- ✓ 11 garments with colors/sizes
- ✓ 7 print locations with pricing
- ✓ 24 pricing tiers (1qty to 5000+qty)
- ✓ 1 existing customer (Shelman Burton)
- ✓ 1 existing quote with artwork
- ✓ All settings preserved

---

## Deploy to Render (5 min)

### Step 1: Push to GitHub
```bash
cd 3TPPC-Full
git add .
git commit -m "v2.1: Production-ready quote system"
git push origin main
```

### Step 2: Redeploy on Render
1. Go to Render dashboard > 3T-Print-Price-Calculator
2. Click "Redeploy latest"
3. Wait 2-3 minutes for build to complete
4. Check Logs tab if any errors

### Step 3: Configure Settings (10 min)
1. Visit: `https://threet-print-price-calculator.onrender.com/admin/login.html`
2. Login: `admin` / `3tprint-admin-2026`
3. Go to **General** tab:
   - Set Email Provider: Gmail
   - Enter your Gmail address
   - Generate 16-char App Password (Google Account > Security > App Passwords)
   - Paste in (without spaces)
   - Click "Save All Settings"
4. Go to **Email Templates** tab:
   - Edit the 4 status emails to match your voice
   - Use {{order_number}} and {{customer_name}} variables
   - Click "Save" for each
5. Go to **Layout** tab:
   - Check which sections are visible
   - Toggle "Print Method" if needed
6. Verify **Garments** tab shows all 11 products

### Step 4: Test
1. Visit: `https://threet-print-price-calculator.onrender.com/customer/`
2. Click "Start Quote"
3. Fill out all steps (use test email)
4. At final step, submit
5. Check email inbox for quote

---

## Features by Section

### Customer Quote Builder (8 steps)

**Step 1: Customer Info**
- First/Last name, email, phone
- Optional business name
- Auto-creates customer on quote submission

**Step 2: Garment Selection**
- 11 products with images
- Click to select
- One garment per quote

**Step 3: Colors & Quantities**
- All colors for selected garment
- All sizes per color
- Enter qty for each size/color combo
- Live totals

**Step 4: Print Locations**
- All 7 locations (chest, back, sleeve, etc)
- Select multiple locations
- Pricing auto-adjusts per location

**Step 5: Print Method** (optional, toggle in admin)
- 7 methods (DTF, Screen Print, Embroidery, etc)
- Radio button selection
- No requirement to select

**Step 6: Personalization** (optional, toggle in admin)
- $2.50 per garment for custom names/numbers
- Checkbox to enable
- Cost shown on review

**Step 7: Artwork**
- 5 artwork options with pricing:
  - Print-ready $0
  - Needs adjustment $25
  - Concept only $50
  - Create from scratch $150
  - Review my art $0
- File upload
- Design notes
- Legal confirmations (3 checkboxes)

**Step 8: Review & Confirm**
- Full order summary
- Itemized price breakdown
- Customer info
- One-click submit
- Quote emailed to customer

### Admin Dashboard (5 tabs)

**General**
- Business name & AKA name
- Business email
- Email provider (Gmail or Mock)
- Gmail credentials (if chosen)
- Quote expiration days (1-365)

**Email Templates**
- Order Confirmed
- In Progress
- Ready for Pickup
- Shipped
- Edit subject + HTML body
- Use {{order_number}} and {{customer_name}} variables

**Layout**
- Show/hide form sections
- Buttons to toggle each section visible/hidden
- Print Method & Personalization can be toggled off

**Garments**
- Read-only list of all products
- Shows name, brand, colors, sizes, cost

**Customers**
- Create new customers manually
- List all customers
- Shows email, phone, account number, total spend

---

## Email Configuration

### Gmail (Recommended)
1. Go to: https://myaccount.google.com/apppasswords
2. Select "Mail" and "Windows Computer"
3. Google generates 16-character password
4. Copy password
5. Paste into admin Settings > Email Configuration > Gmail App Password
6. **No spaces - paste exactly as shown**

### Mock Mode (Testing)
- Emails log to console, not actually sent
- Good for development/testing

---

## URL References

| Page | URL |
|------|-----|
| Customer Quote | https://threet-print-price-calculator.onrender.com/customer/ |
| Admin Login | https://threet-print-price-calculator.onrender.com/admin/login.html |
| Admin Dashboard | https://threet-print-price-calculator.onrender.com/admin/ |
| Health Check | https://threet-print-price-calculator.onrender.com/api/health |

---

## Troubleshooting

**Build Failed**
- Check Render Logs
- Ensure all files uploaded to GitHub
- Verify package.json is valid

**Can't login to admin**
- Default: admin / 3tprint-admin-2026
- Clear browser cache (Ctrl+Shift+Delete)
- Check F12 console for errors

**Email not sending**
- Verify email provider is "Gmail" not "Mock"
- Check Gmail credentials in Settings
- Make sure 2-Step Verification is ON in Google Account
- App Password must be exactly 16 chars, no spaces
- Check Render logs for email errors

**Quote shows $0**
- Check pricing_tiers table
- Verify quantity selected in step 3

**Old data missing**
- Migration should have preserved all data
- Check database: data/db.sqlite exists
- Verify disk is attached in Render settings

---

## Technical Details

**Server**: Node.js + Express  
**Database**: SQLite (persistent disk)  
**Frontend**: Vanilla JS + HTML/CSS  
**Hosting**: Render Starter ($7/month)  

**Port**: 4790  
**Database Path**: data/db.sqlite  
**Build Command**: `npm install`  
**Start Command**: `npm start`  

---

## Support

If something breaks:
1. Check Render Logs
2. Check browser F12 console
3. Verify email settings in admin
4. Test with `/api/health` endpoint

Everything should work. Ship it.
