#!/bin/bash
# Lid-closed no-sleep, for macOS. This process owns `pmset -a disablesleep`: closing the lid then doesn't sleep the
# Mac either (caffeinate can't stop that one, it's below the OS's idle sleep). It needs root, so it runs through a
# sudoers rule allowing exactly `pmset -a disablesleep 1` / `0` (installed once with the "Authorize" button; a rule
# Amphetamine or Gerdr installed for the same command works as well).
#
# Gerdr restarts its backend by itself (an update is picked up once idle), and that restarts this service. Turning
# disablesleep off on the way out would let a Mac with its lid closed fall asleep in the seconds before the next copy
# turns it back on, and a sleeping Mac never starts the next copy. So the on/off choice lives in a file, and on exit
# the mode is handed over: left on, with a detached timer that turns it off unless a new copy takes it within
# HANDOVER seconds (the new copy writes its own pid into $OWNER). Quitting Gerdr for good during a stretch therefore
# keeps the Mac awake for at most that long.
#
# Talks to Gerdr in JSON lines (GUIDE.md "Services"): reads hello / settings / message, writes status / message.

set -u
DATA="${GERDR_ADDON_DATA:-$HOME/.lid-awake}"
mkdir -p "$DATA"
ON="$DATA/on"       # exists = the person turned it on
OWNER="$DATA/owner" # this copy's pid while it holds disablesleep; "handover <pid>" between two copies
PMSET=${LID_AWAKE_PMSET:-/usr/bin/pmset} # overridable only for testing the script
SUDO=${LID_AWAKE_SUDO:-/usr/bin/sudo}
RULE=/etc/sudoers.d/gerdr_lid_awake
HANDOVER=${LID_AWAKE_HANDOVER:-120}
TICK=${LID_AWAKE_TICK:-30}
LOW=20      # battery percent at or under which it lets go (setting lowBattery); 0 = never
LANG_=zh
ERR=""
LAST=""

say() { if [ "$LANG_" = en ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

ready() { $SUDO -n -l $PMSET -a disablesleep 1 >/dev/null 2>&1; }
set_ds() { $SUDO -n $PMSET -a disablesleep "$1" >/dev/null 2>&1; }
ds_now() { $PMSET -g | awk '/SleepDisabled/ { print $2; exit }'; }

# Battery: PCT (-1 = no battery), BATT (1 = running on it).
read_batt() {
  local out
  out=$($PMSET -g batt 2>/dev/null)
  PCT=$(printf '%s' "$out" | sed -n 's/.*[[:space:]]\([0-9][0-9]*\)%;.*/\1/p' | head -1)
  [ -n "$PCT" ] || PCT=-1
  case "$out" in *"'Battery Power'"*) BATT=1 ;; *) BATT=0 ;; esac
}

# apply makes disablesleep match what is wanted: on, and not on a low battery. It only turns off what it turned on
# (OWNER), so with this off it leaves other users of disablesleep (Gerdr's own Labs setting) alone.
apply() {
  read_batt
  IS_LOW=0
  if [ "$BATT" = 1 ] && [ "$PCT" -ge 0 ] && [ "$PCT" -le "$LOW" ] && [ "$LOW" -gt 0 ]; then IS_LOW=1; fi
  if [ -e "$ON" ] && [ "$IS_LOW" = 0 ]; then
    if ! ready; then
      ERR=$(say "还没授权：设置 → 扩展 → 合盖不休眠 → 授权（在电脑上输一次密码）" "Not authorized yet: Settings → Add-ons → Lid awake → Authorize (enter your password once on this computer)")
      return
    fi
    ERR=""
    # Also re-asserts it each tick: something else (Gerdr's Labs stretch ending) may have turned it off
    if [ "$(ds_now)" != 1 ] && ! set_ds 1; then
      ERR=$(say "pmset 没能打开 disablesleep" "pmset could not turn disablesleep on")
      return
    fi
    echo "$$" >"$OWNER"
  else
    ERR=""
    if [ -e "$OWNER" ]; then
      set_ds 0 && rm -f "$OWNER"
    fi
  fi
}

