import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getResend } from '@/libs/resend-client';

const prisma = new PrismaClient();

// Email where contact form submissions are sent
const NOTIFICATION_EMAIL = process.env.CONTACT_NOTIFICATION_EMAIL || 'jeffrey@nuravolt.com';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      companyName,
      plantCapacityMw,
      message,
      honeypot
    } = body;

    // Honeypot check for bot protection
    if (honeypot) {
      console.warn('Bot detected via honeypot');
      return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    }

    // Validation
    if (!email || !companyName) {
      return NextResponse.json({ error: 'Email and company name are required' }, { status: 400 });
    }

    // Get IP and user agent for analytics
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    let leadId: string | null = null;

    // Try to save to database (optional - don't fail if DB is unavailable)
    try {
      const lead = await prisma.lead.upsert({
        where: { email },
        update: {
          company_name: companyName,
          plant_capacity_mw: plantCapacityMw ? parseFloat(plantCapacityMw) : undefined,
          utm_source: 'contact_form',
          updated_at: new Date()
        },
        create: {
          email,
          company_name: companyName,
          plant_capacity_mw: plantCapacityMw ? parseFloat(plantCapacityMw) : undefined,
          utm_source: 'contact_form'
        }
      });
      leadId = lead.id;

      // Create conversion event
      await prisma.conversionEvent.create({
        data: {
          lead_id: lead.id,
          event_type: 'contact_form_submission',
          event_data: {
            companyName,
            plantCapacityMw,
            message,
            ip,
            userAgent
          }
        }
      });
      console.log('✅ Lead saved to database:', leadId);
    } catch (dbError) {
      console.warn('⚠️ Database unavailable, continuing with email only:', dbError);
      // Continue without database - email is the priority
    }

    // Send notification email to the team (REQUIRED)
    let notificationSent = false;
    try {
      console.log('📧 Sending contact notification to:', NOTIFICATION_EMAIL);
      const result = await getResend()?.emails.send({
        from: 'NuraVolt Contact Form <noreply@nuravolt.com>',
        to: NOTIFICATION_EMAIL,
        replyTo: email,
        subject: `New Contact Form Submission from ${companyName}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #2563eb;">New Contact Form Submission</h2>

            <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
              <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
              <p><strong>Company:</strong> ${companyName}</p>
              ${plantCapacityMw ? `<p><strong>Plant Capacity:</strong> ${plantCapacityMw} MW</p>` : ''}
              ${message ? `<p><strong>Message:</strong></p><p style="white-space: pre-wrap;">${message}</p>` : '<p><em>No message provided</em></p>'}
            </div>

            <p style="color: #6b7280; font-size: 14px;">
              Reply directly to this email to respond to the lead.
            </p>

            <hr style="margin: 20px 0; border: none; border-top: 1px solid #e5e7eb;">
            <p style="color: #9ca3af; font-size: 12px;">
              Submitted at: ${new Date().toISOString()}<br>
              IP: ${ip}<br>
              ${leadId ? `Lead ID: ${leadId}` : 'Database: unavailable'}
            </p>
          </div>
        `
      });

      if (!result) {
        console.warn("email disabled: RESEND_API_KEY not set");
      } else if (result.error) {
        console.error('❌ Resend API error:', result.error);
      } else {
        console.log('✅ Notification email sent:', result.data?.id);
        notificationSent = true;
      }
    } catch (emailError) {
      console.error('❌ Failed to send notification email:', emailError);
    }

    // Send confirmation email to the user (optional)
    try {
      console.log('📧 Sending confirmation to:', email);
      await getResend()?.emails.send({
        from: 'NuraVolt <noreply@nuravolt.com>',
        to: email,
        subject: 'Thanks for reaching out - NuraVolt',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Thanks for getting in touch!</h2>
            <p>Hi,</p>
            <p>We've received your message and will get back to you shortly.</p>

            <div style="background-color: #eff6ff; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #2563eb;">
              <p style="margin: 0;"><strong>Your submission:</strong></p>
              <p style="margin: 8px 0 0 0;">Company: ${companyName}</p>
              ${plantCapacityMw ? `<p style="margin: 8px 0 0 0;">Plant Capacity: ${plantCapacityMw} MW</p>` : ''}
              ${message ? `<p style="margin: 8px 0 0 0;">Message: ${message}</p>` : ''}
            </div>

            <p>In the meantime, feel free to explore our resources:</p>
            <ul>
              <li><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://nuravolt.com'}/case-studies">Case Studies</a></li>
              <li><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://nuravolt.com'}/resources">Technical Resources</a></li>
              <li><a href="${process.env.NEXT_PUBLIC_APP_URL || 'https://nuravolt.com'}/roi-calculator">ROI Calculator</a></li>
            </ul>

            <p>Best regards,<br>The NuraVolt Team</p>
          </div>
        `
      });
      console.log('✅ Confirmation email sent');
    } catch (emailError) {
      console.error('❌ Failed to send confirmation email:', emailError);
      // Don't fail if confirmation email fails
    }

    // Return success if notification was sent (even if DB failed)
    if (notificationSent) {
      return NextResponse.json({
        success: true,
        leadId: leadId,
        message: 'Thank you for your message. We will get back to you soon!'
      });
    } else {
      // If even the notification email failed, return error
      return NextResponse.json(
        { error: 'Failed to send your message. Please try again or email us directly at contact@nuravolt.com' },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Contact form error:', error);
    return NextResponse.json(
      { error: 'Failed to process your request. Please try again.' },
      { status: 500 }
    );
  }
}
