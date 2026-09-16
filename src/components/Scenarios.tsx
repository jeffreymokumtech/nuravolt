'use client'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Project } from '@prisma/client'
import axios from 'axios'
import { Field, Form, Formik } from 'formik'
import Image from 'next/image'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import * as Yup from 'yup'

// Dynamic validation schema generator
const generateValidationSchema = (fields: string[]) => {
	const schemaFields = fields.reduce((acc, field) => {
		acc[field] = Yup.string().required(`${field} is required`)
		return acc
	}, {} as { [key: string]: any })

	return Yup.object().shape(schemaFields)
}

const Scenarios = () => {
	const [myProjects, setMyProjects] = useState<Project[]>([])
	const [isLoading, setIsLoading] = useState(false)

	const availableScenarios: ScenarioTemplate[] = [
		{
			id: 0, // Make ID number
			image: '/scenarios/make.png',
			name: 'OpenAI Scenario Make',
			description: 'This is a scenario template for OpenAI using Make',
			fields: ['apiKey', 'apiOrg', 'assistantId'], // make fields
			route: '/api/scenarios/openAIAssistant', // make route
		},
		{
			id: 'your scenario id', // n8n ID string
			image: '/scenarios/n8n.png',
			name: 'OpenAI Scenario n8n',
			description: 'This is a scenario template for OpenAI using n8n',
			fields: ['apiKey', 'apiOrg', 'assistantId'], // n8n fields
			route: '/api/workflows/openAIAssistant', // n8n route
		},
	]

	const getMyProjects = async () => {
		try {
			const response = await axios.get('/api/projects')
			if (response.data.projects) {
				setMyProjects(response.data.projects)
			}
		} catch (error) {
			console.error('Failed to fetch projects:', error)
		}
	}

	const activateProject = async (projectId: string) => {
		try {
			const response = await axios.post(`/api/active`, { projectId })

			if (response.data.success) {
				await getMyProjects()
			}
		} catch (error) {
			console.error('Failed to activate project:', error)
		}
	}

	const createCloneScenario = async (
		values: { [key: string]: string },
		route: string
	) => {
		try {
			setIsLoading(true)
			const response = await axios.post(route, {
				id: values.scenarioId,
				...values,
			})

			if (response.data.success) {
				await getMyProjects()
			}
		} catch (error) {
			console.error('Failed to clone scenario:', error)
		} finally {
			setIsLoading(false)
		}
	}

	useEffect(() => {
		getMyProjects()
	}, [])

	return (
		<div className='flex flex-col w-full items-center justify-start gap-4'>
			<h1 className='text-4xl font-bold'>Scenarios Templates</h1>

			<div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 w-11/12 max-w-7xl'>
				{availableScenarios?.map(scenario => {
					// Generate initial values for form fields
					const initialValues = scenario.fields.reduce(
						(acc: { [key: string]: string }, field) => {
							acc[field] = ''
							return acc
						},
						{ scenarioId: scenario.id } as { [key: number]: string }
					)

					return (
						<div
							key={scenario.id}
							className='flex flex-col justify-between glass rounded-xl border border-gray-600 bg items-start p-4 min-h-40'
						>
							<Image
								src={scenario.image}
								alt={scenario.name}
								width={500}
								height={500}
								className='w-full rounded-lg'
							/>
							<p className='text-2xl mt-2 text-center font-bold w-full truncate text-wrap'>
								{scenario.name}
							</p>

							<p className='text-sm w-full text-center text-gray-400'>
								{scenario.description}
							</p>

							<Formik
								initialValues={initialValues}
								validationSchema={generateValidationSchema(scenario.fields)}
								onSubmit={e => createCloneScenario(e, scenario.route)}
							>
								{({ errors, touched }) => (
									<Form className='w-full space-y-2 mt-2'>
										{scenario.fields.map(field => (
											<div key={field}>
												<Field
													as={Input}
													name={field}
													placeholder={field
														.replace(/([A-Z])/g, ' $1')
														.replace(/^./, str => str.toUpperCase())}
													className='w-full'
												/>
												{(errors as any)[field] &&
													(touched as any)[field] &&
													typeof (errors as any)[field] === 'string' && (
														<div className='text-red-500 text-sm'>
															{(errors as any)[field]}
														</div>
													)}
											</div>
										))}

										<Button
											type='submit'
											className='w-full'
											disabled={isLoading}
										>
											{isLoading ? 'Creating...' : 'Create Agent'}
										</Button>
									</Form>
								)}
							</Formik>
						</div>
					)
				})}
			</div>

			<h1 className='text-4xl font-bold'>My Projects</h1>

			<div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 w-11/12 max-w-7xl'>
				{myProjects?.map(project => (
					<div
						key={project.id}
						className='flex flex-col space-y-3 justify-between glass rounded-xl border border-gray-600 bg items-start p-4 min-h-40'
					>
						<div className='flex w-full justify-between'>
							<p className='text-lg font-bold w-full truncate text-wrap'>
								{project.type}
							</p>
							<Button
								onClick={() => activateProject(project.id)}
								variant='outline'
							>
								{project.status == 'active' ? (
									<p className='text-green-500'>Active</p>
								) : (
									<p className='text-red-500'>Inactive</p>
								)}
							</Button>
						</div>
						<div className='flex w-full flex-col gap-2'>
							<p className='w-full truncate'>
								Assistant ID: {project.assistant_id}
							</p>
							<p className='w-full truncate'>
								Webhook Link: {project.webhookLink}
							</p>
						</div>
						<Link href={`/chat/${project.id}`} className='w-full'>
							<Button className='w-full mt-2'>Go to chat</Button>
						</Link>
					</div>
				))}
			</div>
		</div>
	)
}

export default Scenarios
