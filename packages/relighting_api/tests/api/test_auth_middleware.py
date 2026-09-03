"""Tests for the shared-password Basic Auth middleware.

The middleware is installed at app-factory time when RELIGHT_DEMO_PASSWORD is
set in the environment. These tests use monkeypatch to set/unset the env var
around create_app() calls.
"""
from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from relighting_api.main import create_app

_TEST_PASSWORD = "hunter2"


def _client() -> TestClient:
    return TestClient(create_app(skip_engine=True))


def _basic_auth_header(password: str, username: str = "demo") -> dict[str, str]:
    raw = f"{username}:{password}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}


def test_no_env_var_means_no_auth_required(monkeypatch) -> None:
    monkeypatch.delenv("RELIGHT_DEMO_PASSWORD", raising=False)
    client = _client()
    r = client.get("/healthz")
    assert r.status_code == 200


def test_env_var_set_unauthenticated_request_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz")
    assert r.status_code == 401
    # No WWW-Authenticate: that header is what makes the browser raise its
    # native sign-in dialog. Access is granted by the ?k= link instead.
    assert "www-authenticate" not in {k.lower() for k in r.headers}


def test_env_var_set_correct_password_allows_request(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers=_basic_auth_header(_TEST_PASSWORD))
    assert r.status_code == 200


def test_env_var_set_wrong_password_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers=_basic_auth_header("wrong"))
    assert r.status_code == 401
    assert "www-authenticate" not in {k.lower() for k in r.headers}


def test_env_var_set_username_is_ignored(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers=_basic_auth_header(_TEST_PASSWORD, username="anything"))
    assert r.status_code == 200


def test_env_var_set_malformed_authorization_header_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers={"Authorization": "Basic !!!not-base64!!!"})
    assert r.status_code == 401


def test_env_var_set_non_basic_scheme_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers={"Authorization": "Bearer some-token"})
    assert r.status_code == 401


# --- token-in-URL access (no browser prompt) ----------------------------


def test_token_in_query_sets_cookie_and_redirects(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get(f"/healthz?k={_TEST_PASSWORD}", follow_redirects=False)
    assert r.status_code == 303
    assert "relight_demo" in r.cookies or "set-cookie" in {k.lower() for k in r.headers}
    # the secret must not survive into the redirect target
    assert "k=" not in r.headers["location"]
    assert r.headers["location"].startswith("/healthz")


def test_token_redirect_preserves_other_query_params(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get(f"/healthz?ws=interactive&k={_TEST_PASSWORD}", follow_redirects=False)
    assert r.status_code == 303
    assert "ws=interactive" in r.headers["location"]
    assert _TEST_PASSWORD not in r.headers["location"]


def test_token_grants_access_end_to_end(monkeypatch) -> None:
    """Following the redirect must land on a 200 with no prompt."""
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get(f"/healthz?k={_TEST_PASSWORD}")  # follows redirects
    assert r.status_code == 200


def test_cookie_alone_grants_access_on_later_requests(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    client.get(f"/healthz?k={_TEST_PASSWORD}")  # establishes the cookie
    r = client.get("/healthz")  # no token, no basic auth
    assert r.status_code == 200


def test_wrong_token_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz?k=wrong", follow_redirects=False)
    assert r.status_code == 401
    assert "www-authenticate" not in {k.lower() for k in r.headers}


def test_forged_cookie_is_rejected(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", cookies={"relight_demo": "not-the-real-value"})
    assert r.status_code == 401


def test_cookie_does_not_contain_the_plaintext_password(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get(f"/healthz?k={_TEST_PASSWORD}", follow_redirects=False)
    assert _TEST_PASSWORD not in r.headers.get("set-cookie", "")


def test_basic_auth_still_works_for_curl(monkeypatch) -> None:
    """Back-compat: existing scripts and links keep working."""
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", _TEST_PASSWORD)
    client = _client()
    r = client.get("/healthz", headers=_basic_auth_header(_TEST_PASSWORD))
    assert r.status_code == 200
