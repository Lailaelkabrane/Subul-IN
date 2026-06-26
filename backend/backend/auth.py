from datetime import datetime, timedelta
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import JWTError, jwt
import bcrypt
from dotenv import load_dotenv
import os
import logging

load_dotenv(override=True)

SECRET_KEY   = os.getenv("JWT_SECRET", "change-me-secret")
ALGORITHM    = "HS256"
EXPIRE_HOURS = 24

# Admin credentials loaded from .env
ADMIN_EMAIL    = os.getenv("ADMIN_EMAIL", "admin@linkedin.ai")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")

if SECRET_KEY == "change-me-secret":
    logging.warning("JWT_SECRET is using the default value. Set a strong secret in production.")

if ADMIN_PASSWORD == "admin123":
    logging.warning("ADMIN_PASSWORD is using the default value. Set a strong admin password in production.")

bearer_scheme = HTTPBearer(auto_error=False)


def hash_password(plain: str) -> str:
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, is_admin: bool = False) -> str:
    expire  = datetime.utcnow() + timedelta(hours=EXPIRE_HOURS)
    payload = {"sub": str(user_id), "exp": expire, "is_admin": is_admin}
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def _decode_token(token: str) -> dict:
    return jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])


def verify_admin_password(password: str) -> bool:
    configured = ADMIN_PASSWORD or ""
    if configured.startswith("$2a$") or configured.startswith("$2b$") or configured.startswith("$2y$"):
        return verify_password(password, configured)
    return password == configured


async def get_current_user_optional(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> Optional[str]:
    """Return the user document ID from the JWT token, or None if not authenticated."""
    if not credentials:
        return None
    try:
        payload = _decode_token(credentials.credentials)
        sub = payload.get("sub")
        return str(sub) if sub is not None else None
    except JWTError:
        return None


async def require_admin(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme),
) -> dict:
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin token required")
    try:
        payload = _decode_token(credentials.credentials)
        if not payload.get("is_admin"):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Admin access required")
        return payload
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token")
