"""Shared helpers for the FireLedger Lambda functions (standard library + boto3 only).

- FIRMS MAP_KEY: from SSM Parameter Store in AWS, from the environment locally.
  It is never returned to the client and never written to logs.
- Cache: S3 when CACHE_BUCKET is set, a local folder otherwise.
- Input validation and uniform JSON responses.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

FIRMS_API = "https://firms.modaps.eosdis.nasa.gov/api"
USER_AGENT = "fireledger/0.1 (+https://fireledger.earth)"
MAX_BBOX_AREA_DEG2 = 400.0  # e.g. 20 x 20 degrees
LOCAL_CACHE = Path(os.environ.get("LOCAL_CACHE_DIR", Path(__file__).resolve().parents[2] / "data" / "interim" / "api-cache"))

_key: str | None = None
_s3 = None


class BadRequest(ValueError):
    """Client error; the message is safe to show to the user."""


class UpstreamError(RuntimeError):
    """A provider (FIRMS, Open-Meteo) failed; the message is safe to show."""


def map_key() -> str:
    global _key
    if _key:
        return _key
    _key = os.environ.get("FIRMS_MAP_KEY")
    if not _key:
        import boto3  # available in the Lambda runtime

        name = os.environ.get("FIRMS_KEY_PARAMETER", "/fireledger/FIRMS_MAP_KEY")
        _key = boto3.client("ssm").get_parameter(Name=name, WithDecryption=True)["Parameter"]["Value"]
    return _key


def query(event: dict) -> dict:
    return event.get("queryStringParameters") or {}


def parse_bbox(text: str | None) -> tuple[float, float, float, float]:
    if not text:
        raise BadRequest("bbox is required: west,south,east,north")
    try:
        w, s, e, n = (float(v) for v in text.split(","))
    except ValueError:
        raise BadRequest("bbox must be four numbers: west,south,east,north") from None
    if not all(math.isfinite(v) for v in (w, s, e, n)):
        raise BadRequest("bbox values must be finite numbers")
    if not (-180 <= w < e <= 180 and -90 <= s < n <= 90):
        raise BadRequest("bbox out of range or west/east, south/north swapped")
    if (e - w) * (n - s) > MAX_BBOX_AREA_DEG2:
        raise BadRequest(f"bbox too large (limit {MAX_BBOX_AREA_DEG2:.0f} square degrees)")
    return w, s, e, n


def snap_bbox(bbox, step: float = 0.5) -> tuple[float, float, float, float]:
    """Grow the bbox to a coarse grid so nearby requests share one cache entry."""
    w, s, e, n = bbox
    return (max(math.floor(w / step) * step, -180.0), max(math.floor(s / step) * step, -90.0),
            min(math.ceil(e / step) * step, 180.0), min(math.ceil(n / step) * step, 90.0))


def parse_int(text: str | None, default: int, lo: int, hi: int, name: str) -> int:
    if text is None or text == "":
        return default
    try:
        value = int(text)
    except ValueError:
        raise BadRequest(f"{name} must be an integer") from None
    if not lo <= value <= hi:
        raise BadRequest(f"{name} must be between {lo} and {hi}")
    return value


def parse_float(text: str | None, lo: float, hi: float, name: str) -> float:
    try:
        value = float(text)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise BadRequest(f"{name} is required and must be a number") from None
    if not (math.isfinite(value) and lo <= value <= hi):
        raise BadRequest(f"{name} must be between {lo} and {hi}")
    return value


def parse_date(text: str | None, name: str) -> dt.date:
    try:
        return dt.date.fromisoformat(text or "")
    except ValueError:
        raise BadRequest(f"{name} must be a date YYYY-MM-DD") from None


def http_get(url: str, timeout: int = 25) -> str:
    """GET as text. Errors never contain the URL (it may hold the MAP_KEY)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as err:
        raise UpstreamError(f"upstream service answered HTTP {err.code}") from None
    except (urllib.error.URLError, TimeoutError):
        raise UpstreamError("upstream service not reachable") from None


def response(status: int, body, cache_seconds: int = 0, content_type: str = "application/json") -> dict:
    headers = {
        "Content-Type": f"{content_type}; charset=utf-8",
        "Cache-Control": f"public, max-age={cache_seconds}" if cache_seconds else "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return {"statusCode": status, "headers": headers, "body": body if isinstance(body, str) else json.dumps(body)}


def guarded(handler):
    """Turn validation and upstream errors into clear JSON errors."""

    def wrapper(event, context=None):
        try:
            return handler(event or {}, context)
        except BadRequest as err:
            return response(400, {"error": str(err)})
        except UpstreamError as err:
            return response(502, {"error": str(err)})
        except Exception as err:  # noqa: BLE001 - last line of defence, no details leaked
            print(f"unhandled {type(err).__name__}")
            return response(500, {"error": "internal error"})

    return wrapper


# ------------------------------------------------------------------ cache

def _bucket() -> str | None:
    return os.environ.get("CACHE_BUCKET")


def _client():
    global _s3
    if _s3 is None:
        import boto3

        _s3 = boto3.client("s3")
    return _s3


def cache_get(key: str, ttl_seconds: int | None) -> dict | None:
    """Cached JSON value, or None when missing or older than the TTL (None = never expires)."""
    try:
        if _bucket():
            raw = _client().get_object(Bucket=_bucket(), Key=key)["Body"].read()
        else:
            raw = (LOCAL_CACHE / key).read_bytes()
        entry = json.loads(raw)
    except Exception:  # noqa: BLE001 - a cache miss of any kind
        return None
    if ttl_seconds is not None and time.time() - entry.get("stored", 0) > ttl_seconds:
        return None
    print(f"cache hit {key}")
    return entry["value"]


def cache_put(key: str, value) -> None:
    raw = json.dumps({"stored": time.time(), "value": value}).encode()
    try:
        if _bucket():
            _client().put_object(Bucket=_bucket(), Key=key, Body=raw, ContentType="application/json")
        else:
            path = LOCAL_CACHE / key
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    except Exception as err:  # noqa: BLE001 - caching is best effort
        print(f"cache write failed: {type(err).__name__}")
