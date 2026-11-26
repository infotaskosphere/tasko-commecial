"""Per-licensee scheduled jobs must resolve their licensees on the main loop.

APScheduler runs jobs in a worker thread while the Motor client is bound to
the main event loop. Resolving the licensees with ``asyncio.run`` on a new
loop failed with "Future attached to a different loop", so no per-licensee
job ever ran in production.
"""
import asyncio
import threading

import pytest

import backend.server as server
from backend import dependencies
from backend.server_modules import scheduler_jobs


def test_tenant_targets_run_on_the_main_event_loop(monkeypatch):
    mongomock_motor = pytest.importorskip("mongomock_motor")
    mock_client = mongomock_motor.AsyncMongoMockClient()
    monkeypatch.setattr(dependencies, "client", mock_client)

    main_loop = asyncio.new_event_loop()
    ready = threading.Event()

    def run_main():
        asyncio.set_event_loop(main_loop)
        main_loop.call_soon(ready.set)
        main_loop.run_forever()

    thread = threading.Thread(target=run_main, daemon=True)
    thread.start()
    ready.wait(5)
    monkeypatch.setattr(server, "app_event_loop", main_loop)

    seen_loops = []

    def fake_db_for_customer(customer_id, customer):
        seen_loops.append(asyncio.get_running_loop())
        return f"db_{customer_id}"

    monkeypatch.setattr("backend.tenant_database_manager.tenant_database_for_customer", fake_db_for_customer)

    async def seed():
        central = mock_client[dependencies.DB_NAME]
        await central.commercial_license_customers.insert_one({"id": "cus-1"})
        await central.companies.insert_one({"id": "co-1", "commercial_customer_id": "cus-1"})

    asyncio.run_coroutine_threadsafe(seed(), main_loop).result(5)

    results = []
    # Called from a scheduler-like worker thread.
    worker = threading.Thread(target=lambda: results.append(scheduler_jobs._tenant_targets()))
    worker.start()
    worker.join(10)
    main_loop.call_soon_threadsafe(main_loop.stop)
    thread.join(5)

    assert results == [[("cus-1", "co-1", "db_cus-1")]]
    assert seen_loops == [main_loop]
