def _route_paths(router):
    """Every route path, including routes of routers included into this one. Newer FastAPI keeps an included
    router as a wrapper object (no `.path`) instead of copying its routes, so look inside the wrapper."""
    paths = set()
    for r in router.routes:
        if hasattr(r, "path"):
            paths.add(r.path)
        elif hasattr(r, "original_router"):
            paths |= _route_paths(r.original_router)
    return paths


def test_finix_complete_router_has_all_agent_routes():
    from backend.accounting_ai.finix_complete_router import router
    paths = _route_paths(router)
    assert "/finix/ai/agent/propose" in paths
    assert "/finix/ai/feedback" in paths
    assert "/finix/ai/inbox" in paths
    assert "/finix/ai/inbox/action" in paths
    assert "/finix/ai/upload" in paths
    assert "/finix/ai/ask" in paths
    assert "/finix/ai/bank-transfer/propose" in paths
    assert "/finix/ai/reconciliation/inbox" in paths
    assert "/finix/ai/reconciliation/feedback" in paths
