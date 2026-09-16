import AlertEmail, { type AlertEmailAlert } from '@/components/email-templates/AlertEmail'
import InvoiceTemplate from '@/components/email-templates/Invoice'
import ScheduledReport from '@/components/email-templates/ScheduledReport'
import ThankYouTemplate from '@/components/email-templates/ThanksYouTemplate'
import config from '@/config'
import prisma from '@/libs/prisma'
import { getResend } from '@/libs/resend-client'

class ResendService {
	private get resend() {
		const client = getResend()
		if (!client) throw new Error('email_not_configured')
		return client
	}

	public async sendThanksYouEmail(toMail: string) {
		const { data, error } = await this.resend.emails.send({
			from: config.resend.fromAdmin,
			to: [toMail],
			replyTo: config.resend.forwardRepliesTo,
			subject: config.resend.subjects.thankYou,
			react: ThankYouTemplate({ email: toMail }),
		})

		if (error) {
			throw error
		}

		return data
	}

	public async sendInvoice(toMail: string, renderData: any) {
		const { data, error } = await this.resend.emails.send({
			from: config.resend.fromAdmin,
			to: [toMail],
			replyTo: config.resend.forwardRepliesTo,
			subject: 'Invoice: ' + renderData.id,
			react: InvoiceTemplate(renderData),
		})

		if (error) {
			throw error
		}

		return data
	}

	public async sendScheduledReport(
		recipients: string[],
		reportName: string,
		pdfBuffer: Buffer,
		summaryData: {
			period: string;
			totalPlants: number;
			totalCapacity: string;
			revenueAtRisk: string;
			riskLevel: string;
		}
	) {
		const { data, error } = await this.resend.emails.send({
			from: config.resend.fromAdmin,
			to: recipients,
			replyTo: config.resend.forwardRepliesTo,
			subject: `NuraVolt Report: ${reportName}`,
			react: ScheduledReport({
				reportName,
				period: summaryData.period,
				totalPlants: summaryData.totalPlants,
				totalCapacity: summaryData.totalCapacity,
				revenueAtRisk: summaryData.revenueAtRisk,
				riskLevel: summaryData.riskLevel,
			}),
			attachments: [
				{
					filename: `${reportName.replace(/\s+/g, '_')}_report.pdf`,
					content: pdfBuffer,
				},
			],
		})

		if (error) {
			throw error
		}

		return data
	}

	/**
	 * Plant alerts: one email per plant per evaluation run, batching the newly
	 * triggered / escalated alerts the cron chose to email (critical and, when
	 * the plant allows it, warning severity).
	 */
	public async sendPlantAlert(
		recipients: string[],
		plantName: string,
		plantUrl: string,
		alerts: AlertEmailAlert[]
	) {
		if (recipients.length === 0 || alerts.length === 0) return null
		const { data, error } = await this.resend.emails.send({
			from: config.resend.fromAdmin,
			to: recipients,
			replyTo: config.resend.forwardRepliesTo,
			subject: `Alert for ${plantName}: ${alerts.length === 1 ? alerts[0].message : `${alerts.length} alerts`}`,
			react: AlertEmail({ plantName, plantUrl, alerts }),
		})

		if (error) {
			throw error
		}

		return data
	}

	/**
	 * Tell an operator a ticket was assigned to them. Plain email (no React
	 * template) so this stays a light notification. Callers await this
	 * best-effort and swallow failures.
	 */
	public async sendTicketAssignment(
		recipient: string,
		ticket: { ticketTitle: string; plantName: string; priority: string; ticketUrl: string }
	) {
		const { data, error } = await this.resend.emails.send({
			from: config.resend.fromAdmin,
			to: [recipient],
			replyTo: config.resend.forwardRepliesTo,
			subject: `Ticket assigned to you: ${ticket.ticketTitle}`,
			html: `<p>An O&amp;M ticket on <strong>${ticket.plantName}</strong> has been assigned to you.</p>`
				+ `<p><strong>${ticket.ticketTitle}</strong> (priority: ${ticket.priority})</p>`
				+ `<p><a href="${ticket.ticketUrl}">Open the ticket</a></p>`,
		})

		if (error) {
			throw error
		}

		return data
	}

	public async addNewEmailAddress(email: string) {
		const audience = await this.upsertAudience()
		return this.resend.contacts.create({
			email,
			unsubscribed: false,
			audienceId: audience.resend_id,
		})
	}

	private async upsertAudience() {
		const audience = await prisma.audiences.findFirst()

		if (audience) {
			return audience
		}

		const resendAudience = await this.resend.audiences.create({
			name: 'Waiting List',
		})
		const {
			data: { id, name },
		} = resendAudience
		return prisma.audiences.create({
			data: {
				resend_id: id,
				name,
			},
		})
	}
}

export const resendService = new ResendService()
