#!/bin/bash
# ---------------------------------------------------------------------------------------------
#  Signifi Lane Tester – FULL version installer for Linux (Ubuntu) NUCs, no USB stick needed.
#
#    curl -fsSL https://kspatel45.github.io/Spark-Testing/install.sh | bash
#
#  Installs for the logged-in user only (nothing outside the home folder, except the optional
#  sudo step below):
#    ~/.local/share/signifi-lane-tester   Node.js runtime + tester app (replaced on every update)
#    ~/.config/signifi-lane-tester        settings (Odoo key entered in Admin → Odoo), results, NUC serial
#    Desktop icon "Lane Tester" → opens the tester full screen (kiosk) – Alt+F4 closes it
#  Runs the tester server in the background (systemd user service, port 8080, localhost only).
#  Optional sudo step (asks for the password once): serial-port access for the FTDI adapter and
#  the NUC serial number.   Re-run the same command to update.   Uninstall:
#    bash ~/.local/share/signifi-lane-tester/uninstall.sh
# ---------------------------------------------------------------------------------------------
main() {
  set -u
  local BASE="${LANE_BASE:-https://kspatel45.github.io/Spark-Testing}"
  local DIR="$HOME/.local/share/signifi-lane-tester" CONF="$HOME/.config/signifi-lane-tester"
  local PORT=8080 URL="http://127.0.0.1:8080/"
  # own temp folder; the cleanup trap gets the literal path now (never a variable that may mean something else at exit)
  local TMP; TMP="$(mktemp -d "${TMPDIR:-/tmp}/signifi-lane-tester.XXXXXX")" || { echo "mktemp failed"; exit 1; }
  case "$TMP" in */signifi-lane-tester.??????) trap "rm -rf -- '$TMP'" EXIT ;; *) echo "unexpected temp path $TMP"; exit 1 ;; esac
  say()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
  warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
  die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*"; exit 1; }
  get()  { if command -v curl >/dev/null; then curl -fsSL --retry 2 -o "$2" "$1"; else wget -q -O "$2" "$1"; fi; }
  ask()  { local a=""; if [ -r /dev/tty ]; then read -r -p "$1 " a </dev/tty || a=""; fi; printf '%s' "$a"; }

  [ "$(uname -s)" = Linux ] || die "This installer is for Linux. On Windows use the Windows tester."
  [ "$(uname -m)" = x86_64 ] || die "Only 64-bit Intel/AMD NUCs (x86_64) are supported – this PC is $(uname -m)."
  command -v curl >/dev/null || command -v wget >/dev/null || die "curl or wget is needed."
  command -v tar >/dev/null || die "tar is needed."
  mkdir -p "$DIR" "$CONF/results" || die "Cannot write to $DIR"
  chmod 700 "$CONF"

  # ---- 1. Node.js runtime (official build from nodejs.org, checksum verified)
  local NODE="$DIR/node/bin/node"
  if [ -x "$NODE" ] && "$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; then
    say "Node.js $("$NODE" -v) already installed"
  else
    say "Downloading Node.js (about 30 MB)…"
    local NB="https://nodejs.org/dist/latest-v22.x"
    get "$NB/SHASUMS256.txt" "$TMP/sums" || die "Cannot reach nodejs.org – check the internet connection / proxy."
    local LINE; LINE="$(grep -E 'node-v[0-9.]+-linux-x64\.tar\.gz$' "$TMP/sums" | head -1)"
    [ -n "$LINE" ] || die "Could not find the Node.js download."
    local FILE="${LINE##* }" SUM="${LINE%% *}"
    get "$NB/$FILE" "$TMP/$FILE" || die "Node.js download failed."
    echo "$SUM  $TMP/$FILE" | sha256sum -c --status - || die "Node.js download is corrupt (checksum mismatch) – run the installer again."
    rm -rf "$DIR/node" && mkdir -p "$DIR/node" && tar -xzf "$TMP/$FILE" -C "$DIR/node" --strip-components=1 || die "Could not unpack Node.js."
    say "Node.js $("$NODE" -v) installed"
  fi

  # ---- 2. tester app (same app as the Windows version)
  say "Downloading the Lane Tester…"
  get "$BASE/helper/lane-tester-app.tar.gz?$(date +%s)" "$TMP/app.tgz" || die "Download of the tester failed."
  rm -rf "$DIR/app.new" && mkdir -p "$DIR/app.new" && tar -xzf "$TMP/app.tgz" -C "$DIR/app.new" || die "Could not unpack the tester."
  [ -f "$DIR/app.new/server.js" ] || die "The tester download is incomplete."
  rm -rf "$DIR/app" && mv "$DIR/app.new" "$DIR/app"
  say "Lane Tester $(cat "$DIR/app/VERSION" 2>/dev/null) installed"
  # first install: starter settings (real machine, Qendra) – kept on updates
  [ -f "$CONF/config.json" ] || cp "$DIR/app/starter-config.json" "$CONF/config.json"
  chmod 600 "$CONF/config.json" 2>/dev/null

  # ---- 3. server start script + kiosk launcher + uninstaller
  cat >"$DIR/run-server.sh" <<EOF
