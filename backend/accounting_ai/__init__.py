"""Finix Accounting AI package.

Keep package initialization side-effect free. Accounting modules are imported
individually by the application and some of them depend on the accounting
integrity boundary. Eagerly importing the whole dependency graph here causes
a circular import during Uvicorn startup (accounting_lock -> accounting_controls
-> accounting_ai package -> accounting_engine -> ... -> accounting_controls).
"""

# Deliberately no eager submodule imports here.
# This makes ``from backend.accounting_ai.some_module import X`` safe during
# application bootstrap and avoids executing the complete accounting graph.

__all__ = []
