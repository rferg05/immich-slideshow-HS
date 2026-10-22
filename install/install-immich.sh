#!/usr/bin/env bash
# Installs Immich on the Raspberry Pi that runs Home Screens, with the photos
# and videos stored on a NAS (Synology DS220j here) and only the database on
# the Pi. Tuned so processing new uploads doesn't make the dashboard stutter:
#   - machine learning (face/object search) is off and its container never starts
#   - Immich is limited to half the CPU cores
#   - one thumbnail and one video conversion at a time
#   - iPhone HEIC photos get 2160px JPEG previews, HEVC videos are converted to
#     1080p H.264, both of which the Pi's browser can show
#
# Usage (on the Pi):
#   sudo bash install-immich.sh                       # asks where to store media
#   sudo bash install-immich.sh --nfs 192.168.1.20:/volume1/immich
#   sudo bash install-immich.sh --smb //192.168.1.20/immich --smb-user immich
#   sudo bash install-immich.sh --local               # media on the Pi itself
#
# Re-running is safe: it keeps the database password and existing settings
# file, and updates Immich to the version below.

set -euo pipefail

IMMICH_VERSION="v3.3.5"
INSTALL_DIR="/opt/immich"
MOUNT_POINT="/mnt/immich-media"
SMB_CREDENTIALS="/etc/immich-nas.credentials"
PORT=2283
MIN_RAM_MB=3500     # a 4 GB Pi reports about 3.8 GB
MIN_FREE_GB=6       # Docker images (~2 GB) plus room for the database

STORAGE=""          # nfs | smb | local
NAS_SOURCE=""       # host:/export for NFS, //host/share for SMB
SMB_USER=""
ASSUME_YES=0

# ── Output ───────────────────────────────────────────────────────────────────

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

# ── Arguments ────────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --nfs) STORAGE=nfs; NAS_SOURCE="${2:?--nfs needs host:/path}"; shift 2 ;;
    --smb) STORAGE=smb; NAS_SOURCE="${2:?--smb needs //host/share}"; shift 2 ;;
    --smb-user) SMB_USER="${2:?--smb-user needs a name}"; shift 2 ;;
    --local) STORAGE=local; shift ;;
    --version) IMMICH_VERSION="${2:?--version needs a tag like v3.3.5}"; shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

ask() { # ask "Question" default -> echoes answer
  local reply
  if [[ $ASSUME_YES -eq 1 ]]; then echo "$2"; return; fi
  read -r -p "$1 [$2]: " reply </dev/tty
  echo "${reply:-$2}"
}

# ── 1. Will it fit on this Pi? ───────────────────────────────────────────────

step "Checking this Pi"

arch="$(uname -m)"
[[ "$arch" == "aarch64" ]] || die "Immich needs a 64-bit OS (this is $arch). Reflash with Raspberry Pi OS (64-bit)."

model="$(tr -d '\0' </proc/device-tree/model 2>/dev/null || echo 'unknown board')"
ram_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
cores="$(nproc)"
. /etc/os-release
codename="${VERSION_CODENAME:-}"
echo "  $model, ${ram_mb} MB RAM, $cores cores, ${PRETTY_NAME:-unknown OS}"

if (( ram_mb < MIN_RAM_MB )); then
  die "Immich needs at least 4 GB of RAM alongside Home Screens; this Pi has ${ram_mb} MB.
Run Immich on another always-on computer instead (the slideshow plugin works the same)."
fi
if (( ram_mb < 7000 )); then
  warn "4 GB works with machine learning off (as set up here), but leaves little headroom."
  warn "Avoid uploading hundreds of photos at once; they're processed one at a time."
fi
if [[ "$model" == *"Raspberry Pi 4"* ]]; then
  warn "A Pi 4 converts iPhone videos slowly (minutes per clip). Photos are fine."
fi
case "$codename" in
  bookworm|trixie) ;;
  *) warn "Untested OS release '$codename'. Continuing with Docker's Debian packages for it." ;;
esac

free_gb=$(( $(df --output=avail -k / | tail -1) / 1024 / 1024 ))
(( free_gb >= MIN_FREE_GB )) || die "Only ${free_gb} GB free on the SD card/SSD; Immich needs ${MIN_FREE_GB} GB."

if findmnt -no SOURCE / | grep -q mmcblk; then
  warn "The database will live on the SD card. It works, but an SSD lasts longer and is faster."
fi

if ss -ltn "sport = :$PORT" | grep -q LISTEN && ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^immich_server$'; then
  die "Port $PORT is already in use by something other than Immich."
fi

lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')"
[[ -n "$lan_ip" ]] || die "Couldn't find this Pi's network address. Is it connected?"
echo "  Network address: $lan_ip"

# ── 2. Where the photos go ───────────────────────────────────────────────────

