"""One-time migration for the F2/F3 naming swap (2026-07-05).

The source drawings for floors 2 and 3 were physically swapped; from now
on files and room ids use PHYSICAL story numbers. This rewrites all data
files: room ids "F2/R###" <-> "F3/R###" (names, overlays, groups) and
marker floor fields.

Usage:  python3 migrate_f2f3_swap.py /path/to/data
Backs up each file to <name>.pre_f2f3_swap first. Refuses to run twice.
"""
import json, pathlib, sys

SWAP = {"F2": "F3", "F3": "F2"}

def swap_gid(gid):
    if isinstance(gid, str) and "/" in gid:
        f, r = gid.split("/", 1)
        return SWAP.get(f, f) + "/" + r
    return gid

def migrate(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if k == "_markers" and isinstance(v, dict):
                nm = {}
                for mid, m in v.items():
                    m = dict(m)
                    m["floor"] = SWAP.get(m.get("floor"), m.get("floor"))
                    m["room"] = swap_gid(m.get("room"))
                    nm[mid] = m
                out[k] = nm
            elif k == "members" and isinstance(v, list):
                out[k] = [swap_gid(x) for x in v]
            else:
                out[swap_gid(k)] = migrate(v)
        return out
    if isinstance(obj, list):
        return [migrate(x) for x in obj]
    return obj

def main():
    data = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data")
    stamp = data / ".f2f3_swap_done"
    if stamp.exists():
        print("already migrated (remove .f2f3_swap_done to force)"); return
    for f in sorted(data.glob("*.json")):
        raw = f.read_text(encoding="utf-8")
        bak = f.with_suffix(".pre_f2f3_swap")
        bak.write_text(raw, encoding="utf-8")
        f.write_text(json.dumps(migrate(json.loads(raw)), indent=1), encoding="utf-8")
        print("migrated", f.name)
    stamp.write_text("2026-07-05")
    print("done")

main() if __name__ == "__main__" else None
