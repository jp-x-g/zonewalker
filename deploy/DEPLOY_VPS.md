# VPS deployment (public URL + password)

Assumes an Ubuntu/Debian VPS you can SSH into as root/sudo. The app runs
on localhost only; Caddy terminates HTTPS in front of it. Never expose
port 8177 directly - the password would cross the internet unencrypted.

## 0. Domain

You need a (sub)domain with an A record pointing at the VPS IP, e.g.
map.yourcompany.com. No domain available? A free DuckDNS name
(yourname.duckdns.org) works fine with Caddy too.

## 1. App

    sudo useradd -r -m mapgui
    sudo mkdir -p /opt/room-map-gui
    # copy the room-map-gui folder contents there (scp/rsync/SFTP), minus py\
    #   scp -r room-map-gui/* user@vps:/tmp/rmg && sudo mv /tmp/rmg/* /opt/room-map-gui/
    sudo rm -rf /opt/room-map-gui/py           # Windows-only bundled python
    echo 'YOUR-STRONG-PASSWORD' | sudo tee /opt/room-map-gui/password.txt
    sudo chown -R mapgui:mapgui /opt/room-map-gui
    sudo cp /opt/room-map-gui/deploy/room-map-gui.service /etc/systemd/system/
    sudo systemctl enable --now room-map-gui
    curl -s -u x:YOUR-STRONG-PASSWORD localhost:8177/api/floors | head -c 80   # sanity

## 2. HTTPS front door (Caddy)

    sudo apt install -y caddy
    # edit deploy/Caddyfile: put your real domain in, then:
    sudo cp /opt/room-map-gui/deploy/Caddyfile /etc/caddy/Caddyfile
    sudo systemctl reload caddy

Open https://map.yourcompany.com - browser prompts for the password
(any username). Done.

## 3. Firewall

Only 22 (SSH), 80 and 443 should be open; 8177 must NOT be reachable
from outside (it binds 127.0.0.1 via the service file anyway).
On ufw: `sudo ufw allow 22,80,443/tcp && sudo ufw enable`

## 4. Backups

From any machine, https://your-domain/api/backup.zip (with the password)
downloads all entered data. Grab it on a schedule from home/office, or
cron it on the VPS:
    0 3 * * * cp -r /opt/room-map-gui/data /opt/backups/data-$(date +\%F)

## 5. Updating

Replace static/ files and/or server.py, then `sudo systemctl restart
room-map-gui`. Never touch data/ during updates.

## Notes

- Password lives in /opt/room-map-gui/password.txt; change it and restart.
- Wrong-password attempts are delayed 0.5 s to blunt guessing; still,
  pick a long password - this is the only lock on the door.
- Office users just use the same https URL; the office machine is no
  longer a server (keep its copy as a backup).
