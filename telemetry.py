"""Authenticated Haku telemetry ingestion and room-temperature projection."""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Set, Tuple


SCHEMA_VERSION = "mox.hvac.telemetry.v1"
MAX_BODY_BYTES = 1_000_000
DEFAULT_MAX_SKEW_SECONDS = 300
DEFAULT_STALE_AFTER_SECONDS = 15 * 60


class TelemetryError(ValueError):
    """Base class for rejected telemetry."""


class TelemetryAuthenticationError(TelemetryError):
    """The request signature, key, nonce, or clock was invalid."""


class TelemetryValidationError(TelemetryError):
    """The authenticated JSON payload was malformed."""


def signature_for(secret: str, timestamp: str, nonce: str, body: bytes) -> str:
    signed = f"{timestamp}\n{nonce}\n".encode("utf-8") + body
    return "v1=" + hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()


def parse_utc(value: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise TelemetryValidationError("timestamp must be a non-empty string")
    normalized = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise TelemetryValidationError(f"invalid timestamp: {value}") from exc
    if parsed.tzinfo is None:
        raise TelemetryValidationError("timestamp must include a UTC offset")
    return parsed.astimezone(timezone.utc)


def utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_vav(value: Any) -> str:
    match = re.fullmatch(r"\s*VAV[ -](\d+)[ -](\d+)\s*", str(value), re.I)
    return f"VAV-{match.group(1)}-{match.group(2)}" if match else ""


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".partial")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def validate_envelope(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise TelemetryValidationError("JSON body must be an object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise TelemetryValidationError("unsupported schema_version")
    for key in ("batch_id", "sent_at", "site_id", "source", "readings"):
        if key not in payload:
            raise TelemetryValidationError(f"missing payload property: {key}")
    if not isinstance(payload["batch_id"], str) or not payload["batch_id"]:
        raise TelemetryValidationError("batch_id must be a non-empty string")
    if payload["site_id"] != "mox-sf":
        raise TelemetryValidationError("unexpected site_id")
    if not isinstance(payload["source"], dict) or not payload["source"].get("id"):
        raise TelemetryValidationError("source must identify the sender")
    if not isinstance(payload["readings"], list) or not payload["readings"]:
        raise TelemetryValidationError("readings must be a non-empty array")
    parse_utc(payload["sent_at"])


def temperature_readings(payload: Dict[str, Any], known_vavs: Set[str]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    point_ids: Set[str] = set()
    for index, reading in enumerate(payload["readings"]):
        if not isinstance(reading, dict):
            raise TelemetryValidationError(f"reading {index} must be an object")
        for key in ("point_id", "metric", "value", "unit", "quality", "labels", "observed_at"):
            if key not in reading:
                raise TelemetryValidationError(f"reading {index} missing property: {key}")
        point_id = reading["point_id"]
        if not isinstance(point_id, str) or not point_id:
            raise TelemetryValidationError(f"reading {index} has invalid point_id")
        if point_id in point_ids:
            raise TelemetryValidationError(f"duplicate point_id: {point_id}")
        point_ids.add(point_id)
        if reading["metric"] != "temperature":
            continue

        labels = reading["labels"]
        if not isinstance(labels, dict):
            raise TelemetryValidationError(f"reading {index} labels must be an object")
        vav = normalize_vav(labels.get("zone") or labels.get("name") or "")
        if not vav or vav not in known_vavs:
            raise TelemetryValidationError(f"reading {index} has unknown VAV label")

        value = reading["value"]
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise TelemetryValidationError(f"reading {index} has invalid value")
        unit = str(reading["unit"])
        if unit == "degF":
            value_f = float(value)
        elif unit == "degC":
            value_f = (float(value) * 9.0 / 5.0) + 32.0
        else:
            raise TelemetryValidationError(f"reading {index} has unsupported unit: {unit}")

        observed = parse_utc(reading["observed_at"])
        quality = str(reading["quality"])
        if value_f < 35 or value_f > 100:
            quality = "error"
        candidate = {
            "temperature_f": round(value_f, 2),
            "read_at": utc_text(observed),
            "quality": quality,
            "point_id": point_id,
        }
        previous = result.get(vav)
        if previous is None or parse_utc(candidate["read_at"]) > parse_utc(previous["read_at"]):
            result[vav] = candidate
    if not result:
        raise TelemetryValidationError("payload contains no temperature readings")
    return result


def project_room_overlay(
    layer: Dict[str, Any],
    latest: Dict[str, Dict[str, Any]],
    payload: Dict[str, Any],
    received_at: datetime,
    stale_after_seconds: int,
) -> Dict[str, Any]:
    overlay: Dict[str, Any] = {}
    for room, mapping in sorted(layer.get("rooms", {}).items()):
        vav = mapping.get("vav")
        reading = latest.get(vav)
        if not reading:
            continue
        good = reading.get("quality") == "good"
        overlay[room] = {
            "temperature_f": reading["temperature_f"] if good else None,
            "vav": vav,
            "read_at": reading["read_at"],
            "quality": reading.get("quality", "error"),
        }

    averaged_count = 0
    for aggregate in layer.get("averaged_temperature_rooms", []):
        room = aggregate["room"]
        vavs = aggregate["vavs"]
        readings = [latest.get(vav) for vav in vavs]
        if any(reading is None for reading in readings):
            continue
        present = [reading for reading in readings if reading is not None]
        good = all(reading.get("quality") == "good" for reading in present)
        overlay[room] = {
            "temperature_f": (
                round(sum(reading["temperature_f"] for reading in present) / len(present), 2)
                if good
                else None
            ),
            "vav": " + ".join(vavs),
            # The aggregate is only as fresh as its oldest constituent VAV.
            "read_at": min(reading["read_at"] for reading in present),
            "quality": "good" if good else "error",
            "aggregation": "unweighted_mean",
            "source_count": len(vavs),
        }
        averaged_count += 1

    observed_times = [parse_utc(reading["read_at"]) for reading in latest.values()]
    overlay["_meta"] = {
        "schema_version": 2,
        "source_schema": payload["schema_version"],
        "source_id": payload["source"]["id"],
        "batch_id": payload["batch_id"],
        "sent_at": utc_text(parse_utc(payload["sent_at"])),
        "received_at": utc_text(received_at),
        "latest_observed_at": utc_text(max(observed_times)),
        "stale_after_seconds": stale_after_seconds,
        "vav_count": len(latest),
        "room_count": len([key for key in overlay if key.startswith("F")]),
        "averaged_room_count": averaged_count,
    }
    return overlay


class TelemetryIngestor:
    def __init__(
        self,
        secret: str,
        key_id: str,
        layer_path: Path,
        data_dir: Path,
        max_skew_seconds: int = DEFAULT_MAX_SKEW_SECONDS,
        stale_after_seconds: int = DEFAULT_STALE_AFTER_SECONDS,
    ) -> None:
        self.secret = secret
        self.key_id = key_id
        self.layer_path = layer_path
        self.data_dir = data_dir
        self.max_skew_seconds = max_skew_seconds
        self.stale_after_seconds = stale_after_seconds
        self.seen_nonces: Dict[str, int] = {}
        self.lock = threading.Lock()

    @property
    def latest_path(self) -> Path:
        return self.data_dir / "latest_vav_readings.json"

    @property
    def overlay_path(self) -> Path:
        return self.data_dir / "overlay_temperature.json"

    def _verify_headers(self, headers: Mapping[str, str], body: bytes, now: int) -> None:
        if headers.get("X-Mox-Key-Id", "") != self.key_id:
            raise TelemetryAuthenticationError("unknown key id")
        timestamp_text = headers.get("X-Mox-Timestamp", "")
        nonce = headers.get("X-Mox-Nonce", "")
        supplied = headers.get("X-Mox-Signature", "")
        try:
            timestamp = int(timestamp_text)
        except (TypeError, ValueError) as exc:
            raise TelemetryAuthenticationError("invalid timestamp") from exc
        if abs(now - timestamp) > self.max_skew_seconds:
            raise TelemetryAuthenticationError("timestamp outside allowed window")
        if not nonce or len(nonce) > 100:
            raise TelemetryAuthenticationError("invalid nonce")
        expected = signature_for(self.secret, timestamp_text, nonce, body)
        if not hmac.compare_digest(supplied, expected):
            raise TelemetryAuthenticationError("invalid signature")

    def ingest(
        self,
        headers: Mapping[str, str],
        body: bytes,
        now: Optional[int] = None,
    ) -> Tuple[Dict[str, Any], bool]:
        if len(body) > MAX_BODY_BYTES:
            raise TelemetryValidationError("request body is too large")
        now = int(time.time()) if now is None else now
        self._verify_headers(headers, body, now)
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise TelemetryValidationError("body is not valid UTF-8 JSON") from exc
        validate_envelope(payload)

        layer = load_json(self.layer_path, {})
        known_vavs = set(layer.get("vavs", []))
        incoming = temperature_readings(payload, known_vavs)
        received_at = datetime.fromtimestamp(now, timezone.utc)
        nonce = headers["X-Mox-Nonce"]

        with self.lock:
            cutoff = now - (self.max_skew_seconds * 2)
            self.seen_nonces = {
                value: timestamp
                for value, timestamp in self.seen_nonces.items()
                if timestamp >= cutoff
            }
            if nonce in self.seen_nonces:
                raise TelemetryAuthenticationError("replayed nonce")
            self.seen_nonces[nonce] = now

            state = load_json(
                self.latest_path,
                {"schema_version": 1, "vavs": {}, "last_batch_id": None},
            )
            duplicate = state.get("last_batch_id") == payload["batch_id"]
            if not duplicate:
                latest = state.setdefault("vavs", {})
                for vav, reading in incoming.items():
                    previous = latest.get(vav)
                    if previous is None or parse_utc(reading["read_at"]) >= parse_utc(previous["read_at"]):
                        latest[vav] = reading
                state["last_batch_id"] = payload["batch_id"]
                state["updated_at"] = utc_text(received_at)
                overlay = project_room_overlay(
                    layer,
                    latest,
                    payload,
                    received_at,
                    self.stale_after_seconds,
                )
                atomic_write_json(self.latest_path, state)
                atomic_write_json(self.overlay_path, overlay)
            else:
                overlay = load_json(self.overlay_path, {})

        return {
            "ok": True,
            "batch_id": payload["batch_id"],
            "readings_accepted": len(incoming),
            "vavs_stored": len(state.get("vavs", {})),
            "rooms_projected": overlay.get("_meta", {}).get("room_count", 0),
        }, duplicate

    def status(self) -> Dict[str, Any]:
        overlay = load_json(self.overlay_path, {})
        meta = overlay.get("_meta")
        return {
            "configured": bool(self.secret),
            "has_data": bool(meta),
            "meta": meta,
        }
