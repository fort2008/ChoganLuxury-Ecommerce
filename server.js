import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import multer from 'multer';
import basicAuth from 'express-basic-auth';
import Stripe from 'stripe';

dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-strong';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = process.env.CURRENCY || 'EUR';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// DB
const db = new sqlite3.Database(path.join(__dirname, 'data', 'chogan.sqlite'));

// Views & static
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Storage for uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const base = path.basename(file.originalname, ext).replace(/\s+/g,'-').toLowerCase();
    cb(null, `${base}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

// Basic auth for admin
const adminAuth = basicAuth({
  users: { 'admin': ADMIN_PASSWORD },
  challenge: true,
  realm: 'Chogan Admin'
});

// Helpers
function all(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.all(sql, params, (err, rows)=> err?reject(err):resolve(rows));
  });
}
function get(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.get(sql, params, (err, row)=> err?reject(err):resolve(row));
  });
}
function run(sql, params=[]) {
  return new Promise((resolve,reject)=>{
    db.run(sql, params, function(err){ err?reject(err):resolve(this); });
  });
}

// CONFIG
app.get('/config', (req,res) => {
  res.json({ publishableKey: STRIPE_PUBLISHABLE_KEY, currency: CURRENCY });
});

// Home/catalog
app.get('/', async (req,res) => {
  const q = (req.query.q || '').trim().toLowerCase();
  const gender = req.query.gender || 'Tous';
  const sort = req.query.sort || 'name-asc';

  let rows = await all("SELECT * FROM products ORDER BY name ASC");
  if (q) rows = rows.filter(p => (p.name||'').toLowerCase().includes(q) || (p.sku||'').toLowerCase()===q);
  if (gender !== 'Tous') rows = rows.filter(p => (p.gender||'Unisexe') === gender);

  if (sort === 'name-desc') rows.sort((a,b)=> (b.name||'').localeCompare(a.name||''));
  if (sort === 'price-asc') rows.sort((a,b)=> (a.price||0) - (b.price||0));
  if (sort === 'price-desc') rows.sort((a,b)=> (b.price||0) - (a.price||0));

  res.render('index', { products: rows, q, gender, sort });
});

// Product page
app.get('/product/:sku', async (req,res) => {
  const p = await get("SELECT * FROM products WHERE sku = ?", [req.params.sku]);
  if (!p) return res.status(404).render('404');
  res.render('product', { p });
});

// Cart page
app.get('/cart', (req,res) => res.render('cart'));

// Checkout API
app.post('/api/checkout', async (req,res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Stripe non configuré' });
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: 'Panier vide' });

    const line_items = [];
    let total = 0;
    for (const it of items) {
      const sku = String(it.sku || '').trim();
      const qty = Math.max(1, parseInt(it.qty || 1));
      const p = await get("SELECT * FROM products WHERE sku = ?", [sku]);
      if (!p) continue;
      const unit = Math.round((p.price || 0) * 100);
      total += (unit * qty);
      line_items.push({
        quantity: qty,
        price_data: {
          currency: CURRENCY.toLowerCase(),
          unit_amount: unit,
          product_data: { name: p.name, metadata: { sku: p.sku } }
        }
      });
    }
    if (!line_items.length) return res.status(400).json({ error: 'Produits introuvables' });

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: `${PUBLIC_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/cart`,
      allow_promotion_codes: true,
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: ['FR','BE','TN','IT','DE','NL'] }
    });

    await run("INSERT OR IGNORE INTO orders(stripe_session_id, items_json, total, currency, status) VALUES(?,?,?,?,?)",
      [session.id, JSON.stringify(items), total/100.0, CURRENCY, 'pending']);

    res.json({ sessionId: session.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Erreur de checkout' });
  }
});

// Success
app.get('/success', (req,res) => res.render('success', { session_id: req.query.session_id }));

// Webhook (optional secure)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req,res) => {
  try {
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
    const sig = req.headers['stripe-signature'];
    let event;
    if (endpointSecret) {
      event = (new Stripe(STRIPE_SECRET_KEY)).webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body);
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_details?.email || null;
      await run("UPDATE orders SET status='paid', customer_email=? WHERE stripe_session_id=?",
        [email, session.id]);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

// Re-enable body parser for normal routes
app.use(express.json());

// Admin
app.get('/admin', adminAuth, async (req,res) => {
  const rows = await all("SELECT * FROM products ORDER BY updated_at DESC");
  res.render('admin_list', { products: rows, msg: null });
});
app.get('/admin/orders', adminAuth, async (req,res) => {
  const rows = await all("SELECT * FROM orders ORDER BY created_at DESC");
  res.render('admin_orders', { orders: rows });
});
app.get('/admin/new', adminAuth, (req,res)=> res.render('admin_new', { msg: null }));
app.post('/admin/new', adminAuth, upload.single('imageFile'), async (req,res) => {
  const { sku, name, gender='Unisexe', price=49.90, default_size='70 ml' } = req.body;
  let image = req.body.image || '';
  if (req.file) image = '/uploads/' + req.file.filename;
  try {
    await run("INSERT INTO products (sku,name,gender,price,image,default_size) VALUES (?,?,?,?,?,?)",
      [sku, name, gender, parseFloat(price), image, default_size]);
    res.redirect('/admin');
  } catch (e) {
    res.render('admin_new', { msg: 'Erreur: ' + e.message });
  }
});
app.get('/admin/edit/:id', adminAuth, async (req,res) => {
  const p = await get("SELECT * FROM products WHERE id = ?", [req.params.id]);
  if (!p) return res.redirect('/admin');
  res.render('admin_edit', { p, msg: null });
});
app.post('/admin/edit/:id', adminAuth, upload.single('imageFile'), async (req,res) => {
  const { sku, name, gender='Unisexe', price=49.90, default_size='70 ml' } = req.body;
  let image = req.body.image || '';
  if (req.file) image = '/uploads/' + req.file.filename;
  try {
    await run("UPDATE products SET sku=?, name=?, gender=?, price=?, image=?, default_size=? WHERE id=?",
      [sku, name, gender, parseFloat(price), image, default_size, req.params.id]);
    res.redirect('/admin');
  } catch (e) {
    const p = await get("SELECT * FROM products WHERE id = ?", [req.params.id]);
    res.render('admin_edit', { p, msg: 'Erreur: ' + e.message });
  }
});
app.post('/admin/delete/:id', adminAuth, async (req,res) => {
  await run("DELETE FROM products WHERE id=?", [req.params.id]);
  res.redirect('/admin');
});

// 404
app.use((req,res)=> res.status(404).render('404'));

app.listen(PORT, ()=> console.log(`✅ Chogan E‑commerce on ${PUBLIC_BASE_URL}`));
