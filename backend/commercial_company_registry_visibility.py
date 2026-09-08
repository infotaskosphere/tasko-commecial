"""Keep license-generated companies out of the Platform Owner Company Master.

License generation creates a commercial customer record plus an internal
operational company record so tenant relationships remain intact. That record
must remain visible to the License Registry, but it must not appear in the
Platform Owner's normal Company Master list. Companies created through Company
Master / Quotations remain visible.
"""

from backend import tenant_runtime


_ORIGINAL = tenant_runtime._scope_company_registry_query


def _scope_company_registry_query(query):
    scoped = _ORIGINAL(query)
    if tenant_runtime.in_platform_owner_context() and isinstance(scoped, dict):
        # Preserve an explicit caller filter while always excluding the hidden
        # company created as part of commercial license generation.
        existing = scoped.get("source")
        if existing is None:
            scoped["source"] = {"$ne": "commercial-license"}
        elif isinstance(existing, str) and existing == "commercial-license":
            # A platform-owner operational Company Master request should never
            # be able to opt back into the hidden license-created records.
            scoped["source"] = {"$ne": "commercial-license"}
    return scoped


tenant_runtime._scope_company_registry_query = _scope_company_registry_query
