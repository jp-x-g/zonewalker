"""Validate the built-in VAV room layer against zonewalker geometry."""

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main():
    layer = json.loads((ROOT / "layers" / "vav.json").read_text(encoding="utf-8"))
    rooms = {}
    for floor in range(1, 5):
        geometry = json.loads(
            (ROOT / "partition" / f"F{floor}.geojson").read_text(encoding="utf-8")
        )
        for feature in geometry["features"]:
            if feature["properties"].get("type") == "room":
                gid = f"F{floor}/{feature['properties']['id']}"
                rooms[gid] = feature

    errors = []
    valid_vavs = set(layer["vavs"])
    for gid, record in layer["rooms"].items():
        if gid not in rooms:
            errors.append(f"mapped room is not a current room: {gid}")
        if record.get("vav") not in valid_vavs:
            errors.append(f"unknown VAV for {gid}: {record.get('vav')}")
        floor = gid.split("/", 1)[0][1:]
        if not record.get("vav", "").startswith(f"VAV-{floor}-"):
            errors.append(f"cross-floor mapping: {gid} -> {record.get('vav')}")

    for aggregate in layer.get("averaged_temperature_rooms", []):
        gid = aggregate.get("room")
        if gid not in rooms:
            errors.append(f"averaged room is not a current room: {gid}")
        floor = gid.split("/", 1)[0][1:] if gid else ""
        for vav in aggregate.get("vavs", []):
            if vav not in valid_vavs:
                errors.append(f"unknown averaged-room VAV for {gid}: {vav}")
            if not vav.startswith(f"VAV-{floor}-"):
                errors.append(f"cross-floor averaged mapping: {gid} -> {vav}")

    if errors:
        raise SystemExit("\n".join(errors))
    print(
        f"ok: {len(layer['rooms'])} mapped rooms, "
        f"{len(layer['historical_direct_id_misses'])} historical direct-id misses, "
        f"{len(layer['excluded_multi_vav_rooms'])} excluded multi-VAV records, "
        f"{len(layer.get('averaged_temperature_rooms', []))} averaged rooms"
    )


if __name__ == "__main__":
    main()
