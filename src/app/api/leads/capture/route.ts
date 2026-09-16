import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { getResend } from '@/libs/resend-client';

const prisma = new PrismaClient();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      name,
      email,
      company,
      role,
      region,
      capacity,
      resourceSlug,
      resourceType,
      resourceTitle,
      downloadUrl,
      utmParams,
      honeypot
    } = body;

    // Honeypot check
    if (honeypot) {
      return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    }

    // Validation
    if (!email || !name || !resourceSlug) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Get IP and user agent
    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    // Create or update lead
    const lead = await prisma.lead.upsert({
      where: { email },
      update: {
        name,
        company_name: company || undefined,
        role: role || undefined,
        region: region || undefined,
        plant_capacity_mw: capacity ? parseFloat(capacity) : undefined,
        utm_source: utmParams?.utm_source,
        utm_medium: utmParams?.utm_medium,
        utm_campaign: utmParams?.utm_campaign,
        utm_content: utmParams?.utm_content,
        updated_at: new Date()
      },
      create: {
        email,
        name,
        company_name: company || undefined,
        role: role || undefined,
        region: region || undefined,
        plant_capacity_mw: capacity ? parseFloat(capacity) : undefined,
        utm_source: utmParams?.utm_source,
        utm_medium: utmParams?.utm_medium,
        utm_campaign: utmParams?.utm_campaign,
        utm_content: utmParams?.utm_content
      }
    });

    // Create resource download record
    await prisma.resourceDownload.create({
      data: {
        lead_id: lead.id,
        resource_slug: resourceSlug,
        resource_type: resourceType,
        resource_title: resourceTitle,
        utm_params: utmParams || {},
        ip_address: ip,
        user_agent: userAgent
      }
    });

    // Create conversion event
    await prisma.conversionEvent.create({
      data: {
        lead_id: lead.id,
        event_type: 'resource_download',
        event_data: {
          resourceSlug,
          resourceType,
          resourceTitle,
          utm: utmParams
        }
      }
    });

    // Deliver the requested asset. Datasets/reports pass an explicit downloadUrl;
    // legacy PDF resources fall back to the /resources/pdfs path. NEXT_PUBLIC_APP_URL
    // is unset in prod, so fall back to the canonical origin rather than "undefined".
    const base = (process.env.NEXT_PUBLIC_APP_URL || 'https://nuravolt.com').replace(/\/$/, '');
    const finalDownloadUrl = downloadUrl || `${base}/resources/pdfs/${resourceSlug}.pdf`;

    try {
      console.log('📧 Sending email to:', email);
      const emailResponse = await getResend()?.emails.send({
        from: 'NuraVolt <noreply@nuravolt.com>',
        to: email,
        subject: `Your ${resourceType}: ${resourceTitle}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2>Thanks for downloading!</h2>
            <p>Hi ${name},</p>
            <p>Here's your <strong>${resourceTitle}</strong>:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${finalDownloadUrl}"
                 style="background-color: #2563eb; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: bold;">
                Download ${resourceTitle}
              </a>
            </div>
            <p>I'd love to hear what you think. If you have any questions about applying this to your own plants, just reply to this email.</p>
            <p>Best,<br>Jeffrey<br>NuraVolt Team</p>
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
            <p style="color: #6b7280; font-size: 14px;">
              If you'd like to see how this looks on your own portfolio, just reply and we'll find a time to talk.
            </p>
          </div>
        `
      });
      console.log('✅ Email sent successfully:', emailResponse.data?.id);
    } catch (emailError) {
      console.error('❌ Email send error:', emailError);
      // Don't fail the request if email fails
    }

    // Sync to HubSpot (if configured)
    if (process.env.HUBSPOT_API_KEY) {
      try {
        console.log('📤 Syncing to HubSpot...');
        // All HubSpot API calls use api.hubapi.com
        // The token itself determines the data center (EU vs US)
        // Build HubSpot properties, only include plant_capacity_mw if it's a valid number
        const hubspotProperties: Record<string, string> = {
          email,
          firstname: name.split(' ')[0],
          lastname: name.split(' ').slice(1).join(' ') || '',
          company: company || '',
          jobtitle: role || '',
          resource_downloaded: resourceTitle,
          resource_type: resourceType,
          region: region || ''
        };

        // Only add plant_capacity_mw if it's a valid number
        if (capacity && !isNaN(parseFloat(capacity))) {
          hubspotProperties.plant_capacity_mw = capacity;
        }

        const hubspotResponse = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            properties: hubspotProperties
          })
        });

        const hubspotData = await hubspotResponse.json();

        if (!hubspotResponse.ok) {
          console.error('❌ HubSpot API Error:', {
            status: hubspotResponse.status,
            statusText: hubspotResponse.statusText,
            error: hubspotData
          });
        } else {
          console.log('✅ HubSpot contact created:', hubspotData.id);
        }
      } catch (hubspotError) {
        console.error('❌ HubSpot sync error:', hubspotError);
        // Don't fail the request if HubSpot fails
      }
    }

    return NextResponse.json({
      success: true,
      leadId: lead.id,
      downloadUrl: finalDownloadUrl
    });

  } catch (error) {
    console.error('Lead capture error:', error);
    return NextResponse.json(
      { error: 'Failed to process submission' },
      { status: 500 }
    );
  }
}
