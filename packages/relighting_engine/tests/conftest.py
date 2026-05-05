"""pytest configuration for the relighting_engine test suite.

Extends the installed package's __path__ so that ``relighting_engine.tests``
is importable even though ``tests/`` sits alongside (not inside) the source
package directory in the editable-install layout.
"""
from __future__ import annotations

from pathlib import Path

import relighting_engine

_TESTS_PARENT = str(Path(__file__).resolve().parent.parent)
if _TESTS_PARENT not in relighting_engine.__path__:
    relighting_engine.__path__.append(_TESTS_PARENT)
