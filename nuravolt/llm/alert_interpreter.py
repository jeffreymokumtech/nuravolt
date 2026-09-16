"""
Alert Interpreter Service

Translates ML anomaly outputs into human-readable explanations for operators.

Takes:
- Anomaly score and confidence from ML models
- SHAP feature attributions
- Historical similar events (optional)
- Component context (ID, type, location)

Produces:
- Plain language summary
- Likely root cause hypothesis
- Recommended action with urgency
- References to similar past events

Features:
- JSON output parsing with validation
- Rule-based fallback when LLM unavailable
- Caching based on SHAP value hash
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any
import json
import hashlib
import logging

from nuravolt.llm.client import LLMClient, LLMResponse

logger = logging.getLogger(__name__)


@dataclass
class InterpretedAlert:
    """Human-readable alert interpretation."""
    summary: str                    # One-line summary
    explanation: str                # Detailed explanation (2-3 sentences)
    likely_cause: str               # Root cause hypothesis
    recommended_action: str         # What to do
    urgency: str                    # "immediate", "24h", "7d", "monitor"
    confidence: str                 # "high", "medium", "low"
    similar_past_events: List[str] = field(default_factory=list)

    # LLM metadata
    llm_model: str = ""
    llm_cost_usd: float = 0.0
    llm_latency_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0

    # Fallback indicator
    used_fallback: bool = False

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary for JSON serialization."""
        return {
            'summary': self.summary,
            'explanation': self.explanation,
            'likelyCause': self.likely_cause,
            'recommendedAction': self.recommended_action,
            'urgency': self.urgency,
            'confidence': self.confidence,
            'similarEvents': self.similar_past_events,
            'llmModel': self.llm_model,
            'llmCostUsd': round(self.llm_cost_usd, 6),
            'llmLatencyMs': round(self.llm_latency_ms, 0),
            'usedFallback': self.used_fallback,
        }


@dataclass
class AnomalyContext:
    """Context about an anomaly for interpretation."""
    anomaly_score: float              # 0-1
    is_anomaly: bool
    severity: str                     # "info", "warning", "critical"
    confidence: float = 0.0           # Model confidence 0-1

    # Component info
    component_id: str = ""
    component_type: str = ""          # "inverter", "string", "battery_cell", "gearbox"
    component_location: str = ""

    # Feature attributions (SHAP values)
    feature_contributions: Dict[str, float] = field(default_factory=dict)

    # Temporal context
    consecutive_anomalies: int = 0
    trend_direction: str = "stable"   # "improving", "stable", "worsening"

    # Values
    expected_value: Optional[float] = None
    actual_value: Optional[float] = None
    deviation_percent: Optional[float] = None

    # Existing interpretation (for fallback)
    existing_interpretation: str = ""
    existing_possible_causes: List[str] = field(default_factory=list)


@dataclass
class HistoricalMatch:
    """A similar past event."""
    event_id: str
    timestamp: str
    similarity_score: float
    resolution: str
    root_cause: str
    time_to_resolution: str


