/**
 * shopApi.js
 * The shop's calls to the account service (see cloudflare/src/*.js). Browsing the market needs no account; everything else sends
 * the signed-in person's token. Errors carry the service's own message, ready to show.
 */
import { accountRequest } from './api.js';
import { getSession } from './session.js';

const token = () => {
  const session = getSession();
  return session ? session.token : undefined;
};
const get = (path) => accountRequest(path, { method: 'GET', token: token() });
const post = (path, body = {}) => accountRequest(path, { method: 'POST', body, token: token() });
const qs = (params) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
};

export const shopApi = {
  // the market (public)
  prices: (ids) => get(`/shop/prices${qs({ ids: ids.join(',') })}`),
  listings: (params) => get(`/shop/listings${qs(params)}`),
  // a seller's listings
  myListings: () => get('/shop/listings/mine'),
  saveListing: (listing) => post('/shop/listing', listing),
  removeListing: (id) => post('/shop/listing/remove', { id }),
  // the cart
  cart: () => get('/shop/cart'),
  setCart: (listingId, qty) => post('/shop/cart/set', { listingId, qty }),
  clearCart: () => post('/shop/cart/clear'),
  // checking out
  buyer: () => get('/shop/buyer'),
  suggestAddress: (q) => get(`/shop/address/suggest${qs({ q })}`).then((r) => r.results || []),
  saveAddress: (address) => post('/shop/buyer', { address }),
  removeAddress: () => post('/shop/buyer/address/remove'),
  removeMethod: (id) => post('/shop/buyer/method/remove', { id }),
  quote: (address) => post('/shop/checkout/quote', address ? { address } : {}),
  checkout: (address, provider) => post('/shop/checkout', { ...(address ? { address } : {}), provider }),
  syncOrder: (orderId, paypalApproved = false) => post('/shop/orders/sync', { orderId, paypalApproved }),
  abandonOrder: (orderId) => post('/shop/orders/abandon', { orderId }),
  // orders (as a buyer)
  orders: () => get('/shop/orders'),
  cancelGroup: (groupId) => post('/shop/orders/cancel', { groupId }),
  received: (groupId) => post('/shop/orders/received', { groupId }),
  // sales (as a seller)
  sales: () => get('/shop/sales'),
  buyLabel: (groupId) => post('/shop/sales/label', { groupId }),
  ship: (groupId, carrier, trackingNumber) => post('/shop/sales/ship', { groupId, carrier, trackingNumber }),
  refund: (groupId) => post('/shop/sales/refund', { groupId }),
};
