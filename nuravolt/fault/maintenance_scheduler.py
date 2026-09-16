"""Fleet-level maintenance schedule optimizer.

Optimizes maintenance scheduling across multiple plants by:
- Prioritizing by RUL urgency and economic impact
- Respecting resource constraints (crew, equipment, travel)
- Maximizing ROI (revenue saved vs maintenance cost)
"""

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Dict, List, Optional, Tuple
import json

import polars as pl

from .scheduler_config import (
    SchedulerConfig,
    get_repair_cost,
    get_repair_hours,
    get_fault_severity,
    calculate_revenue_at_risk,
    calculate_priority_score,
    REPAIR_COSTS,
    REPAIR_HOURS,
)
from .rul_predictor import RULPredictor, MaintenanceAction


@dataclass
class PlantInfo:
    """Plant information for scheduling."""

    plant_id: str
    capacity_mw: float
    location: Optional[Tuple[float, float]] = None  # (lat, lon)
    priority_tier: str = "tier_2"
    electricity_rate: float = 80.0  # EUR/MWh


@dataclass
class MaintenanceTask:
    """A maintenance task to be scheduled."""

    plant_id: str
    inverter_id: Optional[str]
    fault_type: str
    days_to_fault: float
    confidence: float
    estimated_repair_hours: float
    repair_cost_eur: float
    revenue_at_risk_eur: float
    priority_score: float
    urgency: str  # urgent, soon, planned, monitoring
    recommended_action: str

    def __lt__(self, other):
        """Sort by priority score (descending)."""
        return self.priority_score > other.priority_score


@dataclass
class ScheduledMaintenance:
    """A scheduled maintenance task with date assignment."""

    task: MaintenanceTask
    scheduled_date: date
    assigned_crew: str = "crew_1"
    travel_time_hours: float = 1.0

    @property
    def total_hours(self) -> float:
        """Total time including travel."""
        return self.task.estimated_repair_hours + self.travel_time_hours


@dataclass
class ScheduleMetrics:
    """Metrics for the optimized schedule."""

    total_tasks: int
    scheduled_tasks: int
    deferred_tasks: int
    total_repair_cost_eur: float
    total_revenue_saved_eur: float
    net_benefit_eur: float
    roi_pct: float
    crew_utilization_pct: float
    avg_days_to_schedule: float

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "total_tasks": self.total_tasks,
            "scheduled_tasks": self.scheduled_tasks,
            "deferred_tasks": self.deferred_tasks,
            "total_repair_cost_eur": round(self.total_repair_cost_eur, 2),
            "total_revenue_saved_eur": round(self.total_revenue_saved_eur, 2),
            "net_benefit_eur": round(self.net_benefit_eur, 2),
            "roi_pct": round(self.roi_pct, 1),
            "crew_utilization_pct": round(self.crew_utilization_pct, 1),
            "avg_days_to_schedule": round(self.avg_days_to_schedule, 1),
        }


@dataclass
class ScheduleResult:
    """Result of schedule optimization."""

    scheduled: List[ScheduledMaintenance]
    deferred: List[MaintenanceTask]
    metrics: ScheduleMetrics
    daily_schedule: Dict[date, List[ScheduledMaintenance]]
    plant_schedule: Dict[str, List[ScheduledMaintenance]]

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "scheduled": [
                {
                    "date": str(s.scheduled_date),
                    "plant_id": s.task.plant_id,
                    "fault_type": s.task.fault_type,
                    "priority_score": round(s.task.priority_score, 1),
                    "repair_hours": s.task.estimated_repair_hours,
                    "repair_cost_eur": round(s.task.repair_cost_eur, 2),
                    "revenue_at_risk_eur": round(s.task.revenue_at_risk_eur, 2),
                    "recommended_action": s.task.recommended_action,
                }
                for s in self.scheduled
            ],
            "deferred": [
                {
                    "plant_id": t.plant_id,
                    "fault_type": t.fault_type,
                    "days_to_fault": round(t.days_to_fault, 1),
                    "priority_score": round(t.priority_score, 1),
                }
                for t in self.deferred
            ],
            "metrics": self.metrics.to_dict(),
            "daily_schedule": {
                str(d): [
                    {"plant_id": s.task.plant_id, "fault_type": s.task.fault_type}
                    for s in tasks
                ]
                for d, tasks in self.daily_schedule.items()
            },
        }

    def to_json(self, path: Optional[str] = None) -> str:
        """Export to JSON."""
        json_str = json.dumps(self.to_dict(), indent=2)
        if path:
            with open(path, "w") as f:
                f.write(json_str)
        return json_str

    def to_markdown(self) -> str:
        """Generate markdown report."""
        lines = [
            "# Maintenance Schedule Report",
            "",
            f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
            "",
            "## Summary Metrics",
            "",
            "| Metric | Value |",
            "|--------|-------|",
            f"| Total Tasks | {self.metrics.total_tasks} |",
            f"| Scheduled | {self.metrics.scheduled_tasks} |",
            f"| Deferred | {self.metrics.deferred_tasks} |",
            f"| Total Repair Cost | €{self.metrics.total_repair_cost_eur:,.0f} |",
            f"| Revenue Saved | €{self.metrics.total_revenue_saved_eur:,.0f} |",
            f"| Net Benefit | €{self.metrics.net_benefit_eur:,.0f} |",
            f"| ROI | {self.metrics.roi_pct:.0f}% |",
            f"| Crew Utilization | {self.metrics.crew_utilization_pct:.0f}% |",
            "",
            "## Daily Schedule",
            "",
        ]

        for day in sorted(self.daily_schedule.keys()):
            tasks = self.daily_schedule[day]
            lines.append(f"### {day.strftime('%Y-%m-%d (%A)')}")
            lines.append("")
            for s in tasks:
                lines.append(
                    f"- **{s.task.plant_id}**: {s.task.fault_type} "
                    f"(priority: {s.task.priority_score:.0f}, {s.task.estimated_repair_hours}h)"
                )
            lines.append("")

        if self.deferred:
            lines.extend(
                [
                    "## Deferred Tasks",
                    "",
                    "| Plant | Fault Type | Days to Fault | Priority |",
                    "|-------|-----------|---------------|----------|",
                ]
            )
            for t in self.deferred[:10]:  # Top 10
                lines.append(
                    f"| {t.plant_id} | {t.fault_type} | {t.days_to_fault:.1f} | {t.priority_score:.0f} |"
                )
            lines.append("")

        return "\n".join(lines)


