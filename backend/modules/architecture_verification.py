"""Final architecture verification contract.

This module reports readiness without changing runtime configuration.
Deployment tooling should consume the report after CI has passed.
"""
from __future__ import annotations

from backend.modules.final_architecture_contract import ARCHITECTURE_GATES


REQUIRED_GATES = tuple(ARCHITECTURE_GATES)


def verification_report() -> dict[str, bool]:
    return {gate: bool(ARCHITECTURE_GATES[gate]) for gate in REQUIRED_GATES}


def is_ready_for_final_verification() -> bool:
    return all(verification_report().values())
