import { DataConnection } from '@prisma/client';
import { InfluxDBService } from './influxdb-service';
import { SQLScadaService } from './sql-scada-service';
import { ModbusService } from './modbus-service';
import { HuaweiAPIService } from './huawei-api-service';
import { SolarEdgeMonitoringService } from './solaredge-api-service';
import { SungrowISolarCloudService } from './sungrow-api-service';

export interface TestResult {
  success: boolean;
  message: string;
  responseTime: number;
  error?: string;
  dataPreview?: any[];
  discoveredFields?: string[];
  plantsDiscovered?: number;
  estimatedDataPoints?: number;
  connectionType?: string;
}

export class TestConnectionService {
  async testConnection(connection: DataConnection): Promise<TestResult> {
    const startTime = Date.now();

    try {
      switch (connection.type) {
        case 'influxdb':
          return await this.testInfluxDB(connection, startTime);
        case 'sql_scada':
          return await this.testSQLScada(connection, startTime);
        case 'modbus_tcp':
          return await this.testModbus(connection, startTime);
        case 'huawei_api':
          return await this.testHuaweiAPI(connection, startTime);
        case 'solaredge_api':
          return await this.testSolarEdgeAPI(connection, startTime);
        case 'sungrow_api':
          return await this.testSungrowAPI(connection, startTime);
        case 'csv_upload':
          return this.testCSVUpload(connection, startTime);
        default:
          return {
            success: false,
            message: 'Unsupported connection type',
            responseTime: Date.now() - startTime,
            error: `Connection type '${connection.type}' is not supported`,
          };
      }
    } catch (error) {
      return {
        success: false,
        message: 'Connection test failed',
        responseTime: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private async testInfluxDB(connection: DataConnection, startTime: number): Promise<TestResult> {
    const influxService = new InfluxDBService();
    
    try {
      await influxService.connect(connection);
      const testResult = await influxService.testConnection();
      
      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'InfluxDB',
        };
      }

      // Get additional info for successful connection
      const [portfolio, dataPreview] = await Promise.all([
        influxService.discoverPortfolio().catch((): null => null),
        influxService.getDataPreview(undefined, 10).catch((): any[] => []),
      ]);

      return {
        success: true,
        message: 'Successfully connected to InfluxDB',
        responseTime: Date.now() - startTime,
        dataPreview,
        plantsDiscovered: portfolio?.plantCount || 0,
        estimatedDataPoints: portfolio?.estimatedDataPoints || 0,
        connectionType: 'InfluxDB',
        discoveredFields: portfolio?.dataTypes || [],
      };
    } finally {
      await influxService.close();
    }
  }

  private async testSQLScada(connection: DataConnection, startTime: number): Promise<TestResult> {
    const sqlService = new SQLScadaService();
    
    try {
      await sqlService.connect(connection);
      const testResult = await sqlService.testConnection();
      
      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'SQL SCADA',
        };
      }

      // Get sample data
      const dataPreview = await sqlService.getDataPreview(10).catch((): any[] => []);
      const tables = await sqlService.discoverTables().catch((): any[] => []);

      return {
        success: true,
        message: 'Successfully connected to SQL database',
        responseTime: Date.now() - startTime,
        dataPreview,
        discoveredFields: tables,
        connectionType: 'SQL SCADA',
      };
    } finally {
      await sqlService.close();
    }
  }

  private async testModbus(connection: DataConnection, startTime: number): Promise<TestResult> {
    const modbusService = new ModbusService();
    
    try {
      await modbusService.connect(connection);
      const testResult = await modbusService.testConnection();
      
      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'Modbus TCP',
        };
      }

      // Try to read some basic registers
      const deviceInfo = await modbusService.readDeviceInfo().catch((): null => null);

      return {
        success: true,
        message: 'Successfully connected via Modbus TCP',
        responseTime: Date.now() - startTime,
        dataPreview: deviceInfo ? [deviceInfo] : [],
        connectionType: 'Modbus TCP',
      };
    } finally {
      await modbusService.close();
    }
  }

  private async testHuaweiAPI(connection: DataConnection, startTime: number): Promise<TestResult> {
    const huaweiService = new HuaweiAPIService();
    
    try {
      await huaweiService.connect(connection);
      const testResult = await huaweiService.testConnection();
      
      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'Huawei FusionSolar API',
        };
      }

      // Get plant list
      const plants = await huaweiService.getPlantList().catch((): any[] => []);

      return {
        success: true,
        message: 'Successfully connected to Huawei FusionSolar API',
        responseTime: Date.now() - startTime,
        plantsDiscovered: plants.length,
        dataPreview: plants.slice(0, 5),
        connectionType: 'Huawei FusionSolar API',
      };
    } finally {
      await huaweiService.close();
    }
  }

  private async testSolarEdgeAPI(connection: DataConnection, startTime: number): Promise<TestResult> {
    const solarEdgeService = new SolarEdgeMonitoringService();

    try {
      await solarEdgeService.connect(connection);
      const testResult = await solarEdgeService.testConnection();

      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'SolarEdge Monitoring API',
        };
      }

      // Get site list
      const plants = await solarEdgeService.getPlantList().catch((): any[] => []);

      return {
        success: true,
        message: 'Successfully connected to SolarEdge monitoring API',
        responseTime: Date.now() - startTime,
        plantsDiscovered: plants.length,
        dataPreview: plants.slice(0, 5),
        connectionType: 'SolarEdge Monitoring API',
      };
    } finally {
      await solarEdgeService.close();
    }
  }

  private async testSungrowAPI(connection: DataConnection, startTime: number): Promise<TestResult> {
    const sungrowService = new SungrowISolarCloudService();

    try {
      await sungrowService.connect(connection);
      const testResult = await sungrowService.testConnection();

      if (!testResult.success) {
        return {
          success: false,
          message: testResult.message,
          responseTime: testResult.responseTime,
          error: testResult.error,
          connectionType: 'Sungrow iSolarCloud API',
        };
      }

      // Get power station list
      const plants = await sungrowService.getPlantList().catch((): any[] => []);

      return {
        success: true,
        message: 'Successfully connected to Sungrow iSolarCloud API',
        responseTime: Date.now() - startTime,
        plantsDiscovered: plants.length,
        dataPreview: plants.slice(0, 5),
        connectionType: 'Sungrow iSolarCloud API',
      };
    } finally {
      await sungrowService.close();
    }
  }

  private testCSVUpload(connection: DataConnection, startTime: number): TestResult {
    // CSV upload doesn't need real-time testing
    return {
      success: true,
      message: 'CSV upload configuration is ready',
      responseTime: Date.now() - startTime,
      connectionType: 'CSV Upload',
      discoveredFields: ['Upload CSV files to begin field discovery'],
    };
  }

  async validateConnectionSecurity(connection: DataConnection): Promise<{
    isSecure: boolean;
    issues: string[];
    recommendations: string[];
  }> {
    const issues: string[] = [];
    const recommendations: string[] = [];

    // Check for unencrypted connections
    if ((connection.config as any).ssl === false) {
      issues.push('Connection is not using SSL/TLS encryption');
      recommendations.push('Enable SSL/TLS encryption for secure data transmission');
    }

    // Check for default ports
    const defaultPorts = {
      influxdb: 8086,
      sql_scada: 1433, // SQL Server
      modbus_tcp: 502,
    };

    if ((connection.config as any).port === defaultPorts[connection.type as keyof typeof defaultPorts]) {
      issues.push('Using default port number');
      recommendations.push('Consider using a non-default port for added security');
    }

    // Check for IP address exposure
    if ((connection.config as any).host && /^\d+\.\d+\.\d+\.\d+$/.test((connection.config as any).host)) {
      const ip = (connection.config as any).host;
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
        // Private IP - good
      } else {
        issues.push('Using public IP address');
        recommendations.push('Consider using VPN or private network connectivity');
      }
    }

    // Check for credential storage
    if (!connection.secret_arn) {
      issues.push('Credentials are not properly encrypted');
      recommendations.push('Store credentials in AWS Secrets Manager');
    }

    return {
      isSecure: issues.length === 0,
      issues,
      recommendations,
    };
  }

  async benchmarkConnection(connection: DataConnection): Promise<{
    averageResponseTime: number;
    throughput: number;
    reliability: number;
    recommendations: string[];
  }> {
    const tests = 5;
    const responseTimes: number[] = [];
    let successCount = 0;

    // Run multiple test connections
    for (let i = 0; i < tests; i++) {
      try {
        const result = await this.testConnection(connection);
        responseTimes.push(result.responseTime);
        if (result.success) successCount++;
      } catch (error) {
        responseTimes.push(10000); // 10s timeout
      }
    }

    const averageResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    const reliability = (successCount / tests) * 100;
    
    // Estimate throughput (very rough)
    const throughput = averageResponseTime > 0 ? Math.round(60000 / averageResponseTime) : 0; // requests per minute

    const recommendations: string[] = [];

    if (averageResponseTime > 5000) {
      recommendations.push('High response times detected - check network connectivity');
    }

    if (reliability < 95) {
      recommendations.push('Connection reliability is below 95% - investigate network stability');
    }

    if (throughput < 10) {
      recommendations.push('Low throughput detected - consider optimizing polling frequency');
    }

    return {
      averageResponseTime,
      throughput,
      reliability,
      recommendations,
    };
  }
}