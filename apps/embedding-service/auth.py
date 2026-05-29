from hmac import compare_digest

from fastapi import Header, HTTPException

from settings import config


def embedding_token_auth_status(token: str | None) -> tuple[bool, bool]:
    auth_required = bool(config.embedding_service_token)
    auth_valid = not auth_required or bool(
        token and compare_digest(token, config.embedding_service_token)
    )
    return auth_required, auth_valid


def require_internal_token(
    x_koed_embedding_token: str | None = Header(default=None),
) -> None:
    auth_required, auth_valid = embedding_token_auth_status(x_koed_embedding_token)
    if auth_required and not auth_valid:
        raise HTTPException(status_code=401, detail="invalid embedding service token")
