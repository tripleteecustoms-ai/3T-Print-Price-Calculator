# 3TPPC v2.0 Deployment Checklist

Complete these steps in order. Estimated time: 15 minutes.

## Pre-Deployment (Local)

- [ ] Extract the zip file: `3TPPC-Overhaul.zip`
- [ ] Navigate to folder: `cd 3TPPC-Overhaul`
- [ ] Verify file structure (should have `public/`, `server/`, `data/`, `package.json`)
- [ ] Verify database exists: `data/db.sqlite` (should be ~500KB)

## Test Locally (Optional but Recommended)

- [ ] Install dependencies: `npm install`
- [ ] Start server: `npm start`
- [ ] Visit admin: `http://localhost:4790/admin/login.html`
- [ ] Login: `admin` / `3tprint-admin-2026`
- [ ] Check Garments tab - should see 11 products
- [ ] Visit customer: `http://localhost:4790/customer/`
- [ ] Click "Get Instant Quote" and verify form loads
- [ ] Stop server: `Ctrl+C`

## Upload to GitHub

- [ ] Go to: https://github.com/tripleteecustoms-ai/3T-Print-Price-Calculator
- [ ] Delete all files in the repo (or create new branch)
- [ ] Drag-and-drop the 3TPPC-Overhaul folder contents into the GitHub web editor
- [ ] Files to upload:
  - [ ] `public/admin/login.html`
  - [ ] `public/admin/index.html`
  - [ ] `public/customer/index.html`
  - [ ] `server/index.js`
  - [ ] `data/db.sqlite`
  - [ ] `package.json`
  - [ ] `.env.example`
  - [ ] `.gitignore`
  - [ ] `README.md`
- [ ] Commit message: `v2.0: Full overhaul with admin dashboard and email templates`
- [ ] Click "Commit changes"

## Render Deployment

- [ ] Go to Render: https://dashboard.render.com
- [ ] Find service: "3T-Print-Price-Calculator"
- [ ] Click the service
- [ ] Check that **persistent disk** is attached (Settings > Disks)
  - If NOT attached: click "Add Disk", set to 5GB, click "Add"
- [ ] Click "Redeploy" or "Manual Deploy"
- [ ] Wait for build to complete (watch the Logs tab)
- [ ] When done, visit: https://threet-print-price-calculator.onrender.com/admin/login.html
- [ ] Login: `admin` / `3tprint-admin-2026`
- [ ] Verify you see the dashboard

## First-Time Configuration

Once logged in to the live admin:

### General Settings Tab
- [ ] Verify Business Name: "3T Print Solutions"
- [ ] Enter AKA Name: "Triple Tee Print"
- [ ] Verify Business Email: "orders@3tprintsolutions.com"
- [ ] Set Email Provider:
  - [ ] Choose "Gmail"
  - [ ] Enter your Gmail address (the one you'll send from)
  - [ ] Generate Gmail App Password:
    - Go to https://myaccount.google.com/apppasswords
    - Select "Mail" and "Windows Computer"
    - Copy the 16-character password
    - Paste into "Gmail App Password" field (no spaces)
  - [ ] Click "Save Settings"
- [ ] Set Quote Expiration: 7 (days)

### Email Templates Tab
- [ ] Edit "Order Confirmed" subject and body to match your voice
- [ ] Edit "In Progress" email
- [ ] Edit "Ready for Pickup" email
- [ ] Edit "Shipped" email
- [ ] Click "Save Template" for each one
- (Use {{order_number}} and {{customer_name}} as variables)

### Layout Tab
- [ ] Review form sections - all should be visible by default
- [ ] Optional: Click "Hide" on "Print Method" if you don't want customers selecting it
- [ ] Optional: Click "+ Add Custom Button" to add any special actions

### Garments Tab
- [ ] Verify all 11 garments appear (Standard Quality T-Shirt, Premium Soft T-Shirt, etc.)

### Print Methods Tab
- [ ] Review the 7 default methods (DTF, Screen Print, Embroidery, etc.)
- [ ] Optional: Add more methods if needed

### Customers Tab
- [ ] You should see 1 customer: "Shelman Burton"
- [ ] Can create new customers from here

## Test the Customer Flow

- [ ] Visit: https://threet-print-price-calculator.onrender.com/customer/
- [ ] Click "Get Instant Quote"
- [ ] Fill out Steps 1-7
- [ ] At Step 7, click "Get Quote Email"
- [ ] Check your email for the quote

## Go Live

Once testing is complete:

- [ ] Update 3tprintsolutions.com to link to: `https://threet-print-price-calculator.onrender.com/customer/`
- [ ] Update any external links to the quote tool
- [ ] Test on mobile phone to verify responsive design
- [ ] Send yourself a test quote and verify email received

## Troubleshooting

**Build failed?**
- Check Render Logs tab for error messages
- Make sure all files were uploaded to GitHub
- Verify `package.json` has correct dependencies

**Can't login?**
- Default password is `3tprint-admin-2026`
- Try clearing browser cache (Ctrl+Shift+Delete)
- Check browser console (F12) for errors

**Email not sending?**
- Verify Gmail credentials in Settings > Email Configuration
- Check that 2-Step Verification is ON in your Google Account
- Make sure App Password is exactly 16 characters with no spaces
- Try "Test Email" button if available

**Database errors?**
- Go to Render dashboard > Settings > Disks
- Verify a disk is attached (need at least 1GB)
- If missing, add one

**Old data missing?**
- Migration should have preserved:
  - All 11 garments
  - All pricing tiers
  - All settings
  - The 1 existing customer
- If missing, contact support

## Support

Questions or issues? Check:
1. README.md in the project folder
2. Render logs (Render dashboard > Logs)
3. Browser console (F12 > Console tab)

---

**Estimated time to deployment**: 15-20 minutes  
**Estimated time to configuration**: 10-15 minutes  
**Total**: ~30 minutes to full launch
