"""Pre-trained foundation models for client-agnostic detection.

Models live under ``models/foundation/`` as ``.pkl`` files paired with
``.meta.json`` metadata. The loaders here read both and expose a clean
predict API that any production code can call without knowing how the
model was trained.

Pattern:
    from nuravolt.foundation.pv_classifier import load_pv_foundation
    fc = load_pv_foundation()
    predictions = fc.predict(signals_df)   # column names in metadata
"""
