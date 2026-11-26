// Money and settings for the shop. All amounts are whole US cents (the shop trades in USD for now); percentages come from
// Worker variables so they can change without a release:
//   PLATFORM_FEE_PERCENT      Binder's cut of the item price (default 10; Stripe's own fees come out of Binder's share)
//   SHIPPING_MARKUP_PERCENT   added on top of a live shipping quote, in case the real label costs more (default 20)
import { now } from './lib.js';

export const DEFAULT_FEE_PERCENT = 10;
export const DEFAULT_SHIPPING_MARKUP_PERCENT = 20;
export const ORDER_HOLD_SECONDS = 35 * 60;               // an unpaid order keeps its cards reserved this long
export const MANUAL_RELEASE_SECONDS = 14 * 24 * 3600;    // hand-tracked orders pay the seller this long after shipping if the buyer says nothing
export const UNSHIPPED_REFUND_SECONDS = 10 * 24 * 3600;  // a paid order the seller never ships is refunded after this long

/** A percentage setting: a number from 0 to max, else the default (a typo in a variable never breaks pricing). */
export function percentSetting(raw, fallback, max = 100) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
}
export const feePercent = (env) => percentSetting(env && env.PLATFORM_FEE_PERCENT, DEFAULT_FEE_PERCENT, 100);
export const shippingMarkupPercent = (env) => percentSetting(env && env.SHIPPING_MARKUP_PERCENT, DEFAULT_SHIPPING_MARKUP_PERCENT, 200);

export const feeCents = (itemsCents, percent) => Math.round((itemsCents * percent) / 100);
export const markUp = (cents, percent) => Math.ceil(cents * (1 + percent / 100));
export const dollars = (cents) => (cents / 100).toFixed(2);

export const nowSeconds = now;

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return prefix + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
