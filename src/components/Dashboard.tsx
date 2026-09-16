'use client'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useFormik } from 'formik'
import toast from 'react-hot-toast'
import * as Yup from 'yup'
import { Button } from './ui/button'

const validationSchema = Yup.object({
	apiKey: Yup.string().required('API Key is required'),
	organizationId: Yup.string().required('Organization ID is required'),
})

const Dashboard = () => {
	const formik = useFormik({
		initialValues: {
			apiKey: '',
			organizationId: '',
		},
		validationSchema,
		onSubmit: values => {
			console.log('Form submitted', values)
			toast.success('Settings saved')
		},
	})

	return (
		<div className='flex justify-center items-center w-full bg-white dark:bg-[#010814] my-16'>
			<div className='max-w-[1440px] w-full rounded-[16px] mx-4 sm:mx-12 dark:border dark:border-[#5f708b] bg-white dark:bg-gradient-to-r from-[#1E242D] to-[#0B111B] min-h-[300px] pb-6'>
				<div className='flex justify-between items-center w-full p-4 sm:p-8 dark:border-b dark:border-[#4D525A]'>
					<p className='text-black1 dark:text-white font-semibold text-xl'>
						Weather App
					</p>
					<div className='flex gap-2 items-center'>
						<Avatar className='w-[32px] h-[32px]'>
							<AvatarImage src='/assets/avatar.svg' />
							<AvatarFallback>CN</AvatarFallback>
						</Avatar>
						<p className='text-black1 dark:text-white font-medium text-lg'>
							John Dow
						</p>
					</div>
				</div>
				<form onSubmit={formik.handleSubmit} className='flex flex-col gap-4'>
					<h1 className='text-black1 dark:text-white font-semibold text-[32px] px-4 sm:px-8 py-4'>
						Environments:
					</h1>

					<div className='px-4 sm:px-8'>
						<h2 className='text-black1 dark:text-white font-medium text-lg py-4'>
							Open AI API Key:
						</h2>
						<input
							id='apiKey'
							name='apiKey'
							type='text'
							onChange={formik.handleChange}
							onBlur={formik.handleBlur}
							value={formik.values.apiKey}
							className='p-2 w-2/3 rounded-md border border-gray-300 dark:border-gray-700'
						/>
						{formik.touched.apiKey && formik.errors.apiKey ? (
							<div className='text-red-500 mt-1'>{formik.errors.apiKey}</div>
						) : null}
					</div>

					<div className='px-4 sm:px-8'>
						<h2 className='text-black1 dark:text-white font-medium text-lg py-4'>
							Organization ID:
						</h2>
						<input
							id='organizationId'
							name='organizationId'
							type='text'
							onChange={formik.handleChange}
							onBlur={formik.handleBlur}
							value={formik.values.organizationId}
							className='p-2 w-2/3 rounded-md border border-gray-300 dark:border-gray-700'
						/>
						{formik.touched.organizationId && formik.errors.organizationId ? (
							<div className='text-red-500 mt-1'>
								{formik.errors.organizationId}
							</div>
						) : null}
					</div>

					<Button
						type='submit'
						className='mx-4 w-2/3 sm:mx-8'
						disabled={formik.isSubmitting}
					>
						Save
					</Button>
				</form>
			</div>
		</div>
	)
}

export default Dashboard
