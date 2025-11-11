// app.js
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const bodyParser = require('body-parser');
const dotenv = require('dotenv');
const stripe = require('stripe');
dotenv.config();

const app = express();

// --- MIDDLEWARE ---
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.raw({ type: 'application/json' }));
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'urban-solz-secret-2025',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));
app.set('view engine', 'ejs');

// --- DATABASE ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('MongoDB Connected');
    // Start server AFTER DB is ready
    startServer();
  })
  .catch(err => {
    console.error('DB Connection Failed:', err);
    process.exit(1);
  });

// --- MODELS ---
const Product = require('./models/Product');
const Order = require('./models/Order');
const Config = require('./models/Config');
const Admin = require('./models/Admin');
const EmailConfig = require('./models/EmailConfig');

// --- DYNAMIC EMAIL CONFIG (Loads after DB ready) ---
let cachedEmailConfig = null;

async function getEmailConfig() {
  if (!cachedEmailConfig) {
    try {
      cachedEmailConfig = await EmailConfig.findOne().lean();
      if (!cachedEmailConfig) {
        console.log('No EmailConfig → seeding from .env');
        cachedEmailConfig = {
          emailUser: process.env.EMAIL_USER,
          emailPass: process.env.EMAIL_PASS,
          sellerEmail: process.env.SELLER_EMAIL
        };
        await new EmailConfig(cachedEmailConfig).save();
      }
    } catch (err) {
      console.error('EmailConfig error:', err);
      cachedEmailConfig = {
        emailUser: process.env.EMAIL_USER,
        emailPass: process.env.EMAIL_PASS,
        sellerEmail: process.env.SELLER_EMAIL
      };
    }
  }
  return cachedEmailConfig;
}

// --- STRIPE WEBHOOK ---
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const config = await Config.findOne();
  if (!config?.stripeSecretKey || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(400).send('Not configured');
  }

  let event;
  try {
    event = stripe(config.stripeSecretKey).webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(400).send(`Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = await Order.findOne({ stripeSessionId: session.id });
    if (order && order.status === 'Pending') {
      order.status = 'Confirmed';
      await order.save();
      console.log(`Order ${order._id} confirmed via webhook`);
    }
  }

  res.json({ received: true });
});

// --- ROUTES (Loaded AFTER DB) ---
let storeRoutes, adminRoutes;

async function loadRoutes() {
  storeRoutes = require('./routes/store')(getEmailConfig, app);
  adminRoutes = require('./routes/admin')(getEmailConfig, app);
  app.use('/', storeRoutes);
  app.use('/admin', adminRoutes);
}

// --- SEED DATA (After DB ready) ---
async function seedData() {
  try {
    if (await Admin.countDocuments() === 0) {
      await new Admin({ username: 'admin', password: 'password' }).save();
      console.log('Admin: admin / password');
    }

    if (await Product.countDocuments() === 0) {
      const products = [
        { name: 'Chelsea Leather Boots', description: 'Premium UK leather', price: 189, image: 'https://via.placeholder.com/300' },
        { name: 'Oxford Brogues', description: 'Classic British', price: 159, image: 'https://via.placeholder.com/300' }
      ];
      await Product.insertMany(products);
      console.log('2 UK products seeded');
    }

    if (await Config.countDocuments() === 0) {
      await new Config({
        stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || 'pk_test_xxx',
        stripeSecretKey: process.env.STRIPE_SECRET_KEY || 'sk_test_xxx'
      }).save();
      console.log('Stripe config seeded');
    }
  } catch (err) {
    console.error('Seed error:', err);
  }
}

// --- START SERVER (After DB + Seed + Routes) ---
async function startServer() {
  await seedData();
  await loadRoutes();

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Mode: ${process.env.NODE_ENV || 'development'}`);
    if (process.env.RENDER) {
      console.log(`LIVE: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
    }
  });
}
