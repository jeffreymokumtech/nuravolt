/**
 * PlantConfig Generator Service
 *
 * Generates Python PlantConfig YAML from UI field mappings,
 * enabling seamless integration between the frontend data hub
 * and the Python analytics backend.
 */

import yaml from 'js-yaml';
import { DataFieldType, FieldMapping, DiscoveredPlant, DataConnection } from '@prisma/client';

// ============================================================================
// Utility Types
// ============================================================================

// Deep partial type for nested optional overrides
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// ============================================================================
// Types matching Python PlantConfig structure
// ============================================================================

export interface PlantConfigJSON {
  plant_id: string;
  plant_name: string;
  location: LocationConfig;
  array: ArrayConfig;
  capacity: CapacityConfig;
  data: DataConfig;
  components: ComponentsConfig;
  training: TrainingConfig;
  model: ModelConfig;
  quality: QualityConfig;
  output: OutputConfig;
  features: FeaturesConfig;
}

interface LocationConfig {
  latitude: number;
  longitude: number;
  altitude: number;
  timezone: string;
}

interface ArrayConfig {
  tilt: number;
  azimuth: number;
  gamma_pdc: number;
}

interface CapacityConfig {
  nominal_mw: number;
  installed_mw?: number;
}

interface ColumnMapping {
  irradiance: string;
  ambient_temp: string;
  module_temp?: string;
  wind_speed?: string;
  humidity?: string;
}

interface DustIQMapping {
  soiling_ratio_1?: string;
  soiling_ratio_2?: string;
  soiling_loss_1?: string;
  soiling_loss_2?: string;
}

interface DCPatternMapping {
  inverter_power?: string;
  dc_current?: string;
  dc_voltage?: string;
}

interface DataConfig {
  source_path: string;
  columns: ColumnMapping;
  inverter_pattern: string;
  timestamp_column: string;
  timestamp_format?: string;
  dustiq: DustIQMapping;
  patterns: DCPatternMapping;
  dc_channels: number;
}

interface InverterSpec {
  inverter_id: string;
  nominal_kw: number;
  string_count?: number;
}

interface GroupSpec {
  group_id: string;
  inverters: InverterSpec[];
}

interface ComponentsConfig {
  groups: GroupSpec[];
}

interface TrainingConfig {
  max_years?: number;
  min_pr: number;
  min_irradiance: number;
  min_training_samples: number;
  validation_split: number;
  use_enhanced_selection: boolean;
}

interface ModelConfig {
  use_catboost: boolean;
  use_hybrid_physics: boolean;
  catboost_params: {
    iterations: number;
    depth: number;
    learning_rate: number;
    l2_leaf_reg: number;
    random_seed: number;
  };
}

interface QualityConfig {
  min_r2: number;
  max_mae_kw: number;
  min_coverage: number;
}

interface OutputConfig {
  base_dir: string;
  save_models: boolean;
  save_json: boolean;
}

interface FeaturesConfig {
  has_dustiq: boolean;
  has_dc_currents: boolean;
  has_dc_voltages: boolean;
}

// ============================================================================
// Generator Inputs
// ============================================================================

export interface GeneratorInput {
  connection: DataConnection;
  plant: DiscoveredPlant;
  fieldMappings: FieldMapping[];
  hierarchy?: {
    pattern?: string;
    inverters?: Array<{
      id: string;
      name?: string;
      capacity_kw?: number;
      group_id?: string;
    }>;
  };
  overrides?: DeepPartial<PlantConfigJSON>;
}

export interface GeneratorResult {
  config: PlantConfigJSON;
  yaml: string;
  validation: {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  };
}

// ============================================================================
// Default Configurations
// ============================================================================

const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  max_years: 3.0,
  min_pr: 0.10,
  min_irradiance: 50.0,
  min_training_samples: 500,
  validation_split: 0.2,
  use_enhanced_selection: true,
};

const DEFAULT_MODEL_CONFIG: ModelConfig = {
  use_catboost: true,
  use_hybrid_physics: true,
  catboost_params: {
    iterations: 1000,
    depth: 8,
    learning_rate: 0.05,
    l2_leaf_reg: 3.0,
    random_seed: 42,
  },
};

const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  min_r2: 0.70,
  max_mae_kw: 0.15,
  min_coverage: 0.80,
};

// ============================================================================
// PlantConfig Generator Class
// ============================================================================

