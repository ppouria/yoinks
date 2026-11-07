#!/usr/bin/env python3
"""
Deezer bridge for yoinks-web.

Called by src/web/deezer.ts with a JSON request on stdin and answers on stdout.
Deezer is the fastest source we have: one API call resolves a download URL that
is a plain CDN file, so no yt-dlp, no JS challenge, no manifest.

Two operations:

  {"op": "search", "query": "..."}   → best-matching track + its CDN url
  {"op": "media",  "trackId": "..."} → a download url for one track

Auth: a free Deezer account is enough. The `arl` cookie is read from the
environment by the caller; without it we can only return 30-second previews,
which we deliberately never treat as a match.
"""
import json
import os
import sys


def reply(payload):
    json.dump(payload, sys.stdout)
    sys.stdout.flush()
    sys.exit(0 if payload.get("ok") else 1)


def fail(message, **extra):
    reply({"ok": False, "error": str(message), **extra})


def main():
    try:
        import deezer
    except ImportError:
        fail("deezer-py is not installed (pip install deezer-py)")

    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 - report, never traceback to the caller
        fail(f"bad request: {exc}")

    arl = os.environ.get("DEEZER_ARL", "").strip()
    if not arl:
        fail("no Deezer session (add your arl cookie under Sessions → Deezer)")

    client = deezer.Deezer()
    try:
        client.login_via_arl(arl)
    except Exception as exc:  # noqa: BLE001 - an expired cookie is an expected case
        fail(f"Deezer rejected the session: {exc}")

    # A free account gets 128 kbps mp3; premium accounts get 320/flac. Ask for
    # the best the account allows and let Deezer downgrade.
    # deezer-py's TrackFormats are plain ints, but get_tracks_url compares the
    # format with str.startswith — so it wants the format *names*.
    formats = ["MP3_320", "MP3_128"]

    def url_for(track):
        last_error = None
        for track_format in formats:
            try:
                url = client.get_track_url(track["TRACK_TOKEN"], track_format)
            except Exception as exc:  # noqa: BLE001 - try the next quality
                last_error = exc
                continue
            if url:
                return url
        raise RuntimeError(last_error or "Deezer returned no download url")

    op = request.get("op")

    if op == "search":
        query = (request.get("query") or "").strip()
        if not query:
            fail("empty query")
        # `gw.get_track` expects a numeric id, so search first and then load the
        # best hit. The public API is used for the search itself: it needs no
        # session and answers faster than the internal gateway.
        try:
            import deezer as _deezer
            hits = client.gw.search(query)
            track_id = None
            if hits and hits.get("TRACK"):
                first = hits["TRACK"].get("data") or []
                if first:
                    track_id = first[0].get("SNG_ID")
            if not track_id:
                fail("no Deezer match")
            track = client.gw.get_track(track_id)
        except Exception as exc:  # noqa: BLE001
            fail(f"Deezer search failed: {exc}")
        if not track:
            fail("no Deezer match")
        try:
            url = url_for(track)
        except Exception as exc:  # noqa: BLE001
            fail(f"Deezer could not serve this track: {exc}")
        reply(
            {
                "ok": True,
                "track": {
                    "id": track.get("SNG_ID"),
                    "title": track.get("SNG_TITLE"),
                    "artist": (track.get("ART_NAME") or ""),
                    "album": track.get("ALB_TITLE"),
                    "duration": track.get("DURATION"),
                },
                "url": url,
            }
        )

    if op == "media":
        track_id = str(request.get("trackId") or "").strip()
        if not track_id:
            fail("missing trackId")
        try:
            track = client.gw.get_track(track_id)
            url = url_for(track)
        except Exception as exc:  # noqa: BLE001
            fail(f"Deezer could not serve this track: {exc}")
        reply(
            {
                "ok": True,
                "track": {
                    "id": track.get("SNG_ID"),
                    "title": track.get("SNG_TITLE"),
                    "artist": (track.get("ART_NAME") or ""),
                    "album": track.get("ALB_TITLE"),
                    "duration": track.get("DURATION"),
                },
                "url": url,
            }
        )

    fail(f"unknown op: {op}")


if __name__ == "__main__":
    main()
