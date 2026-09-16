#!/usr/bin/env python3
"""
CLI for SR Estimation API.

This script is called by Next.js API routes to run SR estimation.
Communication is via stdin (JSON input) and stdout (JSON output).

Commands:
- get_methods: Get available SR methods for a plant
- estimate: Run SR estimation
- compare: Compare all available methods
- get_similarity: Get plant similarity matrix
- get_transfer_config: Get transfer learning configuration
- set_transfer_source: Set manual transfer source
"""

import json
import sys
from datetime import datetime
from pathlib import Path

# Add project root to path
project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(project_root))

from nuravolt.soiling.estimation import (
    SRMethodSelector,
    PlantSimilarityScorer,
    EstimationLayer,
)


def handle_get_methods(plant_id: str) -> dict:
    """Get available SR estimation methods for a plant."""
    selector = SRMethodSelector()
    availabilities = selector.get_availability(plant_id)
    selection = selector.auto_select(plant_id)

    return {
        "plant_id": plant_id,
        "selected_method": selection.selected_method,
        "selected_layer": selection.selected_layer,
        "selected_confidence": selection.confidence,
        "selected_reason": selection.reason,
        "methods": [a.to_dict() for a in availabilities],
    }


def handle_estimate(
    plant_id: str,
    method: str = None,
    start_date: str = None,
    end_date: str = None,
) -> dict:
    """Run SR estimation for a plant."""
    selector = SRMethodSelector()

    try:
        result = selector.estimate(
            plant_id,
            method_override=method,
            start_date=start_date,
            end_date=end_date,
        )

        # Convert to JSON-serializable format
        sr_data = result.sr_values.reset_index()
        sr_data.columns = ["date", "sr"]
        sr_data["date"] = sr_data["date"].dt.strftime("%Y-%m-%d")

        conf_data = result.confidence.reset_index()
        conf_data.columns = ["date", "confidence"]
        conf_data["date"] = conf_data["date"].dt.strftime("%Y-%m-%d")

        return {
            "success": True,
            "plant_id": plant_id,
            "method": result.method,
            "layer": int(result.layer),
            "layer_name": result.layer.name,
            "current_sr": result.current_sr,
            "avg_sr": result.avg_sr,
            "avg_confidence": result.avg_confidence,
            "estimated_loss_pct": result.estimated_loss_pct,
            "validation": {
                "mae": result.validation_mae,
                "rmse": result.validation_rmse,
                "r2": result.validation_r2,
                "bias": result.validation_bias,
            },
            "source_plant": result.source_plant,
            "metadata": result.metadata,
            "data": {
                "sr": sr_data.to_dict(orient="records"),
                "confidence": conf_data.to_dict(orient="records"),
            },
            "estimated_at": result.estimated_at,
        }

    except Exception as e:
        return {
            "success": False,
            "error": str(e),
            "plant_id": plant_id,
        }


def handle_compare(
    plant_id: str,
    start_date: str = None,
    end_date: str = None,
) -> dict:
    """Compare all available estimation methods."""
    selector = SRMethodSelector()
    return selector.compare_methods(plant_id, start_date, end_date)


def handle_get_similarity(plants: list = None) -> dict:
    """Get plant similarity matrix."""
    scorer = PlantSimilarityScorer()
    matrix = scorer.get_similarity_matrix(plants)

    # Convert to JSON-serializable format
    return {
        "plants": list(matrix.index),
        "matrix": matrix.values.tolist(),
        "dustiq_plants": scorer.get_dustiq_plants(),
    }


def handle_get_transfer_config(plant_id: str) -> dict:
    """Get transfer learning configuration for a plant."""
    selector = SRMethodSelector()
    config = selector.get_transfer_config(plant_id)
    ranked = selector.get_ranked_transfer_sources(plant_id, top_k=5)

    return {
        "plant_id": plant_id,
        "current_config": config,
        "ranked_sources": ranked,
    }


def handle_set_transfer_source(target_plant: str, source_plant: str) -> dict:
    """Set manual transfer source for a plant."""
    selector = SRMethodSelector()

    try:
        similarity = selector.set_transfer_source(target_plant, source_plant)
        return {
            "success": True,
            "target_plant": target_plant,
            "source_plant": source_plant,
            "similarity_score": similarity,
        }
    except Exception as e:
        return {
            "success": False,
            "error": str(e),
        }


def main():
    """Main entry point - reads JSON from stdin, writes JSON to stdout."""
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())

        command = input_data.get("command")
        plant_id = input_data.get("plant_id")

        # Route to handler
        if command == "get_methods":
            result = handle_get_methods(plant_id)

        elif command == "estimate":
            result = handle_estimate(
                plant_id,
                method=input_data.get("method"),
                start_date=input_data.get("start_date"),
                end_date=input_data.get("end_date"),
            )

        elif command == "compare":
            result = handle_compare(
                plant_id,
                start_date=input_data.get("start_date"),
                end_date=input_data.get("end_date"),
            )

        elif command == "get_similarity":
            result = handle_get_similarity(
                plants=input_data.get("plants"),
            )

        elif command == "get_transfer_config":
            result = handle_get_transfer_config(plant_id)

        elif command == "set_transfer_source":
            result = handle_set_transfer_source(
                target_plant=plant_id,
                source_plant=input_data.get("source_plant"),
            )

        else:
            result = {"error": f"Unknown command: {command}"}

        # Write output to stdout
        print(json.dumps(result, default=str))

    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"Invalid JSON input: {str(e)}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"Internal error: {str(e)}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
