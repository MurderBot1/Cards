/**
 * orderText.js
 * The words for where an order stands, from what the account service sends (see cloudflare/src/orders.js): one function per thing
 * shown, pure so they can be tested.
 */

const GROUP_STATUS = {
  pending: 'Waiting for payment',
  awaiting_shipment: 'Waiting for the seller to ship',
  shipped: 'On its way',
  delivered: 'Delivered',
  paid_out: 'Delivered',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
};

const TRACKING = {
  PRE_TRANSIT: 'Label created, not picked up yet',
  TRANSIT: 'In transit',
  DELIVERED: 'Delivered',
  RETURNED: 'Coming back to the seller',
  FAILURE: 'The carrier reported a delivery problem',
  UNKNOWN: 'Waiting for the carrier to scan it',
};

/** "Waiting for the seller to ship", "On its way", … for one seller's part of an order. */
export function groupStatusText(group) {
  if (group.hold && (group.status === 'shipped' || group.status === 'delivered')) return 'On hold: contact the seller';
  return GROUP_STATUS[group.status] || group.status;
}

/** The same, from the seller's side: "Ready to ship", "Shipped", "Paid out"… */
export function saleStatusText(group) {
  if (group.hold && (group.status === 'shipped' || group.status === 'delivered')) return 'On hold';
  return { awaiting_shipment: 'Ready to ship', shipped: 'Shipped', delivered: 'Delivered', paid_out: 'Paid out', refunded: 'Refunded' }[group.status] || group.status;
}

/** The carrier's latest word on the parcel, or '' when it has not shipped. */
export function trackingText(group) {
  if (!group.trackingNumber) return '';
  if (group.status === 'delivered' || group.status === 'paid_out') return 'Delivered';
  return TRACKING[group.trackingStatus] || TRACKING.UNKNOWN;
}

/** The four steps of an order for a progress strip: [{ label, done }]. */
export function progressSteps(group) {
  const rank = { pending: 0, awaiting_shipment: 1, shipped: 2, delivered: 3, paid_out: 3 }[group.status];
  if (rank === undefined) return [];   // refunded or cancelled: no progress to show
  return [
    { label: 'Paid', done: rank >= 1 },
    { label: 'Shipped', done: rank >= 2 },
    { label: 'Delivered', done: rank >= 3 },
  ];
}

/** The overall words for an order. */
export function orderStatusText(order) {
  if (order.status === 'pending') return 'Waiting for payment';
  if (order.status === 'refunded') return 'Refunded';
  if (order.status === 'cancelled') return 'Cancelled';
  if (order.flag === 'disputed') return 'Payment disputed';
  const groups = order.groups || [];
  if (groups.length && groups.every((g) => g.status === 'delivered' || g.status === 'paid_out' || g.status === 'refunded')) return 'Complete';
  return 'In progress';
}

/** "Nov 23, 2026" from a Unix time in seconds. */
export function dateText(seconds) {
  if (!seconds) return '';
  return new Date(seconds * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/** What the seller should do next, in words: for the sale cards. */
export function sellerNextStep(group) {
  if (group.status === 'awaiting_shipment') return 'Ship this order, then add the tracking: you are paid when it is delivered.';
  if (group.status === 'shipped') return group.trackingMode === 'manual'
    ? 'Shipped. You are paid when it is delivered (or 14 days after shipping if the carrier does not report it).'
    : 'Shipped. You are paid when the carrier reports it delivered.';
  if (group.status === 'delivered') return group.hold ? 'Delivered, but the payout is on hold.' : 'Delivered: your payout is being sent.';
  if (group.status === 'paid_out') return 'Paid out.';
  if (group.status === 'refunded') return 'Refunded to the buyer.';
  return '';
}
