const express   = require('express');
const router    = express.Router();
const Razorpay  = require('razorpay');
const crypto    = require('crypto');
const Payment   = require('../models/Payment');
const User      = require('../models/User');
const { protect } = require('../middleware/Authmiddleware');

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ── POST /api/payment/create-order ────────────────────────────────────────
// Creates a Razorpay order. User must be logged in.
router.post('/create-order', protect, async (req, res) => {
  try {
    const amount   = 49900; // ₹499 in paise
    const currency = 'INR';

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `receipt_${req.user._id}_${Date.now()}`,
      notes: { userId: req.user._id.toString(), plan: 'alex_access' },
    });

    // Save pending payment record
    await Payment.create({
      user:            req.user._id,
      razorpayOrderId: order.id,
      amount,
      currency,
      plan: 'alex_access',
      status: 'created',
    });

    res.json({
      success: true,
      order,
      key: process.env.RAZORPAY_KEY_ID,
      user: {
        name:  req.user.name,
        email: req.user.email,
        phone: req.user.phone || '',
      },
    });
  } catch (err) {
    console.error('Razorpay create-order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /api/payment/verify ──────────────────────────────────────────────
// Verifies Razorpay signature and unlocks alex for the user.
router.post('/verify', protect, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Signature verification
    const generated = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (generated !== razorpay_signature) {
      await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { status: 'failed' }
      );
      return res.status(400).json({ success: false, error: 'Payment verification failed' });
    }

    // Mark payment as paid
    await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
        status: 'paid',
        paidAt: new Date(),
      }
    );

    // Unlock alex on the user record
    await User.findByIdAndUpdate(req.user._id, { hasalexAccess: true });

    console.log(`✅ Payment verified for user ${req.user.email} — alex unlocked`);
    res.json({ success: true, message: 'Payment verified. alex is now unlocked!' });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /api/payment/status ───────────────────────────────────────────────
// Returns whether the current user has paid for alex access.
router.get('/status', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('hasalexAccess');
    res.json({ success: true, hasalexAccess: !!user?.hasalexAccess });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
