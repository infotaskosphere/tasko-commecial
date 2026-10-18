import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from backend.copilot.context_manager import ContextManager
from backend.copilot.conversation_manager import ConversationManager
from backend.copilot.reasoning_engine import ReasoningEngine
from backend.copilot.tool_router import ToolRouter


class FakeCursor:
    def __init__(self, rows=None):
        self.rows = rows or []

    def sort(self, *_args, **_kwargs):
        return self

    async def to_list(self, _length=100):
        return self.rows


class FakeCollection:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.find_queries = []
        self.count_queries = []
        self.find_one_queries = []
        self.update_queries = []

    def find(self, query=None, _projection=None):
        self.find_queries.append(query or {})
        return FakeCursor(self.rows)

    async def count_documents(self, query):
        self.count_queries.append(query)
        return 0

    async def find_one(self, query, *_args, **_kwargs):
        self.find_one_queries.append(query)
        return {"id": query.get("id")} if query.get("id") else None

    async def update_one(self, query, _update):
        self.update_queries.append(query)
        return SimpleNamespace(modified_count=1)

    async def insert_one(self, _document):
        return SimpleNamespace(inserted_id="test-id")


def fake_db():
    return SimpleNamespace(
        invoices=FakeCollection(),
        tasks=FakeCollection(),
        clients=FakeCollection(),
        ai_document_memory=FakeCollection(),
        approval_requests=FakeCollection(),
        gst_reconciliation_history=FakeCollection(),
        compliance_records=FakeCollection(),
        bank_accounts=FakeCollection(),
        copilot_sessions=FakeCollection(),
        copilot_actions=FakeCollection(),
        audit_platform=FakeCollection(),
        customer_usage=FakeCollection(),
    )


class FakeGeminiResponse:
    def raise_for_status(self):
        return None

    def json(self):
        return {"candidates": [{"content": {"parts": [{"text": "Async test answer"}]}}]}


class FakeAsyncGeminiClient:
    def __init__(self, *args, **kwargs):
        self.timeout = kwargs.get("timeout")

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def post(self, *_args, **_kwargs):
        # Yield to the event loop like a real asynchronous network call.
        await asyncio.sleep(0)
        return FakeGeminiResponse()


class CopilotResilienceTests(unittest.IsolatedAsyncioTestCase):
    async def test_ai_provider_yields_to_other_async_work(self):
        async def run_provider_and_ticker():
            ticker_ran = asyncio.Event()

            async def ticker():
                await asyncio.sleep(0)
                ticker_ran.set()

            answer_task = asyncio.create_task(
                ReasoningEngine.get_response("hello", context_data={})
            )
            ticker_task = asyncio.create_task(ticker())
            result, _ = await asyncio.gather(answer_task, ticker_task)
            return result, ticker_ran.is_set()

        with patch.dict(os.environ, {
            "GEMINI_API_KEY": "test-key",
            "DEFAULT_AI_PROVIDER": "gemini",
            "COPILOT_PROVIDER_TIMEOUT_SECONDS": "1",
            "COPILOT_TOTAL_TIMEOUT_SECONDS": "3",
        }, clear=False), patch(
            "backend.copilot.reasoning_engine.httpx.AsyncClient",
            FakeAsyncGeminiClient,
        ):
            result, ticker_ran = await run_provider_and_ticker()

        self.assertTrue(ticker_ran, "AI network call must not block the event loop")
        self.assertEqual(result["provider"], "gemini")
        self.assertEqual(result["text"], "Async test answer")

    async def test_workspace_context_counts_are_company_scoped(self):
        db = fake_db()
        with patch("backend.copilot.context_manager.db", db):
            result = await ContextManager.gather_user_context("company-A", "tenant-A")

        self.assertEqual(result["company_id"], "company-A")
        for collection in (
            db.invoices, db.tasks, db.clients, db.ai_document_memory, db.approval_requests
        ):
            self.assertTrue(collection.count_queries)
            self.assertTrue(all(q.get("company_id") == "company-A" for q in collection.count_queries))

    async def test_missing_company_scope_fails_closed(self):
        db = fake_db()
        with patch("backend.copilot.tool_router.db", db):
            result = await ToolRouter.execute_matched_tool({
                "module": "clients",
                "action": "list_clients",
                "args": {"company_id": "default_comp"},
            })

        self.assertEqual(result["status"], "FAILED")
        self.assertEqual(db.clients.find_queries, [])

    async def test_invoice_fallback_and_tasks_clients_are_company_scoped(self):
        db = fake_db()
        with patch("backend.copilot.tool_router.db", db):
            await ToolRouter.execute_matched_tool({
                "module": "invoices", "action": "list_outstanding",
                "args": {"company_id": "company-A"},
            })
            await ToolRouter.execute_matched_tool({
                "module": "tasks", "action": "list_tasks",
                "args": {"company_id": "company-A"},
            })
            await ToolRouter.execute_matched_tool({
                "module": "clients", "action": "list_clients",
                "args": {"company_id": "company-A"},
            })

        self.assertGreaterEqual(len(db.invoices.find_queries), 2)
        for collection in (db.invoices, db.tasks, db.clients):
            self.assertTrue(collection.find_queries)
            self.assertTrue(all(q.get("company_id") == "company-A" for q in collection.find_queries))

    async def test_conversation_reads_and_writes_are_owner_scoped(self):
        db = fake_db()
        with patch("backend.copilot.conversation_manager.db", db):
            await ConversationManager.get_session("session-A", "user-A", "company-A")
            await ConversationManager.append_message(
                "session-A", "user", "hello", "user-A", "company-A"
            )

        expected = {"id": "session-A", "user_id": "user-A", "company_id": "company-A"}
        self.assertEqual(db.copilot_sessions.find_one_queries[0], expected)
        self.assertEqual(db.copilot_sessions.update_queries[0], expected)


if __name__ == "__main__":
    unittest.main()