if [[ -z "$STORAGE" ]]; then
  step "Where should photos and videos be stored?"
  echo "  1) Synology/NAS shared folder over NFS   (recommended)"
  echo "  2) Synology/NAS shared folder over SMB   (uses a NAS user name and password)"
  echo "  3) On this Pi                            (fine for trying it out)"
  case "$(ask "Choose 1, 2 or 3" 1)" in
    1) STORAGE=nfs ;;
    2) STORAGE=smb ;;
    3) STORAGE=local ;;
    *) die "Please choose 1, 2 or 3." ;;
  esac
fi

if [[ "$STORAGE" == nfs && -z "$NAS_SOURCE" ]]; then
  host="$(ask "NAS address" "192.168.1.20")"
  path="$(ask "NFS path of the shared folder (Synology: Control Panel > Shared Folder > Edit > NFS Permissions, at the bottom)" "/volume1/immich")"
  NAS_SOURCE="$host:$path"
fi
if [[ "$STORAGE" == smb && -z "$NAS_SOURCE" ]]; then
  host="$(ask "NAS address" "192.168.1.20")"
  share="$(ask "Shared folder name" "immich")"
  NAS_SOURCE="//$host/$share"
fi

# ── 3. Docker ────────────────────────────────────────────────────────────────

step "Installing Docker"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "  Already installed: $(docker --version)"
else
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${codename:-bookworm} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  echo "  Installed: $(docker --version)"
fi

# Container logs otherwise grow without limit on the SD card.
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null

# ── 4. Mount the NAS ─────────────────────────────────────────────────────────

add_fstab() { # add_fstab "line" — replaces any earlier line for the mount point
  local line="$1"
  sed -i "\# ${MOUNT_POINT} #d" /etc/fstab
  echo "$line" >>/etc/fstab
  systemctl daemon-reload
}

if [[ "$STORAGE" == nfs || "$STORAGE" == smb ]]; then
  step "Connecting to the NAS ($NAS_SOURCE)"
  mkdir -p "$MOUNT_POINT"
  umount "$MOUNT_POINT" 2>/dev/null || true

  # x-systemd.automount: mounted on first use, so a NAS that's still booting
  # after a power cut doesn't hold up the Pi; Immich waits for it instead.
  common="_netdev,nofail,noatime,x-systemd.automount,x-systemd.mount-timeout=30"
  if [[ "$STORAGE" == nfs ]]; then
    apt-get install -y -qq nfs-common
    add_fstab "$NAS_SOURCE ${MOUNT_POINT} nfs rw,hard,$common 0 0"
  else
    apt-get install -y -qq cifs-utils
    [[ -n "$SMB_USER" ]] || SMB_USER="$(ask "NAS user name for the shared folder" "immich")"
    if [[ ! -f "$SMB_CREDENTIALS" ]] || ! grep -q "^username=$SMB_USER$" "$SMB_CREDENTIALS"; then
      read -r -s -p "Password for NAS user '$SMB_USER': " smb_pass </dev/tty; echo
      umask 077
      printf 'username=%s\npassword=%s\n' "$SMB_USER" "$smb_pass" >"$SMB_CREDENTIALS"
      unset smb_pass
    fi
    chmod 600 "$SMB_CREDENTIALS"
    add_fstab "$NAS_SOURCE ${MOUNT_POINT} cifs credentials=$SMB_CREDENTIALS,uid=0,gid=0,file_mode=0660,dir_mode=0770,iocharset=utf8,vers=3.0,$common 0 0"
  fi

  systemctl restart remote-fs.target
  if ! timeout 40 ls "$MOUNT_POINT" >/dev/null 2>&1 || ! mountpoint -q "$MOUNT_POINT"; then
    die "Couldn't mount $NAS_SOURCE. On the Synology, check:
  - Control Panel > File Services: NFS (or SMB) is turned on
  - Control Panel > Shared Folder > (folder) > Edit > NFS Permissions has a rule for $lan_ip
    with Read/Write and Squash 'Map all users to admin'
  - the path matches the 'Mount path' shown at the bottom of that NFS Permissions page"
  fi
  probe="$MOUNT_POINT/.immich-write-test-$$"
  if ! touch "$probe" 2>/dev/null; then
    die "Mounted $NAS_SOURCE, but can't write to it. Give $lan_ip Read/Write access (NFS: Squash 'Map all users to admin')."
  fi
  rm -f "$probe"
  echo "  Mounted at $MOUNT_POINT and writable."
  UPLOAD_LOCATION="$MOUNT_POINT/library"
else
  UPLOAD_LOCATION="$INSTALL_DIR/library"
fi
mkdir -p "$UPLOAD_LOCATION"

# ── 5. Immich ────────────────────────────────────────────────────────────────

step "Setting up Immich $IMMICH_VERSION in $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
release="https://github.com/immich-app/immich/releases/download/$IMMICH_VERSION"
curl -fsSL "$release/docker-compose.yml" -o docker-compose.yml \
  || die "Couldn't download Immich $IMMICH_VERSION. Check the version tag and the Pi's internet connection."

db_password=""
if [[ -f .env ]]; then
  db_password="$(sed -n 's/^DB_PASSWORD=//p' .env)"
