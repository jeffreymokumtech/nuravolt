interface Props {
  /** [fMin, fMax] in Hz. */
  range: [number, number];
  /** Nominal frequency, defaults to 50 Hz. */
  nominal?: number;
  width?: number;
}

/**
 * Horizontal bar showing the frequency window the plant must stay connected in,
 * centred on the nominal frequency (50 Hz by default; 60 Hz for SA/KSA).
 */
export default function FrequencyRangeBar({ range, nominal = 50, width = 520 }: Props) {
  const [fMin, fMax] = range;
  const span = fMax - fMin;
  // Display window extends 20% beyond on each side so the bar has context.
  const padding = Math.max(span * 0.2, 0.5);
  const lo = fMin - padding;
  const hi = fMax + padding;
  const scale = (f: number) => ((f - lo) / (hi - lo)) * width;

  const xMin = scale(fMin);
  const xMax = scale(fMax);
  const xNom = scale(nominal);

  return (
    <figure className="compliance-viz">
      <svg
        width={width}
        height={70}
        role="img"
        aria-label={`Frequency operating range: ${fMin},${fMax} Hz`}
        style={{ maxWidth: '100%', height: 'auto' }}
      >
        {/* Backing bar (outside window = disconnect allowed) */}
        <rect x={0} y={25} width={width} height={16} fill="#fee2e2" />
        {/* Operating window */}
        <rect x={xMin} y={25} width={xMax - xMin} height={16} fill="#bbf7d0" />
        {/* Tick marks */}
        <line x1={xMin} x2={xMin} y1={22} y2={44} stroke="#15803d" strokeWidth="2" />
        <line x1={xMax} x2={xMax} y1={22} y2={44} stroke="#15803d" strokeWidth="2" />
        <line x1={xNom} x2={xNom} y1={20} y2={46} stroke="#1e40af" strokeWidth="2" strokeDasharray="3 3" />

        {/* Labels */}
        <text x={xMin} y={18} fontSize="11" fill="#14532d" textAnchor="middle" fontWeight="600">
          {fMin} Hz
        </text>
        <text x={xMax} y={18} fontSize="11" fill="#14532d" textAnchor="middle" fontWeight="600">
          {fMax} Hz
        </text>
        <text x={xNom} y={60} fontSize="10" fill="#1e3a8a" textAnchor="middle">
          nominal {nominal} Hz
        </text>
      </svg>
      <figcaption className="text-xs text-gray-500 mt-1">
        Green = must stay connected. Red = disconnection permitted by protection settings.
      </figcaption>
    </figure>
  );
}