report() {
  local on=false active=false low=false rd=false batt=false text
  [ -e "$ON" ] && on=true
  [ "$(cat "$OWNER" 2>/dev/null)" = "$$" ] && active=true
  [ "${IS_LOW:-0}" = 1 ] && low=true
  ready && rd=true
  [ "${BATT:-0}" = 1 ] && batt=true
  local state="{\"on\":$on,\"active\":$active,\"low\":$low,\"ready\":$rd,\"percent\":${PCT:--1},\"onBattery\":$batt,\"lowLine\":$LOW,\"error\":\"$(esc "$ERR")\"}"
  if [ "$state" != "$LAST" ] || [ "${1:-}" = force ]; then
    LAST=$state
    printf '{"type":"message","data":%s}\n' "$state"
    if [ -n "$ERR" ]; then text=$ERR
    elif [ "$active" = true ]; then text=$(say "合盖也不睡（开着）" "Awake with the lid closed (on)")
    elif [ "$low" = true ]; then text=$(say "电量低，暂时放手：电脑可以睡" "Low battery, let go for now: the Mac may sleep")
    else text=$(say "关着" "Off"); fi
    printf '{"type":"status","text":"%s"}\n' "$(esc "$text")"
  fi
}

# authorize installs the sudoers rule through macOS's administrator prompt. The rule is written by root into a file
# root made itself (mktemp on that side), checked with visudo, then installed: a file of ours handed to root could be
# swapped for "ALL NOPASSWD: ALL" between the check and the copy.
authorize() {
  local u rule sh script
  u=$(id -un)
  case "$u" in *[!A-Za-z0-9._-]*|"") ERR="bad user name"; return ;; esac
  rule="$u ALL=(root) NOPASSWD: $PMSET -a disablesleep 1, $PMSET -a disablesleep 0"
  sh="f=\$(/usr/bin/mktemp /tmp/gerdr_lid_awake.XXXXXX) || exit 1; /usr/bin/printf '%s\\n' '$rule' > \"\$f\" && /usr/sbin/visudo -cf \"\$f\" && /usr/bin/install -m 0440 -o root -g wheel \"\$f\" $RULE; r=\$?; /bin/rm -f \"\$f\"; exit \$r"
  script="do shell script \"$(esc "$sh")\" with administrator privileges with prompt \"$(esc "$(say "合盖不休眠要一次授权：只放行 pmset disablesleep 这一条命令" "Lid awake needs one-time authorization: it only allows the pmset disablesleep command")")\""
  if ! out=$(/usr/bin/osascript -e "$script" 2>&1); then
    case "$out" in *-128*) ERR=$(say "取消了授权" "Authorization canceled") ;; *) ERR="$(say "授权失败：" "Authorization failed: ")$out" ;; esac
    report force
    ERR=""
    return
  fi
}

handover() {
  [ "$(cat "$OWNER" 2>/dev/null)" = "$$" ] || exit 0
  local tag="handover $$"
  echo "$tag" >"$OWNER"
  # Detached from Gerdr's pipes (it waits for stdout to close) and deaf to the signals a stopping parent sends
  (
    trap '' HUP TERM INT
    sleep "$HANDOVER"
    [ "$(cat "$OWNER" 2>/dev/null)" = "$tag" ] && set_ds 0 && rm -f "$OWNER"
  ) </dev/null >/dev/null 2>&1 &
  exit 0
}

# Start: a handover from the last copy is taken by apply (it rewrites OWNER, or turns it off when no longer wanted).
# A leftover owner with the switch off (a copy killed outright) is cleaned up the same way.
apply
report force

while :; do
  t0=$SECONDS
  if IFS= read -r -t "$TICK" line; then
    case "$line" in
      *'"type":"hello"'*)
        case "$line" in *'"lang":"en"'*) LANG_=en ;; *) LANG_=zh ;; esac ;;
      *'"type":"settings"'*)
        v=$(printf '%s' "$line" | sed -n 's/.*"lowBattery":\([0-9][0-9]*\).*/\1/p')
        [ -n "$v" ] && LOW=$v
        apply; report ;;
      *'"type":"message"'*)
        case "$line" in
          *'"cmd":"toggle"'*) if [ -e "$ON" ]; then rm -f "$ON"; else : >"$ON"; fi ;;
          *'"cmd":"on"'*) : >"$ON" ;;
          *'"cmd":"off"'*) rm -f "$ON" ;;
          *'"cmd":"authorize"'*) authorize ;;
        esac
        apply; report force ;;
    esac
  else
    # bash 3.2 returns 1 both on a timeout and at EOF: a timeout took the whole TICK, an EOF comes early (and if one
    # lands right at the end, the next read sees it at once)
    if [ $((SECONDS - t0)) -ge "$TICK" ]; then
      apply; report
    else
      handover
    fi
  fi
done