export class PlantConfigGenerator {
  /**
   * Generate PlantConfig from UI data
   */
  generate(input: GeneratorInput): GeneratorResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Extract plant info
    const plantId = input.plant.external_plant_id;
    const plantName = input.plant.name || plantId;
    const plantLocation = input.plant.location as { lat?: number; lng?: number; country?: string } | null;

    // Build location config
    const location: LocationConfig = {
      latitude: plantLocation?.lat || 0,
      longitude: plantLocation?.lng || 0,
      altitude: 0,
      timezone: input.plant.timezone || 'UTC',
    };

    if (!location.latitude || !location.longitude) {
      warnings.push('Plant location not set - using defaults');
    }

    // Build array config (defaults, can be overridden)
    const array: ArrayConfig = {
      tilt: 20.0,
      azimuth: 180.0,  // South-facing
      gamma_pdc: -0.004,
    };

    // Build capacity config
    const capacity: CapacityConfig = {
      nominal_mw: input.plant.capacity_mw ? Number(input.plant.capacity_mw) : 1.0,
    };

    if (!input.plant.capacity_mw) {
      warnings.push('Plant capacity not set - using 1.0 MW default');
    }

    // Build column mappings from field mappings
    const columns = this.buildColumnMappings(input.fieldMappings, errors, warnings);

    // Build dustIQ mappings
    const dustiq = this.buildDustIQMappings(input.fieldMappings);

    // Build DC patterns
    const patterns = this.buildDCPatterns(input.fieldMappings, input.hierarchy);

    // Build data config
    const data: DataConfig = {
      source_path: this.buildSourcePath(input.connection),
      columns,
      inverter_pattern: this.buildInverterPattern(input.hierarchy),
      timestamp_column: this.findTimestampColumn(input.fieldMappings),
      dustiq,
      patterns,
      dc_channels: 12,  // Default
    };

    // Build components config
    const components = this.buildComponentsConfig(input.hierarchy, capacity.nominal_mw);

    // Build features config
    const features: FeaturesConfig = {
      has_dustiq: dustiq.soiling_ratio_1 !== undefined || dustiq.soiling_loss_1 !== undefined,
      has_dc_currents: patterns.dc_current !== undefined,
      has_dc_voltages: patterns.dc_voltage !== undefined,
    };

    // Build output config
    const output: OutputConfig = {
      base_dir: `public/data/digitaltwin/${plantId}`,
      save_models: true,
      save_json: true,
    };

    // Build base config
    const baseConfig: PlantConfigJSON = {
      plant_id: plantId,
      plant_name: plantName,
      location,
      array,
      capacity,
      data,
      components,
      training: { ...DEFAULT_TRAINING_CONFIG },
      model: { ...DEFAULT_MODEL_CONFIG },
      quality: { ...DEFAULT_QUALITY_CONFIG },
      output,
      features,
    };

    // Apply overrides with deep merge
    const config = this.applyOverrides(baseConfig, input.overrides);

    // Generate YAML
    const yamlStr = this.generateYAML(config);

    // Validate
    this.validateConfig(config, errors, warnings);

