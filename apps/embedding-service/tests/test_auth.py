import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import auth


class AuthTest(unittest.TestCase):
    def test_auth_status_treats_blank_config_token_as_disabled(self) -> None:
        with patch.object(auth, "config", SimpleNamespace(embedding_service_token="")):
            self.assertEqual(auth.embedding_token_auth_status(None), (False, True))

    def test_auth_status_validates_configured_token(self) -> None:
        with patch.object(auth, "config", SimpleNamespace(embedding_service_token="secret")):
            self.assertEqual(auth.embedding_token_auth_status("secret"), (True, True))
            self.assertEqual(auth.embedding_token_auth_status("wrong"), (True, False))

    def test_require_internal_token_rejects_invalid_token(self) -> None:
        with patch.object(auth, "config", SimpleNamespace(embedding_service_token="secret")):
            with self.assertRaises(HTTPException) as raised:
                auth.require_internal_token("wrong")
        self.assertEqual(raised.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
