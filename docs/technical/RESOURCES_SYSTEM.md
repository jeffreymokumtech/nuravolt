# Lead Generation & Resources System

Complete lead capture system with whitepapers, checklists, and CRM integration.

## System Overview

### Components

1. **Lead Capture Forms** - Collect contact information in exchange for resources
2. **Resource Hub** - `/resources` page showcasing all whitepapers and checklists
3. **Dynamic Landing Pages** - Individual pages for each resource with full content preview
4. **Email Automation** - Automatic delivery via Resend with download links
5. **CRM Integration** - Syncs leads to HubSpot EU region
6. **Analytics** - PostHog event tracking and UTM parameter capture

### Resources Available

**Whitepapers (4-6 pages each):**
- **irradiation-data-quality** - "Why 37% of PV Irradiation Data is Wrong"
- **inverter-failures-detection** - "Invisible Failures: AI Detection of Inverter Faults"
- **bess-thermal-runaway** - "BESS Reliability 2025: Thermal Runaway & Warranty Risks"

**Checklists (1 page each):**
- **pv-data-checklist** - "5-Step PV Data Quality Validation"
- **inverter-checklist** - "7 Hidden Causes of Inverter Underperformance"
- **bess-checklist** - "BESS Performance Health Checklist"

## File Structure

```
public/
├── resources/
│   ├── content/           # HTML source files
│   │   ├── irradiation-data-quality.html
│   │   ├── inverter-failures-detection.html
│   │   ├── bess-thermal-runaway.html
│   │   ├── pv-data-checklist.html
│   │   ├── inverter-checklist.html
│   │   └── bess-checklist.html
│   └── pdfs/              # Generated PDF files
│       ├── irradiation-data-quality.pdf
│       ├── inverter-failures-detection.pdf
│       ├── bess-thermal-runaway.pdf
│       ├── pv-data-checklist.pdf
│       ├── inverter-checklist.pdf
│       └── bess-checklist.pdf

src/
├── app/
│   ├── resources/
│   │   ├── page.tsx              # Resource hub (grid of all resources)
│   │   └── [slug]/
│   │       └── page.tsx          # Dynamic resource landing pages
│   └── api/
│       └── leads/
│           └── capture/
│               └── route.ts       # Lead capture API endpoint
├── components/
│   └── resources/
│       ├── LeadCaptureForm.tsx   # Form with validation & UTM tracking
│       ├── WhitepaperCard.tsx    # Resource card component
│       └── ResourceCTA.tsx       # CTA banner/card/inline variants

scripts/
└── generate-pdfs.js              # Automated PDF generation script
```

## Data Flow

```
1. User visits /resources or resource landing page
2. User fills out lead capture form
3. Form submits to /api/leads/capture with:
   - Contact info (name, email, company, role, region, capacity)
   - Resource info (slug, type, title)
   - UTM parameters (captured on page load)
   - Honeypot field (spam protection)

4. API endpoint processes submission:
   a. Creates/updates Lead in database
   b. Creates ResourceDownload record
   c. Creates ConversionEvent record
   d. Sends email via Resend with PDF link
   e. Syncs to HubSpot (EU region)

5. User receives:
   - Success modal with thank you message
   - Automatic PDF download
   - Email with backup download link
```

## Database Schema

### Lead Model
```prisma
model Lead {
  id                  String   @id @default(uuid())
  email               String   @unique
  name                String?
  company_name        String?
  role                String?
  region              String?
  plant_capacity_mw   Decimal?
  utm_source          String?
  utm_medium          String?
  utm_campaign        String?
  utm_content         String?
  hubspot_contact_id  String?  @unique
  created_at          DateTime @default(now())
  updated_at          DateTime @updatedAt

  resource_downloads  ResourceDownload[]
  conversion_events   ConversionEvent[]
}
```

### ResourceDownload Model
```prisma
model ResourceDownload {
  id            String   @id @default(uuid())
  lead_id       String
  resource_slug String
  resource_type String   // "whitepaper" or "checklist"
  resource_title String?
  downloaded_at DateTime @default(now())
  utm_params    Json?
  ip_address    String?
  user_agent    String?

  lead Lead @relation(fields: [lead_id], references: [id])
}
```

## CTA Placements

### Homepage (/)
- After DualSolutionsPreview: irradiation-data-quality (banner)
- After PricingSection: pv-data-checklist (card)
- New section: "Browse All Resources" with link to /resources

### PV Monitoring Page (/solutions/pv-monitoring)
- Before demo CTA: irradiation-data-quality (banner)
- Below that: inverter-checklist (card)

### BESS Monitoring Page (/solutions/bess-monitoring)
- Before demo CTA: bess-thermal-runaway (banner)
- Below that: bess-checklist (card)

## PDF Generation

### Quick Method (Manual)
1. Open HTML files in browser from `public/resources/content/`
2. Print → Save as PDF
3. Save to `public/resources/pdfs/` with matching slug names

