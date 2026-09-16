import BackArrow from '@/assets/images/back-arrow.svg'
import { convertToReadableDate } from '@/utils/functions'
import Image from 'next/image'
import Link from 'next/link'
import { FC } from 'react'

interface AuthorAvatarProps {
	post: WPDetailedPost
}

const BlogSpotlight: FC<AuthorAvatarProps> = ({ post }) => {
	const { yoast_head_json } = post

	const authorSchema = yoast_head_json?.schema?.['@graph']?.find(
		item => item['@type'] === 'Person'
	)

	const authorName = authorSchema?.name || 'Unknown Author'
	const avatarUrl = authorSchema?.image?.contentUrl || ''

	return (
		<div>
			<Link
				href='/blog'
				className='flex items-center dark:text-ink-3 text-black1/70 gap-2 mb-4'
			>
				<Image alt='Back Arrow' src={BackArrow} height={10} width={15} />
				<span>Back to blog</span>
			</Link>
			<h1 className='text-[42px] !leading-[1.19] font-bold mb-2'>
				{post?.title?.rendered}
			</h1>
			<div className='flex items-center mb-4'>
				{avatarUrl ? (
					<Image
						src={avatarUrl}
						width={50}
						height={50}
						alt="Author's profile picture"
						className='w-10 h-10 rounded-full mr-2'
					/>
				) : (
					''
				)}

				<div>
					<div className='font-bold'>{authorName}</div>
					<div className='text-ink-3'>
						{convertToReadableDate(post.date)}
					</div>
				</div>
			</div>
		</div>
	)
}

export default BlogSpotlight
