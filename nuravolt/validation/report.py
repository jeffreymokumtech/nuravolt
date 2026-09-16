"""Report writer + summary aggregator for the validation harness.

Writes per-dataset JSON reports under ``backenddata/validation/{algo}/`` and
builds a top-level ``summary.json`` aggregating all of them.

``backenddata/`` is gitignored, so every report is also mirrored into
``public/data/validation/`` -- which *is* tracked, is served at
``/data/validation/summary.json``, and is what makes a published accuracy
number reproducible by someone who only has the repo. A number with no
committed artifact behind it does not go on a spec sheet.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Literal

VALIDATION_ROOT = Path("backenddata/validation")
# Tracked mirror. ``backenddata/`` is gitignored (and its ``!`` negations are
# no-ops, since git cannot re-include a path under an excluded directory), so
# the artifacts would otherwise live on one laptop only.
PUBLIC_MIRROR_ROOT = Path("public/data/validation")


def _mirror(rel: Path, body: str) -> None:
    """Copy a report into the tracked ``public/data/validation/`` mirror."""
    dst = PUBLIC_MIRROR_ROOT / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(body)


def result_exists(algo: str, dataset: str, root: Path = VALIDATION_ROOT) -> bool:
    """Does a real RESULT already sit where a pending marker would go?

    A validator that cannot find its input should record that, but it must never
    replace a measurement with the note that the measurement is unavailable. That
    is not a hypothetical: the GPVS artifact was destroyed exactly this way, and
    because the dataset itself is a manual download that is no longer on disk, the
    run could not simply be repeated. Call this before writing any
    ``pending_manual_fetch`` payload.
    """
    for base in (root, PUBLIC_MIRROR_ROOT):
        f = base / algo / f"{dataset}.json"
        if not f.exists():
            continue
        try:
            body = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        if not str(body.get("status", "")).startswith(("pending", "no_prediction")):
            return True
    return False


def write_report(
    algo: Literal["pv", "bess", "soiling", "twin", "forecast"],
    dataset: str,
    payload: Dict[str, Any],
    root: Path = VALIDATION_ROOT,
) -> Path:
    """Persist a per-dataset validation report.

    Args:
        algo: one of ``pv``, ``bess``, ``soiling``, ``twin``, ``forecast``
        dataset: short identifier (e.g. ``lazzaretti_holdout``, ``severson_cycle_life``)
        payload: report body — gets a ``generated_at`` timestamp added
        root: optional override of ``backenddata/validation``

    Returns:
        Path that was written.
    """
    out_dir = root / algo
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{dataset}.json"

    payload = dict(payload)
    payload.setdefault("generated_at", datetime.utcnow().isoformat() + "Z")

    body = json.dumps(payload, indent=2, default=str)
    out_path.write_text(body)
    _mirror(Path(algo) / f"{dataset}.json", body)
    return out_path


# Hand-curated tag of each dataset's distribution relationship to its trainer.
# Editable mapping rather than auto-inferred so the labels stay deliberate.
DISTRIBUTION_RELATIONSHIP: Dict[str, str] = {
    # PV — IN-DISTRIBUTION (trained or tuned on the same dataset)
    "lazzaretti_holdout": "in_dist_tuned_thresholds",   # thresholds from Lazzaretti per-class percentiles
    "lazzaretti_lgbm": "in_dist_train_test_split",       # 80/20 split of same dataset
    "lazzaretti_physics_blind": "in_dist_no_tuning",
    "shipped_detector_lazzaretti": "in_dist_shipped_code",
    "shipped_detector_lazzaretti_before_fixes": "in_dist_shipped_code",     # the same shipped detector before the peer-relative fixes; kept as the before-picture
    "shipped_detector_lazzaretti_dwell1": "in_dist_shipped_code",           # same, with persistence disabled so the dataset's lack of a time axis stops confounding the score
    "shipped_detector_lazzaretti_v5": "in_dist_shipped_code",
    # The parameterised cascade and what it can and cannot be measured on.
    "classifier_provenance": "provenance_audit",
    "scale_transfer_lazzaretti": "synthetic_perturbation",
    "classifier_class_mix_real_plants": "operability_no_labels",
    "sandia_sat_transfer": "cross_dist",
    # PV — CROSS-DISTRIBUTION (different dataset than any used in tuning)
    "gpvs_cross_dataset": "cross_dist",                   # GPVS rules tuned on GPVS aggregate stats, tested on GPVS hold-out → cross-DOMAIN (different feature shape than Lazzaretti, so foundation model never touched these signals)
    "rul_cross_dataset": "cross_dist",                    # module_degradation RUL trained on Lazzaretti synthetic labels, tested on Sandia PV-IV-EL real outdoor fade
    "sandia_pv_iv_el_degradation": "literature_comparison",  # fleet fade rate vs Jordan & Kurtz 2013 published 0.5-1.0%/yr
    # BESS — IN-DISTRIBUTION
    "severson": "in_dist_no_tuning",
    "severson_delta_q": "in_dist_loo",                    # leave-one-out within Severson
    "severson_lgbm": "in_dist_loo",
    # BESS — CROSS-DISTRIBUTION
    "nasa": "cross_dist",                                  # never used to tune Severson model
    "lfp_secondlife_2025": "cross_dist",                  # different LFP vendor than Severson
    # Soiling — LITERATURE / GROUND-TRUTH (no training data, just measurement vs published or first-principles)
    "nrel_map_sites": "literature_comparison",
    "universal_dayone": "physics_check",                   # purely physics + lookup
    "pvdaq_system_2107": "ground_truth_measurement",
    "pvdaq_system_7334": "ground_truth_measurement",
    "pvdaq_system_9069": "ground_truth_measurement",
    "pvdaq_system_34": "ground_truth_measurement",
    "climate_prior_cross_check": "literature_vs_observed",  # honest gap check
    "africa_transferability": "transfer_readiness",
    # Fault detectors scored on real plants with no fault labels: what is
    # measurable is operability (alert rate) and scale invariance, NOT recall.
    "peer_inverter_underperformance_fleet": "operability_no_labels",
    "rule_firing_rates_real_plants": "operability_no_labels",  # which regimes we may quote at all
    # Twin / forecast — WALK-FORWARD OUT-OF-SAMPLE on client SCADA.
    # Deliberately its own bucket: these refit on an expanding history and score
    # the next unseen window, i.e. exactly what the model does in production.
    # Calling that "in_dist_train_test_split" understates it; calling it
    # "cross_dist" overstates it.
    "twin_daily_energy_es_fleet": "walk_forward_oos",
    "twin_daily_energy_leave_one_plant_out": "cross_plant_transfer",
    "twin_15min_alpha": "walk_forward_oos",
    "twin_per_inverter_alpha": "walk_forward_oos",
    "forecast_dayahead_alpha_endogenous": "walk_forward_oos",
    "forecast_dayahead_alpha_nwp": "walk_forward_oos",
    "forecast_soiling_sr_ribera": "walk_forward_oos",
    "twin_15min_dayone": "walk_forward_oos",
    "twin_feature_ablation": "walk_forward_oos",
    "twin_local_data_curve": "walk_forward_oos",
}


# Human-readable normaliser names, so a headline can never show a bare
# identifier that a reader has to guess the units of.
_NORMALIZER_LABELS = {
    "ac_capacity_kw": "AC nameplate",
    "mean_daily_energy_kwh": "mean daily energy",
    "mean_measured": "mean measured",
    "capacity_per_period": "capacity per period",
}


def build_summary(root: Path = VALIDATION_ROOT) -> Dict[str, Any]:
    """Aggregate every per-dataset JSON under ``root`` into ``summary.json``.

    Returns the summary dict (also written to ``root/summary.json``). The
    summary tags each entry with ``distribution_relationship`` so cross-
    distribution numbers don't get conflated with in-distribution leakage.
    """
    summary: Dict[str, Any] = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "datasets": {},
        "totals": {"datasets": 0, "samples": 0},
        "headlines": [],
        "scoreboard": {
            "cross_distribution": [],
            "in_distribution": [],
            "literature_comparison": [],
            "ground_truth_measurement": [],
            "physics_check": [],
            "literature_vs_observed": [],
            "provenance_audit": [],
            "synthetic_perturbation": [],
            "walk_forward_oos": [],
            "in_dist_shipped_code": [],
            "cross_plant_transfer": [],
            "transfer_readiness": [],
            "operability_no_labels": [],
            "untagged": [],
        },
    }

    for algo_dir in ("pv", "bess", "soiling", "twin", "forecast"):
        algo_path = root / algo_dir
        if not algo_path.exists():
            continue
        algo_block: Dict[str, Any] = {}
        for fp in sorted(algo_path.glob("*.json")):
            try:
                report = json.loads(fp.read_text())
            except Exception as e:
                report = {"error": f"unreadable: {e}"}
            _mirror(Path(algo_dir) / fp.name, fp.read_text())
            entry = _extract_headline(report)
            relationship = DISTRIBUTION_RELATIONSHIP.get(fp.stem, "untagged")
            entry["distribution_relationship"] = relationship
            algo_block[fp.stem] = entry
            summary["totals"]["datasets"] += 1
            summary["totals"]["samples"] += int(report.get("n_samples", 0) or 0)

            # Categorize into scoreboard buckets
            # An EXACT tag match wins over the "in_dist" prefix. Testing the
            # prefix first meant `in_dist_shipped_code` -- which has its own
            # declared bucket precisely because scoring the code that actually
            # ships deserves separating -- was swallowed into `in_distribution`,
            # leaving its bucket permanently empty.
            bucket = (
                relationship if relationship in summary["scoreboard"]
                else "in_distribution" if relationship.startswith("in_dist")
                else "cross_distribution" if relationship == "cross_dist"
                else "untagged"
            )
            summary["scoreboard"][bucket].append(f"{algo_dir}/{fp.stem}: {entry.get('headline', '?')}")
        if algo_block:
            summary["datasets"][algo_dir] = algo_block

    # Build human-readable headlines (now annotated with distribution tag)
    for algo, datasets in summary["datasets"].items():
        for ds_name, ds in datasets.items():
            if "headline" in ds:
                tag = ds.get("distribution_relationship", "")
                marker = {
                    "cross_dist": "★ CROSS-DIST",
                    "in_dist_train_test_split": "  in-dist (train/test split)",
                    "in_dist_tuned_thresholds": "  in-dist (tuned thresholds)",
                    "in_dist_no_tuning": "  in-dist (no tuning)",
                    "in_dist_loo": "  in-dist (leave-one-out)",
                    "literature_comparison": "✓ literature match",
                    "ground_truth_measurement": "▷ ground truth",
                    "physics_check": "  physics check",
                    "literature_vs_observed": "↔ literature-vs-observed gap",
                    "walk_forward_oos": "◆ walk-forward out-of-sample",
                    "in_dist_shipped_code": "▪ in-dist, SHIPPED code",
                    "cross_plant_transfer": "★ cross-plant (unseen site)",
                    "transfer_readiness": "◇ transfer readiness",
                    "operability_no_labels": "◈ operability (no labels)",
                    "provenance_audit": "⊙ provenance audit",
                    "synthetic_perturbation": "⚗ synthetic perturbation",
                }.get(tag, "")
                summary["headlines"].append(f"[{marker}] {algo}/{ds_name}: {ds['headline']}")

    out_path = root / "summary.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(summary, indent=2, default=str)
    out_path.write_text(body)
    _mirror(Path("summary.json"), body)
    return summary


def _extract_headline(report: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the marquee number for a report (used by build_summary)."""
    out: Dict[str, Any] = {"n_samples": report.get("n_samples")}

    status = report.get("status")
    if status == "pending_manual_fetch":
        out["status"] = "pending_manual_fetch"
        out["headline"] = "⏸  data not yet fetched (see report.reason)"
        return out
    if status == "pending_implementation":
        out["status"] = "pending_implementation"
        out["headline"] = "⏸  harness ready, implementation pending"
        return out

    # --- twin: capacity-normalised error, with the physics baseline alongside ---
    if "nmae_pct" in report and "skill_score" not in report:
        out["nmae_pct"] = report["nmae_pct"]
        out["nrmse_pct"] = report.get("nrmse_pct")
        out["mbe_pct"] = report.get("mbe_pct")
        out["normalizer"] = report.get("normalizer")
        out["reference_baseline"] = report.get("reference_baseline")
        out["reference_nmae_pct"] = report.get("reference_nmae_pct")
        out["uplift_vs_reference_pct"] = report.get("uplift_vs_reference_pct")
        norm = _NORMALIZER_LABELS.get(report.get("normalizer", ""), "normaliser")
        # Omit the bias clause when the artifact has no value for it. It used to
        # default to nan and render the literal string "bias +nan%".
        bias = report.get("mbe_pct")
        bias_txt = f" (bias {bias:+.2f}%)" if isinstance(bias, (int, float)) else ""
        head = (
            f"nMAE {report['nmae_pct']:.2f}% of {norm}{bias_txt} on "
            f"{report.get('n_samples', '?'):,} points"
        )
        if report.get("n_windows"):
            head += f", {report['n_windows']} walk-forward windows"
        if report.get("reference_nmae_pct") is not None:
            head += (
                f" | {report.get('reference_baseline', 'reference')} "
                f"{report['reference_nmae_pct']:.2f}%"
                f" -> ML uplift {report.get('uplift_vs_reference_pct', 0):+.0f}%"
            )
        out["headline"] = head
        return out

    # --- forecast: skill score against a named baseline ---
    if "skill_score" in report:
        out["skill_score"] = report["skill_score"]
        out["nmae_pct"] = report.get("nmae_pct")
        out["baseline_nmae_pct"] = report.get("baseline_nmae_pct")
        out["baseline"] = report.get("baseline", "persistence")
        out["driver"] = report.get("driver")
        out["reference_nmae_pct"] = report.get("reference_nmae_pct")
        out["reference_baseline"] = report.get("reference_baseline")
        head = (
            f"skill {report['skill_score']:+.3f} vs {report.get('baseline', 'persistence')} "
            f"(nMAE {report.get('nmae_pct', float('nan')):.2f}% vs "
            f"{report.get('baseline_nmae_pct', float('nan')):.2f}%) at "
            f"h={report.get('horizon_hours', '?')}h on "
            f"{report.get('n_samples', '?'):,} periods"
        )
        if report.get("reference_nmae_pct") is not None:
            head += (
                f" | {report.get('reference_baseline', 'reference')} "
                f"{report['reference_nmae_pct']:.2f}%"
            )
        out["headline"] = head
        return out

    # --- rule cascade firing rates on real plants ---
    if "fleet_alerts_per_mw_month" in report:
        out["alerts_per_mw_month"] = report["fleet_alerts_per_mw_month"]
        out["implausible_rules"] = report.get("implausible_rules")
        out["headline"] = (
            f"{report.get('fleet_alerts_total', 0):,} alerts across "
            f"{len(report.get('per_plant', {}))} real plants = "
            f"{report['fleet_alerts_per_mw_month']:.0f} per MW-month; "
            f"{len(report.get('implausible_rules', []))} rules fire above any "
            f"plausible base rate"
        )
        return out

    # --- fault detector operability on unlabelled real plants ---
    if "alerts_per_mw_month" in report:
        rate = report["alerts_per_mw_month"]
        gate = report.get("gate", report.get("ship_gate_alerts_per_mw_month"))
        out["alerts_per_mw_month"] = rate
        out["tier"] = report.get("tier")
        out["passes_gate"] = report.get("passes_gate", report.get("passes_ship_gate"))
        nc = report.get("null_calibration") or {}
        si = report.get("scale_invariance") or {}
        out["null_calibrated"] = nc.get("is_calibrated")
        out["signal_to_null_ratio"] = nc.get("signal_to_null_ratio")

        verdict = "PASSES" if out["passes_gate"] else "FAILS"
        head = (f"{rate:.2f} alerts/MW/month on {report.get('n_samples', '?'):,} devices, "
                f"{verdict}" + (f" the {gate} gate" if gate is not None else " the gate"))
        if nc:
            head += (
                f" | null tail {nc.get('null_tail_rate', 0) * 100:.4f}% vs theory "
                f"{nc.get('theoretical_null_rate', 0) * 100:.4f}% "
                f"({'calibrated' if nc.get('is_calibrated') else 'MISCALIBRATED'}), "
                f"signal {nc.get('signal_to_null_ratio')}x null"
            )
        if si.get("computable") and not si.get("passes"):
            head += f" | alert rate tracks plant size (rho {si.get('spearman_size_vs_alert_rate'):+.2f})"
        out["headline"] = head
        return out

    # --- soiling-ratio forecast vs a reference sensor, error in percentage points ---
    if "mae_sr_pp" in report:
        out["mae_sr_pp"] = report["mae_sr_pp"]
        out["n_windows"] = report.get("n_windows")
        sd = report.get("mae_sr_pp_std")
        sd_txt = f" (sd {sd:.2f})" if isinstance(sd, (int, float)) else ""
        out["headline"] = (
            f"soiling-ratio MAE {report['mae_sr_pp']:.2f} pp{sd_txt} at "
            f"h={report.get('horizon_hours', '?')}h over "
            f"{report.get('n_windows', '?')} walk-forward windows"
        )
        return out

    # --- rank-transfer (RUL cross-dataset): correct ordering, uncalibrated scale ---
    if "spearman_correlation_fade_vs_eol" in report:
        rho = report["spearman_correlation_fade_vs_eol"]
        out["spearman"] = rho
        out["interpretation"] = report.get("interpretation")
        out["headline"] = (
            f"Spearman {rho:+.3f} on {report.get('n_samples', '?'):,} modules "
            f"({report.get('interpretation', 'rank transfer')})"
        )
        return out

    # --- fleet degradation rate vs published literature ---
    if "fleet_fade_rate_distribution_pct_per_year" in report:
        d = report["fleet_fade_rate_distribution_pct_per_year"]
        out["fade_rate_pct_per_year"] = d
        out["headline"] = (
            f"fleet fade {d.get('mean', float('nan')):.3f} %/yr mean, "
            f"{d.get('median', d.get('p50', float('nan'))):.3f} %/yr median across "
            f"{report.get('n_samples', '?'):,} modules"
        )
        return out

    # --- day-one climate-zone resolution (physics + lookup, no training) ---
    if "zone_resolution_accuracy" in report:
        out["zone_resolution_accuracy"] = report["zone_resolution_accuracy"]
        n_tested = report.get("n_plants_tested", report.get("n_samples", 0)) or 0
        acc = report["zone_resolution_accuracy"]
        out["headline"] = (
            f"{round(acc * n_tested)}/{n_tested} plants resolved to the correct "
            f"climate zone ({acc * 100:.0f}%)"
        )
        return out

    # --- transfer readiness: where we are allowed to quote a number at all ---
    if "tier_legend" in report and "sites" in report:
        sites = report.get("sites") or []
        tiers: Dict[str, int] = {}
        for site in sites:
            tier = (
                site.get("honest_tier", site.get("tier", "unknown"))
                if isinstance(site, dict)
                else "unknown"
            )
            tiers[tier] = tiers.get(tier, 0) + 1
        out["n_samples"] = len(sites)
        out["tiers"] = tiers
        out["headline"] = (
            f"{len(sites)} sites triaged: "
            + ", ".join(f"{v} {k}" for k, v in sorted(tiers.items()))
        )
        return out

    # --- honest literature-vs-observed gap check ---
    if "n_sites_within_30pct" in report:
        n_ok = report["n_sites_within_30pct"]
        n_all = report.get("n_sites_compared", report.get("n_samples", "?"))
        out["n_sites_within_30pct"] = n_ok
        out["headline"] = f"{n_ok}/{n_all} sites within +/-30% of the climate prior"
        return out

    if "macro_f1" in report:
        out["macro_f1"] = report["macro_f1"]
        out["weighted_f1"] = report.get("weighted_f1")
        out["accuracy"] = report.get("accuracy")
        out["headline"] = (
            f"macro-F1 {report['macro_f1']:.3f} on {report.get('n_samples', '?'):,} samples"
        )
    elif "rmse" in report:
        out["rmse"] = report["rmse"]
        out["mae"] = report.get("mae")
        out["headline"] = (
            f"RMSE {report['rmse']:.4f} on {report.get('n_samples', '?'):,} samples"
        )
    elif "eol_within_10pct_fraction" in report:
        out["eol_within_10pct"] = report["eol_within_10pct_fraction"]
        out["mape"] = report.get("mape")
        # The method and the history window belong IN the headline. The same naive
        # extrapolation scores 75% on one dataset and 3.2% on another purely
        # because of how much of each cell's life it is allowed to see, so a bare
        # percentage invites a comparison that is not valid.
        extras = report.get("extras") or {}
        method = (extras.get("method") or extras.get("prediction_method")
                  or extras.get("model") or "unspecified method")
        is_naive = "extrapolation" in str(method).lower()
        kind = "naive baseline" if is_naive else "our model"
        cycles = extras.get("cycles_used")
        window = f", cycles {cycles[0]}-{cycles[1]}" if isinstance(cycles, list) and len(cycles) == 2 else ""
        out["method"] = method
        out["is_naive_baseline"] = is_naive
        out["headline"] = (
            f"{report['eol_within_10pct_fraction']*100:.0f}% of cells within ±10% EOL "
            f"(MAPE {report.get('mape', float('nan'))*100:.0f}%) — {kind}: "
            f"{str(method)[:60]}{window}"
        )
    elif "distribution" in report and "metric" in report:
        dist = report["distribution"]
        out["distribution"] = dist
        out["metric"] = report["metric"]
        out["headline"] = (
            f"{report['metric']}: p25 {dist.get('p25'):.3f} / p50 {dist.get('p50'):.3f} / "
            f"p75 {dist.get('p75'):.3f} across {report.get('n_samples', '?'):,} sites"
        )
    elif "iwsr_p50" in report:
        out["iwsr"] = report["iwsr_p50"]
        out["n_soiling_intervals"] = report.get("n_soiling_intervals_detected")
        out["headline"] = (
            f"IWSR = {report['iwsr_p50']:.3f} on {report.get('n_days_used', '?'):,} days "
            f"({report.get('n_soiling_intervals_detected', '?')} soiling intervals detected)"
        )
    elif "error" in report:
        out["headline"] = f"error: {report['error']}"
    else:
        # Shapes introduced with the parameterised cascade. Without these the
        # renderer falls through to "report present", which is not a finding.
        if "headline_macro_f1_normalised_spread" in report:
            worst = report.get("headline_macro_f1_unnormalised_worst")
            spread = report.get("headline_macro_f1_normalised_spread")
            base = (report.get("baseline_unperturbed") or {}).get("fixed_refs")
            dead = report.get("classes_that_die_under_perturbation") or []
            out["headline"] = (
                f"macro-F1 {base} unperturbed falls to {worst} on a rig of another "
                f"size; {len(dead)} classes reach F1 0.000. Normalised, invariant to "
                f"within {spread}"
            )
        elif "class_mix_fixed_refs" in str(report.get("per_plant", "")):
            plants = report.get("per_plant") or {}
            scored = [v for v in plants.values() if "never_emitted" in v]
            never = sorted({c for v in scored for c in v["never_emitted"]["fixed"]})
            out["headline"] = (
                f"on {len(scored)} real plants the fixed-reference cascade never emits "
                f"{', '.join(never)} at all"
            )
        elif "which_comparisons_are_valid" in report:
            n = len(report.get("artifacts") or [])
            out["headline"] = (
                f"{n} published fault numbers traced to their classifiers; "
                f"0.835/0.519 comparable, 0.189 is a different implementation"
            )
        else:
            out["headline"] = "report present"

    return out
