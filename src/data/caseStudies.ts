/**
 * Case Studies Data
 * Anonymized real-world NuraVolt implementations
 * Source: Netherlands-Spain presentation (11/2024)
 */

export interface CaseStudy {
  id: string;
  title: string;
  region: 'netherlands' | 'spain' | 'uae' | 'gcc' | 'europe' | 'africa';
  capacity: number; // MW
  sites: number;
  challenges: string[];
  technologies: string[];
  results: {
    powerRecovery: string;
    costSavings: string;
    paybackPeriod: string;
    diagnosticImprovement?: string;
    specificMetrics: Array<{
      label: string;
      value: string;
      description: string;
    }>;
  };
  implementation: {
    timeline: string;
    approach: string;
    keyFeatures: string[];
  };
  quote?: string;
  detectionCapabilities?: Array<{
    category: string;
    advanceWarning: string;
    accuracy: string;
  }>;
  aiTechnology?: {
    preTrainedModel: string;
    zeroShotAccuracy: string;
    operationalAccuracy: string;
    trainingDataSize: string;
    continuousLearning: boolean;
  };
  deploymentOptions?: {
    cloud: boolean;
    onPremise: boolean;
    hybrid: boolean;
    notes?: string;
  };
  soilingDetails?: {
    detectionMethod: string;
    soilingRate: string;
    accuracy: string;
    methodology: string[];
  };
  roiDisclaimer?: string;
}

