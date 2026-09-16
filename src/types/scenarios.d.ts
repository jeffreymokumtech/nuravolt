// Interface for scenario template
interface ScenarioTemplate {
	id: number | string
	image: string
	name: string
	description: string
	fields: string[]
	route: string
}
