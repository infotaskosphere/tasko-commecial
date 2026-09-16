"""Compatibility guard for legacy Finix purchase-invoice pagination.

Older commercial Bank Accounts frontend builds request up to 2000 purchase
invoices. The canonical purchase-invoice endpoint currently validates
page_size at 1000, which makes the otherwise valid read fail with HTTP 422.
Keep the compatibility narrowly scoped to that route declaration so no other
FastAPI Query validation is changed.
"""

import inspect

import fastapi

_ORIGINAL_QUERY = fastapi.Query
_INSTALLED = False


def _compat_query(default=None, *args, **kwargs):
    if kwargs.get("le") == 1000:
        for frame_info in inspect.stack()[1:8]:
            filename = str(frame_info.filename or "")
            if (
                frame_info.function == "list_purchase_invoices"
                and filename.endswith("invoicing.py")
            ):
                kwargs["le"] = 2000
                break
    return _ORIGINAL_QUERY(default, *args, **kwargs)


def install():
    global _INSTALLED
    if _INSTALLED:
        return
    fastapi.Query = _compat_query
    _INSTALLED = True
