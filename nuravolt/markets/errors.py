"""Shared error type for the market-data providers.

Lives in its own module so nuravolt/markets/entsoe.py, gb.py and iberia.py can
raise the same exception without importing each other. entsoe.py re-exports
``PriceFetchError`` so the historical
``from nuravolt.markets.entsoe import PriceFetchError`` import keeps working.
"""

from __future__ import annotations


class PriceFetchError(RuntimeError):
    """Raised when no provider could return prices for the requested range."""


__all__ = ["PriceFetchError"]
