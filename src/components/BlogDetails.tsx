'use client'
import { post } from '@/utils/data'
import { useMemo } from 'react'
import '../assets/styles/blog-page.scss'
import BlogMoreArticles from './BlogMoreArticles'
import BlogSpotlight from './BlogSpotlight'

const BlogDetails = ({ postDetails, allPosts }: any) => {
	const htmlContent = post[0]?.html as string
	const faqArray = useMemo(() => {
		if (typeof window === 'undefined') return []

		const parser = new DOMParser()
		const doc = parser.parseFromString(htmlContent, 'text/html')
		const faqs: Array<{ question: string; answer: string[] }> = []

		doc.querySelectorAll('.schema-faq-section').forEach(section => {
			const question =
				(section.querySelector('.schema-faq-question') as HTMLElement)
					?.innerText || ''
			const answer =
				(section.querySelector('.schema-faq-answer') as HTMLElement)
					?.innerText || ''

			if (question && answer) {
				faqs.push({
					question,
					answer: [answer], // Wrap the answer in an array
				})
			}
		})

		return faqs
	}, [htmlContent])

	return (
		<div>
			<div className='w-full max-w-[60rem] mx-auto px-4 sm:px-6 lg:px-8 mt-32'>
				<BlogSpotlight post={postDetails} />
				<div
					className='mt-6 dark:text-white text-black '
					dangerouslySetInnerHTML={{
						__html: postDetails?.content?.rendered || '',
					}}
				/>
				{/* <div id='blog-detail-faq'>
					<Faq data={faqArray} isHomePage={false} />
				</div> */}
			</div>
			<BlogMoreArticles
				currentBlog={postDetails?.title?.rendered}
				AllPosts={allPosts}
			/>
		</div>
	)
}

export default BlogDetails
