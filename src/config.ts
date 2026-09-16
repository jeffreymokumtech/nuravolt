import { ConfigProps } from '@/types'
import themes from 'daisyui/src/theming/themes'

const config: ConfigProps = {
	// REQUIRED
	appName: 'NuraVolt',
	// REQUIRED: a short description of your app for SEO tags (can be overwritten)
	appDescription:
		'Physics-informed AI monitoring for solar, wind, and battery storage. Catch faults weeks early, optimise cleaning schedules, and auto-generate compliance reports.',
	// REQUIRED (no https://, not trialing slash at the end, just the naked domain)
	domainName: 'nuravolt.com',
	stripe: {
		// Create multiple products in your Stripe dashboard, then add them here. You can add as many plans as you want, just make sure to add the priceId
		products: [
			{
				type: 'one-time', // one-time, subscription
				title: 'your-title',
				productId: 'your-product-id',
				subtitle: 'Per month price',
				price: 25,
				isBest: true,
				linkTitle: 'PAY MOTHERFUCKER',
				featuresTitle: 'Features',
				priceId: 'your-price-id',
				features: [
					{
						title: 'Feature 1',
						disabled: false,
					},
					{
						title: 'Feature 2',
						disabled: true,
					},
				],
			},
			{
				type: 'subscription',
				period: 'year',
				productId: 'your-product-id',
				title: 'Year',
				subtitle: 'Per year price',
				price: 25,
				linkTitle: 'PAY MOTHERFUCKER YEAR',
				featuresTitle: 'Features VIP',
				priceId: 'your-price-id',
				features: [
					{
						title: 'Feature 1',
						disabled: false,
					},
					{
						title: 'Feature 2',
						disabled: false,
					},
				],
			},
		],
	},
	colors: {
		// REQUIRED — The DaisyUI theme to use (added to the main layout.js). Leave blank for default (light & dark mode). If you any other theme than light/dark, you need to add it in config.tailwind.js in daisyui.themes.
		theme: 'light',
		// REQUIRED — This color will be reflected on the whole app outside of the document (loading bar, Chrome tabs, etc..). By default it takes the primary color from your DaisyUI theme (make sure to update your the theme name after "data-theme=")
		// OR you can just do this to use a custom color: main: "#f37055". HEX only.
		main: themes['light']['primary'],
	},
	resend: {
		// REQUIRED — Email 'From' field to be used when sending other emails, like abandoned carts, updates etc..
		fromAdmin: `NuraVolt <noreply@nuravolt.com>`,
		// Email shown to customer if need support. Leave empty if not needed => if empty, set up Crisp above, otherwise you won't be able to offer customer support."
		supportEmail: 'jeffrey@mokumtech.io',
		// When someone replies to supportEmail sent by the app, forward it to the email below (otherwise it's lost). If you set supportEmail to empty, this will be ignored.
		forwardRepliesTo: 'jeffrey@mokumtech.io',
		subjects: {
			thankYou: 'Welcome to NuraVolt',
		},
	},
}

export default config
