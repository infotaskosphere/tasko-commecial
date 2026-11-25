"""The startup routine (indexes, bootstrap, scheduler) must run whichever way
the server is started: ``uvicorn backend.server:app`` (Render today) or
``python -m backend.run``. It must be registered exactly once."""
import backend.server as server
import backend.run  # noqa: F401  (must not register it a second time)


def _startup_handlers(app):
    return list(getattr(app.router, "on_startup", []) or [])


def test_startup_event_is_registered_once_on_the_server_app():
    handlers = _startup_handlers(server.app)
    assert sum(1 for h in handlers if h is server.startup_event) == 1
    assert server.app.state._taskosphere_startup_registered is True
