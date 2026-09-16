import Stripe from "stripe";

class StripeService {
  private stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    typescript: true,
  });

  // This is used to create Customer Portal sessions, so users can manage their subscriptions (payment methods, cancel, etc..)
  public async createCustomerPortal(customerId: string, returnUrl: string): Promise<string> {
    const portalSession = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    return portalSession.url;
  }

// This is used to get the uesr checkout session and populate the data so we get the planId the user subscribed to
  public async findCheckoutSession(sessionId: string) {
  try {
  const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items"],
  });
  return session;
} catch (e) {
  console.error(e);
  return null;
   }
  }

  public async getSubscription(subId: string) {
    return this.stripe.subscriptions.retrieve(subId)
  }

  public async getCheckoutSession(csId: string) {
    return this.stripe.checkout.sessions.retrieve(csId)
  }

}

export const stripeService = new StripeService()