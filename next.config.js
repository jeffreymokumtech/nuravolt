/** @type {import('next').NextConfig} */
const nextConfig = {
	eslint: {
		ignoreDuringBuilds: true,
	},
	typescript: {
		// Skip type checking during build for faster deployment
		ignoreBuildErrors: true,
	},
	// Exclude disabled folders from build
	pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'md', 'mdx'],
	webpack: (config, { isServer, dev }) => {

		// Handle parquet.js issues for Edge Runtime
		if (!isServer) {
			config.resolve.fallback = {
				...config.resolve.fallback,
				fs: false,
				net: false,
				tls: false,
				crypto: false,
				stream: false,
				url: false,
				zlib: false,
				http: false,
				https: false,
				assert: false,
				os: false,
				path: false,
			};
		}

		return config;
	},
	reactStrictMode: true,
	images: {
		domains: [
			// NextJS <Image> component needs to whitelist domains for src={}
			'lh3.googleusercontent.com',
			'images.unsplash.com',
			'localhost',
			'res.cloudinary.com',
			'secure.gravatar.com',
		],
		formats: ['image/webp', 'image/avif'],
		deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048, 3840],
		imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
	},
	compress: true,
	experimental: {
		serverComponentsExternalPackages: [
			'parquetjs',
			// PDF rendering: loaded lazily by renderPageToPdf; bundling them
			// breaks the packaged Chromium binary lookup.
			'puppeteer',
			'puppeteer-core',
			'@sparticuz/chromium',
		],
		// The Brotli-packed Chromium payload (bin/*.br) is loaded via fs at
		// runtime, so the file tracer misses it; without this the function
		// throws "input directory .../@sparticuz/chromium/bin does not exist".
		outputFileTracingIncludes: {
			'/api/dashboards/[id]/export-pdf': ['./node_modules/@sparticuz/chromium/bin/**'],
			'/api/reports/[id]/send': ['./node_modules/@sparticuz/chromium/bin/**'],
			'/api/cron/send-reports': ['./node_modules/@sparticuz/chromium/bin/**'],
		},
	},
	// Transpile echarts to fix webpack 5 compatibility issues with module.nmd
	transpilePackages: ['echarts', 'echarts-for-react', 'zrender'],
	compiler: {
		removeConsole: process.env.NODE_ENV === 'production',
	},
	async redirects() {
		return [
			// Consolidate duplicate legal pages onto their canonical URLs so Google
			// stops flagging "duplicate without user-selected canonical". The
			// canonical versions (/privacy-policy, /tos) are the ones in the sitemap.
			{ source: '/privacy', destination: '/privacy-policy', permanent: true },
			{ source: '/terms', destination: '/tos', permanent: true },
		];
	},
	async headers() {
		return [
			{
				source: '/(.*)',
				headers: [
					{
						key: 'X-DNS-Prefetch-Control',
						value: 'on'
					},
					{
						key: 'X-Frame-Options',
						value: 'SAMEORIGIN'
					},
					// Security headers for production
					...(process.env.NODE_ENV === 'production' ? [
						{
							key: 'Strict-Transport-Security',
							value: 'max-age=63072000; includeSubDomains; preload'
						},
						{
							key: 'X-Content-Type-Options',
							value: 'nosniff'
						},
						{
							key: 'Referrer-Policy',
							value: 'strict-origin-when-cross-origin'
						}
					] : [
						// Development: disable HSTS
						{
							key: 'Strict-Transport-Security',
							value: 'max-age=0'
						}
					]),
				],
			},
		];
	},
}

module.exports = nextConfig