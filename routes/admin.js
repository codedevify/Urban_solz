// routes/admin.js
const multer = require('multer');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const Product = require('../models/Product');
const Order = require('../models/Order');
const Config = require('../models/Config');
const Admin = require('../models/Admin');
const EmailConfig = require('../models/EmailConfig');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

module.exports = function(getEmailConfig, app) {
  const router = require('express').Router();

  const storage = multer.memoryStorage();
  const upload = multer({ storage });

  const isAdmin = (req, res, next) => {
    if (req.session.admin) return next();
    res.redirect('/admin/login');
  };

  // === LOGIN ===
  router.get('/login', (req, res) => res.render('admin/login'));
  router.post('/login', async (req, res) => {
    try {
      const admin = await Admin.findOne({ 
        username: req.body.username, 
        password: req.body.password 
      });
      if (admin) {
        req.session.admin = true;
        res.redirect('/admin');
      } else {
        res.send('Invalid login');
      }
    } catch (err) {
      res.status(500).send('Server error');
    }
  });

  // === DASHBOARD ===
  router.get('/', isAdmin, async (req, res) => {
    try {
      const [orders, products, config, emailConfig] = await Promise.all([
        Order.find().populate('items.product'),
        Product.find(),
        Config.findOne(),
        EmailConfig.findOne()
      ]);
      res.render('admin/dashboard', { orders, products, config, emailConfig });
    } catch (err) {
      console.error(err);
      res.status(500).send('Server error');
    }
  });

  // === EMAIL SETTINGS ===
  router.get('/email-settings', isAdmin, async (req, res) => {
    const emailConfig = await EmailConfig.findOne();
    res.render('admin/email-settings', { config: emailConfig });
  });

  router.post('/email-config', isAdmin, async (req, res) => {
    const { emailUser, emailPass, sellerEmail } = req.body;
    await EmailConfig.updateOne(
      {},
      { emailUser, emailPass, sellerEmail },
      { upsert: true }
    );

    // Refresh transporter
    const storeRoutes = require('./store');
    const storeRouter = storeRoutes(getEmailConfig, app);
    if (storeRouter.createTransporter) {
      storeRouter.createTransporter();
    }

    res.redirect('/admin/email-settings');
  });

  // === ADD PRODUCT ===
  router.post('/product/add', isAdmin, upload.single('image'), async (req, res) => {
    let imageUrl = '';

    if (req.file) {
      try {
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'image' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.file.buffer);
        });
        imageUrl = result.secure_url;
      } catch (err) {
        console.error('Image upload failed:', err);
        return res.status(500).send('Failed to upload image');
      }
    }

    try {
      const product = new Product({
        name: req.body.name,
        description: req.body.desc,
        price: req.body.price,
        image: imageUrl
      });
      await product.save();
      res.redirect('/admin');
    } catch (err) {
      console.error(err);
      res.status(500).send('Failed to save product');
    }
  });

  // === EDIT PRODUCT ===
  router.post('/product/edit/:id', isAdmin, upload.single('image'), async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).send('Product not found');

      const update = {
        name: req.body.name,
        description: req.body.desc,
        price: req.body.price
      };

      if (req.file) {
        // Delete old Cloudinary image if exists
        if (product.image && typeof product.image === 'string' && product.image.startsWith('https://res.cloudinary.com/')) {
          const publicId = product.image.split('/').pop().split('.')[0];
          try {
            await cloudinary.uploader.destroy(publicId);
          } catch (err) {
            console.warn('Failed to delete old image:', err);
          }
        }

        // Upload new image
        const result = await new Promise((resolve, reject) => {
          const uploadStream = cloudinary.uploader.upload_stream(
            { resource_type: 'image' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          uploadStream.end(req.file.buffer);
        });
        update.image = result.secure_url;
      }
      // If no new file, keep old image (even if empty)

      await Product.findByIdAndUpdate(req.params.id, update);
      res.redirect('/admin');
    } catch (err) {
      console.error('Edit error:', err);
      res.status(500).send('Server error');
    }
  });

  // === DELETE PRODUCT ===
  router.post('/product/delete/:id', isAdmin, async (req, res) => {
    try {
      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).send('Product not found');

      // Delete image from Cloudinary if it's a Cloudinary URL
      if (product.image && typeof product.image === 'string' && product.image.startsWith('https://res.cloudinary.com/')) {
        const publicId = product.image.split('/').pop().split('.')[0];
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (err) {
          console.warn('Failed to delete image from Cloudinary:', err);
        }
      }

      await Product.findByIdAndDelete(req.params.id);
      res.redirect('/admin');
    } catch (err) {
      console.error('Delete error:', err);
      res.status(500).send('Failed to delete product');
    }
  });

  // === CONFIRM ORDER ===
  router.post('/order/confirm/:id', isAdmin, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: 'Confirmed' });
    res.redirect('/admin');
  });

  // === CANCEL ORDER ===
  router.post('/order/cancel/:id', isAdmin, async (req, res) => {
    await Order.findByIdAndUpdate(req.params.id, { status: 'Cancelled' });
    res.redirect('/admin');
  });

  // === UPDATE STRIPE KEYS ===
  router.post('/config', isAdmin, async (req, res) => {
    await Config.updateOne(
      {},
      {
        stripePublishableKey: req.body.pk,
        stripeSecretKey: req.body.sk
      },
      { upsert: true }
    );
    res.redirect('/admin');
  });

  return router;
};
