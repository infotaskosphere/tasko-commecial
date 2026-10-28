"""Phase 2 extracted subsystem: dsc_routes.

This is a normal module. It used to be stored as a string (SOURCE) and run
with exec() inside backend.server's namespace. Every name it borrowed from
that shared namespace is now imported explicitly below, from the same
object the shared namespace held. It is loaded (in the original order) by
backend/server_modules/dsc_routes.py via backend.server_modules.routes.load_into().
"""
from backend.dependencies import check_module_permission
from backend.dependencies import check_permission
from backend.dependencies import db
from backend.dependencies import get_current_user
from backend.models import DSC
from backend.models import DSCCreate
from backend.models import DSCListResponse
from backend.models import DSCMovementRequest
from backend.models import MovementUpdateRequest
from backend.models import User
from backend.server_modules.helpers import create_audit_log
from datetime import date
from datetime import datetime
from datetime import timezone
from fastapi import Depends
from fastapi import HTTPException
from fastapi import Query
from pydantic import BaseModel
from typing import Optional
import re
import uuid
from backend.server import IST, api_router, logger  # created in backend/server.py before route modules load

def _to_iso(val) -> Optional[str]:
    """Safely convert datetime/date/string/None to ISO string for MongoDB storage."""
    if val is None:
        return None
    if isinstance(val, (datetime, date)):
        return val.isoformat()
    return str(val)  # already a plain string like "2026-03-22"


# ─── DSC Certificate Reader ────────────────────────────────────────────────────
class DSCReadRequest(BaseModel):
    pin: str
    lib_path: Optional[str] = None  # optional override for PKCS#11 library path


class DSCCertificateData(BaseModel):
    holder_name: Optional[str] = None
    serial_number: Optional[str] = None
    issue_date: Optional[str] = None
    expiry_date: Optional[str] = None
    issuer: Optional[str] = None
    email: Optional[str] = None
    organization: Optional[str] = None
    raw_subject: Optional[str] = None
    read_method: str = "unknown"


def _extract_dn_field(
    name_obj, oid_dotted: str, fallback_attr: str = ""
) -> Optional[str]:
    """Extract a field from an x509 Name by OID or attribute."""
    try:
        from cryptography.x509.oid import NameOID
        import cryptography.x509 as cx509

        oid = cx509.NameOID.__dict__.get(fallback_attr) if fallback_attr else None
        # Try by dotted string OID first
        for attr in name_obj:
            if attr.oid.dotted_string == oid_dotted:
                return attr.value
        # Fallback to NameOID attribute name
        if oid:
            try:
                return name_obj.get_attributes_for_oid(oid)[0].value
            except Exception:
                pass
    except Exception:
        pass
    return None


def _parse_cert_bytes(cert_bytes: bytes) -> DSCCertificateData:
    """Parse DER or PEM certificate bytes and return structured data."""
    from cryptography import x509
    from cryptography.hazmat.backends import default_backend

    try:
        cert = x509.load_der_x509_certificate(cert_bytes, default_backend())
    except Exception:
        try:
            import base64

            pem = (
                b"-----BEGIN CERTIFICATE-----\n"
                + base64.b64encode(cert_bytes)
                + b"\n-----END CERTIFICATE-----"
            )
            cert = x509.load_pem_x509_certificate(pem, default_backend())
        except Exception:
            return DSCCertificateData()

    subject = cert.subject

    # Common Name (holder name)
    holder_name = _extract_dn_field(subject, "2.5.4.3", "COMMON_NAME")

    # Email — try SAN first, then subject emailAddress OID
    email = None
    try:
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        emails = san.value.get_values_for_type(x509.RFC822Name)
        if emails:
            email = emails[0]
    except Exception:
        pass
    if not email:
        email = _extract_dn_field(subject, "1.2.840.113549.1.9.1")

    organization = _extract_dn_field(subject, "2.5.4.10", "ORGANIZATION_NAME")

    serial_hex = format(cert.serial_number, "X")

    not_before = (
        cert.not_valid_before_utc
        if hasattr(cert, "not_valid_before_utc")
        else cert.not_valid_before
    )
    not_after = (
        cert.not_valid_after_utc
        if hasattr(cert, "not_valid_after_utc")
        else cert.not_valid_after
    )

    try:
        raw_subject = cert.subject.rfc4514_string()
    except Exception:
        raw_subject = str(cert.subject)

    return DSCCertificateData(
        holder_name=holder_name,
        serial_number=serial_hex,
        issue_date=not_before.date().isoformat() if not_before else None,
        expiry_date=not_after.date().isoformat() if not_after else None,
        email=email,
        organization=organization,
        raw_subject=raw_subject,
        read_method="pkcs11",
    )


