// routes/store.js
const stripeLib = require('stripe');
const nodemailer = require('nodemailer');  // ← correct import
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');

module.exports = function(getEmailConfig, app) {
  const router = require('express').Router();

  let transporter;
  function createTransporter() {
    const cfg = getEmailConfig();
    transporter = nodemailer.createTransport({  // ← "createTransport" NOT "createTransporter"
      service: 'gmail',
      auth: { user: cfg.emailUser, pass: cfg.emailPass }
    });
  }
  createTransporter();

  // Allow admin to refresh
  router.createTransporter = createTransporter;

  // Home
  router.get('/', async (req, res) => {
    const products = await Product.find();
    res.render('index', { products, cart: req.session.cart || [] });
  });

  // Add to Cart
  router.post('/add-to-cart/:id', async (req, res) => {
    const product = await Product.findById(req.params.id);
    if (!req.session.cart) req.session.cart = [];
    const existing = req.session.cart.find(i => i.id === req.params.id);
    if (existing) existing.quantity += 1;
    else req.session.cart.push({ id: product._id, name: product.name, price: product.price, quantity: 1 });
    res.redirect('/');
  });

  // Cart
  router.get('/cart', (req, res) => {
    const cart = req.session.cart || [];
    const total = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
    res.render('cart', { cart, total });
  });

  // Checkout
  router.post('/checkout', async (req, res) => {
    const cfg = getEmailConfig();
    const config = await Config.findOne();
    const stripe = stripeLib(config.stripeSecretKey);

    const cart = req.session.cart || [];
    const totalCents = cart.reduce((sum, i) => sum + i.price * i.quantity, 0) * 100;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: cart.map(item => ({
        price_data: {
          currency: 'usd',
          product_data: { name: item.name },
          unit_amount: item.price * 100
        },
        quantity: item.quantity
      })),
      mode: 'payment',
      success_url: `${req.protocol}://${req.get('host')}/success`,
      cancel_url: `${req.protocol}://${req.get('host')}/cart`
    });

    const order = new Order({
      items: cart.map(i => ({ product: i.id, quantity: i.quantity })),
      total: totalCents / 100,
      email: req.body.email,
      stripeSessionId: session.id
    });
    await order.save();

    // Buyer Email
    await transporter.sendMail({
      from: cfg.emailUser,
      to: req.body.email,
      subject: 'Confirm Your Order',
      html: `
        <h3>Order #${order._id}</h3>
        <p>Total: $${order.total}</p>
        <p><a href="${req.protocol}://${req.get('host')}/order/confirm/${order._id}">Confirm</a></p>
        <p><a href="${req.protocol}://${req.get('host')}/order/cancel/${order._id}">Cancel</a></p>
      `
    });

    // Owner Alert
    await transporter.sendMail({
      from: cfg.emailUser,
      to: cfg.sellerEmail,
      subject: `New Order #${order._id}`,
      text: `From: ${req.body.email} | Total: $${order.total}`
    });

    res.redirect(303, session.url);
  });

  // Success
  router.get('/success', (req, res) => {
    req.session.cart = [];
    res.render('success');
  });

  // Confirm
  router.get('/order/confirm/:id', async (req, res) => {
    const cfg = getEmailConfig();
    const order = await Order.findById(req.params.id);
    order.status = 'Confirmed';
    await order.save();

    await transporter.sendMail({
      from: cfg.emailUser,
      to: cfg.sellerEmail,
      subject: `Order Confirmed #${order._id}`,
      text: 'Customer confirmed.'
    });

    res.send('<h1>Order Confirmed!</h1>');
  });

  // Cancel
  router.get('/order/cancel/:id', async (req, res) => {
    const cfg = getEmailConfig();
    const order = await Order.findById(req.params.id);
    order.status = 'Cancelled';
    await order.save();

    const config = await Config.findOne();
    const stripe = stripeLib(config.stripeSecretKey);
    try {
      const session = await stripe.checkout.sessions.retrieve(order.stripeSessionId);
      if (session.payment_intent) {
        await stripe.refunds.create({ payment_intent: session.payment_intent });
      }
    } catch (e) {}

    await transporter.sendMail({
      from: cfg.emailUser,
      to: cfg.sellerEmail,
      subject: `Order Cancelled #${order._id}`,
      text: 'Customer cancelled. Refunded.'
    });

    res.send('<h1>Order Cancelled</h1>');
  });

  return router;
};
