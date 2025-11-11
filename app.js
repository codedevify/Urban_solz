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

// SESSION: SECURE ON RENDER (HTTPS)
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'urban-solz-secure-2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS on Render
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    },
  })
);

app.set('view engine', 'ejs');

// --- DATABASE ---
mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch((err) => {
    console.error('DB Error:', err);
    process.exit(1);
  });

// --- MODELS ---
const Product = require('./models/Product');
const Order = require('./models/Order');
const Config = require('./models/Config');
const Admin = require('./models/Admin');
const EmailConfig = require('./models/EmailConfig');

// --- EMAIL CONFIG ---
let cachedEmailConfig = null;
async function getEmailConfig() {
  if (!cachedEmailConfig) {
    try {
      cachedEmailConfig = await EmailConfig.findOne().lean();
      if (!cachedEmailConfig) {
        cachedEmailConfig = {
          emailUser: process.env.EMAIL_USER,
          emailPass: process.env.EMAIL_PASS,
          sellerEmail: process.env.SELLER_EMAIL,
        };
        await new EmailConfig(cachedEmailConfig).save();
      }
    } catch (err) {
      console.error('EmailConfig error:', err);
      cachedEmailConfig = {
        emailUser: process.env.EMAIL_USER,
        emailPass: process.env.EMAIL_PASS,
        sellerEmail: process.env.SELLER_EMAIL,
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
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const order = await Order.findOne({ stripeSessionId: session.id });
    if (order && order.status === 'Pending') {
      order.status = 'Confirmed';
      await order.save();
    }
  }
  res.json({ received: true });
});

// --- ROUTES ---
const storeRoutes = require('./routes/store')(getEmailConfig, app);
const adminRoutes = require('./routes/admin')(getEmailConfig, app);

app.use('/', storeRoutes);
app.use('/admin', adminRoutes);

// --- SEED ---
async function seedData() {
  try {
    if ((await Admin.countDocuments()) === 0) {
      await new Admin({ username: 'admin', password: 'password' }).save();
      console.log('Admin seeded');
    }
  } catch (err) {
    console.error('Seed error:', err);
  }
}
seedData();

// --- SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`LIVE: https://${process.env.RENDER_EXTERNAL_HOSTNAME}`);
});