export const caseStudies: CaseStudy[] = [
  {
    id: 'dutch-multi-site-85mw',
    title: 'Multi-Site Dutch Portfolio',
    region: 'netherlands',
    capacity: 85,
    sites: 12,
    challenges: [
      'Multi-brand inverter management',
      'Distributed sites across Netherlands',
      'Manual diagnostic inefficiency',
      'Limited inverter visibility'
    ],
    technologies: [
      'SMA inverters',
      'Sungrow inverters',
      'Huawei inverters',
      'Modbus-TCP integration',
      'Automated anomaly detection'
    ],
    results: {
      powerRecovery: '156 MWh/year',
      costSavings: '€89,000/year',
      paybackPeriod: 'Positive ROI from month 1',
      diagnosticImprovement: '65% faster fault resolution',
      specificMetrics: [
        {
          label: 'Multi-Brand Integration',
          value: '3 inverter brands',
          description: 'Unified monitoring across SMA, Sungrow, and Huawei systems'
        },
        {
          label: 'Diagnostic Time Reduction',
          value: '65%',
          description: 'From manual checks to automated anomaly alerts'
        },
        {
          label: 'Site Visit Reduction',
          value: '40%',
          description: 'Remote diagnostics reduced truck rolls by 40%'
        },
        {
          label: 'Power Recovery',
          value: '156 MWh/year',
          description: 'Early fault detection and rapid response'
        }
      ]
    },
    implementation: {
      timeline: '6 weeks',
      approach: 'Phased rollout across 12 sites with staggered commissioning',
      keyFeatures: [
        'Multi-protocol data integration (Modbus-TCP, SunSpec)',
        'Automated anomaly detection with physics-based validation',
        'Remote diagnostics dashboard',
        'Mobile alerts for critical faults'
      ]
    },
    quote: 'NuraVolt unified our fragmented monitoring ecosystem and cut diagnostic time by more than half.',
    detectionCapabilities: [
      {
        category: 'Inverter Failures',
        advanceWarning: '2-15 days (median 7 days)',
        accuracy: '92-96% detection accuracy'
      },
      {
        category: 'String Faults',
        advanceWarning: '1-7 days (median 3 days)',
        accuracy: '90-95% accuracy'
      },
      {
        category: 'Module Degradation',
        advanceWarning: '30-90 days early detection',
        accuracy: '88-93% accuracy'
      },
      {
        category: 'Grid Issues',
        advanceWarning: 'Real-time detection',
        accuracy: '95-98% accuracy'
      },
      {
        category: 'Ground Faults',
        advanceWarning: '1-5 days advance warning',
        accuracy: '90-94% accuracy'
      }
    ],
    aiTechnology: {
      preTrainedModel: 'Pre-trained foundation model with 50+ GW of global solar data',
      zeroShotAccuracy: '85-90% (no client data needed)',
      operationalAccuracy: '92-96% (after 30 days with operational data)',
      trainingDataSize: '50+ GW, 1,500+ PV systems, 10+ years historical data',
      continuousLearning: true
    },
    deploymentOptions: {
      cloud: true,
      onPremise: true,
      hybrid: true,
      notes: 'Deployed on NuraVolt cloud with secure API integration. On-premise deployment available for data sovereignty requirements.'
    },
    roiDisclaimer: 'ROI estimates based on conservative electricity rates (€0.050/kWh), tiered subscription pricing ($2K-7K/month based on capacity), and validated deployment data. No setup costs for cloud deployment. Individual results may vary based on plant configuration, local electricity rates, and operational conditions. Contact us for a personalized ROI assessment and pricing quote for your specific portfolio.'
  },
  {
    id: 'spanish-utility-120mw',
    title: 'Spanish Utility-Scale Plant',
    region: 'spain',
    capacity: 120,
    sites: 1,
    challenges: [
      'High soiling rates in Andalusia',
      'Suboptimal cleaning schedules',
      'Performance degradation',
      'Manual soiling assessment'
    ],
    technologies: [
      'Fronius inverters',
      'Advanced soiling analytics',
      'Weather data integration',
      'Optimized cleaning scheduling'
    ],
    results: {
      powerRecovery: '284 MWh/year',
      costSavings: '€142,000/year',
      paybackPeriod: 'Positive ROI from month 1',
      specificMetrics: [
        {
          label: 'Soiling Optimization',
          value: '€78K/year',
          description: 'Reduced cleaning frequency while improving output'
        },
        {
          label: 'Cleaning Cost Reduction',
          value: '32%',
          description: 'From monthly to optimized schedule based on actual soiling rates'
        },
        {
          label: 'Power Recovery',
          value: '284 MWh/year',
          description: 'Soiling detection + optimized cleaning schedule'
        },
        {
          label: 'Water Savings',
          value: '2.4M liters/year',
          description: 'Reduced cleaning frequency with maintained performance'
        }
      ]
    },
    implementation: {
      timeline: '4 weeks',
      approach: 'Soiling-focused deployment with baseline measurement period',
      keyFeatures: [
        'Physics-based soiling detection',
        'Weather integration (humidity, wind, rainfall)',
        'Dynamic cleaning recommendations',
        'ROI tracking dashboard'
      ]
    },
    quote: 'The soiling analytics transformed our O&M strategy. We clean less and produce more.',
    detectionCapabilities: [
      {
        category: 'Soiling Detection',
        advanceWarning: 'Real-time + 3-7 day forecast',
        accuracy: '94-97% accuracy without soiling sensors'
      },
      {
        category: 'Inverter Failures',
        advanceWarning: '2-15 days (median 7 days)',
        accuracy: '92-96% detection accuracy'
      },
      {
        category: 'String Faults',
        advanceWarning: '1-7 days (median 3 days)',
        accuracy: '90-95% accuracy'
      },
      {
        category: 'Module Degradation',
        advanceWarning: '30-90 days early detection',
        accuracy: '88-93% accuracy'
      },
      {
        category: 'Grid Issues',
        advanceWarning: 'Real-time detection',
        accuracy: '95-98% accuracy'
      }
    ],
    aiTechnology: {
      preTrainedModel: 'Pre-trained foundation model with 50+ GW of global solar data',
      zeroShotAccuracy: '85-90% (no client data needed)',
      operationalAccuracy: '92-96% (after 30 days with operational data)',
      trainingDataSize: '50+ GW, 1,500+ PV systems, 10+ years historical data',
      continuousLearning: true
    },
    deploymentOptions: {
      cloud: true,
      onPremise: true,
      hybrid: true,
      notes: 'Deployed on NuraVolt cloud with weather API integration. On-premise deployment available for data sovereignty requirements.'
    },
    soilingDetails: {
      detectionMethod: 'Physics-based clearsky comparison with weather integration',
      soilingRate: '0.2-0.8%/day tracked in real-time (Andalusian climate)',
      accuracy: '94-97% detection accuracy without dedicated soiling sensors',
      methodology: [
        'Clear-sky irradiance modeling with physics-based calculations',
        'Performance ratio degradation analysis with temperature compensation',
        'Weather integration: rainfall detection (auto-cleaning events), humidity levels, wind patterns, dust storm alerts',
        'Spectral effects modeling for Saharan dust events',
        'Array-to-array comparison for spatial soiling pattern detection',
        'Machine learning models trained on global soiling patterns and solar performance data',
        'Dynamic cleaning threshold optimization: cost-benefit analysis per cleaning, seasonal adjustment, site-specific soiling patterns',
        'ROI tracking: power loss quantification, cleaning cost optimization, water usage monitoring'
      ]
    },
    roiDisclaimer: 'ROI estimates based on conservative electricity rates (€0.050/kWh), tiered subscription pricing ($2K-7K/month based on capacity), and validated deployment data. No setup costs for cloud deployment. Soiling rates vary by season and weather patterns. Individual results may vary based on local climate, cleaning costs, and operational conditions. Contact us for a personalized ROI assessment with site-specific soiling analysis and pricing quote.'
  }
];

/**
 * Get case studies filtered by criteria
 */
export function getCaseStudies(filters?: {
  region?: CaseStudy['region'];
  minCapacity?: number;
  maxCapacity?: number;
}): CaseStudy[] {
  let filtered = [...caseStudies];

  if (filters?.region) {
    filtered = filtered.filter(cs => cs.region === filters.region);
  }

  if (filters?.minCapacity) {
    filtered = filtered.filter(cs => cs.capacity >= filters.minCapacity!);
  }

  if (filters?.maxCapacity) {
    filtered = filtered.filter(cs => cs.capacity <= filters.maxCapacity!);
  }

  return filtered;
}

/**
 * Get a single case study by ID
 */
export function getCaseStudyById(id: string): CaseStudy | undefined {
  return caseStudies.find(cs => cs.id === id);
}
