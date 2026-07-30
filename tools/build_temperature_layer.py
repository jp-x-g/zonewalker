"""Join a Haku BACnet snapshot to zonewalker's room-to-VAV overlay."""

import argparse
import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def normalize_vav(value):
    match = re.fullmatch(r"VAV[ -](\d+)[ -](\d+)", str(value).strip(), re.I)
    return f"VAV-{match.group(1)}-{match.group(2)}" if match else str(value).strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("snapshot", type=Path, help="mox.bacnet.snapshot.v1 JSON file")
    parser.add_argument(
        "--vav-overlay", type=Path, default=ROOT / "data" / "overlay_vav.json"
    )
    parser.add_argument(
        "--vav-layer", type=Path, default=ROOT / "layers" / "vav.json"
    )
    parser.add_argument(
        "--output", type=Path, default=ROOT / "data" / "overlay_temperature.json"
    )
    args = parser.parse_args()

    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    if snapshot.get("schema_version") != "mox.bacnet.snapshot.v1":
        raise SystemExit("unsupported BACnet snapshot schema")
    vav_overlay = json.loads(args.vav_overlay.read_text(encoding="utf-8"))
    vav_layer = json.loads(args.vav_layer.read_text(encoding="utf-8"))

    readings = {}
    for reading in snapshot.get("readings", []):
        if reading.get("metric") != "temperature":
            continue
        vav = normalize_vav(reading.get("zone", ""))
        if vav in readings and reading.get("read_at", "") <= readings[vav].get("read_at", ""):
            continue
        readings[vav] = reading

    output = {
        "_meta": {
            "schema_version": 1,
            "source_schema": snapshot["schema_version"],
            "source_file": args.snapshot.name,
            "source_id": snapshot.get("source_id"),
            "snapshot_finished_at": snapshot.get("finished_at"),
            "unit": "degF",
        }
    }
    missing = []
    for room, mapping in sorted(vav_overlay.items()):
        if room.startswith("_") or not isinstance(mapping, dict) or not mapping.get("vav"):
            continue
        vav = normalize_vav(mapping["vav"])
        reading = readings.get(vav)
        if not reading:
            missing.append(f"{room}: {vav}")
            continue
        good = reading.get("quality") == "good"
        output[room] = {
            "temperature_f": reading.get("value") if good else None,
            "vav": vav,
            "read_at": reading.get("read_at"),
            "quality": reading.get("quality", "error"),
        }

    averaged_count = 0
    for aggregate in vav_layer.get("averaged_temperature_rooms", []):
        room = aggregate["room"]
        vavs = [normalize_vav(vav) for vav in aggregate["vavs"]]
        room_readings = [readings.get(vav) for vav in vavs]
        absent = [vav for vav, reading in zip(vavs, room_readings) if reading is None]
        if absent:
            missing.append(f"{room}: {', '.join(absent)}")
            continue
        good = all(reading.get("quality") == "good" for reading in room_readings)
        values = [reading.get("value") for reading in room_readings]
        output[room] = {
            "temperature_f": round(sum(values) / len(values), 2) if good else None,
            "vav": " + ".join(vavs),
            "read_at": max(reading.get("read_at", "") for reading in room_readings),
            "quality": "good" if good else "error",
            "aggregation": "unweighted_mean",
            "source_count": len(vavs),
        }
        averaged_count += 1

    output["_meta"]["averaged_room_count"] = averaged_count

    if missing:
        raise SystemExit("missing readings:\n" + "\n".join(missing))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {len(output) - 1} room temperatures from {len(readings)} VAV readings "
        f"({averaged_count} averaged rooms) to {args.output}"
    )


if __name__ == "__main__":
    main()