def _ensure_opensc_installed() -> bool:
    """Auto-install opensc + pcscd on Linux if not already present. Returns True if pkcs11-tool is available."""
    import shutil, subprocess, os

    if shutil.which("pkcs11-tool"):
        return True
    if os.name == "nt":
        return False
    try:
        # Install opensc (provides pkcs11-tool), pcscd (PC/SC daemon), and libpcsclite-dev
        subprocess.run(
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                "opensc",
                "pcscd",
                "libpcsclite1",
                "libpcsclite-dev",
                "libccid",
                "pcsc-tools",
            ],
            check=True,
            capture_output=True,
            timeout=180,
        )
        # Also start pcscd if it isn't running
        try:
            subprocess.run(
                ["service", "pcscd", "start"], capture_output=True, timeout=10
            )
        except Exception:
            pass
        return shutil.which("pkcs11-tool") is not None
    except Exception:
        pass
    return False


def _ensure_pyscard_installed() -> bool:
    """Install pyscard after ensuring libpcsclite-dev is present. Returns True if importable."""
    try:
        import smartcard  # noqa

        return True
    except ImportError:
        pass
    import subprocess, sys, os

    if os.name == "nt":
        return False
    try:
        # libpcsclite-dev must be installed first
        subprocess.run(
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                "libpcsclite-dev",
                "libpcsclite1",
                "pcscd",
            ],
            check=True,
            capture_output=True,
            timeout=120,
        )
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "pyscard>=2.0.7"],
            check=True,
            capture_output=True,
            timeout=120,
        )
        import smartcard  # noqa

        return True
    except Exception:
        return False


def _try_opensc_cli(pin: str) -> Optional[DSCCertificateData]:
    """
    Use the opensc CLI tool (pkcs11-tool) to read the certificate from the token.
    This works even when PyKCS11 python bindings are not installed, as long as
    the opensc package is available on the server.
    """
    import shutil, subprocess, tempfile, os

    pkcs11_tool = shutil.which("pkcs11-tool")
    if not pkcs11_tool:
        return None

    # Collect candidate PKCS#11 libs for pkcs11-tool --module
    CANDIDATE_LIBS = [
        "/usr/lib/x86_64-linux-gnu/pkcs11/opensc-pkcs11.so",
        "/usr/lib/opensc-pkcs11.so",
        "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
        "/usr/lib/libeTPkcs11.so",
        "/usr/lib/libcastle.so.1",
        "/usr/lib/libcryptoki.so",
        "/usr/lib64/pkcs11/opensc-pkcs11.so",
        None,  # let pkcs11-tool use its default
    ]

    for lib in CANDIDATE_LIBS:
        try:
            cmd = [
                pkcs11_tool,
                "--read-object",
                "--type",
                "cert",
                "--slot-index",
                "0",
                "--pin",
                pin,
            ]
            if lib and os.path.exists(lib):
                cmd += ["--module", lib]

            result = subprocess.run(cmd, capture_output=True, timeout=15)
            if result.returncode == 0 and result.stdout:
                data = _parse_cert_bytes(result.stdout)
                if data and data.holder_name:
                    data.read_method = "opensc-cli"
                    return data
        except Exception:
            continue
    return None