fi
[[ -n "$db_password" ]] || db_password="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)"
tz="$(timedatectl show -p Timezone --value 2>/dev/null || echo Etc/UTC)"
cpus=$(( cores / 2 )); (( cpus >= 1 )) || cpus=1

cat >.env <<ENV
# Written by install-immich.sh. Re-running the script rewrites this file but
# keeps DB_PASSWORD.
UPLOAD_LOCATION=$UPLOAD_LOCATION
# The database stays on the Pi: Immich doesn't support it on a network share.
DB_DATA_LOCATION=$INSTALL_DIR/postgres
TZ=$tz
IMMICH_VERSION=$IMMICH_VERSION
DB_PASSWORD=$db_password
DB_USERNAME=postgres
DB_DATABASE_NAME=immich
# Settings come from immich.json; while this is set they can't be changed
# in Administration > Settings. Edit the file and run: docker compose up -d
IMMICH_CONFIG_FILE=/config/immich.json
ENV
chmod 600 .env

cat >docker-compose.override.yml <<YAML
# Written by install-immich.sh: sharing the Pi with the Home Screens display.
services:
  immich-server:
    volumes:
      - ./immich.json:/config/immich.json:ro
    # At most half the cores, so the dashboard stays smooth while uploads
    # are processed.
    cpus: $cpus
  database:
    cpus: 1
  immich-machine-learning:
    # Face and object search: too heavy next to the display. Never started
    # unless asked for with: docker compose --profile ml up -d
    profiles: ["ml"]
YAML

if [[ ! -f immich.json ]]; then
  cat >immich.json <<JSON
{
  "server": {
    "externalDomain": "http://$lan_ip:$PORT"
  },
  "machineLearning": {
    "enabled": false
  },
  "image": {
    "preview": { "size": 2160, "format": "jpeg", "quality": 82 }
  },
  "ffmpeg": {
    "transcode": "required",
    "targetVideoCodec": "h264",
    "acceptedVideoCodecs": ["h264"],
    "acceptedContainers": ["mp4"],
    "targetResolution": "1080",
    "threads": $cpus,
    "realtime": { "enabled": false }
  },
  "job": {
    "thumbnailGeneration": { "concurrency": 1 },
    "videoConversion": { "concurrency": 1 },
    "metadataExtraction": { "concurrency": 2 },
    "backgroundTask": { "concurrency": 2 }
  },
  "storageTemplate": {
    "enabled": true,
    "template": "{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}"
  }
}
JSON
else
  # Keep the user's settings, but follow the Pi to a new address.
  sed -i -E "s#(\"externalDomain\": *\")[^\"]*#\1http://$lan_ip:$PORT#" immich.json
  echo "  Kept the existing immich.json (address updated to http://$lan_ip:$PORT)."
fi

step "Downloading and starting Immich (the first time takes a few minutes)"
docker compose pull
docker compose up -d --remove-orphans

printf '  Waiting for Immich to answer'
for _ in $(seq 1 90); do
  if curl -fs "http://127.0.0.1:$PORT/api/server/ping" | grep -q pong; then
    echo " - ready."
    break
  fi
  printf '.'
  sleep 4
done
curl -fs "http://127.0.0.1:$PORT/api/server/ping" | grep -q pong \
  || die "Immich didn't start. See: cd $INSTALL_DIR && docker compose logs immich-server"

# ── 6. Next steps ────────────────────────────────────────────────────────────

where="$UPLOAD_LOCATION"
[[ "$STORAGE" == local ]] || where="$UPLOAD_LOCATION ($NAS_SOURCE)"
next_steps="Immich is running at  http://$lan_ip:$PORT
Media is stored in    $where

1. Give this Pi a fixed address ($lan_ip) in your router's DHCP settings, so
   the app, the share links and the dashboard keep finding it.
2. On a phone or computer, open http://$lan_ip:$PORT and create the admin
   account. Then Administration > Users to add one account per family member.
3. Create an album named Dashboard and share it with everyone's account
   (Share > invite users), so they can add to it from the Immich app.
4. In the album, Share > Create link, no password, no expiry. Paste it into the
   Immich Slideshow module's 'Album share link' in the Home Screens editor.
5. For guests without an account: make a second link with 'Allow upload' on.
   They open it in Safari and tap the upload button. No app or sign-in.
6. iPhones: either save the upload link from step 5 to the Home Screen in
   Safari (open it, tap Upload, pick photos), or install 'Immich' from the
   App Store (server URL http://$lan_ip:$PORT), sign in, and add photos to
   the Dashboard album from there.

Settings: $INSTALL_DIR/immich.json  (then: cd $INSTALL_DIR && sudo docker compose up -d)
Logs:     cd $INSTALL_DIR && sudo docker compose logs -f immich-server
Update:   re-run this script with --version vX.Y.Z (read Immich's release notes first)"

echo "$next_steps" >"$INSTALL_DIR/NEXT-STEPS.txt"
echo
bold "Done."
echo "$next_steps"
echo
echo "(Saved to $INSTALL_DIR/NEXT-STEPS.txt)"
