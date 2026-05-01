#!/usr/bin/env bash
# SpamView installer — Proxmox-Helper-style
#
# Usage (on a Proxmox host, as root):
#   ./install.sh
#
# Creates a Debian 13 LXC, installs Node.js + Caddy, deploys SpamView, and
# configures it to pull reject data from your Mailcow server.

set -Eeuo pipefail

# ───────────────────────────────────────────────────────────────────────
# Style
# ───────────────────────────────────────────────────────────────────────
RD=$'\033[01;31m'; YW=$'\033[33m'; BL=$'\033[36m'; GN=$'\033[1;92m'; DM=$'\033[2m'; CL=$'\033[m'
CM=" ${GN}✓${CL}"; CR=" ${RD}✗${CL}"; IN=" ${BL}ℹ${CL}"; AR=" ${YW}»${CL}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

trap 'on_error $LINENO $?' ERR
on_error() {
  echo
  echo -e "${CR} ${RD}installation failed at line $1 (exit $2)${CL}"
  echo -e "${IN} See output above for details."
  exit "$2"
}

step()  { echo -e "${AR} ${1}"; }
ok()    { echo -e "${CM} ${1}"; }
info()  { echo -e "${IN} ${1}"; }
fail()  { echo -e "${CR} ${1}"; exit 1; }

header() {
  clear
  cat <<'BANNER'

   ██████╗ ██████╗  █████╗ ███╗   ███╗██╗   ██╗██╗███████╗██╗    ██╗
  ██╔════╝ ██╔══██╗██╔══██╗████╗ ████║██║   ██║██║██╔════╝██║    ██║
  ╚█████╗  ██████╔╝███████║██╔████╔██║╚██╗ ██╔╝██║█████╗  ██║ █╗ ██║
   ╚═══██╗ ██╔═══╝ ██╔══██║██║╚██╔╝██║ ╚████╔╝ ██║██╔══╝  ██║███╗██║
  ██████╔╝ ██║     ██║  ██║██║ ╚═╝ ██║  ╚██╔╝  ██║███████╗╚███╔███╔╝
  ╚═════╝  ╚═╝     ╚═╝  ╚═╝╚═╝     ╚═╝   ╚═╝   ╚═╝╚══════╝ ╚══╝╚══╝

  Mailcow Reject Analysis — LXC installer
  github-style helper · Postscreen + Rspamd + Quarantine + AI insights

BANNER
}

# ───────────────────────────────────────────────────────────────────────
# Pre-flight
# ───────────────────────────────────────────────────────────────────────
need_root_pve() {
  [[ $EUID -eq 0 ]] || fail "Run as root."
  command -v pveversion >/dev/null 2>&1 || fail "This script must run on a Proxmox VE host."
  command -v whiptail   >/dev/null 2>&1 || fail "whiptail not installed (apt install whiptail)."
  command -v pct        >/dev/null 2>&1 || fail "pct (Proxmox container tool) not found."
}

# whiptail wrappers — return on cancel
W_BACKTITLE="SpamView Installer"
wt_yesno()  { whiptail --backtitle "$W_BACKTITLE" --title "$1" --yesno "$2" 14 78 3>&1 1>&2 2>&3; }
wt_input()  { whiptail --backtitle "$W_BACKTITLE" --title "$1" --inputbox "$2" 12 78 "${3:-}" 3>&1 1>&2 2>&3; }
wt_pass()   { whiptail --backtitle "$W_BACKTITLE" --title "$1" --passwordbox "$2" 11 78 3>&1 1>&2 2>&3; }
wt_menu()   { local title=$1; shift; local prompt=$1; shift; whiptail --backtitle "$W_BACKTITLE" --title "$title" --menu "$prompt" 18 78 8 "$@" 3>&1 1>&2 2>&3; }
wt_msg()    { whiptail --backtitle "$W_BACKTITLE" --title "$1" --msgbox "$2" 14 78 3>&1 1>&2 2>&3; }

abort_on_cancel() { [[ ${1:-0} -ne 0 ]] && { echo; info "${YW}Aborted by user.${CL}"; exit 0; }; }