class MaintenanceScheduleOptimizer:
    """Fleet-level maintenance schedule optimizer."""

    def __init__(
        self,
        config: Optional[SchedulerConfig] = None,
        model_dir: str = "models/rul",
    ):
        """
        Initialize the scheduler.

        Args:
            config: Scheduler configuration
            model_dir: Directory containing RUL models
        """
        self.config = config or SchedulerConfig()
        self.model_dir = model_dir
        self._rul_predictor: Optional[RULPredictor] = None

    @property
    def rul_predictor(self) -> RULPredictor:
        """Lazy-load RUL predictor."""
        if self._rul_predictor is None:
            self._rul_predictor = RULPredictor(self.model_dir)
        return self._rul_predictor

    def collect_tasks(
        self,
        plants: Dict[str, PlantInfo],
        rul_results: Dict[str, Dict[str, List]],
    ) -> List[MaintenanceTask]:
        """
        Collect and convert RUL predictions to maintenance tasks.

        Args:
            plants: Plant info keyed by plant_id
            rul_results: RUL predictions per plant per fault type
                         {plant_id: {fault_type: [RULPrediction, ...]}}

        Returns:
            List of MaintenanceTask objects
        """
        tasks = []

        for plant_id, fault_preds in rul_results.items():
            plant_info = plants.get(plant_id)
            if not plant_info:
                continue

            for fault_type, predictions in fault_preds.items():
                if not predictions:
                    continue

                # Aggregate predictions (use worst case)
                min_rul = min(p.days_to_fault for p in predictions)
                avg_confidence = sum(p.confidence for p in predictions) / len(
                    predictions
                )

                # Skip if monitoring only (> 30 days)
                if min_rul > self.config.planned_threshold_days:
                    continue

                # Determine urgency
                if min_rul < self.config.urgent_threshold_days:
                    urgency = "urgent"
                elif min_rul < self.config.soon_threshold_days:
                    urgency = "soon"
                else:
                    urgency = "planned"

                # Calculate costs and priority
                repair_cost = get_repair_cost(fault_type)
                repair_hours = get_repair_hours(fault_type)
                revenue_at_risk = calculate_revenue_at_risk(
                    fault_type,
                    min_rul,
                    plant_info.capacity_mw,
                    plant_info.electricity_rate,
                )
                priority_score = calculate_priority_score(
                    min_rul,
                    revenue_at_risk,
                    repair_cost,
                    get_fault_severity(fault_type),
                    self.config,
                )

                # Get recommended action
                recommended_action = self._get_recommended_action(fault_type, urgency)

                task = MaintenanceTask(
                    plant_id=plant_id,
                    inverter_id=None,  # Plant-level for now
                    fault_type=fault_type,
                    days_to_fault=min_rul,
                    confidence=avg_confidence,
                    estimated_repair_hours=repair_hours,
                    repair_cost_eur=repair_cost,
                    revenue_at_risk_eur=revenue_at_risk,
                    priority_score=priority_score,
                    urgency=urgency,
                    recommended_action=recommended_action,
                )
                tasks.append(task)

        return tasks

    def _get_recommended_action(self, fault_type: str, urgency: str) -> str:
        """Get recommended action text."""
        actions = {
            "string_degradation": {
                "urgent": "Immediately inspect string connections and bypass diodes",
                "soon": "Schedule inspection of string conductors",
                "planned": "Monitor and check during routine maintenance",
            },
            "inverter_thermal": {
                "urgent": "Check cooling system immediately, reduce load if needed",
                "soon": "Schedule cooling system inspection",
                "planned": "Add cooling check to maintenance schedule",
            },
            "module_degradation": {
                "urgent": "Conduct I-V curve testing on degraded modules",
                "soon": "Schedule module testing",
                "planned": "Plan module replacement budget",
            },
            "thermal_hotspot": {
                "urgent": "CRITICAL: Inspect for localized overheating, fire risk",
                "soon": "Schedule thermal inspection",
                "planned": "Plan preventive inspection",
            },
            "mismatch": {
                "urgent": "Check for shading, soiling, or module failure",
                "soon": "Schedule string comparison testing",
                "planned": "Plan balancing maintenance",
            },
            "bypass_diode": {
                "urgent": "CRITICAL: High hotspot count indicates fire risk",
                "soon": "Schedule thermal and electrical inspection",
                "planned": "Plan preventive diode replacement",
            },
            "insulation": {
                "urgent": "CRITICAL: Ground fault risk! Disconnect if Riso < 10 MΩ",
                "soon": "Schedule insulation testing",
                "planned": "Plan cable inspection",
            },
        }
        return actions.get(fault_type, {}).get(
            urgency, f"Inspect {fault_type.replace('_', ' ')}"
        )

    def optimize_schedule(
        self,
        tasks: List[MaintenanceTask],
        start_date: Optional[date] = None,
    ) -> ScheduleResult:
        """
        Generate optimal maintenance schedule using greedy algorithm.

        Args:
            tasks: List of maintenance tasks to schedule
            start_date: Start date for scheduling (default: tomorrow)

        Returns:
            ScheduleResult with optimized schedule
        """
        if start_date is None:
            start_date = date.today() + timedelta(days=1)

        # Sort tasks by priority (highest first)
        sorted_tasks = sorted(tasks)

        # Initialize schedule tracking
        scheduled: List[ScheduledMaintenance] = []
        deferred: List[MaintenanceTask] = []
        daily_hours: Dict[date, float] = {}
        plant_last_visit: Dict[str, date] = {}

        max_hours_per_day = self.config.working_hours_per_day

        # Greedy scheduling
        for task in sorted_tasks:
            scheduled_task = self._try_schedule_task(
                task,
                start_date,
                daily_hours,
                plant_last_visit,
                max_hours_per_day,
            )

            if scheduled_task:
                scheduled.append(scheduled_task)
                # Update tracking
                task_date = scheduled_task.scheduled_date
                daily_hours[task_date] = (
                    daily_hours.get(task_date, 0) + scheduled_task.total_hours
                )
                plant_last_visit[task.plant_id] = task_date
            else:
                deferred.append(task)

        # Build schedule views
        daily_schedule = self._build_daily_schedule(scheduled)
        plant_schedule = self._build_plant_schedule(scheduled)

        # Calculate metrics
        metrics = self._calculate_metrics(scheduled, deferred, daily_hours)

        return ScheduleResult(
            scheduled=scheduled,
            deferred=deferred,
            metrics=metrics,
            daily_schedule=daily_schedule,
            plant_schedule=plant_schedule,
        )

    def _try_schedule_task(
        self,
        task: MaintenanceTask,
        start_date: date,
        daily_hours: Dict[date, float],
        plant_last_visit: Dict[str, date],
        max_hours: float,
    ) -> Optional[ScheduledMaintenance]:
        """Try to find a valid date for a task."""
        end_date = start_date + timedelta(days=self.config.planning_horizon_days)

        # Calculate estimated travel time
        travel_time = self.config.travel_time_hours
        total_hours = task.estimated_repair_hours + travel_time

        for day_offset in range(self.config.planning_horizon_days):
            candidate_date = start_date + timedelta(days=day_offset)

            # Skip if past planning horizon
            if candidate_date > end_date:
                break

            # Check capacity constraint
            current_hours = daily_hours.get(candidate_date, 0)
            if current_hours + total_hours > max_hours:
                continue

            # Check task count constraint
            tasks_today = sum(
                1
                for d, h in daily_hours.items()
                if d == candidate_date and h > 0
            )
            # Approximate: each task ~3 hours average
            if tasks_today >= self.config.max_tasks_per_day:
                continue

            # Check plant visit spacing
            last_visit = plant_last_visit.get(task.plant_id)
            if last_visit:
                days_since = (candidate_date - last_visit).days
                if days_since < self.config.min_days_between_visits:
                    continue

            # Valid date found
            return ScheduledMaintenance(
                task=task,
                scheduled_date=candidate_date,
                travel_time_hours=travel_time,
            )

        return None

    def _build_daily_schedule(
        self, scheduled: List[ScheduledMaintenance]
    ) -> Dict[date, List[ScheduledMaintenance]]:
        """Build daily view of schedule."""
        daily: Dict[date, List[ScheduledMaintenance]] = {}
        for s in scheduled:
            if s.scheduled_date not in daily:
                daily[s.scheduled_date] = []
            daily[s.scheduled_date].append(s)
        return daily

    def _build_plant_schedule(
        self, scheduled: List[ScheduledMaintenance]
    ) -> Dict[str, List[ScheduledMaintenance]]:
        """Build plant view of schedule."""
        plant: Dict[str, List[ScheduledMaintenance]] = {}
        for s in scheduled:
            if s.task.plant_id not in plant:
                plant[s.task.plant_id] = []
            plant[s.task.plant_id].append(s)
        return plant

    def _calculate_metrics(
        self,
        scheduled: List[ScheduledMaintenance],
        deferred: List[MaintenanceTask],
        daily_hours: Dict[date, float],
    ) -> ScheduleMetrics:
        """Calculate schedule metrics."""
        total_tasks = len(scheduled) + len(deferred)
        scheduled_count = len(scheduled)
        deferred_count = len(deferred)

        # Costs and revenue
        total_repair_cost = sum(s.task.repair_cost_eur for s in scheduled)
        total_revenue_saved = sum(s.task.revenue_at_risk_eur for s in scheduled)
        net_benefit = total_revenue_saved - total_repair_cost
        roi = (net_benefit / total_repair_cost * 100) if total_repair_cost > 0 else 0

        # Crew utilization
        working_days = len(daily_hours)
        max_possible_hours = working_days * self.config.working_hours_per_day
        actual_hours = sum(daily_hours.values())
        utilization = (actual_hours / max_possible_hours * 100) if max_possible_hours > 0 else 0

        # Average days to schedule
        if scheduled:
            today = date.today()
            avg_days = sum(
                (s.scheduled_date - today).days for s in scheduled
            ) / len(scheduled)
        else:
            avg_days = 0

        return ScheduleMetrics(
            total_tasks=total_tasks,
            scheduled_tasks=scheduled_count,
            deferred_tasks=deferred_count,
            total_repair_cost_eur=total_repair_cost,
            total_revenue_saved_eur=total_revenue_saved,
            net_benefit_eur=net_benefit,
            roi_pct=roi,
            crew_utilization_pct=utilization,
            avg_days_to_schedule=avg_days,
        )

    def optimize(
        self,
        plants: Dict[str, PlantInfo],
        rul_results: Dict[str, Dict[str, List]],
        start_date: Optional[date] = None,
    ) -> ScheduleResult:
        """
        Main entry point: collect tasks and optimize schedule.

        Args:
            plants: Plant info keyed by plant_id
            rul_results: RUL predictions per plant per fault type
            start_date: Start date for scheduling

        Returns:
            ScheduleResult with optimized schedule
        """
        # Collect and score tasks
        tasks = self.collect_tasks(plants, rul_results)

        # Optimize schedule
        return self.optimize_schedule(tasks, start_date)


def create_ticket_payload(
    scheduled: ScheduledMaintenance,
    org_id: str,
) -> dict:
    """
    Create ticket payload for O&M system integration.

    Args:
        scheduled: Scheduled maintenance task
        org_id: Organization clerk ID

    Returns:
        Ticket creation payload
    """
    config = SchedulerConfig()
    priority = config.ticket_priority_mapping.get(scheduled.task.urgency, "MEDIUM")

    return {
        "org_clerk_id": org_id,
        "plant_id": scheduled.task.plant_id,
        "inverter_id": scheduled.task.inverter_id,
        "status": "NEW",
        "priority": priority,
        "trigger_type": "SCHEDULED_MAINTENANCE",
        "trigger_metadata": {
            "fault_type": scheduled.task.fault_type,
            "days_to_fault": scheduled.task.days_to_fault,
            "priority_score": scheduled.task.priority_score,
            "scheduled_date": str(scheduled.scheduled_date),
        },
        "title": f"{scheduled.task.fault_type.replace('_', ' ').title()} - Scheduled {scheduled.scheduled_date}",
        "description": scheduled.task.recommended_action,
        "estimated_revenue_impact_eur": scheduled.task.revenue_at_risk_eur,
    }
