interface StripePrice {
    title: string,
    productId: string,
    subtitle: string,
    price: number,
    isBest?: boolean,
    linkTitle: string,
    featuresTitle: string,
    priceId: string,
    features: {
        title: string,
        disabled?: boolean
    }[]
}

interface StripeOneTime extends StripePrice {
    type: 'one-time',
}

interface StripePlan extends StripePrice {
    type: 'subscription',
    period: string
}

type StripeProduct = StripeOneTime | StripePlan