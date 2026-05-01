# SpamView

Self-hosted reject analytics for [Mailcow](https://mailcow.email/). Pulls
postscreen logs, rspamd history and the quarantine table, exposes a dark
ops-console UI behind Caddy + Basic-Auth, and (optionally) explains rejects
in plain language via Google Gemini.

```
postscreen + rspamd + quarantine  ─SSH─►  fetcher  ─SQLite─►  Express API  ─►  Web UI
                                                                  └─ Gemini API (optional)
```

## What you get

- Grouped table view (one row per "logical mail", expandable to individual attempts)
- Filters by source, category, time range, full-text search
- Click any row → header / score / all rspamd symbols / raw log / mail body (if quarantined)
- Daily activity chart, top senders, top source IPs, category breakdown
- AI insights card on the dashboard + per-mail explanations on demand
- Auto-pull every 10 minutes via systemd timer

## Requirements

- A Proxmox VE host (8.x or 9.x) — the installer creates a Debian 13 LXC
- A Mailcow installation on a remote host, reachable via SSH
- An SSH user on the mailserver with password-less sudo for `docker` commands
- Optional: a Gemini API key (free tier is plenty)

## Install

```bash
git clone https://github.com/ruehlingdaniel/spamview.git
cd spamview
sudo ./install.sh
```

### Unattended

Set env vars and pass `SPAMVIEW_UNATTENDED=1`:

```bash
SPAMVIEW_UNATTENDED=1 \
CT_ID=131 CT_HOSTNAME=spamview CT_STORAGE=local-zfs \
CT_IP=192.168.1.97/24 CT_GW=192.168.1.1 CT_PASSWORD='secret' \
AUTH_USER=admin AUTH_PASS='secret' \
MAILSERVER_HOST=mail.example.com MAILSERVER_USER=debian \
GEMINI_API_KEY='AIza...' \
sudo -E ./install.sh
```

Required: `CT_ID, CT_HOSTNAME, CT_STORAGE, CT_PASSWORD, AUTH_PASS, MAILSERVER_HOST`.
With `USE_DHCP=static` (default): also `CT_IP, CT_GW`.
Optional: `CT_DISK, CT_RAM, CT_CORES, CT_BRIDGE, CT_DNS, AUTH_USER, MAILSERVER_USER, MAILCOW_PROJECT, MAILCOW_PATH, IGNORE_HOSTS, GEMINI_API_KEY, PULL_INTERVAL`.

The wizard asks for ~10 inputs: LXC ID, network, root password, web-UI auth,
mailserver hostname/user, optional Gemini key. Defaults work for most setups.

After the install completes, the script prints the **public SSH key** the
container generated. Add this key to your mailserver's `~/.ssh/authorized_keys`
for the user you specified. Once that's done:

```bash
pct exec <CTID> -- systemctl start spamview-fetch.service
```

…populates the database, and the timer keeps it fresh thereafter.

## What the wizard asks

| Prompt | What it controls |
|--------|------------------|
| Container ID | The Proxmox VMID for the new LXC |
| Hostname | Container hostname |
| Storage | Proxmox storage backend for the rootfs |
| Disk / RAM / cores | Resource allocation (1 GB / 1 core is fine) |
| Network mode | DHCP or static IP |
| IP / gateway | Network details (only for static) |
| Root password | LXC root password |
| Web auth user / pass | Basic-auth for the web UI (bcrypt-hashed) |
| Mailserver hostname | FQDN/IP of your mailcow server |
| Mailserver SSH user | User on the mailserver (must have sudo + docker) |
| Mailcow project | Docker compose project name (`mailcowdockerized` is the default) |
| Mailcow path | Where mailcow lives on the server (`/opt/mailcow-dockerized`) |
| Ignore patterns | Regex(es) to drop noise from your own infrastructure |
| Gemini API key | Optional — paste or skip |
| Pull interval | Systemd timer interval (default 10min) |

## Architecture

```
LXC (Debian 13)
├── /opt/spamview/
│   ├── server.js          Express + better-sqlite3 (loopback :3050)
│   ├── fetch.js           SSH puller (postfix logs + redis history + quarantine DB)
│   ├── ai.js              Gemini integration with SQLite cache
│   ├── db.js              Schema + migrations
│   └── public/            Vanilla JS frontend
├── /etc/spamview.env      Runtime config (chmod 600)
├── /etc/caddy/Caddyfile   tls internal · LAN allowlist · basic-auth
├── /etc/systemd/system/
│   ├── spamview.service           Express server
│   ├── spamview-fetch.service     One-shot puller
│   └── spamview-fetch.timer       10-min interval
└── /var/lib/spamview/.ssh/        SSH keypair for mailserver pull
```

## Updating

Re-run `install.sh` against a *new* container ID, or `git pull` and:

```bash
pct push <CTID> src/server.js /opt/spamview/server.js
pct push <CTID> src/fetch.js  /opt/spamview/fetch.js
pct push <CTID> src/public/app.js /opt/spamview/public/app.js
# ... (other changed files)
pct exec <CTID> -- systemctl restart spamview
```

## Uninstall

```bash
pct stop <CTID> && pct destroy <CTID>
# Remove the public key from your mailserver's authorized_keys
```

## Caveats

- **Postscreen rejects have no body** — they're rejected before SMTP `DATA`,
  so we only capture IP/HELO/envelope/reason. Subject and content are
  not recoverable.
- **Mailcow quarantine is empty by default** for reject-action mails. To get
  full bodies, you'd need to configure rspamd to write to the quarantine
  table on reject (a Lua hook).
- Caddy uses `tls internal` (self-signed). Browsers will warn once; accept
  the cert and you're done. If you want a real cert, switch the Caddyfile
  to ACME with your DNS provider.
