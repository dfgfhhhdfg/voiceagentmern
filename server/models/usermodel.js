const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema({
  name:     { type: String, required: [true, 'Name is required'], trim: true },
  email:    { type: String, required: [true, 'Email is required'], unique: true, lowercase: true, trim: true },
  password: { type: String, required: [true, 'Password is required'], minlength: 6, select: false },
  phone:    { type: String, default: '' },
  role:     { type: String, enum: ['patient', 'admin'], default: 'patient' },

  // ── alex AI access — unlocked after Razorpay payment ──
  hasalexAccess: { type: Boolean, default: false },

}, { timestamps: true });

// Hash password before save
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare entered password with stored hash
userSchema.methods.matchPassword = async function (entered) {
  return bcrypt.compare(entered, this.password);
};

module.exports = mongoose.model('User', userSchema);
