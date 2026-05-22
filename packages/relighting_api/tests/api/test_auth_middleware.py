"""Tests for the shared-password Basic Auth middleware.

The middleware is installed at app-factory time when RELIGHT_DEMO_PASSWORD is
set in the environment. These tests use monkeypatch to set/unset the env var
around create_app() calls.
"""
from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from relighting_api.main import create_app


def _basic_auth_header(password: str, username: str = "demo") -> dict[str, str]:
    raw = f"{username}:{password}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}


def test_no_env_var_means_no_auth_required(monkeypatch) -> None:
    monkeypatch.delenv("RELIGHT_DEMO_PASSWORD", raising=False)
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz")
    assert r.status_code == 200


def test_env_var_set_unauthenticated_request_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate", "").lower().startswith("basic")


def test_env_var_set_correct_password_allows_request(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("hunter2"))
    assert r.status_code == 200


def test_env_var_set_wrong_password_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("wrong"))
    assert r.status_code == 401


def test_env_var_set_username_is_ignored(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("hunter2", username="anything"))
    assert r.status_code == 200


def test_env_var_set_malformed_authorization_header_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers={"Authorization": "Basic !!!not-base64!!!"})
    assert r.status_code == 401


def test_env_var_set_non_basic_scheme_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers={"Authorization": "Bearer some-token"})
    assert r.status_code == 401
