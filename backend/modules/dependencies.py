"""Declarative domain dependency metadata."""
from types import MappingProxyType

MODULE_DEPENDENCIES = MappingProxyType({
    "taskosphere": ("people_matrix", "platform"),
    "finix_ai": ("taskosphere", "platform"),
    "aiweave": ("people_matrix", "platform"),
    "compligenie": ("taskosphere", "people_matrix", "platform"),
    "leadsense": ("taskosphere", "people_matrix", "platform"),
    "people_matrix": ("platform",),
    "records": ("taskosphere", "people_matrix", "platform"),
    "trademark": ("taskosphere", "people_matrix", "platform"),
})
