"""DELETE /session/{session_id} — drop in-memory + disk cache for one session."""
from __future__ import annotations

from fastapi import APIRouter, Request, Response

router = APIRouter()


@router.delete("/session/{session_id}", status_code=204)
async def delete_session(session_id: str, request: Request) -> Response:
    request.app.state.sessions.delete(session_id)
    return Response(status_code=204)
