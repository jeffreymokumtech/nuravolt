'use client';

import BlogDetails from '@/components/BlogDetails'
import { wordpressService } from '@/libs/wp'
import PublicLayout from '@/components/layouts/PublicLayout'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

export default function Article() {
	const params = useParams()
	const slug = params.articleId as string
	const [article, setArticle] = useState<any>(null)
	const [articles, setArticles] = useState<any[]>([])
	const [loading, setLoading] = useState(true)

	useEffect(() => {
		async function loadData() {
			try {
				console.log('slug1', slug)
				const [articleData, articlesData] = await Promise.all([
					wordpressService.getPost(slug),
					wordpressService.getAllPosts()
				])
				setArticle(articleData)
				setArticles(articlesData)
			} catch (error) {
				console.error('Error loading article:', error)
			} finally {
				setLoading(false)
			}
		}
		loadData()
	}, [slug])

	if (loading) {
		return (
			<PublicLayout>
				<div className="w-full max-w-[60rem] mx-auto px-4 sm:px-6 lg:px-8 mt-32">
					<div className="animate-pulse">
						<div className="h-8 bg-paper-2 rounded w-3/4 mb-4"></div>
						<div className="h-4 bg-paper-2 rounded w-1/4 mb-8"></div>
						<div className="space-y-3">
							<div className="h-4 bg-paper-2 rounded"></div>
							<div className="h-4 bg-paper-2 rounded w-5/6"></div>
							<div className="h-4 bg-paper-2 rounded w-4/6"></div>
						</div>
					</div>
				</div>
			</PublicLayout>
		)
	}

	return (
		<PublicLayout>
			{article && <BlogDetails postDetails={article} allPosts={articles} />}
		</PublicLayout>
	)
}
