"""Centralized email templates registry for Taskosphere.

Provides 15 system-critical templates with:
- Safe variable interpolation {{var}}
- HTML and plaintext fallbacks
- Branded, mobile-responsive layout
- Licensee-level overrides support
"""
import html
import re
from typing import Any, Dict, List, Optional
from datetime import datetime, timezone


def _base_html(title: str, content: str, support_email: str = "support@taskosphere.com", company_name: str = "TaskoSphere") -> str:
    return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{html.escape(title)}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; margin: 0; padding: 0; color: #1e293b; }}
    .wrapper {{ width: 100%; max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05); }}
    .header {{ background: linear-gradient(135deg, #0D3B66 0%, #1F6FB2 100%); padding: 32px 24px; text-align: center; color: #ffffff; }}
    .header h1 {{ margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }}
    .header p {{ margin: 6px 0 0; font-size: 13px; opacity: 0.85; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; }}
    .body {{ padding: 32px 28px; line-height: 1.6; font-size: 15px; color: #334155; }}
    .cta-btn {{ display: inline-block; background-color: #0D3B66; color: #ffffff !important; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; font-size: 14px; margin: 20px 0; }}
    .code-box {{ background-color: #f1f5f9; border: 1px dashed #cbd5e1; border-radius: 12px; padding: 18px; text-align: center; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #0D3B66; margin: 20px 0; font-family: monospace; }}
    .info-box {{ background-color: #eff6ff; border-left: 4px solid #1F6FB2; border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 18px 0; font-size: 14px; color: #1e3a8a; }}
    .alert-box {{ background-color: #fef2f2; border-left: 4px solid #ef4444; border-radius: 0 10px 10px 0; padding: 14px 18px; margin: 18px 0; font-size: 14px; color: #991b1b; }}
    .footer {{ background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 20px 24px; text-align: center; font-size: 12px; color: #64748b; }}
    .footer a {{ color: #1F6FB2; text-decoration: none; }}
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="header">
      <h1>{html.escape(company_name)}</h1>
      <p>{html.escape(title)}</p>
    </div>
    <div class="body">
      {content}
    </div>
    <div class="footer">
      <p style="margin: 0 0 6px;">Sent by <strong>{html.escape(company_name)}</strong> Security &amp; Notification Engine.</p>
      <p style="margin: 0;">Need assistance? Contact our team at <a href="mailto:{html.escape(support_email)}">{html.escape(support_email)}</a></p>
    </div>
  </div>
</body>
</html>"""


SYSTEM_TEMPLATES: Dict[str, Dict[str, Any]] = {
    "AUTH_WELCOME": {
        "code": "AUTH_WELCOME",
        "name": "Welcome New Account",
        "purpose": "Sent to new users when their account is provisioned or approved",
        "subject": "Welcome to {{company_name}} — Your Account Is Ready",
        "variables": ["user_name", "email", "company_name", "login_url", "support_email", "temporary_password"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "Welcome to {{company_name}}! Your account has been provisioned.\n\n"
            "Login Email: {{email}}\n"
            "Login URL: {{login_url}}\n\n"
            "If a temporary password was assigned, please sign in and set your new password.\n\n"
            "Best regards,\n{{company_name}} Team"
        ),
        "html_body": _base_html(
            "Account Provisioned",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>Welcome to <strong>{{company_name}}</strong>! Your account has been provisioned and is ready for use.</p>
            <div class="info-box">
              <p style="margin: 0 0 6px;"><strong>Registered Email:</strong> {{email}}</p>
              <p style="margin: 0;"><strong>Access Portal:</strong> <a href="{{login_url}}">{{login_url}}</a></p>
            </div>
            <p style="text-align: center;">
              <a href="{{login_url}}" class="cta-btn">Access Your Account &rarr;</a>
            </p>
            <p style="font-size: 13px; color: #64748b;">For your security, we recommend reviewing your notification settings after your first login.</p>"""
        ),
    },

    "EMAIL_VERIFICATION": {
        "code": "EMAIL_VERIFICATION",
        "name": "Email Verification Link",
        "purpose": "Sent to verify user or licensee email ownership",
        "subject": "Verify your email address for {{company_name}}",
        "variables": ["user_name", "email", "verification_link", "company_name", "support_email", "expiry_hours"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "Please verify your email address ({{email}}) for {{company_name}} by clicking the link below:\n\n"
            "{{verification_link}}\n\n"
            "This link will expire in {{expiry_hours}} hours.\n"
            "If you did not request this verification, you can safely ignore this email.\n\n"
            "Best regards,\n{{company_name}} Team"
        ),
        "html_body": _base_html(
            "Email Verification",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>Thank you for registering with <strong>{{company_name}}</strong>. Please confirm that <strong>{{email}}</strong> is your authorized email address.</p>
            <p style="text-align: center;">
              <a href="{{verification_link}}" class="cta-btn">Verify Email Address &rarr;</a>
            </p>
            <p style="font-size: 13px; color: #64748b;">Or copy and paste this verification URL into your browser:<br>
            <a href="{{verification_link}}" style="word-break: break-all; color: #1F6FB2;">{{verification_link}}</a></p>
            <div class="info-box">
              This link is secure, single-use, and valid for {{expiry_hours}} hours.
            </div>"""
        ),
    },

    "PASSWORD_RESET": {
        "code": "PASSWORD_RESET",
        "name": "Password Reset OTP & Link",
        "purpose": "Sent when a user requests a password reset",
        "subject": "Reset your {{company_name}} password — OTP {{otp}}",
        "variables": ["user_name", "email", "otp", "reset_link", "company_name", "expiry_minutes", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "We received a request to reset the password for your account ({{email}}).\n\n"
            "Your 6-digit One-Time Password (OTP) is: {{otp}}\n\n"
            "You can also reset directly via this secure link:\n{{reset_link}}\n\n"
            "This code will expire in {{expiry_minutes}} minutes. If you did not make this request, please change your credentials immediately or contact support.\n\n"
            "Best regards,\n{{company_name}} Team"
        ),
        "html_body": _base_html(
            "Password Reset Request",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>We received a request to reset the password associated with <strong>{{email}}</strong>.</p>
            <p>Enter the following 6-digit security code on the reset page:</p>
            <div class="code-box">{{otp}}</div>
            <p style="text-align: center;">
              <a href="{{reset_link}}" class="cta-btn">Reset Password Directly &rarr;</a>
            </p>
            <div class="alert-box">
              <strong>Security Notice:</strong> This code expires in {{expiry_minutes}} minutes. If you did not request a password reset, someone may be attempting to access your account. Please notify your administrator.
            </div>"""
        ),
    },

    "PASSWORD_CHANGED": {
        "code": "PASSWORD_CHANGED",
        "name": "Password Changed Notification",
        "purpose": "Sent immediately after a user's password is changed or reset",
        "subject": "Security Alert: Password Changed for {{company_name}} Account",
        "variables": ["user_name", "email", "company_name", "time", "ip_address", "support_email", "login_url"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "The password for your {{company_name}} account ({{email}}) was successfully updated on {{time}} from IP {{ip_address}}.\n\n"
            "All previous login sessions have been invalidated.\n\n"
            "If you performed this change, no further action is required.\n"
            "If you did NOT change your password, please contact support immediately at {{support_email}}.\n\n"
            "Best regards,\n{{company_name}} Security Team"
        ),
        "html_body": _base_html(
            "Password Changed",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>This is a confirmation that your <strong>{{company_name}}</strong> account password was changed successfully.</p>
            <div class="info-box">
              <p style="margin: 0 0 6px;"><strong>Account:</strong> {{email}}</p>
              <p style="margin: 0 0 6px;"><strong>Timestamp:</strong> {{time}}</p>
              <p style="margin: 0;"><strong>IP Address:</strong> {{ip_address}}</p>
            </div>
            <div class="alert-box">
              <strong>Did not make this change?</strong> All prior active sessions have been terminated. If this wasn't you, reset your password immediately or email <a href="mailto:{{support_email}}">{{support_email}}</a>.
            </div>"""
        ),
    },

    "FORGOT_EMAIL": {
        "code": "FORGOT_EMAIL",
        "name": "Forgot Email ID Recovery",
        "purpose": "Sent when a user requests recovery of their login email/identifier",
        "subject": "Account Recovery: Your {{company_name}} Registered Login Email",
        "variables": ["user_name", "masked_email", "company_name", "login_url", "support_email", "identifier"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "We received an account recovery request matching your registered reference ({{identifier}}).\n\n"
            "Your registered login email address is:\n{{masked_email}}\n\n"
            "You can log in at: {{login_url}}\n\n"
            "If you did not request this recovery, your account remains secure and no credentials were changed.\n\n"
            "Best regards,\n{{company_name}} Security Team"
        ),
        "html_body": _base_html(
            "Account Identifier Recovery",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>You requested recovery of your login email address for <strong>{{company_name}}</strong> using reference <code>{{identifier}}</code>.</p>
            <div class="info-box">
              <p style="margin: 0; font-size: 16px;"><strong>Your registered login email is:</strong></p>
              <p style="margin: 8px 0 0; font-size: 20px; font-weight: 700; color: #0D3B66; font-family: monospace;">{{masked_email}}</p>
            </div>
            <p style="text-align: center;">
              <a href="{{login_url}}" class="cta-btn">Proceed to Sign In &rarr;</a>
            </p>
            <p style="font-size: 13px; color: #64748b;">If you need further help recovering access, please reach out to <a href="mailto:{{support_email}}">{{support_email}}</a>.</p>"""
        ),
    },

    "NEW_LOGIN": {
        "code": "NEW_LOGIN",
        "name": "New Login Detected",
        "purpose": "Sent when an account signs in from a new IP or device",
        "subject": "Security Notice: New Login to {{company_name}}",
        "variables": ["user_name", "email", "time", "ip_address", "device_info", "company_name", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "A new login to your {{company_name}} account ({{email}}) was recorded.\n\n"
            "Time: {{time}}\n"
            "IP Address: {{ip_address}}\n"
            "Device: {{device_info}}\n\n"
            "If this was you, you can disregard this email.\n"
            "If this wasn't you, please secure your account immediately.\n\n"
            "Best regards,\n{{company_name}} Security Team"
        ),
        "html_body": _base_html(
            "New Login Detected",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p>We detected a new sign-in to your <strong>{{company_name}}</strong> account.</p>
            <div class="info-box">
              <p style="margin: 0 0 6px;"><strong>Timestamp:</strong> {{time}}</p>
              <p style="margin: 0 0 6px;"><strong>IP Address:</strong> {{ip_address}}</p>
              <p style="margin: 0;"><strong>Client / Device:</strong> {{device_info}}</p>
            </div>
            <div class="alert-box">
              If you did not sign in at this time, please change your password immediately or notify your administrator.
            </div>"""
        ),
    },

    "SECURITY_ALERT": {
        "code": "SECURITY_ALERT",
        "name": "Platform Security Alert",
        "purpose": "Sent to administrators or users on suspicious activity",
        "subject": "CRITICAL: Security Alert for {{company_name}} — {{alert_type}}",
        "variables": ["user_name", "alert_type", "details", "time", "ip_address", "company_name", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "SECURITY ALERT for {{company_name}}:\n"
            "Type: {{alert_type}}\n"
            "Time: {{time}}\n"
            "Source IP: {{ip_address}}\n"
            "Details: {{details}}\n\n"
            "Please review your system logs immediately.\n\n"
            "Best regards,\nTaskoSphere Security"
        ),
        "html_body": _base_html(
            "Security Incident Alert",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <div class="alert-box">
              <h3 style="margin: 0 0 8px; color: #991b1b;">Incident Detected: {{alert_type}}</h3>
              <p style="margin: 0 0 6px;"><strong>Time:</strong> {{time}}</p>
              <p style="margin: 0 0 6px;"><strong>Source IP:</strong> {{ip_address}}</p>
              <p style="margin: 0;"><strong>Details:</strong> {{details}}</p>
            </div>
            <p>Please log in to the Commercial Console to inspect active sessions and security logs.</p>"""
        ),
    },

    "LICENSE_CREATED": {
        "code": "LICENSE_CREATED",
        "name": "Commercial License Created",
        "purpose": "Sent to Licensee when a new commercial license is issued",
        "subject": "Your {{company_name}} Commercial License has been Issued (Key: {{license_key}})",
        "variables": ["licensee_name", "license_key", "package_name", "expiry_date", "max_users", "company_name", "login_url", "support_email"],
        "text_body": (
            "Hello {{licensee_name}},\n\n"
            "Your commercial license for {{company_name}} has been created!\n\n"
            "License Key: {{license_key}}\n"
            "Package: {{package_name}}\n"
            "Max Users: {{max_users}}\n"
            "Expiry Date: {{expiry_date}}\n\n"
            "Access your console: {{login_url}}\n\n"
            "Best regards,\n{{company_name}} Commercial Team"
        ),
        "html_body": _base_html(
            "License Issued",
            """<p>Dear <strong>{{licensee_name}}</strong>,</p>
            <p>We are delighted to confirm that your <strong>{{company_name}}</strong> commercial license has been issued.</p>
            <div class="info-box">
              <p style="margin: 0 0 6px;"><strong>License Key:</strong> <code style="font-size: 15px; font-weight: bold;">{{license_key}}</code></p>
              <p style="margin: 0 0 6px;"><strong>Plan / Tier:</strong> {{package_name}}</p>
              <p style="margin: 0 0 6px;"><strong>Seat Capacity:</strong> {{max_users}} user(s)</p>
              <p style="margin: 0;"><strong>Valid Until:</strong> {{expiry_date}}</p>
            </div>
            <p style="text-align: center;">
              <a href="{{login_url}}" class="cta-btn">Access License Console &rarr;</a>
            </p>"""
        ),
    },

    "LICENSE_ACTIVATED": {
        "code": "LICENSE_ACTIVATED",
        "name": "Commercial License Activated",
        "purpose": "Sent when an installation node or customer activates their license",
        "subject": "License Activation Successful — {{licensee_name}}",
        "variables": ["licensee_name", "license_key", "node_id", "time", "company_name", "support_email"],
        "text_body": (
            "Hello {{licensee_name}},\n\n"
            "Your license {{license_key}} has been successfully activated on node {{node_id}} at {{time}}.\n\n"
            "Best regards,\n{{company_name}} Licensing System"
        ),
        "html_body": _base_html(
            "License Activated",
            """<p>Hello <strong>{{licensee_name}}</strong>,</p>
            <p>Your commercial license has been activated on an operational node.</p>
            <div class="info-box">
              <p style="margin: 0 0 6px;"><strong>License Key:</strong> {{license_key}}</p>
              <p style="margin: 0 0 6px;"><strong>Node / Machine:</strong> {{node_id}}</p>
              <p style="margin: 0;"><strong>Activation Time:</strong> {{time}}</p>
            </div>"""
        ),
    },

    "LICENSE_EXPIRING": {
        "code": "LICENSE_EXPIRING",
        "name": "License Expiring Soon Notice",
        "purpose": "Sent 30/15/7 days before a license reaches expiration",
        "subject": "ACTION REQUIRED: Your {{company_name}} License Expires on {{expiry_date}}",
        "variables": ["licensee_name", "license_key", "expiry_date", "days_remaining", "company_name", "support_email", "billing_url"],
        "text_body": (
            "Hello {{licensee_name}},\n\n"
            "Your license {{license_key}} will expire in {{days_remaining}} days (on {{expiry_date}}).\n\n"
            "Please renew your subscription to prevent service interruption.\n\n"
            "Best regards,\n{{company_name}} Licensing Team"
        ),
        "html_body": _base_html(
            "License Expiration Warning",
            """<p>Hello <strong>{{licensee_name}}</strong>,</p>
            <div class="alert-box">
              <strong>Your commercial subscription will expire in {{days_remaining}} days (on {{expiry_date}}).</strong>
            </div>
            <p>To ensure uninterrupted access to your enterprise modules and data pipelines, please contact our billing team or renew your subscription online.</p>
            <div class="info-box">
              <strong>License Key:</strong> {{license_key}}
            </div>"""
        ),
    },

    "LICENSE_EXPIRED": {
        "code": "LICENSE_EXPIRED",
        "name": "License Expired Notification",
        "purpose": "Sent when a license reaches expiration without renewal",
        "subject": "URGENT: Your {{company_name}} License Has Expired",
        "variables": ["licensee_name", "license_key", "company_name", "support_email", "reactivate_url"],
        "text_body": (
            "Hello {{licensee_name}},\n\n"
            "Your {{company_name}} license ({{license_key}}) has expired.\n\n"
            "Access to commercial features has been suspended. Please contact {{support_email}} to reactivate.\n\n"
            "Best regards,\n{{company_name}} Team"
        ),
        "html_body": _base_html(
            "License Expired",
            """<p>Hello <strong>{{licensee_name}}</strong>,</p>
            <div class="alert-box">
              <strong>Notice of Expiration:</strong> Your commercial license (<code>{{license_key}}</code>) has reached its term end.
            </div>
            <p>Operational access has been placed in read-only/suspended mode. Your data is preserved safely. Contact support to renew your license.</p>"""
        ),
    },

    "USER_INVITATION": {
        "code": "USER_INVITATION",
        "name": "Team Member Invitation",
        "purpose": "Sent when an administrator invites a colleague or staff member",
        "subject": "You have been invited to join {{licensee_name}} on {{company_name}}",
        "variables": ["user_name", "licensee_name", "inviter_name", "role", "invite_link", "company_name", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "{{inviter_name}} has invited you to join {{licensee_name}} on {{company_name}} as a {{role}}.\n\n"
            "Accept your invitation and set up your account here:\n{{invite_link}}\n\n"
            "Best regards,\n{{company_name}} Team"
        ),
        "html_body": _base_html(
            "Team Invitation",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <p><strong>{{inviter_name}}</strong> has invited you to collaborate on <strong>{{licensee_name}}</strong> within <strong>{{company_name}}</strong> with the role of <strong>{{role}}</strong>.</p>
            <p style="text-align: center;">
              <a href="{{invite_link}}" class="cta-btn">Accept Invitation &amp; Join Team &rarr;</a>
            </p>"""
        ),
    },

    "ACCOUNT_LOCKED": {
        "code": "ACCOUNT_LOCKED",
        "name": "Account Security Lockout",
        "purpose": "Sent when an account is temporarily locked due to excessive failed attempts",
        "subject": "Security Alert: Your {{company_name}} Account Has Been Temporarily Locked",
        "variables": ["user_name", "email", "time", "ip_address", "unlock_time", "company_name", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "Your account ({{email}}) has been temporarily locked due to multiple failed login attempts.\n\n"
            "Time: {{time}}\n"
            "Lock Duration: Until {{unlock_time}}\n\n"
            "If you forgot your password, please use the Forgot Password link to reset it.\n\n"
            "Best regards,\n{{company_name}} Security Team"
        ),
        "html_body": _base_html(
            "Account Temporarily Locked",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <div class="alert-box">
              Your account ({{email}}) was locked following multiple unsuccessful sign-in attempts from IP {{ip_address}}.
            </div>
            <p>To protect your confidential business data, logins are suspended until <strong>{{unlock_time}}</strong>.</p>"""
        ),
    },

    "ACCOUNT_UNLOCKED": {
        "code": "ACCOUNT_UNLOCKED",
        "name": "Account Unlocked Notice",
        "purpose": "Sent when an account lockout expires or is manually cleared by an admin",
        "subject": "Account Unlocked — You may now sign in to {{company_name}}",
        "variables": ["user_name", "email", "login_url", "company_name", "support_email"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "Your account ({{email}}) has been unlocked. You may now sign in.\n\n"
            "Login: {{login_url}}\n\n"
            "Best regards,\n{{company_name}} Security Team"
        ),
        "html_body": _base_html(
            "Account Unlocked",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <div class="info-box">
              Your account ({{email}}) is active again and ready for sign-in.
            </div>
            <p style="text-align: center;">
              <a href="{{login_url}}" class="cta-btn">Sign In Now &rarr;</a>
            </p>"""
        ),
    },

    "SYSTEM_NOTIFICATION": {
        "code": "SYSTEM_NOTIFICATION",
        "name": "General System Notification",
        "purpose": "Sent for maintenance broadcasts, administrative alerts, or custom notices",
        "subject": "{{company_name}} Notification: {{notification_title}}",
        "variables": ["user_name", "notification_title", "notification_message", "company_name", "support_email", "action_url"],
        "text_body": (
            "Hello {{user_name}},\n\n"
            "{{notification_title}}\n\n"
            "{{notification_message}}\n\n"
            "Best regards,\n{{company_name}} System"
        ),
        "html_body": _base_html(
            "System Notice",
            """<p>Hello <strong>{{user_name}}</strong>,</p>
            <h3 style="color: #0D3B66; margin-top: 0;">{{notification_title}}</h3>
            <p style="white-space: pre-wrap; font-size: 15px;">{{notification_message}}</p>"""
        ),
    },
}


def render_template(
    template_def: Any,
    context: Dict[str, Any],
    licensee_branding: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """
    Renders subject, html_body, and text_body by substituting {{variables}}.
    HTML values are sanitized to prevent unsafe script injection.
    Supports either a template dict or template code string (e.g. 'AUTH_WELCOME').
    """
    if isinstance(template_def, str):
        template_def = SYSTEM_TEMPLATES.get(template_def, {
            "subject": "Notification",
            "html_body": "<p>{{message}}</p>",
            "text_body": "{{message}}"
        })
    merged_context = {
        "company_name": "TaskoSphere",
        "support_email": "support@taskosphere.com",
        "login_url": "https://taskosphere.com/login",
        "user_name": "Valued User",
        "email": "",
        "time": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        **context,
    }

    if licensee_branding:
        if licensee_branding.get("company_name"):
            merged_context["company_name"] = licensee_branding["company_name"]
        if licensee_branding.get("support_email"):
            merged_context["support_email"] = licensee_branding["support_email"]

    def _replace_var(match: re.Match, is_html: bool = False) -> str:
        key = match.group(1).strip()
        val = merged_context.get(key, "")
        if val is None:
            return ""
        val_str = str(val)
        if is_html and key not in ("verification_link", "reset_link", "login_url", "invite_link", "action_url", "billing_url"):
            return html.escape(val_str)
        return val_str

    subject_pattern = re.compile(r"\{\{([a-zA-Z0-9_]+)\}\}")
    rendered_subject = subject_pattern.sub(lambda m: _replace_var(m, False), template_def.get("subject", ""))
    rendered_text = subject_pattern.sub(lambda m: _replace_var(m, False), template_def.get("text_body", ""))
    rendered_html = subject_pattern.sub(lambda m: _replace_var(m, True), template_def.get("html_body", ""))

    return {
        "subject": rendered_subject,
        "text_body": rendered_text,
        "html_body": rendered_html,
    }
