import { Alert } from 'react-native';
import { api } from './api';

function confirmDevPayment(amount) {
  return new Promise((resolve, reject) => {
    Alert.alert('Development payment gateway', `Pay ₹${(amount / 100).toFixed(2)}?`, [
      { text: 'Cancel', style: 'cancel', onPress: () => reject(new Error('Payment cancelled')) },
      { text: 'Pay', onPress: resolve },
    ]);
  });
}

// Opens Razorpay's native checkout for an order the API created, then has
// the API verify the signature and the payment with Razorpay itself.
export async function payOrder(order, { description } = {}) {
  let result;
  if (order.provider === 'mock') {
    // Only reachable against a development API (production refuses mock).
    await confirmDevPayment(order.amount);
    result = await api('/payments/mock/checkout', { method: 'POST', body: { orderId: order.orderId } });
  } else {
    // Loaded lazily: the native module exists only in real app builds.
    const RazorpayCheckout = require('react-native-razorpay').default;
    let data;
    try {
      data = await RazorpayCheckout.open({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'SevaSetu',
        description,
        theme: { color: '#0f766e' },
      });
    } catch (e) {
      throw new Error(e?.description || e?.error?.description || 'Payment cancelled');
    }
    result = { orderId: data.razorpay_order_id, paymentId: data.razorpay_payment_id, signature: data.razorpay_signature };
  }
  return api('/payments/confirm', {
    method: 'POST',
    body: { orderId: result.orderId, paymentId: result.paymentId, signature: result.signature },
  });
}
