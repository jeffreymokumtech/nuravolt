import type { ArticleView, ContentSection, FAQ, RelatedLink } from './types';

/**
 * Template A — Fault / failure-mode catalog (PV + BESS).
 *
 * Substance drawn from docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md, nuravolt/fault/
 * (rule_based.py, rul_models.py, bess_rul_models.py) and the operator manuals
 * under public/data/manuals/seed/synthetic/. Each entry is one indexable page.
 */

const PUBLISHED = '2026-06-09';

export interface FaultEntry {
  slug: string;
  category: 'pv' | 'bess';
  title: string;
  intro: string;
  /** Short factual answer block — the unit AI engines lift. */
  quickAnswer: string;
  symptoms: string[];
  scadaSignatures: string[];
  rootCause: string;
  financialImpact: string;
  /** How NuraVolt's physics-informed ML flags it. */
  detectionMethod: string;
  /** Slugs of other faults in this catalog. */
  relatedFaults: string[];
  /** Cross-catalog links (e.g. BESS metric pages). */
  extraRelated?: RelatedLink[];
  faq: FAQ[];
  heroImage?: string;
  sources?: string[];
  datePublished?: string;
}

export const faults: FaultEntry[] = [
  {
    slug: 'pv-string-underperformance',
    category: 'pv',
    title: 'PV string underperformance',
    intro: 'A string delivering less current than its peers under the same irradiance.',
    quickAnswer:
      'PV string underperformance is when one string produces measurably less current than identical neighbouring strings at the same irradiance and temperature. Typical causes are connector corrosion, partial shading, a failed module, or a tripped bypass diode. Left unaddressed it costs 2–8% of that string’s annual yield.',
    symptoms: [
      'One string’s current sits consistently below sibling strings on the same MPPT.',
      'The gap widens at high irradiance rather than staying proportional.',
      'Performance ratio for the affected combiner drifts down over weeks.',
    ],
    scadaSignatures: [
      'Per-string current (Istr) 3–15% below the MPPT median during clear-sky midday.',
      'Stable voltage but depressed current — distinguishes it from a voltage fault.',
      'No corresponding irradiance or temperature anomaly on the reference sensor.',
    ],
    rootCause:
      'Most often progressive series resistance from corroded MC4 connectors or junction-box solder, a single open-circuited module, or soft partial shading. Because the loss tracks irradiance, it compounds in summer when the asset earns most.',
    financialImpact:
      'A persistent 5% deficit on a 1 MWp string block in southern Europe is roughly €1,500–3,000/year in lost generation — and the connector fault that caused it can escalate into an arc-fault safety event if ignored.',
    detectionMethod:
      'NuraVolt benchmarks each string against its own cohort using a physics-informed expected-current model, so it separates genuine underperformance from irradiance and temperature effects. The rule layer flags the deficit; the RUL layer tracks whether the slope is degrading (connector corrosion) or step-change (module failure).',
    relatedFaults: ['mppt-imbalance', 'dc-insulation-degradation', 'soiling-loss'],
    faq: [
      {
        q: 'How is string underperformance different from soiling?',
        a: 'Soiling depresses every string on a plant roughly equally and recovers after rain or cleaning. Underperformance affects one string (or a few) and does not recover with cleaning — the loss is in the hardware, not on the glass.',
      },
      {
        q: 'What current deficit is worth a truck roll?',
        a: 'A sustained deficit above ~5% of the MPPT median that persists across multiple clear days and is not explained by shading usually justifies inspection; below that, batch it into the next scheduled visit.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md', 'nuravolt/fault/rule_based.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'inverter-clipping',
    category: 'pv',
    title: 'Inverter clipping',
    intro: 'AC power held flat at the inverter rating while DC is available.',
    quickAnswer:
      'Inverter clipping is when DC array power exceeds the inverter’s AC rating and the inverter caps output at its limit, discarding the surplus. Some clipping is designed-in (high DC/AC ratio); excess or unexpected clipping signals an oversized array, a derated inverter, or a thermal limit, and is lost energy you can quantify.',
    symptoms: [
      'AC power flatlines at the nameplate limit during peak irradiance.',
      'A characteristic flat-topped "mesa" shape on the midday power curve.',
      'Clipping appears earlier in the day or at lower irradiance than expected.',
    ],
    scadaSignatures: [
      'Pac pinned at the rated value while Pdc (or string currents) keep rising.',
      'Clipping hours accumulate beyond the design DC/AC ratio expectation.',
      'Unexpected clipping correlated with high heat-sink temperature = thermal derate, not design.',
    ],
    rootCause:
      'Designed clipping comes from a deliberately high DC/AC ratio that boosts morning/evening capture. Problematic clipping comes from thermal derating (cooling fault), a misconfigured power limit, or an array expansion the inverter was never sized for.',
    financialImpact:
      'Modelled clipping is an economic choice; unexpected clipping is pure loss. A thermal-derate that clips an extra 60 kW for three midday hours across a summer can quietly erase tens of MWh — invisible unless you separate expected from anomalous clipping.',
    detectionMethod:
      'NuraVolt compares observed clipping against the plant’s designed DC/AC ratio and a clear-sky expected-power envelope, then attributes the surplus loss. When clipping correlates with rising heat-sink temperature it is reclassified as a cooling/derate fault rather than benign design clipping.',
    relatedFaults: ['inverter-igbt-overtemperature', 'mppt-imbalance'],
    faq: [
      {
        q: 'Is clipping always bad?',
        a: 'No. A high DC/AC ratio with planned clipping often maximises lifetime revenue by capturing more energy at the shoulders of the day. The problem is unplanned clipping from derating or misconfiguration.',
      },
      {
        q: 'How do you tell design clipping from a fault?',
        a: 'Design clipping is stable day-to-day and uncorrelated with temperature. Fault clipping grows with heat-sink temperature or appears after a configuration change — NuraVolt separates the two automatically.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md', 'nuravolt/fault/rule_based.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'mppt-imbalance',
    category: 'pv',
    title: 'MPPT imbalance',
    intro: 'Unequal power across the MPPT inputs of a single inverter.',
    quickAnswer:
      'MPPT imbalance is when the maximum-power-point trackers on one inverter deliver materially different power despite seeing the same conditions. It points to uneven string lengths, mismatched orientation, partial shading on one tracker, or a tracker hunting around its setpoint.',
    symptoms: [
      'One MPPT input consistently lower than the others on the same inverter.',
      'Tracker output oscillates ("hunting") instead of settling at a stable point.',
      'Imbalance appears or worsens at specific sun angles (shading signature).',
    ],
    scadaSignatures: [
      'Per-MPPT power spread above the configured tolerance during clear sky.',
      'Voltage/current oscillation on one tracker = MPPT hunting.',
      'Time-of-day-locked imbalance = geometric shading rather than hardware.',
    ],
    rootCause:
      'Coarse MPPT imbalance usually reflects design (different string counts, split orientations) or developing shading; hunting reflects a control-loop or firmware issue, or a marginal string the tracker cannot resolve cleanly.',
    financialImpact:
      'A few percent of inverter output lost across the high-irradiance season, plus accelerated wear when a tracker hunts continuously. Catching a hunting tracker early avoids both the yield loss and the firmware truck roll.',
    detectionMethod:
      'NuraVolt evaluates per-MPPT power against the inverter cohort and a geometric shading model, separating designed imbalance from developing faults. A dedicated oscillation detector flags hunting from the voltage/current time series.',
    relatedFaults: ['pv-string-underperformance', 'inverter-clipping'],
    faq: [
      {
        q: 'Can MPPT imbalance be normal?',
        a: 'Yes — split-orientation systems or intentionally unequal string counts produce steady, expected imbalance. The catalog flags only the deviations from each inverter’s own designed pattern.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md', 'nuravolt/fault/rule_based.py'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'dc-insulation-degradation',
    category: 'pv',
    title: 'DC insulation resistance degradation',
    intro: 'Falling insulation resistance on the DC side — a safety-critical fault.',
    quickAnswer:
      'DC insulation (Riso) degradation is a drop in the resistance between the PV array’s live conductors and ground, usually from water ingress, damaged backsheet, or abraded DC cabling. It is safety-critical: low Riso trips the inverter (e.g. Huawei SUN2000 code 2002) and, if ignored, raises arc and shock risk.',
    symptoms: [
      'Morning inverter trips that clear as the array dries and warms.',
      'Insulation-resistance alarms clustered after rain or high humidity.',
      'A specific combiner or string repeatedly implicated.',
    ],
    scadaSignatures: [
      'Riso readings falling toward the inverter’s trip threshold (often 1 MΩ class).',
      'Trips correlated with humidity/rainfall and time-of-day (dawn).',
      'Repeating fault code on the same MPPT — e.g. Huawei 2002 low insulation resistance.',
    ],
    rootCause:
      'Water ingress at MC4 connectors or junction boxes, backsheet cracking, rodent or abrasion damage to DC cable, or a degraded module laminate. The fault is often intermittent — worst when wet, recovering when dry — which is exactly why it gets dismissed.',
    financialImpact:
      'Beyond the lost production during each trip, declining Riso is the leading indicator of an insulation failure that can cause an arc-fault fire. The cost of acting is one inspection; the cost of ignoring it is open-ended.',
    detectionMethod:
      'NuraVolt trends Riso per combiner and correlates trips with weather, so an intermittent dawn-only fault is surfaced as a degrading trend rather than dismissed as noise. It maps OEM fault codes (e.g. Huawei 2002) onto the same insulation signature for cross-vendor consistency.',
    relatedFaults: ['pv-string-underperformance'],
    extraRelated: [
      {
        title: 'Huawei SUN2000 integration',
        href: '/integrations/huawei',
        description: 'Fault-code mapping including 2002 low insulation resistance.',
      },
    ],
    faq: [
      {
        q: 'Why does the trip clear by itself in the morning?',
        a: 'A moisture-driven insulation fault recovers as the array dries and heats, so the inverter auto-resets. The recovery is what makes it dangerous to ignore — the underlying ingress is still there and worsening.',
      },
      {
        q: 'Is low insulation resistance urgent?',
        a: 'Yes. It is one of the few PV faults with a direct safety dimension. A persistent or worsening Riso trend warrants inspection before the next wet period.',
      },
    ],
    sources: [
      'docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md',
      'public/data/manuals/seed/synthetic/huawei-sun2000-fault-codes.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'inverter-igbt-overtemperature',
    category: 'pv',
    title: 'Inverter IGBT overtemperature',
    intro: 'Power-stage overheating from cooling failure or a blocked heat sink.',
    quickAnswer:
      'IGBT overtemperature is when the inverter’s power-switching stage runs too hot, usually from a failed cooling fan, a clogged heat sink, or high ambient. It forces the inverter to derate (clip) or trip (e.g. Huawei SUN2000 code 6001) and shortens IGBT and DC-link capacitor life.',
    symptoms: [
      'Midday derating/clipping that tracks heat-sink temperature.',
      'Thermal trips on the hottest days or hottest inverters in the row.',
      'Audible or measured fan fault preceding the temperature rise.',
    ],
    scadaSignatures: [
      'Heat-sink/IGBT temperature climbing toward the OEM limit (<60 °C ambient spec).',
      'Power derate that correlates with temperature, not irradiance.',
      'Hardware fault code on a single inverter — e.g. Huawei 6001 IGBT overtemp / 6011 fan abnormal.',
    ],
    rootCause:
      'Cooling-fan bearing wear or dust ingress, a heat sink blocked by debris, or sustained operation above the ambient spec. Each thermal cycle also ages the DC-link capacitors, so the fault compounds other inverter failure modes.',
    financialImpact:
      'Thermal derating silently clips peak-hour energy, and repeated overtemperature events cut years off the inverter’s service life. A €200 fan replaced on schedule prevents a five-figure power-stage failure.',
    detectionMethod:
      'NuraVolt trends per-inverter thermal behaviour and attributes temperature-correlated derating to cooling rather than design clipping. Its RUL layer projects days-to-fault from the temperature trend so the fan is replaced on a planned visit, not after a trip.',
    relatedFaults: ['inverter-clipping'],
    extraRelated: [
      {
        title: 'BESS thermal stress',
        href: '/faults/bess-thermal-stress',
        description: 'The battery-side analogue of heat-driven degradation.',
      },
    ],
    faq: [
      {
        q: 'How much warning does a cooling fault give?',
        a: 'Cooling degradation is usually gradual — fan bearings and heat-sink fouling trend over days to weeks, which is why a temperature-trend model can flag it with a planned-maintenance horizon rather than an emergency.',
      },
    ],
    sources: [
      'docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md',
      'nuravolt/fault/rul_models.py',
      'public/data/manuals/seed/synthetic/huawei-sun2000-fault-codes.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'soiling-loss',
    category: 'pv',
    title: 'Soiling loss',
    intro: 'Energy lost to dust, dirt, and deposits on the module glass.',
    quickAnswer:
      'Soiling loss is the reduction in PV output caused by dust and dirt on the module surface. It is quantified as a soiling ratio (actual ÷ clean-condition output) and typically costs 1–6% of annual yield depending on climate. Unlike hardware faults it recovers with rain or cleaning, which is exactly what makes cleaning an optimisation problem.',
    symptoms: [
      'Whole-plant performance ratio drifting down between rain events.',
      'A sawtooth yield pattern: gradual decline, sharp recovery after rain/cleaning.',
      'Stronger losses in dry, dusty, or agricultural-dust seasons.',
    ],
    scadaSignatures: [
      'Soiling ratio (measured vs. clear-sky-expected) declining at a steady daily rate.',
      'Step recovery in the ratio aligned with rainfall above a wash-off threshold.',
      'Loss roughly uniform across strings — distinguishes soiling from hardware faults.',
    ],
    rootCause:
      'Airborne dust, pollen, agricultural and industrial particulates, and bird droppings accumulate on the glass and block irradiance. The accumulation rate is climate- and site-specific; rain partially or fully cleans depending on intensity.',
    financialImpact:
      'In dusty climates soiling can exceed 5%/year if uncleaned. But cleaning has a cost and a water footprint, so the real question is economic: clean only when the recovered energy beats the cleaning cost. NuraVolt’s optimiser answers that per site.',
    detectionMethod:
      'NuraVolt estimates the soiling ratio through a five-layer stack — from a DustIQ sensor (when present) down to a physics-based loss disaggregation — and forecasts accumulation with a rain-aware model, then runs a cleaning-schedule optimiser over 1,000+ scenarios to find the ROI-maximising cleaning dates.',
    relatedFaults: ['pv-string-underperformance'],
    extraRelated: [
      {
        title: 'Soiling loss: when is cleaning worth it?',
        href: '/insights/soiling-cleaning-economics',
        description: 'The economic decision behind cleaning schedules.',
      },
      {
        title: 'Soiling stations vs software soiling monitoring',
        href: '/compare/soiling-sensors-vs-software',
        description: 'Hardware sensors compared with sensorless estimation.',
      },
      {
        title: 'Fracsun alternative',
        href: '/compare/fracsun-alternative',
        description: 'Per-inverter soiling estimation without a station.',
      },
    ],
    faq: [
      {
        q: 'How is soiling loss measured without a soiling sensor?',
        a: 'By comparing actual output against a clear-sky expected model and attributing the unexplained, rain-recoverable portion to soiling. NuraVolt layers this with same-plant and transfer-learning ML where sensor data exists, each with a stated confidence level.',
      },
      {
        q: 'When is cleaning worth it?',
        a: 'When the value of the energy you’d recover before the next rain exceeds the cleaning cost. That depends on tariff, soiling rate, and rain forecast — which is why it’s optimised per site rather than scheduled on a fixed calendar.',
      },
    ],
    sources: ['docs/technical/SOILING_METHODOLOGY.md', 'nuravolt/soiling/'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'bess-capacity-fade',
    category: 'bess',
    title: 'BESS capacity fade',
    intro: 'Loss of usable battery capacity as State of Health declines toward warranty limits.',
    quickAnswer:
      'Capacity fade is the gradual loss of a battery’s usable energy as its State of Health (SoH) declines. Warranties typically guarantee ≥70% SoH at 10 years; faster fade means the asset hits that floor early. Drivers are cycle count, temperature, high-SoC dwell, and depth of discharge.',
    symptoms: [
      'Measured usable capacity (kWh) trending below the warranty curve.',
      'A capacity test showing a step drop versus the previous test.',
      'Annualised degradation exceeding the contracted rate.',
    ],
    scadaSignatures: [
      'SoH trend line projected to cross the 70% warranty threshold early.',
      '>5 percentage-point capacity drop between consecutive capacity tests.',
      'Degradation rate above 2× the contracted curve over a rolling 90-day window.',
    ],
    rootCause:
      'Calendar ageing plus cycling. For NMC the dominant drivers are high average SoC and temperature; for LFP it is cycle count and temperature. Aggressive dispatch (deep daily cycles, high C-rate, hot operation) accelerates the fade.',
    financialImpact:
      'Early capacity fade erodes the revenue capacity you can dispatch and can void or trigger the warranty. Detecting a 2×-contracted fade rate inside the 90-day window is the difference between a winning OEM claim and an out-of-pocket replacement.',
    detectionMethod:
      'NuraVolt fits a linear SoH trend over a rolling window and extrapolates the days until the warranty threshold is crossed (an RUL "days-to-fault"), with the trend R² as the confidence. It cross-checks against the contracted degradation curve to raise a warranty-grade alert with the evidence attached.',
    relatedFaults: ['bess-thermal-stress', 'bess-rte-decay', 'bess-cell-imbalance'],
    extraRelated: [
      {
        title: 'State of Health (SoH)',
        href: '/bess/state-of-health',
        description: 'The metric capacity fade is measured against.',
      },
      {
        title: 'Warranty as a data product',
        href: '/bess/warranty-as-data-product',
        description: 'Turning degradation evidence into a defensible claim.',
      },
    ],
    faq: [
      {
        q: 'What SoH counts as end of warranty life?',
        a: 'Most utility BESS warranties set a capacity-retention floor of ≥70% SoH at 10 years (or ≥60% at 20). The exact figure and the parallel energy-throughput limit live in the contract — NuraVolt tracks against both.',
      },
      {
        q: 'When should I open a warranty case?',
        a: 'When annualised SoH degradation exceeds 2× the contracted curve over a rolling 90-day window, or a single capacity test drops more than 5 percentage points versus the prior test.',
      },
    ],
    sources: [
      'nuravolt/fault/bess_rul_models.py',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'bess-cell-imbalance',
    category: 'bess',
    title: 'BESS cell imbalance',
    intro: 'Growing voltage spread between cells in a battery string.',
    quickAnswer:
      'Cell imbalance is a widening voltage spread between individual cells in a battery string. A spread above ~50 mV at 50% SoC signals a weak or failing cell, limits the usable range of the whole string, and is an early warning of thermal-runaway risk if left unbalanced.',
    symptoms: [
      'Max-minus-min cell voltage spread climbing over weeks.',
      'A string hitting its voltage limits before reaching target SoC.',
      'One or more cells consistently lagging the pack on charge/discharge.',
    ],
    scadaSignatures: [
      'Max cell voltage spread trending toward / past the 50 mV threshold at 50% SoC.',
      '>2% of cells in a string deviating >50 mV.',
      'The spread growing monotonically rather than fluctuating with load.',
    ],
    rootCause:
      'Manufacturing variance amplified by ageing, a developing internal short, or uneven thermal exposure across the pack. The BMS balances passively, but when imbalance outruns balancing it indicates a genuinely weak cell.',
    financialImpact:
      'Imbalance throttles the usable energy of an entire string to its weakest cell and is a leading indicator of cell failure. Catching it early means a balance cycle or single-cell swap instead of a string-level thermal event.',
    detectionMethod:
      'NuraVolt trends the max cell-voltage spread and projects days until it crosses the 50 mV threshold, flagging when the BMS can no longer keep up. It correlates the imbalance with temperature to distinguish a thermal cause from an intrinsic cell defect.',
    relatedFaults: ['bess-capacity-fade', 'bess-thermal-stress'],
    extraRelated: [
      {
        title: 'State of Health (SoH)',
        href: '/bess/state-of-health',
        description: 'Imbalance is one of the inputs to a string’s health.',
      },
    ],
    faq: [
      {
        q: 'What cell voltage spread is a problem?',
        a: 'A spread above roughly 50 mV at 50% SoC, or more than ~2% of cells deviating by that much, is the common escalation trigger. NuraVolt alerts on the trend before the threshold so a balance cycle can be scheduled.',
      },
    ],
    sources: [
      'nuravolt/fault/bess_rul_models.py',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'bess-thermal-stress',
    category: 'bess',
    title: 'BESS thermal stress',
    intro: 'Cumulative high-temperature exposure that accelerates battery degradation.',
    quickAnswer:
      'BESS thermal stress is the cumulative degradation a battery suffers from operating above its ideal temperature window. High cell temperature accelerates capacity fade — for NMC it is one of the top degradation drivers — and is usually caused by HVAC underperformance or hot-hour high-power dispatch.',
    symptoms: [
      'Cell temperatures persistently above the 20–22 °C ideal band.',
      'Degradation accelerating in summer or after an HVAC fault.',
      'Temperature gradients across the cabinet (uneven cooling).',
    ],
    scadaSignatures: [
      'Cumulative high-temperature exposure (EMA of cell temp above a safe limit) rising.',
      'Cell temp approaching the OEM ceiling (often ~55 °C) during peak power.',
      'HVAC setpoint drift or compressor fault preceding the temperature rise.',
    ],
    rootCause:
      'HVAC/cooling underperformance, blocked airflow, high ambient, or sustained high-C-rate dispatch during the hottest hours. Because temperature degradation is roughly exponential, small persistent excesses do outsized lifetime damage.',
    financialImpact:
      'Sustained high temperature can multiply calendar-ageing rates and erode warranty headroom — yet the fix (treat HVAC failure as Priority-1, shift peak power off the hottest hours) is operational and cheap relative to lost battery life.',
    detectionMethod:
      'NuraVolt accumulates thermal stress as an exponential-moving-average of time spent above the safe limit and projects days until cumulative exposure breaches it. HVAC faults are escalated immediately because they convert directly into capacity loss.',
    relatedFaults: ['bess-capacity-fade', 'bess-cell-imbalance', 'bess-rte-decay'],
    extraRelated: [
      {
        title: 'Depth of discharge (DoD)',
        href: '/bess/depth-of-discharge',
        description: 'The other operational lever on degradation.',
      },
    ],
    faq: [
      {
        q: 'What temperature should a BESS cabinet hold?',
        a: 'A cabinet HVAC setpoint of 20–22 °C is the common operator target. HVAC failure should be treated as a Priority-1 incident because high cell temperature degrades capacity faster than almost any other controllable factor.',
      },
    ],
    sources: [
      'nuravolt/fault/bess_rul_models.py',
      'public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md',
    ],
    datePublished: PUBLISHED,
  },
  {
    slug: 'bess-rte-decay',
    category: 'bess',
    title: 'BESS round-trip efficiency decay',
    intro: 'Falling round-trip efficiency as internal resistance rises.',
    quickAnswer:
      'Round-trip efficiency (RTE) decay is a gradual fall in the ratio of energy out to energy in, driven by rising internal resistance, ageing, or auxiliary (HVAC) load. A drop below ~85% RTE means more energy is lost as heat on every cycle — directly eroding arbitrage and ancillary-services margin.',
    symptoms: [
      'Measured RTE trending downward cycle-over-cycle.',
      'More heat generated per cycle (rising auxiliary cooling demand).',
      'Lower net throughput for the same charge energy.',
    ],
    scadaSignatures: [
      'RTE (energy discharged ÷ energy charged) declining toward the 85% line.',
      'Internal-resistance proxy rising; voltage sag under load increasing.',
      'Auxiliary/HVAC consumption climbing as a share of throughput.',
    ],
    rootCause:
      'Increasing cell internal resistance from ageing, degraded electrical connections, BMS miscalibration, or a growing parasitic auxiliary load. Each lost percentage point of RTE is energy you paid to store and never sold.',
    financialImpact:
      'On an arbitrage asset, a 2-point RTE loss is a direct hit to spread margin on every cycle, compounded across thousands of cycles a year. It is also a diagnostic signal — rising resistance often precedes other cell-level faults.',
    detectionMethod:
      'NuraVolt computes RTE per cycle, trends it, and projects days until it crosses the efficiency floor. It separates cell-resistance-driven decay from auxiliary-load growth so the fix is targeted (connections/BMS vs. HVAC) rather than guessed.',
    relatedFaults: ['bess-capacity-fade', 'bess-thermal-stress'],
    extraRelated: [
      {
        title: 'Round-trip efficiency (RTE)',
        href: '/bess/round-trip-efficiency',
        description: 'Definition, baseline, and operational levers.',
      },
    ],
    faq: [
      {
        q: 'What is a healthy round-trip efficiency?',
        a: 'Modern Li-ion BESS typically start around 88–92% AC-AC RTE including auxiliaries. A sustained drift below ~85% is worth investigating for rising internal resistance or auxiliary-load creep.',
      },
    ],
    sources: ['nuravolt/fault/bess_rul_models.py', 'notebooks/bess_analytics_crash_course.ipynb'],
    datePublished: PUBLISHED,
  },
  {
    slug: 'balance-of-system-thermal',
    category: 'bess',
    title: 'Balance-of-system thermal failure',
    intro: 'A degraded cooling or HVAC system silently ageing the whole battery.',
    quickAnswer:
      'Balance-of-system (BoS) thermal failure is degradation in a BESS’s cooling, HVAC, or thermal-management hardware — not the cells themselves — that lets pack temperature drift above optimal. Because it sits outside the cell-level data a BMS watches, it is largely invisible to standard monitoring, yet sustained operation ~10°C hot roughly doubles cell ageing. It is the archetypal "BMS isn’t enough" fault.',
    symptoms: [
      'Average pack temperature trends upward over weeks with no change in dispatch.',
      'Widening temperature spread between modules served by the same cooling loop.',
      'Cooling/HVAC drawing more auxiliary power for the same thermal duty.',
    ],
    scadaSignatures: [
      'Module temperatures rising relative to ambient at constant C-rate.',
      'Auxiliary (HVAC) load climbing as a share of throughput — the same signal that erodes round-trip efficiency.',
      'Thermal gradient across the enclosure exceeding the OEM’s allowed spread.',
    ],
    rootCause:
      'A failing or fouled cooling system: blocked filters, low coolant, a degrading chiller/compressor, or fan wear. None of it shows in cell voltages, so a BMS watching cells assumes all is well while the balance-of-system quietly bakes the pack. Industry inspections find thermal-management defects in a meaningful share of deployed BESS.',
    financialImpact:
      'On a multi-million-euro asset, sustained operation ~10°C above optimal roughly doubles the lithium-ion ageing rate — consuming years of warranty life and pulling forward augmentation spend. The cooling repair is cheap; the degradation it causes if missed is not.',
    detectionMethod:
      'NuraVolt models expected pack temperature from ambient, dispatch, and C-rate, then flags the residual when actual temperature runs hot — catching cooling degradation as a balance-of-system anomaly the BMS cannot see, and linking it to the capacity-fade and RTE it will otherwise cause.',
    relatedFaults: ['bess-thermal-stress', 'bess-capacity-fade', 'bess-rte-decay'],
    extraRelated: [
      {
        title: 'State of Health (SoH)',
        href: '/bess/state-of-health',
        description: 'The capacity that BoS heat quietly erodes.',
      },
    ],
    faq: [
      {
        q: 'Why can’t the BMS catch a cooling-system failure?',
        a: 'A battery management system watches cell-level electrical data — voltages, currents, and cell temperatures. A degrading chiller, fouled filter, or failing fan is balance-of-system hardware outside that scope, so the BMS sees normal cells right up until the heat has already aged them. Detecting it needs a model of expected versus actual pack temperature.',
      },
    ],
    sources: ['public/data/manuals/seed/synthetic/bess-warranty-and-degradation.md', 'nuravolt/fault/bess_rul_models.py'],
    datePublished: '2026-06-15',
  },
  {
    slug: 'bypass-diode-failure',
    category: 'pv',
    title: 'Bypass diode failure',
    intro: 'A failed module diode dragging down a whole string’s output.',
    quickAnswer:
      'A bypass diode failure is when one of the diodes that route current around a shaded or faulty cell-group fails short or open. A shorted diode disables a third of a module’s output; an open diode removes the protection and risks hot-spots. Either way the loss propagates to the whole series string and is easily mistaken for generic underperformance.',
    symptoms: [
      'A step drop in one string’s output that does not recover with cleaning.',
      'A module section running hot on a thermal scan (hot-spot or active diode).',
      'Output loss roughly in thirds — one, two, or three sub-strings of a module affected.',
    ],
    scadaSignatures: [
      'Affected string current sits below siblings by a discrete step, not a gradual drift.',
      'The deficit is largely flat with irradiance rather than scaling smoothly.',
      'No matching irradiance/temperature anomaly — distinguishing it from soiling or shading.',
    ],
    rootCause:
      'Bypass diodes fail from thermal cycling, lightning-induced surges, or sustained activation under partial shading, often ending shorted (a permanent third-of-module loss) or open (loss of hot-spot protection). Because each module typically has three diodes, the signature is loss in multiples of a third.',
    financialImpact:
      'A handful of shorted diodes across a plant is a quiet few-percent yield loss; left unaddressed, an open diode allowing repeated hot-spotting can escalate into module damage or a fire-risk event, turning a cheap diode swap into a module replacement.',
    detectionMethod:
      'NuraVolt benchmarks each string against its cohort and looks for the discrete, irradiance-flat step that distinguishes a diode failure from soiling or progressive resistance, then flags candidate strings for a targeted thermal inspection rather than a blind sweep.',
    relatedFaults: ['pv-string-underperformance', 'mppt-imbalance', 'dc-insulation-degradation'],
    extraRelated: [
      {
        title: 'Performance Ratio (PR)',
        href: '/pv-metrics/performance-ratio',
        description: 'The plant metric a failed diode quietly drags down.',
      },
    ],
    faq: [
      {
        q: 'How do I tell a bypass diode failure from shading or soiling?',
        a: 'Shading and soiling losses scale with irradiance and (for soiling) recover after rain or cleaning. A bypass diode failure shows a discrete step loss — often a clean third of a module — that is roughly flat with irradiance and never recovers with cleaning. A thermal scan then confirms the affected section.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md', 'nuravolt/fault/rule_based.py'],
    datePublished: '2026-06-15',
  },
  {
    slug: 'potential-induced-degradation',
    category: 'pv',
    title: 'Potential-induced degradation (PID)',
    intro: 'High system voltage driving a recoverable — then permanent — power loss.',
    quickAnswer:
      'Potential-induced degradation (PID) is power loss caused by leakage currents between the cells and the grounded module frame under high system voltage, worsened by heat and humidity. It can strip 10–30% from affected modules, hits strings near the negative end of the array hardest, and is partly recoverable if caught early — making detection time-critical.',
    symptoms: [
      'Modules near the negative (high-potential-difference) end of strings underperform most.',
      'A gradual power decline across affected modules, accelerating in hot, humid conditions.',
      'Output partially recovering after dry spells or overnight, in early-stage PID.',
    ],
    scadaSignatures: [
      'A systematic gradient in string performance correlated with electrical position in the array.',
      'Loss worsening with humidity and module temperature rather than tracking irradiance.',
      'Combiner-level PR drift concentrated on specific inverters/strings, not plant-wide.',
    ],
    rootCause:
      'A high potential difference between cells and the grounded frame drives ion migration (notably sodium from the glass) into the cell, creating shunting leakage paths. Moisture and heat accelerate it. Transformerless inverters and certain module/grounding configurations are more exposed; anti-PID hardware and night-time recovery devices mitigate it.',
    financialImpact:
      'PID can remove 10–30% from affected modules and, once advanced, becomes permanent. Across the worst-hit strings of a plant that is a large, compounding yield loss — but early detection plus PID-recovery measures can reclaim much of it, so the value is overwhelmingly in catching it early.',
    detectionMethod:
      'NuraVolt looks for the tell-tale spatial gradient — underperformance correlated with electrical position and amplified by humidity and temperature rather than irradiance — to separate PID from soiling, shading, or diode faults, and flags it while recovery is still possible.',
    relatedFaults: ['pv-string-underperformance', 'dc-insulation-degradation', 'mppt-imbalance'],
    extraRelated: [
      {
        title: 'Temperature-corrected PR',
        href: '/pv-metrics/temperature-corrected-pr',
        description: 'PID loss is easier to see once the heat penalty is removed.',
      },
    ],
    faq: [
      {
        q: 'Is potential-induced degradation reversible?',
        a: 'Partly, if caught early. Early-stage PID can be substantially recovered with anti-PID or night-time voltage-recovery devices. Left to advance in hot, humid conditions it becomes permanent, which is why timely detection of the position-correlated loss pattern matters so much.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md'],
    datePublished: '2026-06-15',
  },
  {
    slug: 'dc-arc-fault',
    category: 'pv',
    title: 'DC arc fault',
    intro: 'A high-energy arc in DC wiring — a yield loss and a fire risk.',
    quickAnswer:
      'A DC arc fault is a sustained electrical discharge across a gap or poor connection in a plant’s DC wiring, often the end-state of corroded connectors or damaged insulation. Unlike AC, the DC arc does not self-extinguish, so it is both a generation loss and a serious fire hazard — the most safety-critical fault in the PV fault library.',
    symptoms: [
      'Intermittent string dropouts or erratic current preceding a hard fault.',
      'Evidence of connector overheating, discolouration, or burning at inspection.',
      'Arc-fault circuit interrupter (AFCI) trips on the affected string or inverter.',
    ],
    scadaSignatures: [
      'Erratic, high-frequency current/voltage noise on a string before failure.',
      'Repeated unexplained string trips clustered on one combiner or connector run.',
      'A step loss following the earlier signature of rising series resistance.',
    ],
    rootCause:
      'Usually the terminal stage of progressive series resistance: corroded MC4 connectors, loose terminations, or rodent- or UV-damaged insulation create a gap that the array’s DC voltage arcs across. Because a DC arc is self-sustaining, what began as a small underperformance can escalate into a high-energy, fire-capable event.',
    financialImpact:
      'Beyond the lost generation from the tripped string, an unaddressed DC arc is a genuine fire risk to the asset and to personnel — the cost ceiling is the plant, not the string. This is the fault where early detection of the precursor (rising resistance, connector heating) pays for the entire monitoring programme.',
    detectionMethod:
      'NuraVolt treats the connector-degradation pathway as a continuum: it tracks the rising series resistance and string-current deficits that precede an arc and escalates them as safety-critical, so the corroded connector is replaced before it reaches the arcing stage rather than after.',
    relatedFaults: ['dc-insulation-degradation', 'pv-string-underperformance', 'inverter-igbt-overtemperature'],
    extraRelated: [
      {
        title: 'Huawei SUN2000 integration',
        href: '/integrations/huawei',
        description: 'Where DC arc and insulation fault codes are surfaced.',
      },
    ],
    faq: [
      {
        q: 'Why are DC arc faults more dangerous than AC faults?',
        a: 'An AC arc crosses zero volts 100–120 times a second, which helps it self-extinguish. A DC arc has no zero crossing, so once struck it can sustain itself and reach very high energy — making it a real fire hazard. That is why the precursors (corroded connectors, rising resistance) are worth catching early.',
      },
    ],
    sources: ['docs/technical/FAULT_DETECTION_TECHNICAL_SPEC.md', 'nuravolt/fault/rule_based.py'],
    datePublished: '2026-06-15',
  },
];

const FAULT_HUB = { label: 'Fault library', href: '/faults' };

export function getFault(slug: string): FaultEntry | undefined {
  return faults.find((f) => f.slug === slug);
}

export function normalizeFault(entry: FaultEntry): ArticleView {
  const sections: ContentSection[] = [
    { heading: 'Symptoms', blocks: [{ type: 'list', items: entry.symptoms }] },
    { heading: 'SCADA signatures', blocks: [{ type: 'list', items: entry.scadaSignatures }] },
    { heading: 'Root cause', blocks: [{ type: 'paragraph', text: entry.rootCause }] },
    { heading: 'Financial impact', blocks: [{ type: 'paragraph', text: entry.financialImpact }] },
    {
      heading: 'How NuraVolt detects it',
      blocks: [{ type: 'paragraph', text: entry.detectionMethod }],
    },
  ];

  const related: RelatedLink[] = [
    ...entry.relatedFaults
      .map((slug) => faults.find((f) => f.slug === slug))
      .filter((f): f is FaultEntry => Boolean(f))
      .map((f) => ({ title: f.title, href: `/faults/${f.slug}`, description: f.intro })),
    ...(entry.extraRelated ?? []),
  ];

  return {
    category: entry.category === 'bess' ? 'BESS fault' : 'PV fault',
    hub: FAULT_HUB,
    slug: entry.slug,
    urlRelative: `/faults/${entry.slug}`,
    title: entry.title,
    intro: entry.intro,
    quickAnswer: entry.quickAnswer,
    sections,
    faq: entry.faq,
    related,
    datePublished: entry.datePublished,
    heroImage: entry.heroImage,
    sources: entry.sources,
  };
}
