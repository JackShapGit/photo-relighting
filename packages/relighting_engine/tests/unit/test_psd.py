"""Unit tests for PSD assembly."""
from __future__ import annotations
import io
import numpy as np
import pytest
pytoshop = pytest.importorskip("pytoshop")
from relighting_engine.lighting.psd import assemble_psd, deduplicate_names


def _white_layer(h=4, w=4):
    return np.ones((h, w, 3), dtype=np.float32)


def _gray_layer(h=4, w=4, val=0.5):
    return np.full((h, w, 3), val, dtype=np.float32)


# ---------------------------------------------------------------------------
# assemble_psd
# ---------------------------------------------------------------------------

def test_assemble_psd_returns_bytes():
    layers = {"Ambient": _gray_layer(), "Key Light": _white_layer()}
    data = assemble_psd(layers)
    assert isinstance(data, bytes)
    assert len(data) > 0


def test_assemble_psd_roundtrip_layer_count():
    layers = {"Ambient": _gray_layer(), "Key": _white_layer(), "Fill": _gray_layer(val=0.3)}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) == 3


def test_assemble_psd_roundtrip_layer_names():
    layers = {"Ambient": _gray_layer(), "Key": _white_layer(), "Fill": _gray_layer(val=0.3)}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    records = psd.layer_and_mask_info.layer_info.layer_records
    names = [r.name for r in records]
    assert "Ambient" in names
    assert "Key" in names
    assert "Fill" in names


def test_assemble_psd_16_bit():
    layers = {"Ambient": _gray_layer()}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    assert psd.depth == 16


def test_assemble_psd_ambient_only():
    layers = {"Ambient": _gray_layer()}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) == 1


# ---------------------------------------------------------------------------
# deduplicate_names
# ---------------------------------------------------------------------------

def test_deduplicate_names_no_dupes():
    assert deduplicate_names(["Key", "Fill", "Rim"]) == ["Key", "Fill", "Rim"]


def test_deduplicate_names_with_dupes():
    result = deduplicate_names(["Spot Light", "Spot Light", "Spot Light", "Fill"])
    assert result == ["Spot Light", "Spot Light (2)", "Spot Light (3)", "Fill"]


def test_deduplicate_names_empty():
    assert deduplicate_names([]) == []