    return {
      config,
      yaml: yamlStr,
      validation: {
        isValid: errors.length === 0,
        errors,
        warnings,
      },
    };
  }

  /**
   * Build column mappings from field mappings
   */
  private buildColumnMappings(
    mappings: FieldMapping[],
    errors: string[],
    warnings: string[]
  ): ColumnMapping {
    const findMapping = (type: DataFieldType): string | undefined => {
      const m = mappings.find(m => m.mapped_field === type && m.is_confirmed);
      return m?.original_field;
    };

    // Required fields
    const irradiance = findMapping('irradiance_poa') || findMapping('irradiance_ghi');
    const ambient_temp = findMapping('temp_ambient');

    if (!irradiance) {
      errors.push('Missing required field mapping: irradiance (irradiance_poa or irradiance_ghi)');
    }

    if (!ambient_temp) {
      errors.push('Missing required field mapping: ambient_temp');
    }

    // Optional fields
    const module_temp = findMapping('temp_module');
    const wind_speed = findMapping('wind_speed');
    const humidity = findMapping('humidity');

    if (!module_temp) {
      warnings.push('Module temperature not mapped - model accuracy may be reduced');
    }

    return {
      irradiance: irradiance || 'UNMAPPED_IRRADIANCE',
      ambient_temp: ambient_temp || 'UNMAPPED_AMBIENT_TEMP',
      module_temp,
      wind_speed,
      humidity,
    };
  }

  /**
   * Build DustIQ soiling sensor mappings
   */
  private buildDustIQMappings(mappings: FieldMapping[]): DustIQMapping {
    const soilingMappings = mappings.filter(m => m.mapped_field === 'soiling_ratio');

    const dustiq: DustIQMapping = {};

    if (soilingMappings.length >= 1) {
      dustiq.soiling_ratio_1 = soilingMappings[0].original_field;
    }
    if (soilingMappings.length >= 2) {
      dustiq.soiling_ratio_2 = soilingMappings[1].original_field;
    }

    return dustiq;
  }

  /**
   * Build DC-side measurement patterns
   */
  private buildDCPatterns(
    mappings: FieldMapping[],
    hierarchy?: GeneratorInput['hierarchy']
  ): DCPatternMapping {
    // Look for power_ac mappings that contain inverter patterns
    const powerMappings = mappings.filter(m => m.mapped_field === 'power_ac');

    const patterns: DCPatternMapping = {};

    // Try to extract inverter power pattern
    if (powerMappings.length > 0 && hierarchy?.pattern) {
      // If we have a hierarchy pattern, use it to build the inverter power pattern
      const samplePowerCol = powerMappings[0].original_field;

      // Try to convert sample column to pattern with {inv} placeholder
      // e.g., "Eta (ES): INV 01.001 / Power" -> "Eta (ES): {inv} / Power"
      const invPattern = /(INV\s*\d+\.\d+|Inverter\s*\d+|INV[-_]?\d+)/i;
      const match = samplePowerCol.match(invPattern);

      if (match) {
        patterns.inverter_power = samplePowerCol.replace(match[1], '{inv}');
      }
    }

    // Look for DC current/voltage mappings
    const currentMappings = mappings.filter(m => m.mapped_field === 'current_dc');
    const voltageMappings = mappings.filter(m => m.mapped_field === 'voltage_dc');

    if (currentMappings.length > 0) {
      // Try to extract pattern
      const sample = currentMappings[0].original_field;
      const channelPattern = /_(\d+)\s*\(A\)$/i;
      if (channelPattern.test(sample)) {
        patterns.dc_current = sample.replace(/_\d+\s*\(A\)$/i, '_{ch:02d} (A)');
      }
    }

    if (voltageMappings.length > 0) {
      const sample = voltageMappings[0].original_field;
      const channelPattern = /_(\d+)\s*\(V\)$/i;
      if (channelPattern.test(sample)) {
        patterns.dc_voltage = sample.replace(/_\d+\s*\(V\)$/i, '_{ch} (V)');
      }
    }

    return patterns;
  }

  /**
   * Build inverter pattern regex
   */
  private buildInverterPattern(hierarchy?: GeneratorInput['hierarchy']): string {
    if (hierarchy?.pattern) {
      return hierarchy.pattern;
    }

    // Default pattern for common naming conventions
    return '(INV\\s*\\d+\\.\\d+|Inverter\\s*\\d+|INV[-_]?\\d+)';
  }

  /**
   * Find timestamp column from mappings
   */
  private findTimestampColumn(mappings: FieldMapping[]): string {
    const tsMapping = mappings.find(m => m.mapped_field === 'timestamp');
    return tsMapping?.original_field || 'timestamp';
  }

  /**
   * Build source path from connection config
   */
  private buildSourcePath(connection: DataConnection): string {
    const config = connection.config as Record<string, any>;

    switch (connection.type) {
      case 'influxdb':
        return `influxdb://${config.url}/${config.bucket}`;
      case 'sql_scada':
        return `sqlscada://${config.host}/${config.database}`;
      case 'csv_upload':
        return config.file_path || 'csv://uploaded';
      case 'huawei_api':
        return 'huawei://fusionsolar.huawei.com';
      case 'solaredge_api':
        return 'solaredge://monitoringapi.solaredge.com';
      case 'modbus_tcp':
        return `modbus://${config.host}:${config.port}`;
      default:
        return `connection://${connection.id}`;
    }
  }

  /**
   * Build components config from hierarchy
   */
  private buildComponentsConfig(
    hierarchy: GeneratorInput['hierarchy'] | undefined,
    nominalMW: number
  ): ComponentsConfig {
    if (!hierarchy?.inverters || hierarchy.inverters.length === 0) {
      // Create a default single group with estimated inverters
      const estimatedInverterCount = Math.max(1, Math.round(nominalMW * 10));  // ~100kW per inverter
      const inverterCapacity = (nominalMW * 1000) / estimatedInverterCount;

      return {
        groups: [{
          group_id: 'default',
          inverters: Array.from({ length: estimatedInverterCount }, (_, i) => ({
            inverter_id: `INV_${String(i + 1).padStart(2, '0')}`,
            nominal_kw: inverterCapacity,
          })),
        }],
      };
    }

    // Group inverters by group_id
    const groupMap = new Map<string, InverterSpec[]>();

    for (const inv of hierarchy.inverters) {
      const groupId = inv.group_id || 'default';
      if (!groupMap.has(groupId)) {
        groupMap.set(groupId, []);
      }

      groupMap.get(groupId)!.push({
        inverter_id: inv.id,
        nominal_kw: inv.capacity_kw || (nominalMW * 1000 / hierarchy.inverters.length),
      });
    }

    return {
      groups: Array.from(groupMap.entries()).map(([group_id, inverters]) => ({
        group_id,
        inverters,
      })),
    };
  }

  /**
   * Generate YAML string from config
   */
  private generateYAML(config: PlantConfigJSON): string {
    // Use js-yaml to generate YAML with nice formatting
    const yamlOptions: yaml.DumpOptions = {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
      sortKeys: false,
    };

    // Add header comment
    const header = `# PlantConfig for ${config.plant_name}
# Generated by NuraVolt DataHub
# Generated at: ${new Date().toISOString()}
#
# This configuration file is automatically generated from UI field mappings.
# You can customize it further by editing the values below.

`;

    return header + yaml.dump(config, yamlOptions);
  }

  /**
   * Validate config completeness
   */
  private validateConfig(
    config: PlantConfigJSON,
    errors: string[],
    warnings: string[]
  ): void {
    // Check location
    if (config.location.latitude === 0 && config.location.longitude === 0) {
      warnings.push('Plant location is at 0,0 - please set correct coordinates');
    }

    // Check capacity
    if (config.capacity.nominal_mw <= 0) {
      errors.push('Plant capacity must be greater than 0');
    }

    // Check columns
    if (config.data.columns.irradiance.includes('UNMAPPED')) {
      errors.push('Irradiance column must be mapped');
    }

    if (config.data.columns.ambient_temp.includes('UNMAPPED')) {
      errors.push('Ambient temperature column must be mapped');
    }

    // Check components
    if (config.components.groups.length === 0) {
      errors.push('At least one inverter group must be defined');
    }

    const totalInverters = config.components.groups.reduce(
      (sum, g) => sum + g.inverters.length, 0
    );

    if (totalInverters === 0) {
      errors.push('At least one inverter must be defined');
    }
  }

  /**
   * Apply deep partial overrides to base config
   */
  private applyOverrides(
    base: PlantConfigJSON,
    overrides?: DeepPartial<PlantConfigJSON>
  ): PlantConfigJSON {
    if (!overrides) return base;

    // Create a copy with overrides applied
    const result: PlantConfigJSON = {
      ...base,
      plant_id: overrides.plant_id ?? base.plant_id,
      plant_name: overrides.plant_name ?? base.plant_name,
      location: {
        ...base.location,
        ...(overrides.location as Partial<typeof base.location>),
      },
      array: {
        ...base.array,
        ...(overrides.array as Partial<typeof base.array>),
      },
      capacity: {
        ...base.capacity,
        ...(overrides.capacity as Partial<typeof base.capacity>),
      },
      data: {
        ...base.data,
        ...(overrides.data as Partial<typeof base.data>),
      },
      components: overrides.components
        ? (overrides.components as typeof base.components)
        : base.components,
      training: {
        ...base.training,
        ...(overrides.training as Partial<typeof base.training>),
      },
      model: {
        ...base.model,
        ...(overrides.model as Partial<typeof base.model>),
      },
      quality: {
        ...base.quality,
        ...(overrides.quality as Partial<typeof base.quality>),
      },
      output: {
        ...base.output,
        ...(overrides.output as Partial<typeof base.output>),
      },
      features: {
        ...base.features,
        ...(overrides.features as Partial<typeof base.features>),
      },
    };

    return result;
  }
}

// Export singleton and utility functions
export const plantConfigGenerator = new PlantConfigGenerator();

export function generatePlantConfig(input: GeneratorInput): GeneratorResult {
  return plantConfigGenerator.generate(input);
}

/**
 * Parse existing YAML back to PlantConfigJSON
 */
export function parsePlantConfigYAML(yamlStr: string): PlantConfigJSON {
  return yaml.load(yamlStr) as PlantConfigJSON;
}