### Automated Method
```bash
# Install Puppeteer (if not already installed)
npm install --save-dev puppeteer

# Generate all PDFs
npm run generate-pdfs
```

The script will:
- Read HTML files from `public/resources/content/`
- Generate PDFs with print-optimized settings (A4, 2cm margins)
- Save to `public/resources/pdfs/`
- Display file sizes and success/error status

## HubSpot Integration

### Setup
1. Create private app in HubSpot (Settings → Integrations → Private Apps)
2. Add scopes:
   - `crm.objects.contacts.read`
   - `crm.objects.contacts.write`
3. Copy access token
4. Add to `.env`: `HUBSPOT_API_KEY=pat-eu1-...`

### Custom Properties
Create these in HubSpot (Settings → Properties → Contact Properties):
- `resource_downloaded` (Single-line text)
- `resource_type` (Dropdown: whitepaper, checklist)
- `plant_capacity_mw` (Number)
- `region` (Dropdown: UAE, KSA, Qatar, Oman, Kuwait, Bahrain)

### EU Region Support
The system automatically detects EU1 tokens (`pat-eu1-*`) and uses the correct endpoint:
- EU: `https://api.hubapi.eu/crm/v3/objects/contacts`
- US: `https://api.hubapi.com/crm/v3/objects/contacts`

## Email Templates

Current email format (via Resend):
- From: `NuraVolt <noreply@nuravolt.com>`
- Subject: `Your {resourceType}: {resourceTitle}`
- Body: HTML with download button + CTA for free consultation

**Future Enhancement:** Upgrade to React Email for prettier templates

## Analytics & Tracking

### PostHog Events
- `resource_download` - Fired on form submission
  - Properties: resource_slug, resource_type

### UTM Parameters
Captured automatically on page load:
- `utm_source` - Traffic source (e.g., linkedin, google)
- `utm_medium` - Marketing medium (e.g., cpc, email)
- `utm_campaign` - Campaign name
- `utm_content` - Content variation

### Database Tracking
- Lead created/updated timestamp
- Resource download timestamp
- Conversion events with full context

## Security Features

### Spam Protection
- Honeypot field (hidden, must be empty)
- Server-side validation
- Rate limiting (TODO: implement if needed)

### Data Privacy
- IP address and user agent logged for fraud detection
- No sensitive data in client-side code
- Environment variables for all API keys

## Testing Checklist

### Local Testing
```bash
# Start dev server
npm run dev

# Test URLs
open http://localhost:3000/resources
open http://localhost:3000/resources/irradiation-data-quality
open http://localhost:3000/resources/pv-data-checklist
```

### Form Testing
1. Fill out form with real email
2. Verify success modal appears
3. Check PDF downloads automatically
4. Check email received with download link
5. Verify lead created in database: `npx prisma studio`
6. Check HubSpot for new/updated contact

### Email Testing
Test from different email providers:
- Gmail
- Outlook
- Corporate email

## Monitoring

### Key Metrics to Track
- Lead capture rate (form views → submissions)
- Email delivery rate (check Resend dashboard)
- HubSpot sync rate (check API logs)
- PDF download success rate
- UTM attribution (which campaigns drive most downloads)

### Error Monitoring
- Check Vercel logs for API errors
- Monitor Resend for bounced emails
- Check HubSpot activity logs for sync failures

## Future Enhancements

### Short-term
1. Add more resources (case studies, ROI calculators)
2. Implement lead scoring based on downloads
3. A/B test different CTA placements and copy
4. Add LinkedIn conversion tracking pixels

### Medium-term
1. Create resource preview modal (see content before downloading)
2. Add resource categories and filtering
3. Implement progressive profiling (less fields for returning visitors)
4. Add social sharing buttons for resources

### Long-term
1. Build content recommendation engine
2. Create resource bundles
3. Implement gated video content
4. Add webinar registration integration

## Troubleshooting

### PDFs Not Downloading
- Check files exist in `/public/resources/pdfs/`
- Verify correct slug names match resourcesData in `[slug]/page.tsx`
- Check browser console for 404 errors

### Form Submission Fails
- Check API logs in Vercel dashboard
- Verify database connection (DATABASE_URL)
- Check Resend API key is valid
- Verify HubSpot token has correct scopes

### Emails Not Sending
- Check Resend dashboard for delivery status
- Verify sender domain is verified in Resend
- Check spam folder
- Verify RESEND_API_KEY is set correctly

### HubSpot Sync Issues
- Check token is EU region (`pat-eu1-*`)
- Verify custom properties exist in HubSpot
- Check API logs for error messages
- Verify token scopes include contacts.read and contacts.write

## Support

For issues or questions:
1. Check this documentation
2. Review DEPLOYMENT_CHECKLIST.md
3. Check Vercel logs, Resend dashboard, HubSpot activity logs
4. Contact development team
