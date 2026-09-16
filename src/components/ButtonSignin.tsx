/* eslint-disable @next/next/no-img-element */
'use client'

import { Button } from '@/components/ui/button'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

// A simple button to sign in - temporarily disabled Clerk for deployment
// Shows a basic button that redirects to sign-in page
const ButtonSignin = ({
	text = 'Get started',
	extraStyle,
}: {
	text?: string
	extraStyle?: string
}) => {
	const router = useRouter()

	const handleClick = () => {
		// Temporarily redirect to sign-in page instead of using Clerk
		router.push('/sign-in')
	}

	// For deployment, always show the sign-in button (no authentication check)
	return (
		<Button
			className={`btn bg-[#006fee] border-none scale-1 hover:scale-[1.05] transition-all duration-300 rounded-full px-8 hover:bg-[#006fee] ${
				extraStyle ? extraStyle : ''
			}`}
			onClick={handleClick}
		>
			{text}
		</Button>
	)
}

export default ButtonSignin
