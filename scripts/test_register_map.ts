/**
 * Standalone test script for the AI Modbus register-map auto-mapper.
 * No test framework — run with:  npx tsx scripts/test_register_map.ts
 * Exits non-zero on any failure. NO live Bedrock calls in the default run
 * (invokeBedrock is mocked via the invokeImpl injection hook, mirroring the
 * fetchImpl injection in huawei-api-service.ts).
 *
 * Covers:
 *   - deterministic CSV fast path: exact row counts, delimiter/header
 *     detection, hex addresses, gain parsing, data-type normalization
 *   - heuristic mapping when NURAVOLT_LLM_FIELD_MAPPING_ENABLED=0 (no LLM calls)
 *   - LLM batch assignment: out-of-taxonomy rejection to 'unmapped',
 *     confidence clamps to [0.5, 0.85], heuristic fallback for skipped rows
 *   - LLM full extraction (SMA-style datasheet text): row validation
 *     (address >= 0, data-type whitelist, taxonomy), vendor/model passthrough
 *   - long-source prefilter keeps register-table lines under the char cap
 *   - route-level persistence plan matches the FieldMapping contract
 *     (modbus.<name> scoping, field_path=address, auto-confirm >= 0.85)
 *
 * Optional:  npx tsx scripts/test_register_map.ts --live
 *   Calls real Bedrock and benchmarks extraction against the MODBUS_PRESETS
 *   ground truth (>= 80% of preset registers correctly mapped). Requires AWS
 *   credentials (AWS_BEARER_TOKEN_BEDROCK or standard credentials).
 */
import {
  VALID_FIELD_TYPES,
  clampLlmConfidence,
  normalizeDataType,
  parseRegisterCsv,
  prefilterRegisterText,
  validateExtractedRegister,
  buildRegisterPersistenceRows,
  registerOriginalField,
  type ExtractedRegister,
} from '../src/lib/ai/register-map-schema';
import { extractRegisterMap, type BedrockInvoke } from '../src/lib/ai/register-map-llm';

// ---------------------------------------------------------------------------
// Tiny assertion harness (same shape as scripts/test_huawei_connector.ts)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(condition: boolean, label: string): void {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    failures.push(label);
    console.error(`  FAIL: ${label}`);
  }
}

function checkEqual(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
  }
  check(ok, label);
}

function section(name: string): void {
  console.log(`\n== ${name} ==`);
}

// ---------------------------------------------------------------------------
// Mock invokeBedrock (records calls, scripted responses)
// ---------------------------------------------------------------------------

interface RecordedInvoke {
  prompt: string;
  opts: any;
}

function buildMockInvoke(responses: string[]): { invoke: BedrockInvoke; calls: RecordedInvoke[] } {
  const calls: RecordedInvoke[] = [];
  const queue = [...responses];
  const invoke: BedrockInvoke = async (prompt, opts) => {
    calls.push({ prompt, opts });
    if (queue.length === 0) throw new Error('Mock invoke exhausted');
    return queue.length > 1 ? queue.shift()! : queue[0];
  };
  return { invoke, calls };
}

