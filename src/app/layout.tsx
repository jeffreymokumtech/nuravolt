import { Providers } from '@/components/providers'
import { getSEOTags, buildOrganizationSchema, buildWebsiteSchema } from '@/libs/seo'
import SchemaJsonLd from '@/components/SchemaJsonLd'
import { Inter } from 'next/font/google'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { ReactNode } from 'react'
import { LanguageProvider } from '@/contexts/LanguageContext'
import { PHProvider } from './providers'
import Script from 'next/script'

import '@/assets/styles/globals.scss'
import '@/assets/styles/ops-theme.scss'

const inter = Inter({
	subsets: ['latin'],
	variable: '--font-inter',
	display: 'swap',
})
// Dashboard typography: Geist (sans) for reading text + Geist Mono for numerics,
// via the self-hosted `geist` package (no external font request, CSP-safe).
// Replaces JetBrains Mono as the ops base font so the console/CLI feel gives way
// to a cleaner technical read while numbers stay tabular-aligned in mono.
// GeistSans.variable = --font-geist-sans, GeistMono.variable = --font-geist-mono.

export const metadata = {
	...getSEOTags({
		title: 'NuraVolt, Energy Intelligence for Solar, Wind & Storage',
		description: 'Physics-informed AI monitoring for solar, wind, and battery storage, catch faults weeks early, optimise cleaning, and automate compliance reports.',
		keywords: ['energy intelligence', 'solar monitoring', 'wind turbine analytics', 'BESS monitoring', 'predictive maintenance', 'soiling forecast', 'fault detection', 'physics-informed AI', 'compliance reporting', 'SCADA integration'],
	}),
	viewport: {
		width: 'device-width',
		initialScale: 1,
		themeColor: '#1e40af',
	}
}

export default function RootLayout({ children }: { children: ReactNode }) {
	return (
		<html lang='en' suppressHydrationWarning className={`${inter.variable} ${GeistSans.variable} ${GeistMono.variable}`}>
			<head>
				<link rel="icon" href="data:image/svg+xml,%3Csvg width='32' height='32' viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3CradialGradient id='sunGrad' cx='50%25' cy='50%25'%3E%3Cstop offset='0%25' style='stop-color:%23fbbf24'/%3E%3Cstop offset='100%25' style='stop-color:%23f59e0b'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='32' height='32' fill='%23ffffff'/%3E%3Cg stroke='%23f59e0b' stroke-width='2' stroke-linecap='round'%3E%3Cline x1='16' y1='2' x2='16' y2='5'/%3E%3Cline x1='27' y1='16' x2='30' y2='16'/%3E%3Cline x1='16' y1='30' x2='16' y2='27'/%3E%3Cline x1='2' y1='16' x2='5' y2='16'/%3E%3Cline x1='25' y1='7' x2='23' y2='9'/%3E%3Cline x1='25' y1='25' x2='23' y2='23'/%3E%3Cline x1='7' y1='25' x2='9' y2='23'/%3E%3Cline x1='7' y1='7' x2='9' y2='9'/%3E%3C/g%3E%3Ccircle cx='16' cy='16' r='8' fill='url(%23sunGrad)'/%3E%3Ctext x='16' y='21' font-family='Arial, sans-serif' font-size='12' font-weight='bold' text-anchor='middle' fill='%231e40af'%3EH%3C/text%3E%3Ccircle cx='12' cy='12' r='1' fill='%233b82f6' opacity='0.7'/%3E%3Ccircle cx='20' cy='12' r='1' fill='%233b82f6' opacity='0.7'/%3E%3Ccircle cx='12' cy='20' r='1' fill='%233b82f6' opacity='0.7'/%3E%3Ccircle cx='20' cy='20' r='1' fill='%233b82f6' opacity='0.7'/%3E%3C/svg%3E" type="image/svg+xml" />
				<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg width='32' height='32' viewBox='0 0 32 32' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3CradialGradient id='sunGrad' cx='50%25' cy='50%25'%3E%3Cstop offset='0%25' style='stop-color:%23fbbf24'/%3E%3Cstop offset='100%25' style='stop-color:%23f59e0b'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='32' height='32' fill='%23ffffff'/%3E%3Cg stroke='%23f59e0b' stroke-width='2' stroke-linecap='round'%3E%3Cline x1='16' y1='2' x2='16' y2='5'/%3E%3Cline x1='27' y1='16' x2='30' y2='16'/%3E%3Cline x1='16' y1='30' x2='16' y2='27'/%3E%3Cline x1='2' y1='16' x2='5' y2='16'/%3E%3Cline x1='25' y1='7' x2='23' y2='9'/%3E%3Cline x1='25' y1='25' x2='23' y2='23'/%3E%3Cline x1='7' y1='25' x2='9' y2='23'/%3E%3Cline x1='7' y1='7' x2='9' y2='9'/%3E%3C/g%3E%3Ccircle cx='16' cy='16' r='8' fill='url(%23sunGrad)'/%3E%3Ctext x='16' y='21' font-family='Arial, sans-serif' font-size='12' font-weight='bold' text-anchor='middle' fill='%231e40af'%3EH%3C/text%3E%3Ccircle cx='12' cy='12' r='1' fill='%233b82f6' opacity='0.7'/%3E%3Ccircle cx='20' cy='20' r='1' fill='%233b82f6' opacity='0.7'/%3E%3C/svg%3E" />
				<link rel="apple-touch-icon" href="/apple-touch-icon.svg?v=3" />
				{/* Pre-hydration theme script, read localStorage and apply the
				    ops-theme-dark class to <html> before first paint, so dark-mode
				    users don't see a flash of light theme on every reload. */}
				<script
					type="text/javascript"
					dangerouslySetInnerHTML={{
						__html: `
							try {
								var t = window.localStorage.getItem('nuravolt:ops-theme');
								if (t === 'dark') document.documentElement.classList.add('ops-theme-dark');
							} catch (e) {}
						`,
					}}
				/>
			</head>
			<body className='font-sans'>
				<SchemaJsonLd data={[buildOrganizationSchema(), buildWebsiteSchema()]} />
				<PHProvider>
					<LanguageProvider>
						<Providers>
							{children}
						</Providers>
					</LanguageProvider>
				</PHProvider>

				{/* Lemlist Visitor Tracking */}
				{process.env.NEXT_PUBLIC_ENABLE_LEMLIST_TRACKER === '1' && (
					<Script
						src="https://app.lemlist.com/api/visitors/tracking?k=L%2B3bowcdbXWe5vUA7fAzHhw2Sz9ZVUWSjaMm18rIevU%3D&t=tea_4qnniLkipBYGMYta6"
						strategy="afterInteractive"
					/>
				)}
			</body>
		</html>
	)
}