class AlertInterpreter:
    """
    Interpret ML anomaly outputs for plant operators.

    Example:
        interpreter = AlertInterpreter(llm_client)

        context = AnomalyContext(
            anomaly_score=0.87,
            is_anomaly=True,
            severity="warning",
            component_id="INV-103",
            component_type="inverter",
            feature_contributions={
                'dc_voltage_deviation': 0.34,
                'temperature_residual': 0.28,
            }
        )

        interpreted = interpreter.interpret(context)
        print(interpreted.summary)
        # "INV-103 DC voltage anomaly: running 6.5% below expected"
    """

    SYSTEM_PROMPT = '''You are an expert solar/wind/battery plant operations assistant.
Your job is to translate technical anomaly detection outputs into clear, actionable insights for plant operators.

Guidelines:
1. Be CONCISE - operators are busy, get to the point
2. Be SPECIFIC - use actual numbers and component IDs
3. Be ACTIONABLE - always include next steps with timeframe
4. Be HONEST about uncertainty - if confidence is low, say so
5. Reference similar past events when available - operators trust experience

You must respond in this exact JSON format:
{
    "summary": "One sentence summary of the issue",
    "explanation": "2-3 sentences explaining why the ML flagged this",
    "likely_cause": "Most probable root cause based on the evidence",
    "recommended_action": "Specific steps with timeframe"
}'''

    def __init__(
        self,
        llm_client: LLMClient,
        enable_cache: bool = True,
        cache_ttl_hours: int = 24,
    ):
        """
        Initialize alert interpreter.

        Args:
            llm_client: LLM client for generating interpretations
            enable_cache: Whether to cache interpretations
            cache_ttl_hours: Cache time-to-live in hours
        """
        self.llm = llm_client
        self.enable_cache = enable_cache
        self.cache_ttl_hours = cache_ttl_hours
        self._cache: Dict[str, InterpretedAlert] = {}

    def interpret(
        self,
        context: AnomalyContext,
        historical_matches: Optional[List[HistoricalMatch]] = None,
        use_fallback_on_error: bool = True,
    ) -> InterpretedAlert:
        """
        Generate human-readable interpretation of anomaly.

        Args:
            context: Anomaly context with scores and attributions
            historical_matches: Similar past events
            use_fallback_on_error: Use rule-based fallback if LLM fails

        Returns:
            InterpretedAlert with summary, explanation, and recommended action
        """
        # Check cache
        if self.enable_cache:
            cache_key = self._compute_cache_key(context)
            if cache_key in self._cache:
                logger.debug(f"Cache hit for {cache_key[:8]}")
                return self._cache[cache_key]

        # Try LLM interpretation
        try:
            result = self._llm_interpret(context, historical_matches)

            # Cache result
            if self.enable_cache:
                self._cache[cache_key] = result

            return result

        except Exception as e:
            logger.warning(f"LLM interpretation failed: {e}")
            if use_fallback_on_error:
                return self._fallback_interpret(context, historical_matches)
            raise

    def _llm_interpret(
        self,
        context: AnomalyContext,
        historical_matches: Optional[List[HistoricalMatch]],
    ) -> InterpretedAlert:
        """Generate interpretation using LLM."""
        # Build prompt
        user_prompt = self._build_prompt(context, historical_matches)

        messages = [
            {"role": "system", "content": self.SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ]

        response = self.llm.complete(messages, temperature=0.1, max_tokens=500)

        # Parse response
        parsed = self._parse_response(response.content)

        return InterpretedAlert(
            summary=parsed.get("summary", "Anomaly detected"),
            explanation=parsed.get("explanation", ""),
            likely_cause=parsed.get("likely_cause", "Unknown"),
            recommended_action=parsed.get("recommended_action", "Investigate"),
            urgency=self._determine_urgency(context),
            confidence=self._map_confidence(context.confidence),
            similar_past_events=[m.event_id for m in (historical_matches or [])[:3]],
            llm_model=response.model,
            llm_cost_usd=response.cost_usd,
            llm_latency_ms=response.latency_ms,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            used_fallback=False,
        )

    def _fallback_interpret(
        self,
        context: AnomalyContext,
        historical_matches: Optional[List[HistoricalMatch]],
    ) -> InterpretedAlert:
        """
        Rule-based fallback when LLM is unavailable.

        Uses existing interpretation fields from CompoundFaultResult
        and generates simple rule-based explanations.
        """
        # Use existing interpretation if available
        if context.existing_interpretation:
            summary = context.existing_interpretation
        else:
            summary = f"{context.component_type.title()} {context.component_id} anomaly detected"

        # Build explanation from feature contributions
        if context.feature_contributions:
            top_features = sorted(
                context.feature_contributions.items(),
                key=lambda x: abs(x[1]),
                reverse=True
            )[:3]
            feature_text = ", ".join([f"{f} ({v:+.2f})" for f, v in top_features])
            explanation = f"Primary contributing factors: {feature_text}."
        else:
            explanation = f"Anomaly score: {context.anomaly_score:.2f}"

        # Add deviation info if available
        if context.expected_value is not None and context.actual_value is not None:
            deviation = ((context.actual_value - context.expected_value) /
                        context.expected_value * 100) if context.expected_value else 0
            explanation += f" Expected: {context.expected_value:.1f}, Actual: {context.actual_value:.1f} ({deviation:+.1f}%)."

        # Likely cause from existing or rule-based
        if context.existing_possible_causes:
            likely_cause = context.existing_possible_causes[0]
        else:
            likely_cause = self._infer_cause_from_features(context.feature_contributions)

        # Recommended action based on severity
        urgency = self._determine_urgency(context)
        if urgency == "immediate":
            recommended_action = f"IMMEDIATE: Investigate {context.component_id}. Check {likely_cause}."
        elif urgency == "24h":
            recommended_action = f"Schedule inspection of {context.component_id} within 24 hours."
        elif urgency == "7d":
            recommended_action = f"Plan maintenance for {context.component_id} within 7 days."
        else:
            recommended_action = f"Monitor {context.component_id}. Review if trend continues."

        return InterpretedAlert(
            summary=summary,
            explanation=explanation,
            likely_cause=likely_cause,
            recommended_action=recommended_action,
            urgency=urgency,
            confidence=self._map_confidence(context.confidence),
            similar_past_events=[m.event_id for m in (historical_matches or [])[:3]],
            used_fallback=True,
        )

    def _build_prompt(
        self,
        context: AnomalyContext,
        history: Optional[List[HistoricalMatch]],
    ) -> str:
        """Build the user prompt with all context."""
        prompt = f'''Analyze this anomaly detection output:

## Component Information
- ID: {context.component_id}
- Type: {context.component_type}
- Location: {context.component_location or "Not specified"}

## Anomaly Detection Output
- Anomaly Score: {context.anomaly_score:.3f}
- Model Confidence: {context.confidence:.1%}
- Severity: {context.severity}
- Consecutive Anomalies: {context.consecutive_anomalies}
- Trend: {context.trend_direction}
'''

        if context.expected_value is not None and context.actual_value is not None:
            deviation = ((context.actual_value - context.expected_value) /
                        context.expected_value * 100) if context.expected_value else 0
            prompt += f'''
## Current Values
- Expected: {context.expected_value:.2f}
- Actual: {context.actual_value:.2f}
- Deviation: {deviation:+.1f}%
'''

        if context.feature_contributions:
            prompt += "\n## Feature Contributions (what drove this detection)\n"
            sorted_features = sorted(
                context.feature_contributions.items(),
                key=lambda x: abs(x[1]),
                reverse=True
            )
            for feature, value in sorted_features[:5]:
                direction = "+" if value > 0 else ""
                prompt += f"- {feature}: {direction}{value:.3f}\n"

        if history:
            prompt += "\n## Similar Historical Events\n"
            for match in history[:3]:
                prompt += f'''- {match.event_id} ({match.timestamp})
  - Similarity: {match.similarity_score:.1%}
  - Root Cause: {match.root_cause}
  - Resolution: {match.resolution}
  - Time to Resolve: {match.time_to_resolution}
'''

        prompt += "\nProvide your analysis in the JSON format specified."
        return prompt

    def _parse_response(self, content: str) -> Dict[str, str]:
        """Parse JSON response from LLM."""
        try:
            # Look for JSON block
            if "```json" in content:
                json_str = content.split("```json")[1].split("```")[0]
            elif "```" in content:
                json_str = content.split("```")[1].split("```")[0]
            elif "{" in content:
                start = content.index("{")
                end = content.rindex("}") + 1
                json_str = content[start:end]
            else:
                json_str = content

            return json.loads(json_str)

        except (json.JSONDecodeError, ValueError, IndexError) as e:
            logger.warning(f"Could not parse LLM response as JSON: {e}")
            return {
                "summary": content[:200] if content else "Anomaly detected",
                "explanation": content if content else "",
                "likely_cause": "See explanation",
                "recommended_action": "Review anomaly details"
            }

    def _determine_urgency(self, context: AnomalyContext) -> str:
        """Determine urgency based on severity and trend."""
        if context.severity == "critical":
            return "immediate"
        elif context.severity == "warning":
            if context.trend_direction == "worsening" or context.consecutive_anomalies >= 3:
                return "24h"
            return "7d"
        return "monitor"

    def _map_confidence(self, confidence: float) -> str:
        """Map numeric confidence to categorical."""
        if confidence > 0.8:
            return "high"
        elif confidence > 0.5:
            return "medium"
        return "low"

    def _infer_cause_from_features(
        self,
        contributions: Dict[str, float]
    ) -> str:
        """Infer likely cause from feature contributions."""
        if not contributions:
            return "Unknown - requires investigation"

        # Simple rule-based inference
        cause_mapping = {
            'dc_voltage': 'DC cable or connector issue',
            'temperature': 'Thermal stress or cooling problem',
            'efficiency': 'Inverter degradation or fault',
            'current': 'String mismatch or bypass diode failure',
            'power': 'Performance deviation from expected',
            'irradiance': 'Sensor calibration or shading',
            'soiling': 'Module soiling accumulation',
            'residual': 'Model prediction deviation',
        }

        top_feature = max(contributions.items(), key=lambda x: abs(x[1]))[0].lower()

        for keyword, cause in cause_mapping.items():
            if keyword in top_feature:
                return cause

        return f"Related to {top_feature}"

    def _compute_cache_key(self, context: AnomalyContext) -> str:
        """Compute cache key from context."""
        # Hash based on component, severity, and top features
        key_parts = [
            context.component_id,
            context.severity,
            str(round(context.anomaly_score, 2)),
        ]

        if context.feature_contributions:
            sorted_features = sorted(context.feature_contributions.items())
            key_parts.append(str([(k, round(v, 2)) for k, v in sorted_features[:5]]))

        key_string = "|".join(key_parts)
        return hashlib.md5(key_string.encode()).hexdigest()

    def clear_cache(self):
        """Clear the interpretation cache."""
        self._cache.clear()
