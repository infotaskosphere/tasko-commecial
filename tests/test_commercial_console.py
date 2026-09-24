import pytest
import os

os.environ["EMAIL_ENCRYPT_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
os.environ["PASSWORD_REPO_KEY"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
os.environ["JWT_SECRET"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="

def test_commercial_console_api_routes():
    from backend.commercial_console_api import router
    paths = [r.path for r in router.routes]
    assert "/api/commercial-console/system-health" in paths
    assert "/api/commercial-console/analytics" in paths
    assert "/api/commercial-console/activity" in paths
    assert "/api/commercial-console/omni-settings" in paths
    assert "/api/commercial-console/domains" in paths
    assert "/api/commercial-console/plans" in paths
