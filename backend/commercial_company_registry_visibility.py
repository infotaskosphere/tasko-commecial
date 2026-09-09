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
    if isinstance(scoped, dict):
        # Platform Owner Company Master is for operational companies (to create tasks,
        # add employees, issue invoices). Companies generated for commercial customer
        # licenses must never appear in Company Master.
        scoped["source"] = {"$nin": ["commercial-license", "commercial", "license"]}
        scoped["commercial_customer_id"] = {"$in": [None, ""]}
    return scoped


tenant_runtime._scope_company_registry_query = _scope_company_registry_query
