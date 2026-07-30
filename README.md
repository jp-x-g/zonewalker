# Room Map GUI — portable

To run: double-click `START_MAP_GUI.bat`, then open http://localhost:8177
in any browser. Other people on the same network can open
http://<this-machine-ip>:8177 (the console prints the address).

The launcher uses, in order: a bundled Python in `py\` if present, the
`py` launcher, or `python` on PATH. If the target machine has no Python,
first run `prepare_portable.ps1` once on a machine with internet (right-
click → Run with PowerShell); it downloads a self-contained Python into
`py\` and the folder becomes fully standalone. Nothing is installed on
the machine either way; delete the folder and it's gone.

Everything lives inside this folder: `partition\` holds the floor
geometry, `static\` the interface, and `data\` all entered information
(names, groups, overlays — JSON, with timestamped backups in
`data\backups\`). To move the whole thing later — including everything
people have entered — just copy the folder. To sync back to the master
copy at home, copy `data\` alone.

`layers\vav.json` is a version-controlled VAV-to-room classification using
zonewalker's physical-floor convention (`F2` means Floor 2 and `F3` means
Floor 3). It appears as the built-in **VAV zones** overlay and as a
**Color by** choice. Entries saved through the GUI override these defaults
in `data\overlay_vav.json`; completed manual room assignments should be
promoted back into the layer file so other installations inherit them.

To generate the **Latest temperatures** layer from a Haku BACnet snapshot:

```powershell
python tools\build_temperature_layer.py C:\path\to\vav_live_snapshot.json
```

The generated `data\overlay_temperature.json` joins each single-VAV room
to its VAV reading, retaining the reading time and quality. The four large
multi-VAV rooms listed in `layers\vav.json` use an unweighted mean of their
serving VAV temperatures. Select
**Color by → Latest temperatures** for a 65–80 °F heat map with numeric
room labels.

Usage guide is in the sidebar tabs; see also gui/README.md in the main
project. Server code is standard-library-only Python (no packages needed).

The top-bar **View** button switches between **North ↑** (north at the top)
and **North →** (the original view with north at the right). Portrait phones
default to North ↑; an explicit choice is remembered in that browser.

## Remote access (Tailscale)

The host machine and each remote worker's device join the same tailnet;
remote workers then open http://<host-machine-name>:8177 (or the
machine's 100.x.y.z Tailscale IP) from anywhere. Traffic is encrypted by
Tailscale and only tailnet members can reach the server.

## Password

Create `password.txt` next to `server.py` containing one line — the shared
password — and restart. Every visitor gets a browser login prompt (any
username, that password). Delete the file to go back to open LAN mode.
The console prints whether protection is ON at startup.

Recommended once remote access is on: password ON, and keep periodic
copies of `data\` somewhere other than the host machine.

## Automated live-site backups

`tools/backup_posting_foundation.sh` downloads the live site's read-only
`/api/backup.zip`, verifies the ZIP and its core data entries, and only then
makes it visible under `~/backups/zonewalker/`. It deliberately keeps every
daily snapshot; incomplete or invalid downloads are removed.

The user-level systemd units in `deploy/zonewalker-backup.{service,timer}` run
the backup every day at 3:15 AM and catch up after a powered-off machine comes
back. Copy `deploy/zonewalker-backup.curl.conf.example` to
`~/.config/zonewalker-backup/curl.conf`, add the live-site password, make that
file readable only by its owner, and install/enable the units:

```sh
install -m 600 deploy/zonewalker-backup.curl.conf.example \
  ~/.config/zonewalker-backup/curl.conf
install -m 644 deploy/zonewalker-backup.{service,timer} \
  ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now zonewalker-backup.timer
systemctl --user start zonewalker-backup.service
```

Deployed on VPS 2026-07-08.
