"""Compatibility fix for legacy user projections.

Some HR/task handlers use Mongo projections that exclude fields and later read
our application-level ``id`` field.  The previous shim force-added ``id: 1``
to every projection, which is invalid when the caller uses an exclusion
projection (MongoDB rejects mixing inclusion and exclusion fields).

This shim is intentionally narrow: for a users projection it only removes an
explicit ``id: 0`` exclusion.  Inclusion projections remain inclusion
projections, while exclusion projections remain exclusion projections.
"""

from backend.tenant_runtime import TenantAwareCollection


_original_find = TenantAwareCollection.find
_original_find_one = TenantAwareCollection.find_one


def _fix_user_projection(collection, args, kwargs):
    if collection._name != "users":
        return args, kwargs

    updated_args = list(args)
    projection = None
    projection_in_args = bool(updated_args and isinstance(updated_args[0], dict))

    if projection_in_args:
        projection = dict(updated_args[0])
    elif isinstance(kwargs.get("projection"), dict):
        projection = dict(kwargs["projection"])

    if projection is None or "id" not in projection:
        return args, kwargs

    # Only remove an explicit exclusion. Do NOT add id=1 to exclusion
    # projections, because MongoDB forbids mixing inclusion and exclusion.
    if projection.get("id") == 0:
        projection.pop("id", None)
        if projection_in_args:
            updated_args[0] = projection
        else:
            kwargs = dict(kwargs)
            kwargs["projection"] = projection

    return tuple(updated_args), kwargs


def _find(self, query=None, *args, **kwargs):
    args, kwargs = _fix_user_projection(self, args, kwargs)
    return _original_find(self, query, *args, **kwargs)


async def _find_one(self, query=None, *args, **kwargs):
    args, kwargs = _fix_user_projection(self, args, kwargs)
    return await _original_find_one(self, query, *args, **kwargs)


TenantAwareCollection.find = _find
TenantAwareCollection.find_one = _find_one
