import Image from 'next/image'
import Link from 'next/link'

import { convertToReadableDate } from '@/utils/functions'

const BlogMoreArticles = ({ currentBlog, AllPosts }: any) => {
	const filteredPosts = AllPosts.filter(
		(post: any) => post.title.rendered !== currentBlog
	)
	return (
		<div className='max-w-6xl mx-auto p-6 mb-12'>
			<h2 className='text-4xl font-bold mb-6 text-center'>Other News</h2>
			<div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 '>
				{filteredPosts.slice(0, 3).map((post: any, index: any) => (
					<Link
						href={`/blog/${post.slug}`}
						key={index}
						className='bg-paper  dark:bg-[#1E232C] rounded overflow-hidden shadow-sm dark:border border-solid border-[#373C53] hover:border-[#5b6285] transition-all duration-500 transform hover:scale-105 ease-in-out  '
					>
						<Image
							src={post.featured_img}
							alt={post.title.rendered}
							className='object-cover'
							width={500}
							height={156}
						/>
						<div className='p-4'>
							<h2 className=' font-normal text-[16px] dark:text-white mb-2'>
								{post.title.rendered}
							</h2>
							<p className='text-ink-3'>
								{convertToReadableDate(post.date)}
							</p>
						</div>
					</Link>
				))}
			</div>
		</div>
	)
}

export default BlogMoreArticles
