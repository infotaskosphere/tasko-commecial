"""Unified Finix AI routes.

Keeps the existing accounting engine authoritative while exposing the complete
agent workflow from one stable router. Existing Finix routes remain available.
"""
from fastapi import APIRouter
from backend.accounting_ai.finix_agent_mount import router as agent_router
from backend.accounting_ai.finix_reconciliation_agent import router as reconciliation_router

router = APIRouter()
router.include_router(agent_router)
router.include_router(reconciliation_router)
