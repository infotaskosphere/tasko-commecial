"""Machine-readable migration status for architecture phases."""
from types import MappingProxyType

MIGRATION_STATUS = MappingProxyType({
    "taskosphere": "facade",
    "finix_ai": "facade",
    "aiweave": "facade",
    "compligenie": "facade",
    "leadsense": "facade",
    "people_matrix": "facade",
    "records": "boundary",
    "trademark": "facade",
})

FINAL_RUNTIME_MIGRATION_ENABLED = False