#!/bin/bash
export LANE_CONFIG="$CONF/config.json" LANE_RESULTS_DIR="$CONF/results" PORT=$PORT
[ -f "$CONF/.api" ] && export LANE_ODOO_FILE="$CONF/.api"
[ -s "$CONF/nuc-serial" ] && export LANE_HOST_SERIAL="\$(cat "$CONF/nuc-serial")"
cd "$DIR/app" && exec "$DIR/node/bin/node" server.js
EOF
  cat >"$DIR/kiosk.sh" <<EOF
#!/bin/bash
# Opens the Lane Tester full screen. Starts the server first if it is not running.
port_open() { (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null; }
if ! port_open; then
  systemctl --user start signifi-lane-tester.service 2>/dev/null || ( nohup "$DIR/run-server.sh" >"$CONF/server.log" 2>&1 & )
  for i in \$(seq 1 80); do port_open && break; sleep 0.25; done
fi
port_open || { command -v zenity >/dev/null && zenity --error --text="The Lane Tester did not start.\nSee $CONF/server.log"; exit 1; }
B=""; for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge; do command -v "\$b" >/dev/null && { B="\$b"; break; }; done
[ -n "\$B" ] || { xdg-open "$URL"; exit 0; }
P="$CONF/browser-profile"
case "\$(readlink -f "\$(command -v "\$B")")" in /snap/*|*/snap) P="\$HOME/snap/\$(basename "\$B" | sed 's/-browser\$//')/common/lane-tester-profile" ;; esac
mkdir -p "\$P"
exec "\$B" --kiosk --app="$URL" --user-data-dir="\$P" --no-first-run --no-default-browser-check --password-store=basic \\
  --use-fake-ui-for-media-stream --disable-features=TranslateUI --overscroll-history-navigation=0
EOF
  cat >"$DIR/uninstall.sh" <<EOF
#!/bin/bash
systemctl --user disable --now signifi-lane-tester.service 2>/dev/null
rm -f "\$HOME/.config/systemd/user/signifi-lane-tester.service" "\$HOME/.config/autostart/signifi-lane-tester.desktop" \\
      "\$HOME/.local/share/applications/signifi-lane-tester.desktop" "$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")/signifi-lane-tester.desktop"
rm -rf "$DIR"
echo "Lane Tester removed. Settings and results are kept in $CONF (delete that folder to remove them too)."
EOF
  chmod +x "$DIR/run-server.sh" "$DIR/kiosk.sh" "$DIR/uninstall.sh"

  # ---- 4. background server (systemd user service, or a login autostart entry as fallback)
  if systemctl --user show-environment >/dev/null 2>&1; then
    mkdir -p "$HOME/.config/systemd/user"
    cat >"$HOME/.config/systemd/user/signifi-lane-tester.service" <<EOF
