def test_finix_complete_router_has_all_agent_routes():
    from backend.accounting_ai.finix_complete_router import router
    paths = {r.path for r in router.routes}
    assert "/finix/ai/agent/propose" in paths
    assert "/finix/ai/feedback" in paths
    assert "/finix/ai/inbox" in paths
    assert "/finix/ai/inbox/action" in paths
    assert "/finix/ai/upload" in paths
    assert "/finix/ai/ask" in paths
    assert "/finix/ai/bank-transfer/propose" in paths
    assert "/finix/ai/reconciliation/inbox" in paths
    assert "/finix/ai/reconciliation/feedback" in paths
