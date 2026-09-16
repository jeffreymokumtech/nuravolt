"""Where trained model files actually live.

This module exists because a trained model was silently unreachable for months.

``PredictiveMaintenancePipeline`` defaulted to ``model_dir="models"`` and looked
for ``models/fault_detection/fault_classifier_string_level.pkl``. The file is at
``backenddata/models/fault_detection/fault_classifier_string_level.pkl``. There is
no ``models/fault_detection`` directory at all. The pipeline printed
``⚠ Fault classifier not found`` and carried on, so a 15 MB trained classifier and
the whole RUL directory were dead in the default configuration and nothing failed.

Two rules follow from that:

1. **Resolve against the repository root, never the working directory.** A relative
   default silently changes meaning depending on where a script is launched from.
2. **Never resolve to a directory that does not exist.** ``resolve_model_root``
   returns the first candidate that is actually present and raises when none is,
   because a path that cannot hold a model should fail loudly rather than produce
   a "not found" warning that reads like an empty fleet.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, Optional

#: Repository root, derived from this file rather than from the process CWD.
REPO_ROOT = Path(__file__).resolve().parents[1]

#: Model roots in priority order. ``backenddata/models`` is where every trained
#: artifact currently lives; ``models`` is kept because the foundation models
#: (``models/foundation/*.pkl``) really do sit there, and because older configs
#: and docs reference it.
MODEL_ROOTS = ("backenddata/models", "models")


def candidate_roots() -> list[Path]:
    return [REPO_ROOT / r for r in MODEL_ROOTS]


def resolve_model_root(preferred: Optional[str] = None) -> Path:
    """Return the first model root that exists.

    Args:
        preferred: an explicit directory. Used as-is when it exists, so callers
            and tests can always override.

    Raises:
        FileNotFoundError: when nothing exists. Silence here is what caused the
            original defect.
    """
    if preferred is not None:
        p = Path(preferred)
        if not p.is_absolute():
            # A bare relative path is interpreted against the repo, not the CWD.
            repo_relative = REPO_ROOT / p
            if repo_relative.exists():
                return repo_relative
        if p.exists():
            return p
        raise FileNotFoundError(
            f"model directory {preferred!r} does not exist "
            f"(tried {p} and {REPO_ROOT / p})"
        )

    for root in candidate_roots():
        if root.exists():
            return root

    raise FileNotFoundError(
        f"no model root found; tried {[str(r) for r in candidate_roots()]}. "
        f"Trained models cannot be loaded, and a detector running without them "
        f"reports a clean result that is indistinguishable from a healthy plant."
    )


def resolve_model_path(*parts: str, preferred_root: Optional[str] = None) -> Optional[Path]:
    """Find one model file across the known roots.

    Returns None when the file is genuinely absent everywhere, which is a real
    state (a model that has never been trained) and distinct from a misconfigured
    root.
    """
    roots: Iterable[Path]
    if preferred_root is not None:
        roots = [resolve_model_root(preferred_root)]
    else:
        roots = [r for r in candidate_roots() if r.exists()]

    for root in roots:
        candidate = root.joinpath(*parts)
        if candidate.exists():
            return candidate
    return None
