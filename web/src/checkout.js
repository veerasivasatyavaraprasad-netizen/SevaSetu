import { api } from './api.js';

function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the payment window. Check your connection.'));
    document.head.appendChild(s);
  });
}

// Opens the gateway checkout for an order created by the API, then has
// the API verify the signature and the payment with the gateway itself.
export async function payOrder(order, { name, description, prefillContact } = {}) {
  let result;
  if (order.provider === 'mock') {
    // Development gateway: stands in for the Razorpay window.
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Development payment gateway\n\nPay ₹${(order.amount / 100).toFixed(2)}?`)) {
      throw new Error('Payment cancelled');
    }
    result = await api('/payments/mock/checkout', { method: 'POST', body: { orderId: order.orderId } });
  } else {
    await loadRazorpay();
    result = await new Promise((resolve, reject) => {
      const rz = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: name || 'SevaSetu',
        description,
        prefill: prefillContact ? { contact: prefillContact } : undefined,
        theme: { color: '#0f766e' },
        handler: (r) => resolve({ orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature }),
        modal: { ondismiss: () => reject(new Error('Payment cancelled')) },
      });
      rz.on('payment.failed', (r) => reject(new Error(r.error?.description || 'Payment failed')));
      rz.open();
    });
  }
  return api('/payments/confirm', {
    method: 'POST',
    body: { orderId: result.orderId, paymentId: result.paymentId, signature: result.signature },
  });
}
