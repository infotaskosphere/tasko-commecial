from datetime import datetime, timezone
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class EmailProviderConfig(BaseModel):
    provider_type: str = "smtp"  # "smtp" | "sendgrid" | "brevo"
    is_enabled: bool = True

    # Sender settings
    from_name: str = "TaskoSphere"
    from_email: str = "notifications@taskosphere.com"
    reply_to: Optional[str] = None

    # SMTP Settings
    smtp_host: Optional[str] = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_username: Optional[str] = ""
    smtp_password: Optional[str] = ""  # Plaintext in DB or encrypted, masked in UI
    smtp_use_tls: bool = True
    smtp_use_ssl: bool = False

    # SendGrid Settings
    sendgrid_api_key: Optional[str] = ""
    sendgrid_sender_verified: bool = False

    # Brevo Settings (backward-compatibility)
    brevo_api_key: Optional[str] = ""

    # Status tracking
    last_connected_at: Optional[str] = None
    last_test_success_at: Optional[str] = None
    last_test_failure_at: Optional[str] = None
    last_test_error: Optional[str] = None
    last_email_sent_at: Optional[str] = None
    last_email_failed_at: Optional[str] = None
    last_email_error: Optional[str] = None


class MaskedEmailConfig(BaseModel):
    provider_type: str
    is_enabled: bool
    from_name: str
    from_email: str
    reply_to: Optional[str] = None
    smtp_host: Optional[str] = None
    smtp_port: int
    smtp_username: Optional[str] = None
    smtp_password_masked: Optional[str] = None
    smtp_use_tls: bool
    smtp_use_ssl: bool
    sendgrid_api_key_masked: Optional[str] = None
    sendgrid_sender_verified: bool
    brevo_api_key_masked: Optional[str] = None
    last_connected_at: Optional[str] = None
    last_test_success_at: Optional[str] = None
    last_test_failure_at: Optional[str] = None
    last_test_error: Optional[str] = None
    last_email_sent_at: Optional[str] = None
    last_email_failed_at: Optional[str] = None
    last_email_error: Optional[str] = None


class EmailTemplateDoc(BaseModel):
    code: str
    name: str
    purpose: str
    subject: str
    html_body: str
    text_body: str
    variables: List[str] = Field(default_factory=list)
    is_active: bool = True
    is_system: bool = True
    updated_at: Optional[str] = None
    updated_by: Optional[str] = None


class AccountRecoverySettings(BaseModel):
    enable_forgot_password: bool = True
    enable_forgot_email: bool = True
    require_email_verification: bool = False
    enable_security_notifications: bool = True
    enable_new_login_alerts: bool = True
    enable_password_changed_alerts: bool = True
    password_reset_token_expiry_minutes: int = 15
    email_verification_token_expiry_hours: int = 24
    max_reset_requests_per_hour: int = 5
    reset_rate_limit_per_minute: int = 3
    recovery_attempt_limit_per_hour: int = 5


class EmailDeliveryLog(BaseModel):
    id: str
    recipient: str
    subject: str
    template_code: Optional[str] = None
    email_type: str = "transactional"  # "auth" | "notification" | "system" | "license" | "test"
    provider: str = "smtp"
    status: str = "QUEUED"  # "QUEUED" | "SENDING" | "SENT" | "FAILED" | "RETRYING"
    retry_count: int = 0
    max_retries: int = 3
    error_message: Optional[str] = None
    related_user_id: Optional[str] = None
    related_licensee_id: Optional[str] = None
    created_at: str
    sent_at: Optional[str] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class TestEmailRequest(BaseModel):
    recipient_email: str
    subject: Optional[str] = "TaskoSphere Mail Pipeline Test"
    message: Optional[str] = None


class ForgotEmailRequest(BaseModel):
    identifier: str  # Phone number, license key, or GSTIN