def _try_pyscard_read(pin: str) -> Optional[DSCCertificateData]:
    """
    Fallback: use pyscard (PC/SC) to communicate directly with the smart card
    via APDU commands. Works with any CCID-compliant DSC token.
    Installs libpcsclite-dev + pyscard at runtime if not already present.
    """
    if not _ensure_pyscard_installed():
        return None
    try:
        from smartcard.System import readers
        from smartcard.util import toHexString, toBytes  # noqa
        from smartcard.Exceptions import CardConnectionException  # noqa
    except ImportError:
        return None

    try:
        reader_list = readers()
        if not reader_list:
            return None

        connection = reader_list[0].createConnection()
        connection.connect()

        # SELECT MF
        SELECT_MF = [0x00, 0xA4, 0x04, 0x00]
        connection.transmit(SELECT_MF)

        # Try standard DSC certificate EF paths (Indian DSC tokens)
        CERT_PATHS = [
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x10, 0x05],  # ePass2003
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x00, 0x01],  # eToken
            [0x00, 0xA4, 0x02, 0x04, 0x02, 0x10, 0x01],  # WatchData/ProxKey
        ]

        cert_bytes = None
        for path_apdu in CERT_PATHS:
            try:
                resp, sw1, sw2 = connection.transmit(path_apdu)
                if sw1 == 0x90:
                    # READ BINARY — read up to 4096 bytes in chunks
                    cert_data = []
                    offset = 0
                    while True:
                        read_apdu = [
                            0x00,
                            0xB0,
                            (offset >> 8) & 0xFF,
                            offset & 0xFF,
                            0xFF,
                        ]
                        data_chunk, sw1, sw2 = connection.transmit(read_apdu)
                        if sw1 == 0x90 and data_chunk:
                            cert_data.extend(data_chunk)
                            offset += len(data_chunk)
                            if len(data_chunk) < 255:
                                break
                        else:
                            break
                    if cert_data:
                        cert_bytes = bytes(cert_data)
                        break
            except Exception:
                continue

        connection.disconnect()

        if cert_bytes:
            data = _parse_cert_bytes(cert_bytes)
            if data and data.holder_name:
                data.read_method = "pyscard"
                return data
    except Exception:
        pass
    return None


def _try_pkcs11_read(
    pin: str, lib_path: Optional[str] = None
) -> Optional[DSCCertificateData]:
    """Try to read certificate using PyKCS11 (python-pkcs11 wrapper)."""
    import os

    CANDIDATE_LIBS = [
        lib_path,
        "/usr/lib/x86_64-linux-gnu/pkcs11/opensc-pkcs11.so",
        "/usr/lib/opensc-pkcs11.so",
        "/usr/lib/x86_64-linux-gnu/opensc-pkcs11.so",
        "/usr/lib/libeTPkcs11.so",
        "/usr/lib/libcastle.so.1",
        "/usr/lib/libcryptoki.so",
        "/usr/lib64/pkcs11/opensc-pkcs11.so",
        "C:\\Windows\\System32\\eTPKCS11.dll",
        "C:\\Windows\\System32\\akisp11.dll",
        "C:\\Windows\\System32\\opensc-pkcs11.dll",
    ]
    try:
        import PyKCS11
    except ImportError:
        return None

    for lib in CANDIDATE_LIBS:
        if not lib:
            continue
        if not os.path.exists(lib):
            continue
        try:
            pkcs11 = PyKCS11.PyKCS11Lib()
            pkcs11.load(lib)
            slots = pkcs11.getSlotList(tokenPresent=True)
            if not slots:
                continue
            session = pkcs11.openSession(
                slots[0], PyKCS11.CKF_SERIAL_SESSION | PyKCS11.CKF_RW_SESSION
            )
            session.login(pin)
            certs = session.findObjects([(PyKCS11.CKA_CLASS, PyKCS11.CKO_CERTIFICATE)])
            if not certs:
                session.logout()
                session.closeSession()
                continue
            for cert_obj in certs:
                attrs = session.getAttributeValue(
                    cert_obj, [PyKCS11.CKA_VALUE, PyKCS11.CKA_CERTIFICATE_TYPE]
                )
                cert_bytes = bytes(attrs[0])
                if cert_bytes:
                    data = _parse_cert_bytes(cert_bytes)
                    data.read_method = "pkcs11"
                    session.logout()
                    session.closeSession()
                    return data
            session.logout()
            session.closeSession()
        except Exception:
            continue
    return None


