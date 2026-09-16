import Stripe from 'stripe';

let client: Stripe | null = null;

/**
 * Lazy Stripe singleton — instantiating at module scope would crash builds
 * and preview deploys where STRIPE_SECRET_KEY isn't configured yet.
 */
export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  if (!client) {
    client = new Stripe(process.env.STRIPE_SECRET_KEY, {
      typescript: true,
    });
  }
  return client;
}
