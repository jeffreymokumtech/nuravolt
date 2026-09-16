import { PrismaClient, TicketStatus, TicketPriority, TicketTriggerType, TicketValidationAction, ConnectionType, ConnectionStatus } from '@prisma/client';

const prisma = new PrismaClient();

async function createDemoData() {
  try {
    // Check if demo connection exists
    const existingConn = await prisma.dataConnection.findFirst({
      where: { id: 'demo_conn_1' }
    });

    if (!existingConn) {
      console.log('Creating DataConnection...');
      await prisma.dataConnection.create({
        data: {
          id: 'demo_conn_1',
          customer_id: 'demo_customer',
          name: 'Demo Connection',
          type: ConnectionType.csv_upload,
          status: ConnectionStatus.connected,
          config: {},
          polling_interval: 900,
        }
      });
      console.log('✅ DataConnection created');
    } else {
      console.log('ℹ️ DataConnection already exists');
    }

    // Check if demo plant exists
    const existingPlant = await prisma.discoveredPlant.findFirst({
      where: { id: 'alpha1_1' }
    });

    if (!existingPlant) {
      console.log('Creating DiscoveredPlant...');
      await prisma.discoveredPlant.create({
        data: {
          id: 'alpha1_1',
          connection_id: 'demo_conn_1',
          external_plant_id: 'alpha1_demo',
          name: 'Alpha1 Solar Park',
          location: { lat: 37.8, lng: -4.5, country: 'Spain', region: 'Andalusia' },
          capacity_mw: 5.0,
          timezone: 'Europe/Madrid',
          enabled: true,
        }
      });
      console.log('✅ DiscoveredPlant created');
    } else {
      console.log('ℹ️ DiscoveredPlant already exists');
    }

    // Create demo tickets
    const demoTickets = [
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        title: 'High soiling detected - Cleaning recommended',
        description: 'Soiling ratio dropped below 94%. Estimated 3.2% energy loss. Cleaning within 7 days recommended.',
        status: TicketStatus.NEW,
        priority: TicketPriority.HIGH,
        trigger_type: TicketTriggerType.SOILING_FORECAST,
        estimated_revenue_impact_eur: 1250.00,
        estimated_energy_loss_kwh: 4200,
      },
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        inverter_id: 'INV_A1',
        title: 'Inverter A1 underperforming by 12%',
        description: 'Performance anomaly detected. Actual output 12% below expected based on irradiance.',
        status: TicketStatus.VALIDATED,
        priority: TicketPriority.MEDIUM,
        trigger_type: TicketTriggerType.PERFORMANCE_ANOMALY,
        estimated_revenue_impact_eur: 850.00,
        estimated_energy_loss_kwh: 2800,
      },
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        title: 'Scheduled panel cleaning - Q4',
        description: 'Quarterly cleaning scheduled based on optimization results. 4 cleaning events planned.',
        status: TicketStatus.ASSIGNED,
        priority: TicketPriority.LOW,
        trigger_type: TicketTriggerType.SCHEDULED_MAINTENANCE,
        assigned_to_clerk_id: 'demo_user_1',
        assigned_at: new Date(),
        estimated_revenue_impact_eur: 5200.00,
        estimated_energy_loss_kwh: 15000,
      },
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        inverter_id: 'INV_B2',
        title: 'DC voltage threshold exceeded',
        description: 'String voltage exceeded 98% of maximum rated voltage. Check for string issues.',
        status: TicketStatus.IN_PROGRESS,
        priority: TicketPriority.CRITICAL,
        trigger_type: TicketTriggerType.THRESHOLD_ALERT,
        assigned_to_clerk_id: 'demo_user_2',
        assigned_at: new Date(),
        estimated_revenue_impact_eur: 3200.00,
        estimated_energy_loss_kwh: 8500,
      },
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        title: 'AC grid frequency fluctuation resolved',
        description: 'Grid frequency anomaly was within acceptable range. No action required.',
        status: TicketStatus.WONT_FIX,
        priority: TicketPriority.LOW,
        trigger_type: TicketTriggerType.THRESHOLD_ALERT,
        validation_action: TicketValidationAction.DISMISSED_FALSE_POSITIVE,
        validation_notes: 'Within normal grid parameters',
        validated_at: new Date(),
        validated_by_clerk_id: 'demo_user_1',
      },
      {
        org_clerk_id: 'demo_org_alpha1',
        plant_id: 'alpha1_1',
        title: 'Tracker alignment issue fixed',
        description: 'Single-axis tracker on row 5 was misaligned. Realigned and tested.',
        status: TicketStatus.DONE,
        priority: TicketPriority.MEDIUM,
        trigger_type: TicketTriggerType.MANUAL_CREATION,
        closed_at: new Date(),
        resolution_notes: 'Tracker motor recalibrated. Now tracking correctly.',
      },
    ];

    console.log('Creating demo tickets...');
    for (const ticketData of demoTickets) {
      const existing = await prisma.ticket.findFirst({
        where: { title: ticketData.title, plant_id: ticketData.plant_id }
      });

      if (!existing) {
        await prisma.ticket.create({
          data: {
            ...ticketData,
            history: {
              create: {
                new_status: ticketData.status,
                new_priority: ticketData.priority,
                changed_by_clerk_id: 'system',
                change_reason: 'Demo ticket created',
              }
            }
          }
        });
        console.log(`✅ Created ticket: ${ticketData.title}`);
      } else {
        console.log(`ℹ️ Ticket already exists: ${ticketData.title}`);
      }
    }

    // Get counts
    const ticketCount = await prisma.ticket.count();
    const plantCount = await prisma.discoveredPlant.count();

    console.log('\n📊 Demo Data Summary:');
    console.log(`   Plants: ${plantCount}`);
    console.log(`   Tickets: ${ticketCount}`);
    console.log('\n✅ Demo data creation complete!');
  } catch (error) {
    console.error('❌ Error:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

createDemoData();
