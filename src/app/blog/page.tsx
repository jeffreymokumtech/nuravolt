'use client';

import { wordpressService } from '@/libs/wp'
import BlogListingNew from './_assets/components/BlogListingNew'
import PublicLayout from '@/components/layouts/PublicLayout'
import { useEffect, useState } from 'react'

export default function Blog() {
	// Static articles for NuraVolt blog
	const [articles, setArticles] = useState<any[]>([])

	useEffect(() => {
		async function loadArticles() {
			const staticArticles = [
				{
					id: 'bms-monitoring-not-enough-2026',
					title: 'Why cell-level BMS monitoring is no longer enough in 2026',
					excerpt: 'The failures putting BESS assets at risk increasingly live in the balance-of-system, cooling, HVAC, connections, which the BMS was never designed to see.',
					slug: 'bms-monitoring-not-enough-2026',
					date: '2026-06-15',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['Battery Storage', 'Monitoring']
				},
				{
					id: 'augment-vs-overbuild',
					title: 'Augment or overbuild? How analytics defers the spend',
					excerpt: 'Augmentation timing is one of the biggest line items in a storage business case, and it is set by your real degradation rate, not the warranty’s conservative curve.',
					slug: 'augment-vs-overbuild',
					date: '2026-06-15',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['Battery Storage', 'Economics']
				},
				{
					id: 'clipping-hides-soiling',
					title: 'How inverter clipping hides your soiling losses',
					excerpt: 'When an inverter is clipping, moderate soiling and string losses can vanish from the AC data, the plant looks stable while yield quietly leaks under the cap.',
					slug: 'clipping-hides-soiling',
					date: '2026-06-15',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['PV Monitoring', 'Soiling']
				},
				{
					id: 'leading-with-bess-2026',
					title: 'Why we’re leading with BESS in 2026, and the warranty mistake we keep seeing',
					excerpt: 'Battery storage is where the operational money and risk now sit. The recurring mistake: treating the warranty as a filed document instead of a live data position.',
					slug: 'leading-with-bess-2026',
					date: '2026-06-10',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['Battery Storage', 'Strategy']
				},
				{
					id: 'iberian-blackout-bess-readiness',
					title: 'What the Iberian blackout exposed about BESS readiness',
					excerpt: 'The April 2025 Iberian blackout was a stress test for storage. The assets that came through best belonged to operators who already knew their batteries’ real state.',
					slug: 'iberian-blackout-bess-readiness',
					date: '2026-06-10',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1558618047-3c8c76ca7d13?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['Battery Storage', 'Market']
				},
				{
					id: 'soiling-season-field-note',
					title: 'Soiling season is here: a field note on when cleaning actually pays',
					excerpt: 'It’s June, the rain has stopped across Iberia and the Gulf, and soiling is climbing. A short note on resisting the fixed-calendar clean and letting the numbers decide.',
					slug: 'soiling-season-field-note',
					date: '2026-06-10',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['PV Monitoring', 'Soiling']
				},
				{
					id: 'cost-of-poor-irradiation-data',
					title: 'The Cost of Poor Irradiation Data Quality in PV Monitoring',
					excerpt: 'Discover how poor irradiance data quality costs solar operators millions in missed performance issues, false alarms, and suboptimal O&M decisions.',
					slug: 'cost-of-poor-irradiation-data',
					date: '2025-10-01',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1509391366360-2e959784a276?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['PV Monitoring', 'Data Quality']
				},
				{
					id: 'bess-faults-ml-adds-value',
					title: 'Common BESS Faults Where ML/AI Adds Value Over Classic Monitoring',
					excerpt: 'Discover how machine learning catches battery storage system faults that traditional BMS monitoring misses, from thermal runaway to capacity fade prediction.',
					slug: 'bess-faults-ml-adds-value',
					date: '2025-10-01',
					author: { name: 'NuraVolt Team' },
					featured_media: 'https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80',
					categories: ['Battery Storage', 'Machine Learning']
				}
			]

			// Temporarily disable WordPress calls for deployment
			let wpArticles = []
			try {
				// Add timeout to prevent build hanging
				const timeoutPromise = new Promise((_, reject) =>
					setTimeout(() => reject(new Error('WordPress timeout')), 5000)
				)
				wpArticles = await Promise.race([
					wordpressService.getAllPosts(),
					timeoutPromise
				]) || []
			} catch (error) {
				console.warn('WordPress API unavailable:', error)
				wpArticles = []
			}

			// Combine static and WordPress articles
			setArticles([...staticArticles, ...wpArticles])
		}
		loadArticles()
	}, [])

	return (
		<PublicLayout>
			{/* Hero Section */}
			<section className='py-16 sm:py-20 border-b border-divider'>
				<div className='container mx-auto px-6 max-w-4xl'>
					<div className='font-mono text-meta uppercase tracking-[0.08em] text-ink-3 mb-3'>
						NuraVolt Blog
					</div>
					<h1 className='text-h1 sm:text-display font-semibold text-ink mb-5'>
						Field notes from solar &amp; storage operations.
					</h1>
					<p className='text-body text-ink-2 max-w-2xl'>
						Battery storage analytics, warranty math, equivalent-cycle accounting,
						degradation-aware dispatch, plus PV monitoring and wind performance for
						operators running portfolios across diverse climates.
					</p>
				</div>
			</section>

			{/* Blog Grid */}
			<div className='py-12'>
				<div className='container mx-auto px-8 md:w-[80%]'>
					<BlogListingNew articles={articles} />
				</div>
			</div>
		</PublicLayout>
	)
}
