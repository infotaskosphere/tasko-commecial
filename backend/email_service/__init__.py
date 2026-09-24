"""Taskosphere Centralized Email Service.

Provides a unified, provider-agnostic email delivery pipeline for the entire platform:
- SMTP (standard TLS / SSL)
- SendGrid (v3 REST API)
- Brevo (v3 REST API backward compatibility)
- Future provider adapters
"""
from backend.email_service.service import email_service

__all__ = ["email_service"]