# ───────────────────────────────────────────────────────────────────────
# Wizard
# ───────────────────────────────────────────────────────────────────────
wizard() {
  wt_msg "Welcome" "This installer will:

 • Create a new Debian 13 LXC on this Proxmox host
 • Install Node.js, Caddy (TLS) and SQLite
 • Deploy SpamView and the periodic fetcher
 • Configure SSH-key-based pull from your Mailcow server

You'll be guided through ~10 questions. Defaults work for most setups."

  # ── LXC basics ──
  CT_ID=$(wt_input "Container ID" "Pick a free LXC ID (Proxmox VMID).
 Existing IDs are reserved — pick anything between 100 and 999." "$(pvesh get /cluster/nextid 2>/dev/null || echo 130)")
  abort_on_cancel $?

  if pct status "$CT_ID" >/dev/null 2>&1; then
    fail "LXC $CT_ID already exists. Pick a different ID."
  fi

  CT_HOSTNAME=$(wt_input "Container hostname" "Hostname inside the LXC. Will also become the mDNS name." "spamview")
  abort_on_cancel $?

  STORAGE=$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | head -5 | tr '\n' ' ')
  STORAGE_DEFAULT=$(echo "$STORAGE" | awk '{print $1}')
  CT_STORAGE=$(wt_input "Storage" "Storage for the rootfs. Available: $STORAGE" "$STORAGE_DEFAULT")
  abort_on_cancel $?

  CT_DISK=$(wt_input "Disk size (GB)" "Root disk size. SpamView itself is tiny (<50 MB), but allow room for SQLite growth." "8")
  abort_on_cancel $?

  CT_RAM=$(wt_input "RAM (MB)" "Memory. 512 is plenty for SpamView; 1024 is comfortable." "1024")
  abort_on_cancel $?

  CT_CORES=$(wt_input "CPU cores" "Number of cores." "1")
  abort_on_cancel $?

  # ── Network ──
  USE_DHCP=$(whiptail --backtitle "$W_BACKTITLE" --title "Network" --menu "Network configuration mode:" 12 78 2 \
    static "Static IP (recommended for a service)" \
    dhcp "DHCP" 3>&1 1>&2 2>&3) || abort_on_cancel 1

  if [[ "$USE_DHCP" == "static" ]]; then
    CT_IP=$(wt_input "IP address" "Static IP for the container in CIDR notation." "192.168.1.250/24")
    abort_on_cancel $?
    CT_GW=$(wt_input "Gateway" "Default gateway." "192.168.1.1")
    abort_on_cancel $?
  fi

  CT_BRIDGE=$(wt_input "Network bridge" "Proxmox bridge interface for the LXC." "vmbr0")
  abort_on_cancel $?

  CT_DNS=$(wt_input "DNS server" "Optional DNS server (empty = use Proxmox default)." "")
  abort_on_cancel $?

  CT_PASSWORD=$(wt_pass "Container root password" "Root password for the LXC. Stored as a hash.")
  abort_on_cancel $?
  [[ -z "$CT_PASSWORD" ]] && fail "Root password is required."

  # ── Web access ──
  AUTH_USER=$(wt_input "Web UI · username" "Username for the SpamView web UI (HTTP basic-auth)." "admin")
  abort_on_cancel $?
  AUTH_PASS=$(wt_pass "Web UI · password" "Password for the web UI. Will be bcrypt-hashed before storage.")
  abort_on_cancel $?
  [[ -z "$AUTH_PASS" ]] && fail "Web password is required."

  # ── Mailserver ──
  wt_msg "Mailserver — about" "Next: how SpamView reaches your Mailcow server.

The container will SSH into the server and run:
  • docker logs <postfix-container>     (postscreen rejects)
  • docker exec <redis-container>       (rspamd history)
  • docker exec <mysql-container>       (quarantine table)

Your SSH user therefore needs sudo + docker access on the mailserver."

  MAILSERVER_HOST=$(wt_input "Mailserver hostname" "FQDN or IP of your mailserver." "mail.example.com")
  abort_on_cancel $?
  MAILSERVER_USER=$(wt_input "Mailserver SSH user" "User on the mailserver. Must be in sudo group with NOPASSWD or a tty-less sudoers entry for docker commands." "debian")
  abort_on_cancel $?
  MAILCOW_PROJECT=$(wt_input "Mailcow Docker project name" "The compose project name on the mailserver. Default Mailcow installations use 'mailcowdockerized'." "mailcowdockerized")
  abort_on_cancel $?
  MAILCOW_PATH=$(wt_input "Mailcow installation path" "Where Mailcow lives on the server (contains mailcow.conf)." "/opt/mailcow-dockerized")
  abort_on_cancel $?

  IGNORE_HOSTS=$(wt_input "Ignore patterns (regex, comma-separated)" "Drop noise from your own infrastructure. Examples:
   pve\\d+\\.fritz\\.box   →  proxmox auto-notifications
   .*\\.lan                →  internal hosts
Leave empty to keep everything." "")
  abort_on_cancel $?

  # ── AI ──
  AI_ENABLE=$(whiptail --backtitle "$W_BACKTITLE" --title "AI insights (optional)" --menu "Enable Google Gemini for natural-language explanations of rejects?" 14 78 2 \
    yes "Yes — I have or will create a Gemini API key" \
    no  "No — disable AI features" 3>&1 1>&2 2>&3) || abort_on_cancel 1

  GEMINI_API_KEY=""
  if [[ "$AI_ENABLE" == "yes" ]]; then
    wt_msg "Gemini API Key" "Get a free key at:
   https://aistudio.google.com/apikey

The free tier is generous and SpamView caches per-pattern explanations for 30 days, so usage stays minimal."

    GEMINI_API_KEY=$(wt_pass "Gemini API Key" "Paste your AIza... key (or leave empty to skip).")
    abort_on_cancel $?
  fi

  # ── Schedule ──
  PULL_INTERVAL=$(wt_input "Pull interval" "How often to pull from the mailserver (systemd timer syntax: 5min, 10min, 1h, …)." "10min")
  abort_on_cancel $?

  # ── Summary ──
  whiptail --backtitle "$W_BACKTITLE" --title "Review" --yesno "Ready to install SpamView with these settings?

LXC ID:        $CT_ID
Hostname:      $CT_HOSTNAME
Storage:       $CT_STORAGE  (${CT_DISK}G disk, ${CT_RAM}M RAM, ${CT_CORES} core)
Network:       ${USE_DHCP}${CT_IP:+  $CT_IP via $CT_GW}  on $CT_BRIDGE
Web UI auth:   $AUTH_USER  /  ********
Mailserver:    $MAILSERVER_USER@$MAILSERVER_HOST
  project:     $MAILCOW_PROJECT
  path:        $MAILCOW_PATH
AI:            ${AI_ENABLE}
Pull interval: $PULL_INTERVAL

Proceed?" 22 78 || abort_on_cancel 1
}

# ───────────────────────────────────────────────────────────────────────
# Container creation
# ───────────────────────────────────────────────────────────────────────
ensure_template() {
  step "Locating Debian 13 LXC template"
  TEMPLATE=$(pveam list local 2>/dev/null | awk '/debian-13/ {print $1; exit}')
  if [[ -z "$TEMPLATE" ]]; then
    info "Downloading debian-13-standard..."
    pveam update >/dev/null 2>&1 || true
    TEMPLATE_NAME=$(pveam available --section system 2>/dev/null | awk '/debian-13-standard/ {print $2; exit}')
    [[ -z "$TEMPLATE_NAME" ]] && fail "Cannot find debian-13-standard template in pveam catalog."
    pveam download local "$TEMPLATE_NAME" >/dev/null
    TEMPLATE="local:vztmpl/$TEMPLATE_NAME"
  fi
  ok "Template: $TEMPLATE"
}

create_lxc() {
  step "Creating LXC $CT_ID"
  local NET="name=eth0,bridge=$CT_BRIDGE"
  if [[ "$USE_DHCP" == "dhcp" ]]; then
    NET="$NET,ip=dhcp"
  else
    NET="$NET,ip=$CT_IP,gw=$CT_GW"
  fi
  local DNS_OPT=""
  [[ -n "$CT_DNS" ]] && DNS_OPT="--nameserver $CT_DNS"

  pct create "$CT_ID" "$TEMPLATE" \
    --hostname "$CT_HOSTNAME" \
    --memory "$CT_RAM" \
    --cores "$CT_CORES" \
    --rootfs "$CT_STORAGE:$CT_DISK" \
    --net0 "$NET" \
    $DNS_OPT \
    --password "$CT_PASSWORD" \
    --unprivileged 1 \
    --features nesting=1 \
    --onboot 1 \
    >/dev/null
  ok "LXC $CT_ID created"

  step "Starting LXC"
  pct start "$CT_ID"
  for i in {1..15}; do
    pct exec "$CT_ID" -- true 2>/dev/null && break
    sleep 1
  done
  ok "LXC running"
}

ct() { pct exec "$CT_ID" -- bash -c "$1"; }

install_packages() {
  step "Updating apt"
  ct "apt-get update -qq" >/dev/null
  step "Installing base packages"
  ct "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates gnupg sqlite3 zstd openssh-client" >/dev/null
  ok "Base packages installed"

  step "Installing Node.js 22"
  ct "curl -fsSL https://deb.nodesource.com/setup_22.x | bash -" >/dev/null 2>&1
  ct "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs" >/dev/null
  ok "Node $(ct 'node -v')"

  step "Installing Caddy"
  ct "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg" 2>/dev/null
  ct "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list"
  ct "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy" >/dev/null
  ok "Caddy installed"
}

deploy_app() {
  step "Deploying SpamView application"
  ct "mkdir -p /opt/spamview/public /var/lib/spamview/.ssh && chmod 700 /var/lib/spamview/.ssh"

  for f in db.js fetch.js server.js ai.js package.json; do
    pct push "$CT_ID" "$SCRIPT_DIR/src/$f" "/opt/spamview/$f" >/dev/null
  done
  for f in index.html style.css app.js; do
    pct push "$CT_ID" "$SCRIPT_DIR/src/public/$f" "/opt/spamview/public/$f" >/dev/null
  done
  ok "Source deployed"

  step "Installing npm dependencies"
  ct "cd /opt/spamview && npm install --omit=dev --silent --no-audit --no-fund" 2>&1 | tail -1
  ok "Dependencies installed"
}

setup_ssh_key() {
  step "Generating SSH key for mailserver pull"
  ct "ssh-keygen -t ed25519 -f /var/lib/spamview/.ssh/id_ed25519 -N '' -q -C 'spamview@$CT_HOSTNAME'"
  PUBKEY=$(ct "cat /var/lib/spamview/.ssh/id_ed25519.pub")
  ok "SSH key generated"
}

write_env_and_units() {
  step "Writing environment file"
  local TMP=$(mktemp)
  sed \
    -e "s|%%MAILSERVER_HOST%%|${MAILSERVER_HOST}|g" \
    -e "s|%%MAILSERVER_USER%%|${MAILSERVER_USER}|g" \
    -e "s|%%MAILCOW_PROJECT%%|${MAILCOW_PROJECT}|g" \
    -e "s|%%MAILCOW_PATH%%|${MAILCOW_PATH}|g" \
    -e "s|%%IGNORE_HOSTS%%|${IGNORE_HOSTS}|g" \
    -e "s|%%GEMINI_API_KEY%%|${GEMINI_API_KEY}|g" \
    "$SCRIPT_DIR/templates/spamview.env.tpl" > "$TMP"
  pct push "$CT_ID" "$TMP" /etc/spamview.env >/dev/null
  ct "chmod 600 /etc/spamview.env"
  rm "$TMP"
  ok "Wrote /etc/spamview.env"

  step "Writing systemd units"
  pct push "$CT_ID" "$SCRIPT_DIR/templates/spamview.service" /etc/systemd/system/spamview.service >/dev/null
  pct push "$CT_ID" "$SCRIPT_DIR/templates/spamview-fetch.service" /etc/systemd/system/spamview-fetch.service >/dev/null

  TMP=$(mktemp)
  sed "s|%%PULL_INTERVAL%%|${PULL_INTERVAL}|g" "$SCRIPT_DIR/templates/spamview-fetch.timer" > "$TMP"
  pct push "$CT_ID" "$TMP" /etc/systemd/system/spamview-fetch.timer >/dev/null
  rm "$TMP"
  ct "systemctl daemon-reload"
  ok "Systemd units installed"
}

write_caddyfile() {
  step "Generating Caddyfile (basic-auth + tls internal)"
  local AUTH_HASH
  AUTH_HASH=$(ct "caddy hash-password --plaintext '$AUTH_PASS'")
  local LISTEN
  LISTEN=$(echo "$CT_IP" | cut -d/ -f1)
  [[ -z "$LISTEN" ]] && LISTEN=$(ct "hostname -I | awk '{print \$1}'")

  local TMP=$(mktemp)
  sed \
    -e "s|%%LISTEN%%|${LISTEN}|g" \
    -e "s|%%LISTEN_PLAIN%%|${LISTEN}|g" \
    -e "s|%%AUTH_USER%%|${AUTH_USER}|g" \
    -e "s|%%AUTH_HASH%%|${AUTH_HASH}|g" \
    "$SCRIPT_DIR/templates/Caddyfile.tpl" > "$TMP"
  pct push "$CT_ID" "$TMP" /etc/caddy/Caddyfile >/dev/null
  rm "$TMP"
  ct "mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy"
  ct "caddy validate --config /etc/caddy/Caddyfile" >/dev/null 2>&1 || fail "Caddyfile validation failed"
  ok "Caddyfile valid"
}

start_services() {
  step "Enabling and starting services"
  ct "systemctl enable --now spamview.service spamview-fetch.timer caddy.service" >/dev/null 2>&1
  ok "Services up"
}

# ───────────────────────────────────────────────────────────────────────
# Post-install hand-off
# ───────────────────────────────────────────────────────────────────────
print_handoff() {
  local LISTEN
  LISTEN=$(echo "$CT_IP" | cut -d/ -f1)
  [[ -z "$LISTEN" ]] && LISTEN=$(ct "hostname -I | awk '{print \$1}'")

  whiptail --backtitle "$W_BACKTITLE" --title "Deploy SSH key to mailserver" \
    --msgbox "Almost done!

To let SpamView pull data, install this public key into ~/.ssh/authorized_keys
of '$MAILSERVER_USER' on $MAILSERVER_HOST:

$PUBKEY

After dismissing this dialog, you'll see a one-liner ready to copy/paste." 22 78

  echo
  echo -e "${GN}══════════════════════════════════════════════════════════${CL}"
  echo -e "${GN}  SpamView is live${CL}"
  echo -e "${GN}══════════════════════════════════════════════════════════${CL}"
  echo
  echo -e "  ${BL}URL${CL}      https://${LISTEN}/    (accept TLS-internal warning once)"
  echo -e "  ${BL}Login${CL}    $AUTH_USER / [the password you chose]"
  echo
  echo -e "  ${YW}Action required:${CL} install this key on $MAILSERVER_USER@$MAILSERVER_HOST"
  echo
  echo -e "${DM}    ssh-copy-id -i /tmp/spamview.pub $MAILSERVER_USER@$MAILSERVER_HOST${CL}"
  echo
  echo -e "  Or copy the key manually:"
  echo
  echo -e "${DM}    cat <<'KEY' >> ~/.ssh/authorized_keys${CL}"
  echo "    $PUBKEY"
  echo -e "${DM}    KEY${CL}"
  echo
  echo -e "  Then run inside the LXC to seed the DB:"
  echo
  echo -e "${DM}    pct exec $CT_ID -- systemctl start spamview-fetch.service${CL}"
  echo -e "${DM}    pct exec $CT_ID -- journalctl -u spamview-fetch.service -n 30 --no-pager${CL}"
  echo
}

# ───────────────────────────────────────────────────────────────────────
# Main
# ───────────────────────────────────────────────────────────────────────
unattended_load() {
  : "${CT_ID:?CT_ID required in unattended mode}"
  : "${CT_HOSTNAME:?CT_HOSTNAME required}"
  : "${CT_STORAGE:?CT_STORAGE required}"
  CT_DISK="${CT_DISK:-8}"
  CT_RAM="${CT_RAM:-1024}"
  CT_CORES="${CT_CORES:-1}"
  USE_DHCP="${USE_DHCP:-static}"
  if [[ "$USE_DHCP" == "static" ]]; then
    : "${CT_IP:?CT_IP required for static}"
    : "${CT_GW:?CT_GW required for static}"
  fi
  CT_BRIDGE="${CT_BRIDGE:-vmbr0}"
  CT_DNS="${CT_DNS:-}"
  : "${CT_PASSWORD:?CT_PASSWORD required}"
  AUTH_USER="${AUTH_USER:-admin}"
  : "${AUTH_PASS:?AUTH_PASS required}"
  : "${MAILSERVER_HOST:?MAILSERVER_HOST required}"
  MAILSERVER_USER="${MAILSERVER_USER:-debian}"
  MAILCOW_PROJECT="${MAILCOW_PROJECT:-mailcowdockerized}"
  MAILCOW_PATH="${MAILCOW_PATH:-/opt/mailcow-dockerized}"
  IGNORE_HOSTS="${IGNORE_HOSTS:-}"
  GEMINI_API_KEY="${GEMINI_API_KEY:-}"
  AI_ENABLE=$([[ -n "$GEMINI_API_KEY" ]] && echo yes || echo no)
  PULL_INTERVAL="${PULL_INTERVAL:-10min}"

  pct status "$CT_ID" >/dev/null 2>&1 && fail "LXC $CT_ID already exists."
  info "Unattended mode — using environment variables"
}

main() {
  header
  need_root_pve
  if [[ "${SPAMVIEW_UNATTENDED:-0}" == "1" ]]; then
    unattended_load
  else
    wizard
  fi
  ensure_template
  create_lxc
  install_packages
  deploy_app
  setup_ssh_key
  write_env_and_units
  write_caddyfile
  start_services
  print_handoff
}

main "$@"