const throwingInvoke: BedrockInvoke = async () => {
  throw new Error('invokeBedrock must not be called in this scenario');
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// (b) Sungrow-style register CSV export (semicolon-delimited, title line,
//     hex address, gain column, one bad row)
const SUNGROW_CSV = [
  'Sungrow SG series Modbus register export',
  'Register Address;Signal Name;Data Type;Unit;Gain;Byte Order',
  '5031;Active power;U32;kW;0.1;big-endian',
  '5004;Total energy;U32;kWh;1;big-endian',
  '5011;MPPT 1 voltage;U16;V;0.1;big-endian',
  '5012;MPPT 1 current;U16;A;0.1;big-endian',
  '5008;Internal temperature;S16;°C;0.1;big-endian',
  '0x13A5;Grid frequency;U16;Hz;0.01;big-endian',
  '5019;Power factor;S16;;0.001;big-endian',
  'N/A;Bad row;U16;;;',
].join('\n');
const SUNGROW_CSV_VALID_ROWS = 7; // 8 data rows, 1 skipped (bad address)

// (a) Synthetic SMA-style datasheet text (free text, not CSV-parsable)
const SMA_DATASHEET_TEXT = [
  'SMA Sunny Tripower CORE1 - Modbus interface specification (excerpt)',
  '',
  'The SMA Modbus profile uses big-endian 32-bit registers. Enable Modbus TCP',
  'in the device webUI before connecting. Default unit id is 3.',
  '',
  'Telemetry registers:',
  '30775 P_AC Active power of all phases S32 in W',
  '30529 E_Total Total yield U32 in Wh',
  '30771 V_DC DC voltage input A S32 in V x 100',
  '30769 I_DC DC current input A S32 in A x 1000',
  '30953 Temp_Inv Internal temperature S32 in °C x 10',
].join('\n');

// ---------------------------------------------------------------------------
// Test sections
// ---------------------------------------------------------------------------

async function testCsvParsing(): Promise<void> {
  section('deterministic CSV parsing');

  const parsed = parseRegisterCsv(SUNGROW_CSV);
  check(parsed !== null, 'Sungrow CSV parses');
  if (!parsed) return;

  checkEqual(parsed.registers.length, SUNGROW_CSV_VALID_ROWS, 'exact valid row count');
  checkEqual(parsed.rowCount, 8, 'exact attempted row count');
  checkEqual(parsed.skippedRows, 1, 'bad-address row skipped');
  checkEqual(parsed.delimiter, ';', 'semicolon delimiter detected');

  const byName = new Map(parsed.registers.map(r => [r.name, r]));
  checkEqual(byName.get('Active power')?.address, 5031, 'decimal address parsed');
  checkEqual(byName.get('Grid frequency')?.address, 0x13a5, 'hex address parsed to decimal');
  checkEqual(byName.get('Active power')?.dataType, 'uint32', 'U32 normalized to uint32');
  checkEqual(byName.get('Internal temperature')?.dataType, 'int16', 'S16 normalized to int16');
  checkEqual(byName.get('Active power')?.scale, 0.1, 'gain column parsed as scale');
  checkEqual(byName.get('Power factor')?.scale, 0.001, 'small gain parsed');
  checkEqual(byName.get('Active power')?.unit, 'kW', 'unit column parsed');
  checkEqual(byName.get('Active power')?.byteOrder, 'big-endian', 'byte order column parsed');
  check(parsed.registers.every(r => r.mapped_field === 'unmapped' && r.confidence === 0),
    'CSV rows start unmapped (mapping assigned in a later stage)');

  checkEqual(parseRegisterCsv(SMA_DATASHEET_TEXT), null, 'datasheet prose is not treated as CSV');
  checkEqual(
    parseRegisterCsv('Hello, this is prose with commas.\nAnother line, with more commas, here.'),
    null,
    'comma-laden prose is not treated as CSV'
  );
}

async function testHeuristicPathWithLlmDisabled(): Promise<void> {
  section('CSV path with LLM disabled (NURAVOLT_LLM_FIELD_MAPPING_ENABLED=0)');

  process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED = '0';
  try {
    const result = await extractRegisterMap(SUNGROW_CSV, {
      vendorHint: 'sungrow',
      invokeImpl: throwingInvoke, // throws if any LLM call happens
    });

    checkEqual(result.method, 'csv+heuristic', 'method is csv+heuristic');
    checkEqual(result.registers.length, SUNGROW_CSV_VALID_ROWS, 'all valid rows preserved');

    const byName = new Map(result.registers.map(r => [r.name, r]));
    checkEqual(byName.get('Active power')?.mapped_field, 'power_ac', 'heuristic: Active power -> power_ac');
    checkEqual(byName.get('Total energy')?.mapped_field, 'energy_total', 'heuristic: Total energy -> energy_total');
    checkEqual(byName.get('MPPT 1 voltage')?.mapped_field, 'voltage_dc', 'heuristic: MPPT voltage -> voltage_dc');
    checkEqual(byName.get('MPPT 1 current')?.mapped_field, 'current_dc', 'heuristic: MPPT current -> current_dc');
    checkEqual(byName.get('Internal temperature')?.mapped_field, 'temp_inverter', 'heuristic: internal temp -> temp_inverter');
    check(result.registers.every(r => VALID_FIELD_TYPES.includes(r.mapped_field)),
      'heuristic output stays inside taxonomy');

    // Non-CSV input with LLM disabled must not extract (and must not call Bedrock)
    const none = await extractRegisterMap(SMA_DATASHEET_TEXT, { invokeImpl: throwingInvoke });
    checkEqual(none.method, 'none', 'non-CSV + LLM disabled -> method none');
    checkEqual(none.registers.length, 0, 'non-CSV + LLM disabled -> no registers');
  } finally {
    process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED = '1';
  }
}

async function testCsvLlmAssignment(): Promise<void> {
  section('CSV path with LLM batch assignment');

  const { invoke, calls } = buildMockInvoke([
    JSON.stringify({
      assignments: [
        { index: 0, mapped_field: 'power_ac', confidence: 0.99 }, // clamp ceiling
        { index: 1, mapped_field: 'performance_ratio', confidence: 0.9 }, // out-of-taxonomy
        { index: 2, mapped_field: 'voltage_dc', confidence: 0.1 }, // clamp floor
        // index 3 intentionally missing -> heuristic fallback
        { index: 4, mapped_field: 'temp_inverter', confidence: 0.8 },
        { index: 5, mapped_field: 'frequency', confidence: 0.85 },
        { index: 6, mapped_field: 'power_factor', confidence: 0.7 },
      ],
    }),
  ]);

  const result = await extractRegisterMap(SUNGROW_CSV, { vendorHint: 'sungrow', invokeImpl: invoke });

  checkEqual(result.method, 'csv+llm', 'method is csv+llm');
  checkEqual(calls.length, 1, 'single batched LLM call for the whole CSV');
  check(calls[0].opts?.jsonMode === true, 'assignment call uses jsonMode');
  check(String(calls[0].opts?.system).includes('CLOSED TAXONOMY'), 'assignment system prompt carries taxonomy');
  check(calls[0].prompt.includes('Active power'), 'batch prompt contains register names');
  check(calls[0].prompt.includes('Vendor hint: sungrow'), 'batch prompt carries vendor hint');

  const regs = result.registers;
  checkEqual(regs[0].mapped_field, 'power_ac', 'assignment applied');
  checkEqual(regs[0].confidence, 0.85, 'confidence 0.99 clamps to 0.85');
  checkEqual(regs[1].mapped_field, 'unmapped', 'out-of-taxonomy field rejected to unmapped');
  checkEqual(regs[2].confidence, 0.5, 'confidence 0.1 clamps to 0.5');
  checkEqual(regs[3].mapped_field, 'current_dc', 'skipped index falls back to heuristic (MPPT current)');
  checkEqual(regs[4].mapped_field, 'temp_inverter', 'later assignments applied');
}

async function testLlmFullExtraction(): Promise<void> {
  section('LLM full extraction (SMA-style datasheet text)');

  const { invoke, calls } = buildMockInvoke([
    JSON.stringify({
      vendor: 'SMA',
      model: 'Sunny Tripower CORE1',
      notes: 'Values are big-endian.',
      registers: [
        {
          address: 30775, name: 'P_AC', dataType: 'S32', unit: 'W', scale: 1,
          byteOrder: 'big-endian', mapped_field: 'power_ac', confidence: 0.95,
          source_excerpt: '30775 P_AC Active power of all phases',
        },
        { address: '0x7863', name: 'HexReg', dataType: 'int32', mapped_field: 'voltage_dc', confidence: 0.7 },
        { address: -5, name: 'Bogus', dataType: 'int32', mapped_field: 'power_dc', confidence: 0.9 },
        { address: 30529, name: 'E_Total', dataType: 'FOO', unit: 'Wh', mapped_field: 'totally_made_up', confidence: 0.9 },
        { address: 30953, name: 'Temp_Inv', dataType: 's32', unit: '°C', scale: 0.1, mapped_field: 'temp_inverter', confidence: 0.2 },
      ],
    }),
  ]);

  const result = await extractRegisterMap(SMA_DATASHEET_TEXT, { vendorHint: 'sma', invokeImpl: invoke });

  checkEqual(result.method, 'llm', 'method is llm');
  checkEqual(calls.length, 1, 'one extraction call');
  check(String(calls[0].opts?.system).includes('CLOSED TAXONOMY'), 'extraction system prompt carries taxonomy');
  check(String(calls[0].opts?.system).includes('bess_soc'), 'taxonomy includes BESS members');
  check(calls[0].prompt.includes('30775'), 'source text reaches the prompt');
  check(calls[0].opts?.jsonMode === true, 'extraction call uses jsonMode');

  checkEqual(result.registers.length, 4, 'negative-address row rejected, others kept');
  checkEqual(result.vendor, 'SMA', 'vendor passthrough');
  checkEqual(result.model, 'Sunny Tripower CORE1', 'model passthrough');
  check(String(result.notes).includes('1 row(s) rejected'), 'rejection surfaced in notes');

  const byName = new Map(result.registers.map(r => [r.name, r]));
  checkEqual(byName.get('P_AC')?.dataType, 'int32', 'S32 alias normalized to int32');
  checkEqual(byName.get('P_AC')?.confidence, 0.85, 'confidence 0.95 clamps to 0.85');
  checkEqual(byName.get('HexReg')?.address, 0x7863, 'hex string address parsed');
  checkEqual(byName.get('E_Total')?.dataType, 'uint16', 'unknown dataType falls back to uint16');
  checkEqual(byName.get('E_Total')?.mapped_field, 'unmapped', 'out-of-taxonomy mapped_field rejected to unmapped');
  checkEqual(byName.get('Temp_Inv')?.confidence, 0.5, 'confidence 0.2 clamps to 0.5');
  check(!byName.has('Bogus'), 'address -5 row dropped');
}

async function testPrefilter(): Promise<void> {
  section('long-source prefilter');

  const noiseLine = 'This paragraph describes installation and wiring guidance without numeric content.';
  const tableA = [
    '30775 P_AC Active power S32 W',
    '30529 E_Total Total yield U32 Wh',
    '30771 V_DC DC voltage S32 V',
    '30769 I_DC DC current S32 A',
    '30953 Temp Internal temperature S32 °C',
  ];
  const tableB = [
    '40083 W AC power int16 W',
    '40093 WH Total energy acc32 Wh',
    '40100 DCW DC power int16 W',
    '40254 MPPT module float32 V',
    '40270 Evt1 Event bitfield32 -',
  ];
  const text = [
    ...Array(200).fill(noiseLine),
    ...tableA,
    ...Array(200).fill(noiseLine),
    ...tableB,
    ...Array(200).fill(noiseLine),
  ].join('\n');

  const filtered = prefilterRegisterText(text, 4000);
  check(filtered.length <= 4000, 'prefiltered text respects the char cap');
  check(filtered.includes('30775'), 'register table A survives prefilter');
  check(filtered.includes('40083'), 'register table B survives prefilter');
  const noiseCount = filtered.split('\n').filter(l => l === noiseLine).length;
  check(noiseCount <= 20, `noise lines mostly removed (kept ${noiseCount})`);
  check(filtered.includes('...'), 'non-contiguous regions marked with ellipsis');

  const short = 'tiny text';
  checkEqual(prefilterRegisterText(short, 4000), short, 'short text passes through untouched');
}

async function testPersistencePlan(): Promise<void> {
  section('route persistence payload (FieldMapping contract)');

  const regs: ExtractedRegister[] = [
    { address: 30775, name: 'P_AC', dataType: 'int32', unit: 'W', scale: 1, mapped_field: 'power_ac', confidence: 0.85 },
    { address: 30776, name: 'P_AC', dataType: 'int32', mapped_field: 'power_ac', confidence: 0.84 },
    { address: 30953, name: 'Internal temp', dataType: 'int32', scale: 0.1, mapped_field: 'temp_inverter', confidence: 0.7 },
    { address: 31000, name: 'Mystery', dataType: 'uint16', mapped_field: 'unmapped', confidence: 0.5 },
  ];

  const rows = buildRegisterPersistenceRows(regs);
  checkEqual(rows.length, 4, 'one plan row per register');

  checkEqual(rows[0].original_field, 'modbus.P_AC', 'original_field scoped as modbus.<name>');
  checkEqual(rows[1].original_field, 'modbus.P_AC@30776', 'name collision deduped with @address');
  checkEqual(rows[2].original_field, 'modbus.Internal_temp', 'whitespace in names normalized');
  checkEqual(registerOriginalField('  My  Reg '), 'modbus.My_Reg', 'registerOriginalField trims and joins');

  checkEqual(rows[0].field_path, '30775', 'field_path carries the register address');
  checkEqual(rows[0].is_confirmed, true, 'auto-confirm at confidence >= 0.85');
  checkEqual(rows[1].is_confirmed, false, 'confidence 0.84 stays unconfirmed');
  checkEqual(rows[0].scaling_factor, 1, 'explicit scale preserved');
  checkEqual(rows[1].scaling_factor, 1, 'missing scale defaults to 1.0');
  checkEqual(rows[2].scaling_factor, 0.1, 'fractional scale preserved');
  checkEqual(rows[3].persisted, false, 'unmapped rows excluded from persistence');
  checkEqual(rows[3].is_confirmed, false, 'unmapped rows never auto-confirm');
  check(rows.filter(r => r.persisted).every(r => VALID_FIELD_TYPES.includes(r.mapped_field) && r.mapped_field !== 'unmapped'),
    'persisted rows carry valid DataFieldType members');

  // Contract shape: exactly the FieldMapping-facing keys the route consumes
  checkEqual(
    Object.keys(rows[0]).sort(),
    ['confidence_score', 'field_path', 'is_confirmed', 'mapped_field', 'original_field', 'persisted', 'scaling_factor', 'unit'],
    'plan row shape matches the FieldMapping contract'
  );
}

async function testValidationHelpers(): Promise<void> {
  section('validation helpers');

  checkEqual(clampLlmConfidence(0.99), 0.85, 'clamp ceiling 0.85');
  checkEqual(clampLlmConfidence(0.0), 0.5, 'clamp floor 0.5');
  checkEqual(clampLlmConfidence(0.7), 0.7, 'in-range value untouched');
  checkEqual(clampLlmConfidence('nonsense'), 0.65, 'non-numeric defaults to 0.65');

  checkEqual(normalizeDataType('U16'), 'uint16', 'U16 alias');
  checkEqual(normalizeDataType('float'), 'float32', 'float alias');
  checkEqual(normalizeDataType('DOUBLE'), 'float64', 'double alias');
  checkEqual(normalizeDataType('int32'), 'int32', 'whitelist passthrough');
  checkEqual(normalizeDataType('???'), 'uint16', 'unknown falls back to uint16');
  checkEqual(normalizeDataType(undefined), 'uint16', 'missing falls back to uint16');

  checkEqual(
    validateExtractedRegister({ address: 0, name: 'Reg0', dataType: 'uint16', mapped_field: 'power_ac', confidence: 0.8 })?.address,
    0,
    'address 0 is valid'
  );
  checkEqual(validateExtractedRegister({ address: 1.5, name: 'X', mapped_field: 'power_ac', confidence: 0.8 }), null,
    'non-integer address rejected');
  checkEqual(validateExtractedRegister({ address: 10, name: '   ', mapped_field: 'power_ac', confidence: 0.8 }), null,
    'empty name rejected');
}

// ---------------------------------------------------------------------------
// Optional --live benchmark against MODBUS_PRESETS ground truth
// ---------------------------------------------------------------------------

/**
 * Ground truth derived from the ConnectionWizard MODBUS_PRESETS display
 * strings (SMA P_AC @30775, Huawei SUN2000 @32080, Sungrow @5031, GoodWe
 * @35105, ...). Kept local so the script doesn't import the 'use client'
 * wizard component.
 */
const LIVE_GROUND_TRUTH: Array<{
  vendor: string;
  text: string;
  expected: Array<{ address: number; mapped_field: string }>;
}> = [
  {
    vendor: 'sma',
    text: [
      'SMA Sunny Tripower / Core Modbus profile (32-bit big-endian).',
      'Register 30775: P_AC — AC active power, all phases, S32, W',
      'Register 30529: E_Total — total yield, U32, Wh',
      'Register 30771: V_DC — DC voltage input A, S32, V, gain 0.01',
      'Register 30769: I_DC — DC current input A, S32, A, gain 0.001',
      'Register 30953: Temp — internal (inverter) temperature, S32, °C, gain 0.1',
    ].join('\n'),
    expected: [
      { address: 30775, mapped_field: 'power_ac' },
      { address: 30529, mapped_field: 'energy_total' },
      { address: 30771, mapped_field: 'voltage_dc' },
      { address: 30769, mapped_field: 'current_dc' },
      { address: 30953, mapped_field: 'temp_inverter' },
    ],
  },
  {
    vendor: 'huawei',
    text: [
      'Huawei SUN2000 string inverter Modbus register map (via SDongle / SmartLogger).',
      'Register 32080: Active power, I32, kW, gain 0.001',
      'Register 32106: Accumulated energy yield, U32, kWh, gain 0.01',
      'Register 32087: Internal temperature, I16, °C, gain 0.1',
    ].join('\n'),
    expected: [
      { address: 32080, mapped_field: 'power_ac' },
      { address: 32106, mapped_field: 'energy_total' },
      { address: 32087, mapped_field: 'temp_inverter' },
    ],
  },
  {
    vendor: 'sungrow',
    text: [
      'Sungrow SG series string inverter map (read input registers, function code 04).',
      'Register 5031: Total active power, U32, W',
      'Register 5004: Total energy yield, U32, kWh',
      'Register 5011: MPPT 1 voltage, U16, V, gain 0.1',
      'Register 5008: Internal air temperature, S16, °C, gain 0.1',
    ].join('\n'),
    expected: [
      { address: 5031, mapped_field: 'power_ac' },
      { address: 5004, mapped_field: 'energy_total' },
      { address: 5011, mapped_field: 'voltage_dc' },
      { address: 5008, mapped_field: 'temp_inverter' },
    ],
  },
  {
    vendor: 'goodwe',
    text: [
      'GoodWe ET/MT series Modbus map (Ezlogger, default unit id 247).',
      'Register 35105: Total inverter power (AC active power), U32, W',
      'Register 35191: Total energy generated, U32, kWh, gain 0.1',
      'Register 35103: PV DC voltage, U16, V, gain 0.1',
      'Register 35174: Inverter internal temperature, S16, °C, gain 0.1',
    ].join('\n'),
    expected: [
      { address: 35105, mapped_field: 'power_ac' },
      { address: 35191, mapped_field: 'energy_total' },
      { address: 35103, mapped_field: 'voltage_dc' },
      { address: 35174, mapped_field: 'temp_inverter' },
    ],
  },
];

async function runLiveBenchmark(): Promise<void> {
  section('LIVE Bedrock benchmark vs MODBUS_PRESETS ground truth');
  process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED = '1';

  let totalExpected = 0;
  let totalCorrect = 0;

  for (const fixture of LIVE_GROUND_TRUTH) {
    try {
      const result = await extractRegisterMap(fixture.text, { vendorHint: fixture.vendor });
      const byAddress = new Map(result.registers.map(r => [r.address, r]));
      let correct = 0;
      for (const exp of fixture.expected) {
        totalExpected += 1;
        const got = byAddress.get(exp.address);
        if (got && got.mapped_field === exp.mapped_field) {
          correct += 1;
          totalCorrect += 1;
        } else {
          console.log(
            `    [${fixture.vendor}] @${exp.address}: expected ${exp.mapped_field}, ` +
            `got ${got ? got.mapped_field : 'MISSING'}`
          );
        }
      }
      console.log(`  ${fixture.vendor}: ${correct}/${fixture.expected.length} registers correct (method=${result.method})`);
    } catch (err) {
      totalExpected += fixture.expected.length;
      console.error(`  ${fixture.vendor}: extraction failed —`, err);
    }
  }

  const accuracy = totalExpected > 0 ? totalCorrect / totalExpected : 0;
  console.log(`  Live accuracy: ${totalCorrect}/${totalExpected} = ${(accuracy * 100).toFixed(1)}%`);
  check(accuracy >= 0.8, `live extraction accuracy >= 80% (got ${(accuracy * 100).toFixed(1)}%)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const originalEnv = process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED;
  process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED = '1';

  try {
    await testCsvParsing();
    await testHeuristicPathWithLlmDisabled();
    await testCsvLlmAssignment();
    await testLlmFullExtraction();
    await testPrefilter();
    await testPersistencePlan();
    await testValidationHelpers();

    if (process.argv.includes('--live')) {
      await runLiveBenchmark();
    } else {
      console.log('\n(skipping live Bedrock benchmark — pass --live to run it)');
    }
  } finally {
    if (originalEnv === undefined) delete process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED;
    else process.env.NURAVOLT_LLM_FIELD_MAPPING_ENABLED = originalEnv;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