[Unit]
Description=Signifi Lane Tester server (localhost:$PORT)
[Service]
ExecStart=$DIR/run-server.sh
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable signifi-lane-tester.service >/dev/null 2>&1
    systemctl --user restart signifi-lane-tester.service && say "Server running (starts automatically at login)"
  else
    mkdir -p "$HOME/.config/autostart"
    printf '[Desktop Entry]\nType=Application\nName=Lane Tester server\nExec=%s\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n' "$DIR/run-server.sh" >"$HOME/.config/autostart/signifi-lane-tester.desktop"
    pkill -u "$(id -u)" -f "signifi-lane-tester/node/bin/node server.js" 2>/dev/null; sleep 1
    ( nohup "$DIR/run-server.sh" >"$CONF/server.log" 2>&1 & )
    say "Server started (starts automatically at login)"
  fi

  # ---- 5. desktop icon + app menu entry (kiosk mode)
  cp "$DIR/app/icon-192.png" "$DIR/icon.png" 2>/dev/null || true
  local ENTRY
  ENTRY="[Desktop Entry]
Version=1.0
Type=Application
Name=Lane Tester
Comment=Signifi lane tester (full version) – full screen, Alt+F4 to close
Exec="$DIR/kiosk.sh"
Icon=$DIR/icon.png
Terminal=false
Categories=Utility;
StartupNotify=true"
  mkdir -p "$HOME/.local/share/applications"
  printf '%s\n' "$ENTRY" >"$HOME/.local/share/applications/signifi-lane-tester.desktop"
  local DESK; DESK="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
  mkdir -p "$DESK"
  printf '%s\n' "$ENTRY" >"$DESK/signifi-lane-tester.desktop"
  chmod +x "$DESK/signifi-lane-tester.desktop" "$HOME/.local/share/applications/signifi-lane-tester.desktop"
  command -v gio >/dev/null && gio set "$DESK/signifi-lane-tester.desktop" metadata::trusted true 2>/dev/null
  say "Desktop icon \"Lane Tester\" created"

  # ---- 6. optional, needs sudo once: FTDI serial access + NUC serial number
  local DO_SUDO="${LANE_SUDO:-}"
  [ -z "$DO_SUDO" ] && DO_SUDO="$(ask 'Set up serial-port access and read the NUC serial number now? Needs the sudo password once. [Y/n]')"
  case "$DO_SUDO" in n|N|no|NO) warn "Skipped. Without it Connect may fail (\"permission denied\") and the NUC serial shows as unknown." ;;
    *)
      if sudo -v </dev/tty; then
        printf '%s\n' '# Signifi Lane Tester: USB-RS232 adapters (FTDI and others) usable without root' \
          'SUBSYSTEM=="tty", ATTRS{idVendor}=="0403", MODE="0666"' \
          'SUBSYSTEM=="tty", ATTRS{idVendor}=="067b", MODE="0666"' \
          'SUBSYSTEM=="tty", ATTRS{idVendor}=="10c4", MODE="0666"' \
          'SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", MODE="0666"' | sudo tee /etc/udev/rules.d/99-signifi-lane-tester.rules >/dev/null
        sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=tty
        for d in /dev/ttyUSB* /dev/ttyACM*; do [ -e "$d" ] && sudo chmod a+rw "$d"; done
        sudo usermod -aG dialout "$USER" 2>/dev/null
        sudo cat /sys/class/dmi/id/product_serial 2>/dev/null | tr -d '\r\n ' >"$CONF/nuc-serial"
        chmod 600 "$CONF/nuc-serial"
        say "Serial-port access set up; NUC serial: $(cat "$CONF/nuc-serial" 2>/dev/null || echo unknown)"
        systemctl --user restart signifi-lane-tester.service 2>/dev/null || true
      else warn "sudo was not accepted – skipped. Re-run the installer to try again."; fi ;;
  esac

  echo
  say "Done. Double-click \"Lane Tester\" on the desktop (or find it in Show Applications)."
  echo "    Odoo SO lookup: in the tester open Admin (gear) → Odoo, enter URL, database, login and API key once."
  echo "    Update: run the same install command again.   Uninstall: bash $DIR/uninstall.sh"
  if [ -t 1 ] && [ -z "${LANE_NO_LAUNCH:-}" ]; then ( setsid "$DIR/kiosk.sh" >/dev/null 2>&1 & ); fi
  return 0
}
main "$@"
