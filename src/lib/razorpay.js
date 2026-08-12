const Razorpay = require('razorpay');

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';

let client = null;

function getClient() {
  if (!KEY_ID || !KEY_SECRET) return null;
  if (client) return client;
  client = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  return client;
}

function isConfigured() {
  return !!(KEY_ID && KEY_SECRET);
}

async function createOrder(amountPaise, currency, receiptId) {
  const c = getClient();
  if (!c) throw new Error('Razorpay not configured');
  const order = await c.orders.create({
    amount: Math.round(amountPaise),
    currency: currency || 'INR',
    receipt: receiptId,
    payment_capture: 1,
  });
  return order;
}

async function fetchPayment(paymentId) {
  const c = getClient();
  if (!c) throw new Error('Razorpay not configured');
  return c.payments.fetch(paymentId);
}

async function capturePayment(paymentId, amountPaise) {
  const c = getClient();
  if (!c) throw new Error('Razorpay not configured');
  return c.payments.capture(paymentId, Math.round(amountPaise), 'INR');
}

async function createSubscription(planId, customerId, totalCount) {
  const c = getClient();
  if (!c) throw new Error('Razorpay not configured');
  const sub = await c.subscriptions.create({
    plan_id: planId,
    total_count: totalCount || 1,
    customer_notify: 1,
    notify_info: { notify_phone: '', notify_email: '' },
  });
  return sub;
}

async function fetchSubscription(subscriptionId) {
  const c = getClient();
  if (!c) throw new Error('Razorpay not configured');
  return c.subscriptions.fetch(subscriptionId);
}

module.exports = {
  isConfigured, createOrder, fetchPayment, capturePayment,
  createSubscription, fetchSubscription,
};