@api_router.post("/dsc/read-certificate", response_model=DSCCertificateData)
async def read_dsc_certificate(
    req: DSCReadRequest, current_user: User = Depends(get_current_user)
):
    """
    Read certificate data from a physically connected DSC USB token.

    Tries 3 methods in order:
      1. PyKCS11 python bindings (fastest, if installed)
      2. opensc CLI via pkcs11-tool (auto-installs opensc if missing on Linux)
      3. pyscard PC/SC direct APDU (broadest hardware support)

    Returns holder_name, serial_number, issue_date, expiry_date, organization.
    """
    if not req.pin or not req.pin.strip():
        raise HTTPException(
            status_code=422, detail="PIN is required to read the DSC token."
        )

    pin = req.pin.strip()

    # Method 1: PyKCS11 python bindings
    data = _try_pkcs11_read(pin, req.lib_path)
    if data and data.holder_name:
        return data

    # Method 2: opensc CLI (auto-installs on Render/Linux if missing)
    _ensure_opensc_installed()
    data = _try_opensc_cli(pin)
    if data and data.holder_name:
        return data

    # Method 3: pyscard direct PC/SC APDU
    data = _try_pyscard_read(pin)
    if data and data.holder_name:
        return data

    raise HTTPException(
        status_code=422,
        detail=(
            "Could not read the certificate from the token. "
            "Make sure: (1) the DSC USB token is physically plugged into the SERVER machine, "
            "(2) pcscd (PC/SC daemon) is running, and (3) the PIN is correct. "
            "On Render.com, the token must be plugged into your local machine and the backend "
            "must be running locally (not on the cloud) to access USB hardware."
        ),
    )


@api_router.post("/dsc", response_model=DSC)
async def create_dsc(
    dsc_data: DSCCreate,
    current_user: User = Depends(check_module_permission("dsc_register", "create")),
):
    try:
        now = datetime.now(timezone.utc)
        dsc = DSC(
            **dsc_data.model_dump(),
            created_by=current_user.id,
            created_at=now,  # explicitly set — never None
        )
        doc = dsc.model_dump()
        doc["created_at"] = _to_iso(doc["created_at"])
        doc["issue_date"] = _to_iso(doc["issue_date"])
        doc["expiry_date"] = _to_iso(doc["expiry_date"])
        await db.dsc_register.insert_one(doc)
        doc.pop("_id", None)
        return dsc
    except Exception as e:
        logger.error(f"DSC create error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to save DSC: {str(e)}")


@api_router.get("/dsc")
async def get_dsc_list(
    sort_by: str = Query("holder_name"),
    order: str = Query("asc", pattern="^(asc|desc)$", ignore_case=True),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    limit: int = Query(500, ge=1, le=500),
    current_user: User = Depends(check_permission("can_view_all_dsc")),
):
    query = {}
    if search:
        safe_search = re.escape(search)
        search_regex = {"$regex": safe_search, "$options": "i"}
        query["$or"] = [
            {"holder_name": search_regex},
            {"dsc_type": search_regex},
            {"associated_with": search_regex},
            {"current_status": search_regex},
        ]
    sort_dir = 1 if order.lower() == "asc" else -1
    skip = (page - 1) * limit
    total = await db.dsc_register.count_documents(query)
    cursor = (
        db.dsc_register.find(query, {"_id": 0})
        .sort(sort_by, sort_dir)
        .skip(skip)
        .limit(limit)
    )
    dsc_list = await cursor.to_list(length=limit)
    now = datetime.now(IST)

    for dsc in dsc_list:
        # Safely parse stored ISO strings back to datetime for comparison
        for field in ("created_at", "issue_date", "expiry_date"):
            val = dsc.get(field)
            if isinstance(val, str):
                try:
                    dsc[field] = datetime.fromisoformat(val)
                except ValueError:
                    dsc[field] = None

        expiry_date = dsc.get("expiry_date")
        if expiry_date:
            # Make expiry_date timezone-aware for comparison with IST now
            if isinstance(expiry_date, datetime) and expiry_date.tzinfo is None:
                expiry_date = expiry_date.replace(tzinfo=timezone.utc)

            if expiry_date < now:
                movement_log = dsc.get("movement_log", [])
                updated = False
                if not any(
                    log.get("movement_type") == "EXPIRED" for log in movement_log
                ):
                    movement_log.append(
                        {
                            "id": str(uuid.uuid4()),
                            "movement_type": "EXPIRED",
                            "person_name": "System Auto",
                            "notes": "Auto marked as expired",
                            "timestamp": now.isoformat(),
                            "recorded_by": "System",
                        }
                    )
                    updated = True
                if dsc.get("current_status") != "EXPIRED":
                    updated = True
                if updated:
                    await db.dsc_register.update_one(
                        {"id": dsc["id"]},
                        {
                            "$set": {
                                "current_status": "EXPIRED",
                                "movement_log": movement_log,
                            }
                        },
                    )
                    dsc["current_status"] = "EXPIRED"
                    dsc["movement_log"] = movement_log

    return DSCListResponse(data=dsc_list, total=total, page=page, limit=limit)


