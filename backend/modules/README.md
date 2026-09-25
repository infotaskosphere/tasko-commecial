# Domain module architecture

The backend/modules tree is the target ownership boundary for ERP subsystems.

Migration rule: new package boundaries and facades must not change production
router registration until their import graph and runtime behavior are verified.

The existing backend/server.py composition layer remains authoritative during
migration.

Domain modules may consume declared shared/platform capabilities. Cross-domain
dependencies are documented in dependencies.py.
