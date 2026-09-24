import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from telemetry import (
    TelemetryAuthenticationError,
    TelemetryIngestor,
    signature_for,
)


ROOT = Path(__file__).resolve().parents[1]
NOW = 1_800_000_000


def utc_now():
    return datetime.fromtimestamp(NOW, timezone.utc).isoformat().replace("+00:00", "Z")


class TelemetryIngestorTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temporary.name)
        self.ingestor = TelemetryIngestor(
            secret="test-secret",
            key_id="haku-test",
            layer_path=ROOT / "layers" / "vav.json",
            data_dir=self.data_dir,
        )
        layer = json.loads((ROOT / "layers" / "vav.json").read_text())
        self.vavs = layer["vavs"]

    def tearDown(self):
        self.temporary.cleanup()

    def request(self, nonce="nonce-1", batch_id="batch-1", values=None):
        values = values or {vav: 70 + index / 10 for index, vav in enumerate(self.vavs)}
        payload = {
            "schema_version": "mox.hvac.telemetry.v1",
            "batch_id": batch_id,
            "sent_at": utc_now(),
            "site_id": "mox-sf",
            "source": {"id": "haku-bacnet-live", "kind": "bacnet"},
            "readings": [
                {
                    "point_id": f"{vav}:zone-temperature",
                    "metric": "temperature",
                    "value": value,
                    "unit": "degF",
                    "quality": "good",
                    "labels": {"zone": vav},
                    "observed_at": utc_now(),
                }
                for vav, value in values.items()
            ],
        }
        body = json.dumps(payload, separators=(",", ":")).encode()
        timestamp = str(NOW)
        headers = {
            "X-Mox-Key-Id": "haku-test",
            "X-Mox-Timestamp": timestamp,
            "X-Mox-Nonce": nonce,
            "X-Mox-Signature": signature_for("test-secret", timestamp, nonce, body),
        }
        return headers, body

    def test_projects_single_and_averaged_rooms(self):
        result, duplicate = self.ingestor.ingest(*self.request(), now=NOW)
        overlay = json.loads(self.ingestor.overlay_path.read_text())

        self.assertFalse(duplicate)
        self.assertEqual(result["readings_accepted"], 31)
        self.assertEqual(result["rooms_projected"], 74)
        self.assertEqual(overlay["_meta"]["averaged_room_count"], 4)
        expected = sum(
            overlay_room["temperature_f"]
            for vav, overlay_room in [
                (vav, {"temperature_f": 70 + self.vavs.index(vav) / 10})
                for vav in ["VAV-1-1", "VAV-1-3", "VAV-1-5"]
            ]
        ) / 3
        self.assertAlmostEqual(overlay["F1/R010"]["temperature_f"], expected, places=2)

    def test_average_uses_oldest_constituent_timestamp_for_freshness(self):
        values = {"VAV-1-1": 70, "VAV-1-3": 71, "VAV-1-5": 72}
        headers, body = self.request(values=values)
        payload = json.loads(body)
        payload["readings"][0]["observed_at"] = "2026-01-01T00:00:00Z"
        body = json.dumps(payload, separators=(",", ":")).encode()
        headers["X-Mox-Signature"] = signature_for(
            "test-secret", headers["X-Mox-Timestamp"], headers["X-Mox-Nonce"], body
        )
        self.ingestor.ingest(headers, body, now=NOW)
        overlay = json.loads(self.ingestor.overlay_path.read_text())
        self.assertEqual(overlay["F1/R010"]["read_at"], "2026-01-01T00:00:00Z")

    def test_rejects_bad_signature_and_replayed_nonce(self):
        headers, body = self.request()
        bad = dict(headers, **{"X-Mox-Signature": "v1=bad"})
        with self.assertRaises(TelemetryAuthenticationError):
            self.ingestor.ingest(bad, body, now=NOW)

        self.ingestor.ingest(headers, body, now=NOW)
        with self.assertRaises(TelemetryAuthenticationError):
            self.ingestor.ingest(headers, body, now=NOW)

    def test_duplicate_batch_is_idempotent_with_new_nonce(self):
        self.ingestor.ingest(*self.request(), now=NOW)
        result, duplicate = self.ingestor.ingest(
            *self.request(nonce="nonce-2", batch_id="batch-1"),
            now=NOW,
        )
        self.assertTrue(duplicate)
        self.assertEqual(result["rooms_projected"], 74)


if __name__ == "__main__":
    unittest.main()
