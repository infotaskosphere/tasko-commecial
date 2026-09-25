"""Taskosphere SaaS Platform modules.

Platform managers are loaded lazily to preserve the legacy public exports
without creating an import cycle while the compatibility model facade loads.
"""

__all__ = [
    "TenantManager",
    "OrganizationManager",
    "SubscriptionManager",
    "LicenseManager",
    "FeatureManager",
    "StorageManager",
    "APIGateway",
    "ConfigurationManager",
    "EnvironmentManager",
    "PlatformEngine",
]

_LAZY_EXPORTS = {
    "TenantManager": ("backend.platform.tenant_manager", "TenantManager"),
    "OrganizationManager": ("backend.platform.organization_manager", "OrganizationManager"),
    "SubscriptionManager": ("backend.platform.subscription_manager", "SubscriptionManager"),
    "LicenseManager": ("backend.platform.license_manager", "LicenseManager"),
    "FeatureManager": ("backend.platform.feature_manager", "FeatureManager"),
    "StorageManager": ("backend.platform.storage_manager", "StorageManager"),
    "APIGateway": ("backend.platform.api_gateway", "APIGateway"),
    "ConfigurationManager": ("backend.platform.configuration_manager", "ConfigurationManager"),
    "EnvironmentManager": ("backend.platform.environment_manager", "EnvironmentManager"),
    "PlatformEngine": ("backend.platform.platform_engine", "PlatformEngine"),
}


def __getattr__(name):
    target = _LAZY_EXPORTS.get(name)
    if target is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, attribute_name = target
    from importlib import import_module
    module = import_module(module_name)
    value = getattr(module, attribute_name)
    globals()[name] = value
    return value
