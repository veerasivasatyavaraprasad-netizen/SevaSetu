// Section 7.2: worker_payout = amount − (amount × commission_rate).
// Integer paise, commission rounded to the nearest paisa (half up) so
// commission + payout always equals the amount exactly.
export function splitCommission(amountPaise, rateBps) {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) throw new Error('amount must be positive paise');
  if (!Number.isInteger(rateBps) || rateBps < 0 || rateBps > 5000) throw new Error('rate out of range');
  const commission = Math.floor((amountPaise * rateBps + 5000) / 10000);
  return { commission, workerPayout: amountPaise - commission };
}

export function applyBps(amountPaise, bps) {
  return Math.floor((amountPaise * bps + 5000) / 10000);
}

export function formatInr(paise) {
  return `₹${(paise / 100).toFixed(2)}`;
}
