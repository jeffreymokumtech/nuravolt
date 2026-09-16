import { NextRequest, NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { Resend } from 'resend';

const prisma = new PrismaClient();
const resend = new Resend(process.env.RESEND_API_KEY);

const CAPACITY_MIDPOINTS: Record<string, number> = {
  '<10': 5,
  '10-50': 30,
  '50-200': 125,
  '200+': 300
};

const NOTIFY_INBOX = process.env.AUDIT_LEADS_INBOX || 'contact@nuravolt.com';
const FROM_ADDRESS = process.env.AUDIT_LEADS_FROM || 'NuraVolt <noreply@nuravolt.com>';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      name,
      capacityBand,
      region,
      pain,
      source,
      intent,
      honeypot,
      utmParams
    } = body || {};

    const normalizedIntent: 'monitoring' | 'audit' | 'foundation' =
      intent === 'monitoring' || intent === 'foundation' ? intent : 'audit';
    const intentLabel: Record<typeof normalizedIntent, string> = {
      monitoring: 'Monitoring lead',
      audit: 'Audit request',
      foundation: 'Data Foundation lead',
    };

    if (honeypot) {
      return NextResponse.json({ error: 'Invalid submission' }, { status: 400 });
    }

    if (!email || !name || !capacityBand || !region) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    if (!/.+@.+\..+/.test(String(email))) {
      return NextResponse.json({ error: 'Invalid email address' }, { status: 400 });
    }

    if (!Object.prototype.hasOwnProperty.call(CAPACITY_MIDPOINTS, String(capacityBand))) {
      return NextResponse.json({ error: 'Invalid capacity band' }, { status: 400 });
    }

    const capacityMw = CAPACITY_MIDPOINTS[String(capacityBand)];
    const trimmedPain = typeof pain === 'string' ? pain.slice(0, 500).trim() : null;
    const leadSource = typeof source === 'string' ? source.slice(0, 100) : 'unknown';

    const ip = request.headers.get('x-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    const userAgent = request.headers.get('user-agent') || 'unknown';

    const lead = await prisma.lead.upsert({
      where: { email: String(email).toLowerCase() },
      update: {
        name,
        region,
        plant_capacity_mw: capacityMw,
        utm_source: utmParams?.utm_source || undefined,
        utm_medium: utmParams?.utm_medium || undefined,
        utm_campaign: utmParams?.utm_campaign || undefined,
        utm_content: utmParams?.utm_content || undefined,
        updated_at: new Date()
      },
      create: {
        email: String(email).toLowerCase(),
        name,
        region,
        plant_capacity_mw: capacityMw,
        utm_source: utmParams?.utm_source || undefined,
        utm_medium: utmParams?.utm_medium || undefined,
        utm_campaign: utmParams?.utm_campaign || undefined,
        utm_content: utmParams?.utm_content || undefined
      }
    });

    await prisma.conversionEvent.create({
      data: {
        lead_id: lead.id,
        event_type: `${normalizedIntent}_request`,
        event_data: {
          intent: normalizedIntent,
          capacityBand,
          capacityMw,
          region,
          pain: trimmedPain,
          source: leadSource,
          utm: utmParams || {},
          ip,
          userAgent
        }
      }
    });

    // Notify the sales inbox (do not fail the request if this fails)
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: NOTIFY_INBOX,
        replyTo: email,
        subject: `[${intentLabel[normalizedIntent]}] ${name} · ${capacityBand} MW · ${region}`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 640px;">
            <h2 style="color: #111827; margin: 0 0 16px 0;">New ${intentLabel[normalizedIntent].toLowerCase()}</h2>
            <table style="border-collapse: collapse; width: 100%;">
              <tr><td style="padding: 6px 0; color: #6b7280; width: 140px;">Name</td><td style="padding: 6px 0;"><strong>${escapeHtml(name)}</strong></td></tr>
              <tr><td style="padding: 6px 0; color: #6b7280;">Email</td><td style="padding: 6px 0;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
              <tr><td style="padding: 6px 0; color: #6b7280;">Capacity</td><td style="padding: 6px 0;">${escapeHtml(capacityBand)} MW</td></tr>
              <tr><td style="padding: 6px 0; color: #6b7280;">Region</td><td style="padding: 6px 0;">${escapeHtml(region)}</td></tr>
              <tr><td style="padding: 6px 0; color: #6b7280;">Source</td><td style="padding: 6px 0;">${escapeHtml(leadSource)}</td></tr>
            </table>
            ${
              trimmedPain
                ? `<div style="margin-top: 20px; padding: 16px; background: #f9fafb; border-left: 3px solid #2563eb; border-radius: 4px;"><div style="font-size: 12px; color: #6b7280; margin-bottom: 6px;">What they want surfaced</div><div style="color: #111827; white-space: pre-wrap;">${escapeHtml(trimmedPain)}</div></div>`
                : ''
            }
            <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">Reply within 24h with a scoping doc and three call times. Lead ID: ${lead.id}</p>
          </div>
        `
      });
    } catch (notifyError) {
      console.error('❌ Audit notification email failed:', notifyError);
    }

    // Confirmation to the prospect (do not fail the request if this fails)
    try {
      await resend.emails.send({
        from: FROM_ADDRESS,
        to: email,
        subject: 'Your NuraVolt audit request — we\'ll be in touch within 24h',
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #111827;">Thanks, ${escapeHtml((name as string).split(' ')[0])}.</h2>
            <p>Your audit request is in. We&rsquo;ll reply within 24 hours with a scoping document and three suggested call times.</p>
            <p style="margin-top: 24px;"><strong>What happens next:</strong></p>
            <ol style="color: #374151; line-height: 1.7;">
              <li>30-minute scoping call (free) to confirm data access and audit goals.</li>
              <li>Two to three weeks of analysis: data ingestion, loss disaggregation, revenue-impact mapping.</li>
              <li>90-minute findings call + PDF report you can share with your investment committee.</li>
            </ol>
            <p style="margin-top: 24px; color: #6b7280; font-size: 14px;">If anything urgent comes up, reply to this email and it will reach me directly.</p>
            <p style="color: #374151;">— Jeffrey de Jong<br/>Founder, NuraVolt</p>
          </div>
        `
      });
    } catch (confirmError) {
      console.error('❌ Audit confirmation email failed:', confirmError);
    }

    // Sync to HubSpot if configured
    if (process.env.HUBSPOT_API_KEY) {
      try {
        const hubspotProperties: Record<string, string> = {
          email: String(email).toLowerCase(),
          firstname: (name as string).split(' ')[0],
          lastname: (name as string).split(' ').slice(1).join(' ') || '',
          region: region || '',
          lead_source_detail: `${normalizedIntent}_request_${leadSource}`,
          plant_capacity_mw: String(capacityMw)
        };
        if (trimmedPain) {
          hubspotProperties.audit_pain_statement = trimmedPain;
        }

        const hubspotResponse = await fetch('https://api.hubapi.com/crm/v3/objects/contacts', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.HUBSPOT_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ properties: hubspotProperties })
        });
        if (!hubspotResponse.ok) {
          const errBody = await hubspotResponse.json().catch(() => ({}));
          console.error('❌ HubSpot sync (audit) failed:', hubspotResponse.status, errBody);
        }
      } catch (hubspotError) {
        console.error('❌ HubSpot sync error:', hubspotError);
      }
    }

    return NextResponse.json({ success: true, leadId: lead.id });
  } catch (error) {
    console.error('Audit lead capture error:', error);
    return NextResponse.json({ error: 'Failed to process submission' }, { status: 500 });
  }
}

function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
