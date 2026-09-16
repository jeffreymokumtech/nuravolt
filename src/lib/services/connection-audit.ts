import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export interface AuditLogEntry {
  connectionId: string;
  action: string;
  userId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  oldValues?: any;
  newValues?: any;
  success: boolean;
  errorMessage?: string;
}

export class ConnectionAuditService {
  async logAction(entry: AuditLogEntry): Promise<void> {
    try {
      await prisma.connectionAudit.create({
        data: {
          connection_id: entry.connectionId,
          action: entry.action,
          user_id: entry.userId,
          ip_address: entry.ipAddress,
          user_agent: entry.userAgent,
          old_values: entry.oldValues,
          new_values: entry.newValues,
          success: entry.success,
          error_message: entry.errorMessage,
        },
      });

      // Also log to CloudWatch for monitoring
      if (process.env.NODE_ENV === 'production') {
        console.log('AUDIT_LOG', {
          connectionId: entry.connectionId,
          action: entry.action,
          userId: entry.userId,
          success: entry.success,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      console.error('Failed to create audit log:', error);
      // Don't throw - audit logging shouldn't break the main operation
    }
  }

  async getConnectionAuditHistory(
    connectionId: string,
    limit: number = 50
  ): Promise<any[]> {
    return await prisma.connectionAudit.findMany({
      where: {
        connection_id: connectionId,
      },
      orderBy: {
        timestamp: 'desc',
      },
      take: limit,
      select: {
        id: true,
        action: true,
        user_id: true,
        success: true,
        error_message: true,
        timestamp: true,
        old_values: true,
        new_values: true,
      },
    });
  }

  async getSecurityEvents(
    customerId: string,
    timeRange: { start: Date; end: Date }
  ): Promise<any[]> {
    return await prisma.connectionAudit.findMany({
      where: {
        connection: {
          customer_id: customerId,
        },
        timestamp: {
          gte: timeRange.start,
          lte: timeRange.end,
        },
        OR: [
          { success: false },
          { action: 'deleted' },
          { action: 'credential_updated' },
        ],
      },
      include: {
        connection: {
          select: {
            name: true,
            type: true,
          },
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });
  }

  async detectSuspiciousActivity(customerId: string): Promise<{
    suspiciousEvents: any[];
    riskScore: number;
    recommendations: string[];
  }> {
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // Get recent failed attempts
    const failedAttempts = await prisma.connectionAudit.count({
      where: {
        connection: {
          customer_id: customerId,
        },
        timestamp: {
          gte: last24Hours,
        },
        success: false,
        action: 'tested',
      },
    });

    // Get unique IP addresses
    const uniqueIPs = await prisma.connectionAudit.findMany({
      where: {
        connection: {
          customer_id: customerId,
        },
        timestamp: {
          gte: last24Hours,
        },
        ip_address: {
          not: null,
        },
      },
      select: {
        ip_address: true,
      },
      distinct: ['ip_address'],
    });

    // Get after-hours activity (assuming business hours 9-17 UTC)
    const afterHoursActivity = await prisma.connectionAudit.count({
      where: {
        connection: {
          customer_id: customerId,
        },
        timestamp: {
          gte: last24Hours,
        },
      },
    });

    const suspiciousEvents: any[] = [];
    let riskScore = 0;
    const recommendations: string[] = [];

    // Analyze failed attempts
    if (failedAttempts > 10) {
      riskScore += 30;
      suspiciousEvents.push({
        type: 'excessive_failed_attempts',
        count: failedAttempts,
        severity: 'high',
      });
      recommendations.push('Review connection credentials and investigate failed connection attempts');
    }

    // Analyze IP diversity
    if (uniqueIPs.length > 5) {
      riskScore += 20;
      suspiciousEvents.push({
        type: 'multiple_ip_addresses',
        count: uniqueIPs.length,
        severity: 'medium',
      });
      recommendations.push('Consider implementing IP whitelisting for sensitive connections');
    }

    // Basic after-hours detection (this would be more sophisticated in production)
    const currentHour = new Date().getUTCHours();
    if (afterHoursActivity > 20 && (currentHour < 9 || currentHour > 17)) {
      riskScore += 15;
      suspiciousEvents.push({
        type: 'after_hours_activity',
        count: afterHoursActivity,
        severity: 'low',
      });
      recommendations.push('Monitor after-hours access patterns and consider time-based access controls');
    }

    return {
      suspiciousEvents,
      riskScore: Math.min(riskScore, 100),
      recommendations,
    };
  }

  async generateComplianceReport(
    customerId: string,
    startDate: Date,
    endDate: Date
  ): Promise<{
    summary: any;
    events: any[];
    compliance_score: number;
  }> {
    const events = await prisma.connectionAudit.findMany({
      where: {
        connection: {
          customer_id: customerId,
        },
        timestamp: {
          gte: startDate,
          lte: endDate,
        },
      },
      include: {
        connection: {
          select: {
            name: true,
            type: true,
          },
        },
      },
      orderBy: {
        timestamp: 'desc',
      },
    });

    const summary = {
      total_actions: events.length,
      successful_actions: events.filter(e => e.success).length,
      failed_actions: events.filter(e => !e.success).length,
      unique_users: new Set(events.map(e => e.user_id).filter(Boolean)).size,
      unique_connections: new Set(events.map(e => e.connection_id)).size,
      action_types: events.reduce((acc, event) => {
        acc[event.action] = (acc[event.action] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };

    // Calculate compliance score based on audit completeness
    const successRate = summary.total_actions > 0 
      ? (summary.successful_actions / summary.total_actions) * 100 
      : 100;
    
    const auditCompleteness = events.filter(e => 
      e.user_id && e.ip_address && e.action
    ).length / Math.max(summary.total_actions, 1) * 100;

    const compliance_score = Math.round((successRate * 0.7) + (auditCompleteness * 0.3));

    return {
      summary,
      events: events.map(event => ({
        timestamp: event.timestamp,
        action: event.action,
        connection_name: event.connection.name,
        connection_type: event.connection.type,
        user_id: event.user_id,
        success: event.success,
        error_message: event.error_message,
      })),
      compliance_score,
    };
  }
}