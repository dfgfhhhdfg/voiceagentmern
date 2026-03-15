const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  razorpayOrderId:   { type: String, required: true },
  razorpayPaymentId: { type: String, default: null },
  razorpaySignature: { type: String, default: null },
  amount:   { type: Number, required: true },   // in paise (e.g. 49900 = ₹499)
  currency: { type: String, default: 'INR' },
  plan:     { type: String, default: 'alex_access' },
  status:   { type: String, enum: ['created', 'paid', 'failed'], default: 'created' },
  paidAt:   { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);

