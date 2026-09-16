"""The default configuration must actually load the models it claims to.

This exists because a 15 MB trained fault classifier and the entire RUL directory
were unreachable in the default configuration for months, and nothing failed.

``PredictiveMaintenancePipeline`` defaulted to ``model_dir="models"`` and looked
for ``models/fault_detection/fault_classifier_string_level.pkl``. The files are
under ``backenddata/models/``. There is no ``models/fault_detection`` directory at
all. The pipeline printed a warning and continued, so every downstream consumer
ran with no classifier and no remaining-useful-life predictions, and the output
looked exactly like a plant with nothing wrong.

The failure mode is the dangerous one: **a detector that cannot load reports a
clean result.** Silence and health are indistinguishable from the outside, so the
only defence is a test that asserts the default path resolves.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from nuravolt.model_paths import (
    MODEL_ROOTS,
    REPO_ROOT,
    resolve_model_path,
    resolve_model_root,
)


class TestModelPathResolution:
    def test_resolves_against_the_repo_not_the_cwd(self, tmp_path, monkeypatch):
        """A relative default must not change meaning with the working directory."""
        monkeypatch.chdir(tmp_path)
        root = resolve_model_root()
        assert root.is_absolute()
        assert REPO_ROOT in root.parents or root == REPO_ROOT / MODEL_ROOTS[0]

    def test_returns_a_root_that_exists(self):
        assert resolve_model_root().exists()

    def test_missing_file_returns_none_not_a_bogus_path(self):
        assert resolve_model_path("no_such_dir", "no_such_model.pkl") is None

    def test_explicit_missing_root_raises_rather_than_degrading(self):
        """A misconfigured root is a configuration error, not an empty fleet."""
        with pytest.raises(FileNotFoundError, match="does not exist"):
            resolve_model_root("definitely/not/a/real/directory")


class TestDefaultConstructionLoads:
    """The regression that started this: default construction must find its models."""

    def test_fault_classifier_is_reachable_by_default(self):
        path = resolve_model_path(
            "fault_detection", "fault_classifier_string_level.pkl"
        )
        if path is None:
            pytest.skip("classifier not trained in this checkout")
        assert path.exists() and path.stat().st_size > 0

    def test_rul_directory_is_reachable_by_default(self):
        path = resolve_model_path("rul")
        if path is None:
            pytest.skip("no RUL models in this checkout")
        assert path.is_dir()

    def test_pipeline_loads_every_model_present_on_disk(self):
        """Construct with no arguments and assert nothing silently failed."""
        from nuravolt.fault.predictive_maintenance import PredictiveMaintenancePipeline

        pipeline = PredictiveMaintenancePipeline(plant_id="test")

        classifier_on_disk = resolve_model_path(
            "fault_detection", "fault_classifier_string_level.pkl"
        )
        if classifier_on_disk is not None:
            assert pipeline.fault_classifier is not None, (
                f"{classifier_on_disk} exists on disk but the default pipeline did "
                f"not load it. This is the original defect: the pipeline warns and "
                f"continues, producing a clean-looking result with no classifier."
            )

        rul_dir = resolve_model_path("rul")
        if rul_dir is not None and any(rul_dir.glob("*.pkl")):
            assert pipeline.rul_predictor is not None, (
                f"{rul_dir} contains models but the default pipeline did not load them."
            )


class TestWithdrawnModelsStayWithdrawn:
    """Quarantined models must not creep back into the runtime registry.

    Four RUL models were withdrawn for label leakage and synthesized inputs. Two
    are quarantined under ``backenddata/models/rul/withdrawn/``. If someone moves
    a .pkl back or re-adds an entry to MODEL_FILES, this fails.
    """

    WITHDRAWN = {"thermal_hotspot", "module_degradation", "bypass_diode", "insulation"}

    def test_withdrawn_models_are_not_loaded_at_runtime(self):
        from nuravolt.fault.rul_predictor import MODEL_FILES

        leaked = self.WITHDRAWN & set(MODEL_FILES)
        assert not leaked, (
            f"withdrawn RUL model(s) back in MODEL_FILES: {sorted(leaked)}. "
            f"See backenddata/models/rul/withdrawn/README.md for why they were "
            f"withdrawn; their reported accuracy measured injected label noise."
        )

    def test_quarantine_directory_is_not_on_the_load_path(self):
        rul_dir = resolve_model_path("rul")
        if rul_dir is None:
            pytest.skip("no RUL directory")
        quarantined = {p.stem.replace("rul_", "") for p in (rul_dir / "withdrawn").glob("*.pkl")} \
            if (rul_dir / "withdrawn").exists() else set()
        active = {p.stem.replace("rul_", "") for p in rul_dir.glob("*.pkl")}
        assert not (quarantined & active), (
            f"a withdrawn model is also present in the active directory: "
            f"{sorted(quarantined & active)}"
        )
