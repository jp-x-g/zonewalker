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

Usage guide is in the sidebar tabs; see also gui/README.md in the main
project. Server code is standard-library-only Python (no packages needed).

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

Deployed on VPS 2026-07-08.
