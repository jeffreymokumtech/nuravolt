/**
 * HubSpot Custom Properties Setup Script
 * Creates custom contact properties needed for lead generation system
 *
 * Usage: node scripts/setup-hubspot-properties.js
 * Requires: HUBSPOT_API_KEY in .env file
 */

require('dotenv').config();

const HUBSPOT_API_KEY = process.env.HUBSPOT_API_KEY;

if (!HUBSPOT_API_KEY) {
  console.error('❌ Error: HUBSPOT_API_KEY not found in environment variables');
  console.error('Please add HUBSPOT_API_KEY to your .env file');
  process.exit(1);
}

// All HubSpot API calls use api.hubapi.com regardless of region
// The token itself (pat-eu1-* vs pat-na1-*) determines the data center
const isEU = HUBSPOT_API_KEY.startsWith('pat-eu1-');
const baseUrl = 'https://api.hubapi.com';

console.log(`🌍 Using HubSpot ${isEU ? 'EU' : 'US'} token with endpoint: ${baseUrl}\n`);

// Define custom properties to create
const properties = [
  {
    name: 'resource_downloaded',
    label: 'Resource Downloaded',
    type: 'string',
    fieldType: 'text',
    groupName: 'contactinformation',
    description: 'Title of the last resource downloaded (whitepaper or checklist)',
    hasUniqueValue: false,
    hidden: false,
    formField: true
  },
  {
    name: 'resource_type',
    label: 'Resource Type',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Type of resource downloaded',
    hasUniqueValue: false,
    hidden: false,
    formField: true,
    options: [
      { label: 'Whitepaper', value: 'whitepaper' },
      { label: 'Checklist', value: 'checklist' }
    ]
  },
  {
    name: 'plant_capacity_mw',
    label: 'Plant Capacity (MW)',
    type: 'number',
    fieldType: 'number',
    groupName: 'contactinformation',
    description: 'Solar or BESS plant capacity in megawatts',
    hasUniqueValue: false,
    hidden: false,
    formField: true
  },
  {
    name: 'region',
    label: 'Region',
    type: 'enumeration',
    fieldType: 'select',
    groupName: 'contactinformation',
    description: 'Geographic region (GCC countries)',
    hasUniqueValue: false,
    hidden: false,
    formField: true,
    options: [
      { label: 'UAE', value: 'UAE' },
      { label: 'Saudi Arabia', value: 'KSA' },
      { label: 'Qatar', value: 'Qatar' },
      { label: 'Oman', value: 'Oman' },
      { label: 'Kuwait', value: 'Kuwait' },
      { label: 'Bahrain', value: 'Bahrain' },
      { label: 'Other', value: 'Other' }
    ]
  }
];

async function createProperty(property) {
  try {
    console.log(`   → Sending request to: ${baseUrl}/crm/v3/properties/contacts`);

    const response = await fetch(`${baseUrl}/crm/v3/properties/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HUBSPOT_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(property)
    });

    if (!response.ok) {
      let errorData;
      try {
        errorData = await response.json();
      } catch (e) {
        errorData = { message: await response.text() };
      }

      // Check if property already exists
      if (errorData.category === 'CONFLICT' || errorData.message?.includes('already exists')) {
        console.log(`⚠️  Property "${property.name}" already exists - skipping`);
        return { success: true, alreadyExists: true };
      }

      console.error(`   → Response status: ${response.status}`);
      console.error(`   → Error details:`, JSON.stringify(errorData, null, 2));
      throw new Error(`${response.status} - ${errorData.message || response.statusText}`);
    }

    const data = await response.json();
    console.log(`✅ Created property: ${property.name} (${property.label})`);
    return { success: true, data };

  } catch (error) {
    console.error(`❌ Failed to create property "${property.name}":`);
    console.error(`   → Error: ${error.message}`);
    if (error.cause) {
      console.error(`   → Cause:`, error.cause);
    }
    return { success: false, error: error.message };
  }
}

async function setupProperties() {
  console.log('🚀 Starting HubSpot custom properties setup...\n');

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const property of properties) {
    console.log(`📝 Creating: ${property.name}...`);
    const result = await createProperty(property);

    if (result.success) {
      if (result.alreadyExists) {
        skipped++;
      } else {
        created++;
      }
    } else {
      failed++;
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary:');
  console.log(`   ✅ Created: ${created}`);
  console.log(`   ⚠️  Skipped (already exist): ${skipped}`);
  console.log(`   ❌ Failed: ${failed}`);
  console.log('='.repeat(50));

  if (failed > 0) {
    console.log('\n⚠️  Some properties failed to create. Check the errors above.');
    console.log('Common issues:');
    console.log('  - Invalid API key or insufficient permissions');
    console.log('  - Property name conflicts with reserved names');
    console.log('  - Rate limiting (wait a moment and try again)');
    process.exit(1);
  } else {
    console.log('\n✨ All properties are ready!');
    console.log('\nYou can view them in HubSpot:');
    console.log('Settings → Properties → Contact Properties');
  }
}

// Run the script
setupProperties().catch(error => {
  console.error('\n💥 Fatal error:', error);
  process.exit(1);
});
