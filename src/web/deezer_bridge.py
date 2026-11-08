#!/usr/bin/env python3
"""
Deezer bridge for yoinks-web — a long-lived worker, not a one-shot script.

Called by src/web/deezer.ts. Speaks newline-delimited JSON on stdin/stdout:

    → {"id": 1, "op": "search", "arl": "...", "query": "Artist - Title"}
    ← {"id": 1, "ok": true, "track": {...}, "url": "https://cdnt..."}

Running as a worker matters: importing deezer-py costs ~0.2s and logging in
~0.16s, and a fresh process per request paid that every time. The session is
reused, and a different arl switches account without restarting the process.
"""
import json
import sys

_state = {"arl": None, "client": None, "formats": None}


def client_for(arl):
    """One logged-in client, reused until the arl changes."""
    if _state["client"] is not None and _state["arl"] == arl:
        return _state["client"]

    import deezer

    client = deezer.Deezer()
    client.login_via_arl(arl)

    # deezer-py's TrackFormats are plain ints, but get_tracks_url compares the
    # format with str.startswith — so it wants the format *names*.
    _state.update(arl=arl, client=client, formats=["MP3_320", "MP3_128"])
    return client


def url_for(client, track):
    last_error = None
    for track_format in _state["formats"]:
        try:
            url = client.get_track_url(track["TRACK_TOKEN"], track_format)
        except Exception as exc:  # noqa: BLE001 - try the next quality
            last_error = exc
            continue
        if url:
            return url
    raise RuntimeError(str(last_error) if last_error else "Deezer returned no download url")


def summarise(track):
    duration = track.get("DURATION")
    return {
        "id": str(track.get("SNG_ID")),
        "title": track.get("SNG_TITLE"),
        "artist": track.get("ART_NAME") or "",
        "album": track.get("ALB_TITLE"),
        # Deezer sends this as a string; callers do arithmetic on it.
        "duration": int(duration) if str(duration).isdigit() else None,
    }


def handle(request):
    arl = (request.get("arl") or "").strip()
    if not arl:
        return {"ok": False, "error": "no Deezer session (add your arl cookie under Sessions → Deezer)"}

    try:
        import deezer  # noqa: F401
    except ImportError:
        return {"ok": False, "error": "deezer-py is not installed (pip install deezer-py)"}

    try:
        client = client_for(arl)
    except Exception as exc:  # noqa: BLE001 - an expired cookie is expected
        _state.update(arl=None, client=None)
        return {"ok": False, "error": f"Deezer rejected the session: {exc}"}

    op = request.get("op")

    if op == "search":
        query = (request.get("query") or "").strip()
        if not query:
            return {"ok": False, "error": "empty query"}
        try:
            hits = client.gw.search(query)
            rows = ((hits or {}).get("TRACK") or {}).get("data") or []
            if not rows:
                return {"ok": False, "error": "no Deezer match"}
            # The search row usually carries the token already, so the extra
            # get_track round-trip is skipped when it does.
            track = rows[0]
            if not track.get("TRACK_TOKEN"):
                track = client.gw.get_track(track["SNG_ID"])
            return {"ok": True, "track": summarise(track), "url": url_for(client, track)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"Deezer search failed: {exc}"}

    if op == "media":
        track_id = str(request.get("trackId") or "").strip()
        if not track_id:
            return {"ok": False, "error": "missing trackId"}
        try:
            track = client.gw.get_track(track_id)
            return {"ok": True, "track": summarise(track), "url": url_for(client, track)}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": f"Deezer could not serve this track: {exc}"}

    if op == "ping":
        return {"ok": True}

    return {"ok": False, "error": f"unknown op: {op}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"bad request: {exc}"}), flush=True)
            continue
        try:
            result = handle(request)
        except Exception as exc:  # noqa: BLE001 - never traceback to the caller
            result = {"ok": False, "error": str(exc)}
        result["id"] = request.get("id")
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
