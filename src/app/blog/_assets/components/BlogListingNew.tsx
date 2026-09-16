'use client'

import { convertToReadableDate } from '@/utils/functions'
import Link from 'next/link'
import Image from 'next/image'
import { useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

type blogTitle = {
	rendered: string
}

type blogTypes = {
	title: blogTitle | string
	slug: string
	image_url?: string
	featured_media?: string
	date: string
	excerpt?: string
	categories?: string[]
}

interface props {
	articles: blogTypes[]
}

const BlogListingNew = ({ articles }: props) => {
	const [visiblePosts, setVisiblePosts] = useState(6)

	const loadMore = () => {
		setVisiblePosts(prevVisiblePosts => prevVisiblePosts + 6)
	}

	// Helper function to get title string
	const getTitle = (post: any) => {
		return typeof post.title === 'string' ? post.title : post.title?.rendered || 'Untitled'
	}

	// Helper function to get image URL
	const getImageUrl = (post: any) => {
		return post.featured_media || post.image_url || 'https://images.unsplash.com/photo-1497435334941-8c899ee9e8e9?ixlib=rb-4.0.3&auto=format&fit=crop&w=800&q=80'
	}

	// Helper function to get excerpt (first 150 chars)
	const getExcerpt = (post: any) => {
		if (post.excerpt) {
			return post.excerpt.length > 150 ? post.excerpt.substring(0, 150) + '...' : post.excerpt
		}
		return ''
	}

	return (
		<>
			<div className='grid grid-cols-1 md:grid-cols-2 gap-8'>
				{articles?.slice(0, visiblePosts).map((post: any, index: any) => (
					<motion.div
						key={index}
						initial={{ opacity: 0, y: 20 }}
						whileInView={{ opacity: 1, y: 0 }}
						viewport={{ once: true }}
						transition={{ duration: 0.5, delay: index * 0.1 }}
					>
						<Link
							href={`/blog/${post.slug}`}
							className='group bg-white rounded-xl overflow-hidden shadow-lg hover:shadow-2xl transition-all duration-300 transform hover:-translate-y-2 block h-full'
						>
							{/* Featured Image */}
							<div className='relative h-64 overflow-hidden'>
								<Image
									src={getImageUrl(post)}
									alt={getTitle(post)}
									fill
									className='object-cover group-hover:scale-110 transition-transform duration-500'
									sizes='(max-width: 768px) 100vw, 50vw'
								/>
								{/* Category Badges */}
								{post.categories && post.categories.length > 0 && (
									<div className='absolute top-4 left-4 flex gap-2 z-10'>
										{post.categories.map((category: string) => (
											<span
												key={category}
												className='px-3 py-1 bg-blue-600 text-white text-xs font-semibold rounded-full'
											>
												{category}
											</span>
										))}
									</div>
								)}
							</div>

							{/* Content */}
							<div className='p-6'>
								{/* Date */}
								<p className='text-sm text-gray-500 mb-3'>
									{convertToReadableDate(post.date)}
								</p>

								{/* Title */}
								<h2 className='text-2xl font-bold text-gray-900 mb-3 group-hover:text-blue-600 transition-colors line-clamp-2'>
									{getTitle(post)}
								</h2>

								{/* Excerpt */}
								{getExcerpt(post) && (
									<p className='text-gray-600 mb-4 line-clamp-3'>
										{getExcerpt(post)}
									</p>
								)}

								{/* Read More Link */}
								<div className='flex items-center text-blue-600 font-semibold group-hover:text-blue-700'>
									Read More
									<ArrowRight className='ml-2 h-4 w-4 group-hover:translate-x-2 transition-transform' />
								</div>
							</div>
						</Link>
					</motion.div>
				))}
			</div>
			{visiblePosts < articles.length && (
				<div className='flex justify-center'>
					<button
						className='bg-blue-600 hover:bg-blue-700 px-8 py-4 rounded-lg text-white font-semibold mt-12 transition-colors shadow-lg hover:shadow-xl'
						onClick={loadMore}
					>
						Load More Articles
					</button>
				</div>
			)}
		</>
	)
}

export default BlogListingNew
