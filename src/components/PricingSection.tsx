'use client'

import { Check } from 'lucide-react'
import CheckoutButton from './CheckoutButton' // Importing the CheckoutButton component

export default function PricingSection() {
	return (
		<section className='py-16'>
			<div className='container mx-auto px-4'>
				<h2 className='text-3xl font-bold text-center mb-12 dark:text-white text-black1'>
					Choose Your Plan
				</h2>
				<div className='grid md:grid-cols-2 gap-8 max-w-4xl mx-auto'>
					{/* Monthly Plan */}
					<div className='dark:bg-[#131211] bg-white rounded-lg shadow-md p-8'>
						<h3 className='text-2xl font-semibold mb-4'>Monthly Plan</h3>
						<p className='text-4xl font-bold mb-6'>
							$25
							<span className='text-xl dark:text-gray-500 text-black1/70 font-normal'>
								/month
							</span>
						</p>
						<ul className='space-y-3 mb-8'>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>Full access to all features</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>24/7 customer support</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>Up to 10 team members</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>5GB cloud storage</span>
							</li>
						</ul>

						{/* Вызов CheckoutButton для Monthly Plan */}
						<CheckoutButton priceId='price_1Pwjf2LYI6vAk2YTcpS2Nw9c' />
					</div>

					{/* Annual Plan */}
					<div className='dark:bg-[#131211] bg-white rounded-lg shadow-md p-8 border-4 border-blue-500 relative'>
						<div className='absolute top-0 right-0 bg-blue-500 text-white py-1 px-4 rounded-bl-lg text-sm font-semibold'>
							Best Value
						</div>
						<h3 className='text-2xl font-semibold mb-4'>Annual Plan</h3>
						<p className='text-4xl font-bold mb-2'>
							$240
							<span className='text-xl dark:text-gray-500 text-black1/70 font-normal'>
								/year
							</span>
						</p>
						<p className='text-blue-500 font-semibold mb-6'>
							Save 20% compared to monthly
						</p>
						<ul className='space-y-3 mb-8'>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>All features from Monthly Plan</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>Priority customer support</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>Up to 20 team members</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>20GB cloud storage</span>
							</li>
							<li className='flex items-center'>
								<Check className='text-green-500 mr-2' />
								<span>Advanced analytics</span>
							</li>
						</ul>

						{/* Вызов CheckoutButton для Annual Plan */}
						<CheckoutButton priceId='price_1PwjfbLYI6vAk2YTJ208kMgd' />
					</div>
				</div>
			</div>
		</section>
	)
}
