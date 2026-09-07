"""Compatibility fix for legacy user projections.

Some attendance/HR handlers read user records by ``id`` after requesting a
narrow Mongo projection that omitted the ``id`` field.  That turns into a
KeyError at response time.  This additive shim keeps the existing queries and
behavior intact while guaranteeing ``id`` is present whenever the users
collection is queried with a projection.
"""

from backend.tenant_runtime import TenantAwareCollection


_original_find = TenantAwareCollection.find
_original_find_one = TenantAwareCollection.find_one


def _with_user_id_projection(collection, args, kwargs):
    if collection._name != "users":
        return args, kwargs

    updated_args = list(args)
    if updated_args and isinstance(updated_args[0], dict):
        projection = dict(updated_args[0])
        projection["id"] = 1
        updated_args[0] = projection
    elif isinstance(kwargs.get("projection"), dict):
        projection = dict(kwargs["projection"])
        projection["id"] = 1
        kwargs = dict(kwargs)
        kwargs["projection"] = projection

    return tuple(updated_args), kwargs


def _find(self, query=None, *args, **kwargs):
    args, kwargs = _with_user_id_projection(self, args, kwargs)
    return _original_find(self, query, *args, **kwargs)


async def _find_one(self, query=None, *args, **kwargs):
    args, kwargs = _with_user_id_projection(self, args, kwargs)
    return await _original_find_one(self, query, *args, **kwargs)


TenantAwareCollection.find = _find
TenantAwareCollection.find_one = _find_one