@api_router.put("/dsc/{dsc_id}", response_model=DSC)
async def update_dsc(
    dsc_id: str,
    dsc_data: DSCCreate,
    current_user: User = Depends(check_permission("can_edit_dsc")),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    update_data = dsc_data.model_dump()
    update_data["issue_date"] = _to_iso(update_data["issue_date"])
    update_data["expiry_date"] = _to_iso(update_data["expiry_date"])

    await db.dsc_register.update_one({"id": dsc_id}, {"$set": update_data})
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data=update_data,
    )

    updated = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not updated:
        raise HTTPException(status_code=404, detail="DSC not found after update")

    # Parse ISO strings back to datetime for Pydantic response model
    for field in ("created_at", "issue_date", "expiry_date"):
        val = updated.get(field)
        if isinstance(val, str):
            try:
                updated[field] = datetime.fromisoformat(val)
            except ValueError:
                updated[field] = None

    return DSC(**updated)


@api_router.delete("/dsc/{dsc_id}")
async def delete_dsc(
    dsc_id: str, current_user: User = Depends(check_permission("can_edit_dsc"))
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")
    await create_audit_log(
        current_user,
        action="DELETE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
    )
    result = await db.dsc_register.delete_one({"id": dsc_id})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="DSC not found")
    return {"message": "DSC deleted successfully"}


@api_router.post("/dsc/{dsc_id}/movement")
async def record_dsc_movement(
    dsc_id: str,
    movement_data: DSCMovementRequest,
    current_user: User = Depends(get_current_user),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    movement = {
        "id": str(uuid.uuid4()),
        "movement_type": movement_data.movement_type,
        "person_name": movement_data.person_name,
        "timestamp": datetime.now(IST).isoformat(),
        "notes": movement_data.notes,
        "recorded_by": current_user.full_name,
    }
    movement_log = existing.get("movement_log", [])
    movement_log.append(movement)

    await db.dsc_register.update_one(
        {"id": dsc_id},
        {
            "$set": {
                "current_status": movement_data.movement_type,
                "current_location": "with_company"
                if movement_data.movement_type == "IN"
                else "taken_by_client",
                "movement_log": movement_log,
            }
        },
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data={"movement_log": movement_log},
    )
    return {
        "message": f"DSC marked as {movement_data.movement_type}",
        "movement": movement,
    }


@api_router.put("/dsc/{dsc_id}/movement/{movement_id}")
async def update_dsc_movement(
    dsc_id: str,
    movement_id: str,
    update_data: MovementUpdateRequest,
    current_user: User = Depends(get_current_user),
):
    existing = await db.dsc_register.find_one({"id": dsc_id}, {"_id": 0})
    if not existing:
        raise HTTPException(status_code=404, detail="DSC not found")

    movement_log = existing.get("movement_log", [])
    movement_found = False

    for i, movement in enumerate(movement_log):
        if movement.get("id") == movement_id:
            movement_log[i]["movement_type"] = update_data.movement_type
            if update_data.person_name:
                movement_log[i]["person_name"] = update_data.person_name
            if update_data.notes is not None:
                movement_log[i]["notes"] = update_data.notes
            movement_log[i]["edited_by"] = current_user.full_name
            movement_log[i]["edited_at"] = datetime.now(timezone.utc).isoformat()
            movement_found = True
            break

    if not movement_found:
        raise HTTPException(status_code=404, detail="Movement entry not found")

    # Derive current_status from the last non-EXPIRED movement entry
    non_expired = [m for m in movement_log if m.get("movement_type") != "EXPIRED"]
    new_status = non_expired[-1]["movement_type"] if non_expired else "IN"

    await db.dsc_register.update_one(
        {"id": dsc_id},
        {"$set": {"current_status": new_status, "movement_log": movement_log}},
    )
    await create_audit_log(
        current_user,
        action="UPDATE_DSC",
        module="dsc",
        record_id=dsc_id,
        old_data=existing,
        new_data={"movement_log": movement_log},
    )
    return {"message": "Movement updated successfully", "movement_log": movement_log}


# DOCUMENT REGISTER ROUTES
