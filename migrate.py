#!/usr/bin/env python3
"""
Migration script: Old schema -> New schema with all enhancements
- Preserves all garments, colors, sizes, print locations, pricing, settings
- Adds: email templates, layout config, print methods, status templates
"""

import sqlite3
import json
from datetime import datetime

OLD_DB = "/mnt/user-data/uploads/3tprint.sqlite"
NEW_DB = "data/db.sqlite"

def init_new_schema(conn):
    """Create new database schema with all tables"""
    cursor = conn.cursor()
    
    # Admins
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS admins (
            id INTEGER PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Settings (key-value for business config)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Garments (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS garments (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            brand TEXT,
            style_number TEXT,
            description TEXT,
            image_url TEXT,
            internal_cost REAL DEFAULT 0,
            supplier_id INTEGER,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Suppliers (new)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS suppliers (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            contact_email TEXT,
            contact_phone TEXT,
            lead_time_days INTEGER,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Garment colors (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS garment_colors (
            id INTEGER PRIMARY KEY,
            garment_id INTEGER NOT NULL,
            name TEXT,
            hex TEXT,
            image_url TEXT,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            FOREIGN KEY(garment_id) REFERENCES garments(id)
        )
    """)
    
    # Garment sizes (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS garment_sizes (
            id INTEGER PRIMARY KEY,
            garment_id INTEGER NOT NULL,
            label TEXT,
            surcharge REAL DEFAULT 0,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            FOREIGN KEY(garment_id) REFERENCES garments(id)
        )
    """)
    
    # Print locations (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS print_locations (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            code TEXT,
            included_in_base INTEGER DEFAULT 0,
            internal_cost_per_unit REAL DEFAULT 0,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Print location pricing (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS print_location_pricing (
            print_location_id INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            addon_price REAL DEFAULT 0,
            PRIMARY KEY(print_location_id, quantity),
            FOREIGN KEY(print_location_id) REFERENCES print_locations(id)
        )
    """)
    
    # Pricing tiers (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS pricing_tiers (
            quantity INTEGER PRIMARY KEY,
            standard_price REAL,
            hard_floor_price REAL,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Print methods (new)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS print_methods (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            code TEXT UNIQUE,
            description TEXT,
            base_cost REAL DEFAULT 0,
            visible_to_customers INTEGER DEFAULT 1,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Print method sub-types (new)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS print_method_subtypes (
            id INTEGER PRIMARY KEY,
            print_method_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            code TEXT,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            FOREIGN KEY(print_method_id) REFERENCES print_methods(id)
        )
    """)
    
    # Print method add-ons (new)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS print_method_addons (
            id INTEGER PRIMARY KEY,
            print_method_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            description TEXT,
            cost REAL DEFAULT 0,
            active INTEGER DEFAULT 1,
            sort_order INTEGER,
            FOREIGN KEY(print_method_id) REFERENCES print_methods(id)
        )
    """)
    
    # Email templates (new - status update emails)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS email_templates (
            id INTEGER PRIMARY KEY,
            status_type TEXT UNIQUE NOT NULL,
            subject TEXT,
            body_html TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Layout configuration (new)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS layout_config (
            id INTEGER PRIMARY KEY,
            section_key TEXT UNIQUE NOT NULL,
            section_name TEXT,
            visible INTEGER DEFAULT 1,
            sort_order INTEGER,
            is_custom_button INTEGER DEFAULT 0,
            button_url TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Customers (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS customers (
            id INTEGER PRIMARY KEY,
            first_name TEXT,
            last_name TEXT,
            email TEXT UNIQUE,
            phone TEXT,
            business_name TEXT,
            account_number TEXT UNIQUE,
            total_spend REAL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    
    # Quotes (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS quotes (
            id INTEGER PRIMARY KEY,
            quote_code TEXT UNIQUE,
            customer_id INTEGER,
            status TEXT DEFAULT 'pending',
            garment_id INTEGER,
            print_method_id INTEGER,
            fulfillment_method TEXT,
            event_name TEXT,
            needed_by_date TEXT,
            notes TEXT,
            design_notes TEXT,
            discretionary_adjustment REAL DEFAULT 0,
            discretionary_adjustment_note TEXT,
            floor_override INTEGER DEFAULT 0,
            override_unit_price REAL,
            pricing_snapshot TEXT,
            subtotal REAL,
            total REAL,
            expires_at TEXT,
            viewed_at TEXT,
            checkout_started_at TEXT,
            paid_at TEXT,
            shopify_draft_order_id TEXT,
            shopify_order_id TEXT,
            payment_provider TEXT DEFAULT 'mock',
            payment_reference TEXT,
            amount_paid REAL,
            terms_accepted_at TEXT,
            artwork_status TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(customer_id) REFERENCES customers(id),
            FOREIGN KEY(garment_id) REFERENCES garments(id),
            FOREIGN KEY(print_method_id) REFERENCES print_methods(id)
        )
    """)
    
    # Quote items (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS quote_items (
            id INTEGER PRIMARY KEY,
            quote_id INTEGER NOT NULL,
            color_name TEXT,
            color_hex TEXT,
            size_label TEXT,
            quantity INTEGER,
            unit_surcharge REAL DEFAULT 0,
            FOREIGN KEY(quote_id) REFERENCES quotes(id)
        )
    """)
    
    # Quote print locations (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS quote_print_locations (
            id INTEGER PRIMARY KEY,
            quote_id INTEGER NOT NULL,
            print_location_id INTEGER,
            location_name TEXT,
            addon_price_each REAL DEFAULT 0,
            FOREIGN KEY(quote_id) REFERENCES quotes(id)
        )
    """)
    
    # Artwork files (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS artwork_files (
            id INTEGER PRIMARY KEY,
            quote_id INTEGER NOT NULL,
            draft_token TEXT,
            print_location_id INTEGER,
            location_name TEXT,
            original_filename TEXT,
            stored_filename TEXT,
            mime_type TEXT,
            size_bytes INTEGER,
            status TEXT,
            uploaded_at TEXT,
            FOREIGN KEY(quote_id) REFERENCES quotes(id)
        )
    """)
    
    # Quote events (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS quote_events (
            id INTEGER PRIMARY KEY,
            quote_id INTEGER NOT NULL,
            event_type TEXT,
            detail TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(quote_id) REFERENCES quotes(id)
        )
    """)
    
    # Emails sent (preserved)
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS emails_sent (
            id INTEGER PRIMARY KEY,
            quote_id INTEGER,
            to_email TEXT,
            subject TEXT,
            body_html TEXT,
            provider TEXT,
            sent_at TEXT,
            FOREIGN KEY(quote_id) REFERENCES quotes(id)
        )
    """)
    
    conn.commit()

def migrate_data(old_conn, new_conn):
    """Migrate all data from old DB to new schema"""
    old_cursor = old_conn.cursor()
    new_cursor = new_conn.cursor()
    
    now = datetime.now().isoformat()
    
    print("Migrating admins...")
    old_cursor.execute("SELECT id, username, password_hash, display_name, created_at FROM admins")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO admins (id, username, password_hash, display_name, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating settings...")
    old_cursor.execute("SELECT key, value FROM settings")
    for key, value in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, ?)
        """, (key, value, now))
    
    # Add new settings
    new_settings = {
        'business_aka_name': 'Triple Tee Print',
        'quote_expiration_days': '7',
        'email_provider': 'mock',
        'email_address': '',
        'email_app_password': '',
        'custom_status_email_enabled': '1'
    }
    for key, value in new_settings.items():
        new_cursor.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, value))
    
    print("Migrating garments...")
    old_cursor.execute("SELECT id, name, brand, style_number, description, image_url, internal_cost, active, sort_order FROM garments")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO garments (id, name, brand, style_number, description, image_url, internal_cost, active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating garment colors...")
    old_cursor.execute("SELECT id, garment_id, name, hex, image_url, active, sort_order FROM garment_colors")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO garment_colors (id, garment_id, name, hex, image_url, active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating garment sizes...")
    old_cursor.execute("SELECT id, garment_id, label, surcharge, active, sort_order FROM garment_sizes")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO garment_sizes (id, garment_id, label, surcharge, active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating print locations...")
    old_cursor.execute("SELECT id, name, code, included_in_base, internal_cost_per_unit, active, sort_order FROM print_locations")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO print_locations (id, name, code, included_in_base, internal_cost_per_unit, active, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating print location pricing...")
    old_cursor.execute("SELECT print_location_id, quantity, addon_price FROM print_location_pricing")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO print_location_pricing (print_location_id, quantity, addon_price)
            VALUES (?, ?, ?)
        """, row)
    
    print("Migrating pricing tiers...")
    old_cursor.execute("SELECT quantity, standard_price, hard_floor_price FROM pricing_tiers")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO pricing_tiers (quantity, standard_price, hard_floor_price)
            VALUES (?, ?, ?)
        """, row)
    
    print("Migrating customers...")
    old_cursor.execute("SELECT id, first_name, last_name, email, phone, business_name FROM customers")
    for id, first, last, email, phone, business in old_cursor.fetchall():
        acct_num = f"ACCT-{id:06d}"
        new_cursor.execute("""
            INSERT INTO customers (id, first_name, last_name, email, phone, business_name, account_number)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (id, first, last, email, phone, business, acct_num))
    
    print("Migrating quotes...")
    old_cursor.execute("""
        SELECT id, quote_code, customer_id, status, garment_id, fulfillment_method, event_name,
               needed_by_date, notes, design_notes, discretionary_adjustment, discretionary_adjustment_note,
               floor_override, override_unit_price, pricing_snapshot, subtotal, total, expires_at, viewed_at,
               checkout_started_at, paid_at, shopify_draft_order_id, shopify_order_id, payment_provider,
               payment_reference, amount_paid, terms_accepted_at, artwork_status, created_at, updated_at
        FROM quotes
    """)
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO quotes (id, quote_code, customer_id, status, garment_id, fulfillment_method, event_name,
                                needed_by_date, notes, design_notes, discretionary_adjustment, discretionary_adjustment_note,
                                floor_override, override_unit_price, pricing_snapshot, subtotal, total, expires_at, viewed_at,
                                checkout_started_at, paid_at, shopify_draft_order_id, shopify_order_id, payment_provider,
                                payment_reference, amount_paid, terms_accepted_at, artwork_status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating quote items...")
    old_cursor.execute("SELECT id, quote_id, color_name, color_hex, size_label, quantity, unit_surcharge FROM quote_items")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO quote_items (id, quote_id, color_name, color_hex, size_label, quantity, unit_surcharge)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating quote print locations...")
    old_cursor.execute("SELECT id, quote_id, print_location_id, location_name, addon_price_each FROM quote_print_locations")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO quote_print_locations (id, quote_id, print_location_id, location_name, addon_price_each)
            VALUES (?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating artwork files...")
    old_cursor.execute("""
        SELECT id, quote_id, draft_token, print_location_id, location_name, original_filename,
               stored_filename, mime_type, size_bytes, status, uploaded_at FROM artwork_files
    """)
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO artwork_files (id, quote_id, draft_token, print_location_id, location_name,
                                      original_filename, stored_filename, mime_type, size_bytes, status, uploaded_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating quote events...")
    old_cursor.execute("SELECT id, quote_id, event_type, detail, created_at FROM quote_events")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO quote_events (id, quote_id, event_type, detail, created_at)
            VALUES (?, ?, ?, ?, ?)
        """, row)
    
    print("Migrating emails sent...")
    old_cursor.execute("SELECT id, quote_id, to_email, subject, body_html, provider, sent_at FROM emails_sent")
    for row in old_cursor.fetchall():
        new_cursor.execute("""
            INSERT INTO emails_sent (id, quote_id, to_email, subject, body_html, provider, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, row)
    
    # Add default print methods
    print("Creating default print methods...")
    print_methods = [
        ("dtf", "DTF (Direct-to-Film)", "Direct-to-Film transfer printing", 2.75),
        ("screen", "Screen Print", "Traditional screen printing", 2.75),
        ("embroidery", "Embroidery", "Professional embroidery", 3.50),
        ("sublimation", "Sublimation", "Sublimation printing", 3.00),
        ("dtg", "DTG (Direct-to-Garment)", "Direct-to-garment printing", 4.00),
        ("vinyl", "Vinyl", "Heat transfer vinyl", 1.50),
        ("laser", "Laser Printing", "Laser engraving/printing", 3.75),
    ]
    for i, (code, name, desc, cost) in enumerate(print_methods, 1):
        new_cursor.execute("""
            INSERT INTO print_methods (id, code, name, description, base_cost, sort_order)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (i, code, name, desc, cost, i))
    
    # Add default layout sections
    print("Creating default layout sections...")
    sections = [
        ("customer_info", "Customer Info", 1, 1),
        ("garment", "Garment Selection", 1, 2),
        ("color", "Color Selection", 1, 3),
        ("sizes", "Sizes", 1, 4),
        ("print_locations", "Print Locations", 1, 5),
        ("print_method", "Print Method", 0, 6),  # Optional by default
        ("artwork", "Artwork Upload", 1, 7),
        ("personalization", "Custom Personalization", 0, 8),  # Optional by default
        ("review", "Order Review & Confirm", 1, 9),
    ]
    for key, name, visible, order in sections:
        new_cursor.execute("""
            INSERT INTO layout_config (section_key, section_name, visible, sort_order)
            VALUES (?, ?, ?, ?)
        """, (key, name, visible, order))
    
    # Add default email templates for status updates
    print("Creating default email templates...")
    templates = {
        "order_confirmed": {
            "subject": "Order Confirmed - {{order_number}}",
            "body": "<h2>Your order has been confirmed!</h2><p>Thank you for your order. We'll begin production shortly.</p>"
        },
        "in_progress": {
            "subject": "Order In Progress - {{order_number}}",
            "body": "<h2>Your order is being prepared</h2><p>We're currently working on your order and will have it ready soon.</p>"
        },
        "ready_for_pickup": {
            "subject": "Your Order is Ready - {{order_number}}",
            "body": "<h2>Your order is ready for pickup!</h2><p>Your items are ready. Please come pick them up at your earliest convenience.</p>"
        },
        "shipped": {
            "subject": "Your Order Has Shipped - {{order_number}}",
            "body": "<h2>Your order is on its way!</h2><p>Your items have been shipped and tracking information is below.</p>"
        }
    }
    for status, content in templates.items():
        new_cursor.execute("""
            INSERT INTO email_templates (status_type, subject, body_html)
            VALUES (?, ?, ?)
        """, (status, content["subject"], content["body"]))
    
    new_conn.commit()
    print("\nMigration complete!")

if __name__ == "__main__":
    print("Starting migration...")
    
    # Open old DB (read only)
    old_conn = sqlite3.connect(f"file:{OLD_DB}?mode=ro", uri=True)
    
    # Create new DB
    new_conn = sqlite3.connect(NEW_DB)
    
    # Initialize schema
    print("Creating new schema...")
    init_new_schema(new_conn)
    
    # Migrate data
    migrate_data(old_conn, new_conn)
    
    old_conn.close()
    new_conn.close()
    
    print(f"✓ New database created at: {NEW_DB}")
    print("✓ All data migrated successfully")
