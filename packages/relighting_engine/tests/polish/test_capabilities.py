"""Tests for polish.capabilities.is_available() — boolean GPU/import check."""
from __future__ import annotations

from unittest import mock

import pytest

from relighting_engine.polish import capabilities


def test_is_available_returns_bool():
    result = capabilities.is_available()
    assert isinstance(result, bool)


def test_is_available_false_when_diffusers_missing():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=False):
        assert capabilities.is_available() is False


def test_is_available_false_when_no_cuda():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=False):
        assert capabilities.is_available() is False


def test_is_available_false_when_vram_below_threshold():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=True), \
         mock.patch.object(capabilities, "_free_vram_bytes", return_value=4 * 1024**3):
        assert capabilities.is_available() is False


def test_is_available_true_when_all_checks_pass():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=True), \
         mock.patch.object(capabilities, "_free_vram_bytes", return_value=10 * 1024**3):
        assert capabilities.is_available() is True
