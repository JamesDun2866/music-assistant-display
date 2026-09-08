"""Extract catalog references only, never follow provider-supplied URLs."""

import re
from urllib.parse import parse_qs, urlsplit

ID = re.compile(r"[1-9][0-9]{0,14}")


def catalog_url(raw):
    if type(raw) is not str or len(raw) > 2048 or any(ord(c) <= 32 for c in raw):
        return None
    try:
        url = urlsplit(raw)
        if url.scheme != "https" or url.netloc != "music.apple.com" or url.fragment:
            return None
        match = re.fullmatch(r"/([a-z]{2})/(album|song)/(?:[^/]{1,512}/)?([1-9][0-9]{0,14})/?", url.path)
        if not match:
            return None
        query = parse_qs(url.query, keep_blank_values=True, max_num_fields=32)
        track_id = query.get("i")
        if track_id is not None and (len(track_id) != 1 or not ID.fullmatch(track_id[0])):
            return None
        country, kind, identity = match.groups()
        if kind == "song" and track_id is not None and track_id[0] != identity:
            return None
        return {"kind": "collection" if kind == "album" else "track", "id": identity, "country": country}
    except ValueError:
        return None


def catalog_reference(track):
    hub = track.get("hub")
    if type(hub) is not dict:
        return None
    options = hub.get("options", [])
    if type(options) is not list or len(options) > 16:
        return None
    references = []
    for group in [hub, *options]:
        if type(group) is not dict:
            continue
        actions = group.get("actions", [])
        if type(actions) is not list or len(actions) > 16:
            return None
        for action in actions:
            reference = catalog_url(action.get("uri")) if type(action) is dict else None
            if reference is not None:
                references.append(reference)
    collections = [item for item in references if item["kind"] == "collection"]
    selected = collections or references
    if not selected or any(item != selected[0] for item in selected):
        return None
    return selected[0]


def valid_reference(value):
    return value is None or (
        type(value) is dict and set(value) == {"kind", "id", "country"}
        and value["kind"] in ("collection", "track")
        and type(value["id"]) is str and ID.fullmatch(value["id"]) is not None
        and type(value["country"]) is str and re.fullmatch("[a-z]{2}", value["country"]) is not None
    )
