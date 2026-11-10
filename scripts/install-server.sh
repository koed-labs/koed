#!/usr/bin/env bash
# Koed Server installer release template, rendered with one exact version.
# Everything before the final line only defines functions, so a truncated
# download cannot start an installation.
koed_fail() { printf '%s\n' "$@" >&2; return 1; }
koed_phase_fail() {
  printf '%s\n' "Koed install stopped during: $1." \
    "Installed state is preserved in $home; nothing was stopped or rolled back." \
    "Fix the cause, then rerun this installer with the same version. To inspect: $launcher doctor" >&2
  return 1
}
# koed_owner create|check|node|update VERSION [STATE [NODE]]
koed_owner() {
  python3 -I -c 'import json,os,sys
home,action,version=sys.argv[1:4]
p=home+"/installer/owner.json"
d={}
if action!="create":
    if os.path.islink(p) or not os.path.isfile(p): sys.exit(1)
    try: d=json.load(open(p))
    except ValueError: sys.exit(1)
    if not isinstance(d,dict) or d.get("version")!=version or d.get("home")!=home: sys.exit(1)
if action=="check": sys.exit(0)
if action=="node":
    print(d.get("node") or ""); sys.exit(0)
d.update(version=version,home=home,state=sys.argv[4])
if len(sys.argv)>5: d["node"]=sys.argv[5]
f=open(p,"x") if action=="create" else open(p+".next","w")
json.dump(d,f); f.flush(); os.fsync(f.fileno()); f.close()
if action!="create": os.replace(p+".next",p)' "$home" "$@"
}
koed_cli() {
  env -i HOME="$HOME" KOED_HOME="$home" PATH="$(dirname "$node"):$PATH" \
    ${USER:+USER="$USER"} ${LOGNAME:+LOGNAME="$LOGNAME"} ${LANG:+LANG="$LANG"} ${LC_ALL:+LC_ALL="$LC_ALL"} ${TMPDIR:+TMPDIR="$TMPDIR"} \
    "$node" "$package/bin/koed.js" "$@"
}
# koed_json EXPRESSION COMMAND...: command stdout stays private and is never
# printed; EXPRESSION is evaluated with the parsed JSON object bound to d.
koed_json() {
  local expression=$1 output="${install_dir:?}/tmp/command.json" status=0
  shift
  koed_cli "$@" > "$output" || status=$?
  python3 -I -c 'import json,sys
try: d=json.load(open(sys.argv[1]))
except (OSError, ValueError): sys.exit(1)
if not isinstance(d,dict) or not eval(sys.argv[2],{"d":d}): sys.exit(1)
if type(d.get("startedPid")) is int: open(sys.argv[3],"w").write(str(d["startedPid"]))' "$output" "$expression" "$install_dir/tmp/started-pid" || status=1
  rm -f "$output"
  return "$status"
}
koed_supervisor_pid() {
  python3 -I -c 'import json,os,sys
p=sys.argv[1]+"/run/koed-server.lock"
try:
    if os.path.islink(p): sys.exit(1)
    pid=json.load(open(p)).get("pid")
except (OSError, ValueError, AttributeError): sys.exit(1)
if type(pid) is not int or pid<=1: sys.exit(1)
print(pid)' "$home"
}
koed_install() {
  local embedded='__KOED_INSTALLER_VERSION__'
  local sentinel='koed-installer-complete-v1'
  if [[ $# -ne 3 || $1 != --version || $3 != "$sentinel" ]] ||
     [[ ! $embedded =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
     [[ $2 != "$embedded" ]]; then
    printf '%s\n' 'Installer requires its exact stable release version: --version X.Y.Z' >&2
    return 1
  fi
  local os arch node npm node_version home parent install_dir package launcher link base_target resume=0
  os=$(uname -s) || return 1
  arch=$(uname -m) || return 1
  case "$os:$arch" in
    Darwin:arm64)
      local mac_version mac_major
      mac_version=$(sw_vers -productVersion 2>/dev/null) || mac_version=''
      mac_major=${mac_version%%.*}
      if [[ ! $mac_major =~ ^[0-9]+$ ]] || (( 10#$mac_major < 14 )); then
        printf '%s\n' 'Unsupported macOS version; macOS 14 or later required.' >&2; return 1
      fi
      base_target=macos-arm64 ;;
    Linux:x86_64)
      local glibc glibc_major glibc_minor
      glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null) || glibc=''
      if [[ ! $glibc =~ ^glibc\ ([0-9]+)\.([0-9]+)$ ]]; then
        printf '%s\n' 'Unsupported Linux libc; glibc 2.35 or later required.' >&2; return 1
      fi
      glibc_major=${BASH_REMATCH[1]}; glibc_minor=${BASH_REMATCH[2]}
      if (( 10#$glibc_major < 2 || (10#$glibc_major == 2 && 10#$glibc_minor < 35) )); then
        printf '%s\n' 'Unsupported Linux libc; glibc 2.35 or later required.' >&2; return 1
      fi
      base_target=linux-x64 ;;
    *) printf '%s\n' 'Unsupported installer host' >&2; return 1 ;;
  esac
  if ! command -v python3 >/dev/null; then
    printf '%s\n' 'Python 3 is required' >&2; return 1
  fi
  home=${KOED_HOME:-${HOME:?HOME is required}/.koed}
  case "$home" in /*) ;; *) printf '%s\n' 'KOED_HOME must be absolute' >&2; return 1 ;; esac
  if [[ $home == *$'\n'* || $home == *"'"* || $HOME != /* || $HOME == *$'\n'* ]]; then
    koed_fail 'KOED_HOME and HOME must be absolute paths without quotes or newlines'; return 1
  fi
  parent=$(dirname "$home")
  if [[ ! -d $parent || -L $home ]]; then
    koed_fail 'Refusing unsafe KOED_HOME: its parent must exist and it must not be a symlink'; return 1
  fi
  home=$(python3 -I -c 'import os,sys; print(os.path.join(os.path.realpath(os.path.dirname(sys.argv[1])), os.path.basename(sys.argv[1])))' "$home") || return 1
  install_dir="$home/installer"
  package="$install_dir/package/node_modules/@koed-labs/server"
  launcher="$install_dir/bin/koed"
  link="$HOME/.local/bin/koed"
  if [[ -e $home ]]; then
    if [[ ! -d $home || -L $install_dir ]] || ! koed_owner check "$embedded"; then
      koed_fail "Refusing existing KOED_HOME that this installer version does not own: $home" \
        'Existing Koed data, Desktop installations and other versions are never modified; upgrades are manual.'
      return 1
    fi
    resume=1
  fi
  if [[ -e $link || -L $link ]] && [[ ! -L $link || $(readlink "$link") != "$launcher" ]]; then
    koed_fail "Refusing to replace an existing koed command this installation does not own: $link"; return 1
  fi
  node=''
  if (( resume )); then node=$(koed_owner node "$embedded") || node=''; fi
  if [[ -z $node ]]; then node=$(command -v node || true); fi
  if [[ -n $node ]]; then
    node=$(python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node") || return 1
    npm="$(dirname "$(dirname "$node")")/lib/node_modules/npm/bin/npm-cli.js"
    node_version=$(env -i PATH=/usr/bin:/bin "$node" --version 2>/dev/null) || node_version=''
    if [[ ! $node_version =~ ^v(24|25|26)\.[0-9]+\.[0-9]+$ || ! -f $npm ]] ||
       ! env -i HOME="$HOME" PATH=/usr/bin:/bin "$node" "$npm" --version >/dev/null 2>&1; then
      node=''
    fi
  fi
  if [[ -z $node && ! -e $install_dir/node ]] && ! command -v curl >/dev/null; then
    printf '%s\n' 'curl is required for private Node' >&2; return 1
  fi
  umask 077
  if (( ! resume )); then
    if ! mkdir "$home" || ! mkdir "$install_dir"; then
      printf '%s\n' 'Could not create private KOED_HOME' >&2; return 1
    fi
    koed_owner create "$embedded" created || return 1
  fi
  KOED_INSTALL_LOCK="${install_dir:?}/lock"
  if ! mkdir "$KOED_INSTALL_LOCK" 2>/dev/null; then
    koed_fail "Another installer holds $KOED_INSTALL_LOCK, or an earlier run was interrupted." \
      'If no installer is running, remove that lock directory and rerun this installer.'
    return 1
  fi
  trap 'rm -f "${KOED_INSTALL_LOCK:?}/pid"; rmdir "${KOED_INSTALL_LOCK:?}" 2>/dev/null' EXIT
  trap 'exit 130' INT TERM HUP
  printf '%s\n' "$$" > "$KOED_INSTALL_LOCK/pid" || return 1
  # tmp holds only this installer's own staging; leftovers are incomplete.
  rm -rf "${install_dir:?}/tmp" || return 1
  mkdir -p "$install_dir/tmp" "$install_dir/cache" "$install_dir/bin" || return 1
  if [[ -z $node ]]; then
    local target digest archive root
    case "$os:$arch" in
      Darwin:arm64) target=darwin-arm64; digest=6f5b3187d9df9fc007e881167905bc7d69ad26450ddc377c83d63256a2495b6e ;;
      Linux:x86_64) target=linux-x64; digest=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997 ;;
    esac
    root="node-v26.13.0-$target"
    archive="$install_dir/tmp/node.tar.xz"
    if [[ ! -e $install_dir/node ]]; then
      if ! curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 300 --max-filesize 104857600 -o "$archive" "https://nodejs.org/dist/v26.13.0/$root.tar.xz"; then
        printf '%s\n' 'Node download failed.' >&2; return 1
      fi
      if ! python3 -I -c 'import hashlib,os,sys; p=sys.argv[1]; assert os.path.isfile(p) and os.path.getsize(p)<=104857600; h=hashlib.sha256(); f=open(p,"rb"); [h.update(b) for b in iter(lambda:f.read(1048576),b"")]; sys.exit(h.hexdigest()!=sys.argv[2])' "$archive" "$digest"; then
        printf '%s\n' 'Node archive checksum or size invalid.' >&2; return 1
      fi
      mkdir "$install_dir/tmp/node" || return 1
      if ! python3 -I - "$archive" "$install_dir/tmp/node" "$root" <<'PYEXTRACT'
import lzma, os, shutil, stat, sys, tarfile
archive, dest, root = sys.argv[1:]
class Bounded:
    def __init__(self, source): self.source, self.count = source, 0
    def read(self, size):
        if size < 0 or size > 16777216 or size > 536870912 - self.count:
            raise ValueError('expanded archive exceeds limit')
        data = self.source.read(size)
        self.count += len(data)
        return data
try:
    seen = set()
    with lzma.open(archive, 'rb') as compressed, tarfile.open(fileobj=Bounded(compressed), mode='r|') as tar:
        for index, member in enumerate(tar):
            if index >= 100000: raise ValueError('too many entries')
            name = member.name.rstrip('/')
            parts = name.split('/')
            if not name or name.startswith('/') or any(p in ('', '.', '..') for p in parts) or parts[0] != root or name in seen:
                raise ValueError('unsafe archive path or duplicate')
            seen.add(name)
            if member.size > 268435456 or not (member.isdir() or member.isfile() or member.issym()):
                raise ValueError('unsafe archive type or size')
            path = os.path.join(dest, *parts)
            parent = dest
            for part in parts[:-1]:
                parent = os.path.join(parent, part)
                if os.path.lexists(parent):
                    if not stat.S_ISDIR(os.lstat(parent).st_mode): raise ValueError('unsafe archive parent')
                else: os.mkdir(parent, 0o700)
            if member.isdir():
                if os.path.lexists(path):
                    if not stat.S_ISDIR(os.lstat(path).st_mode): raise ValueError('conflicting directory')
                else: os.mkdir(path, 0o700)
            elif member.issym():
                link = member.linkname
                expected = {root + '/bin/npm': '../lib/node_modules/npm/bin/npm-cli.js', root + '/bin/npx': '../lib/node_modules/npm/bin/npx-cli.js'}
                if expected.get(name) != link:
                    raise ValueError('unsafe archive link')
                os.symlink(link, path)
            else:
                with tar.extractfile(member) as src, open(path, 'xb') as out:
                    shutil.copyfileobj(src, out, 1048576)
                os.chmod(path, 0o700 if member.mode & 0o111 else 0o600)
except (OSError, ValueError, tarfile.TarError, EOFError) as error:
    print('Unsafe Node archive: ' + str(error), file=sys.stderr)
    sys.exit(1)
PYEXTRACT
      then return 1; fi
      rm -f "$archive"
      mv "$install_dir/tmp/node" "$install_dir/node" || return 1
    fi
    node="$install_dir/node/$root/bin/node"
    npm="$install_dir/node/$root/lib/node_modules/npm/bin/npm-cli.js"
    if [[ ! -x $node || ! -f $npm ]] || [[ $(env -i PATH=/usr/bin:/bin "$node" --version 2>/dev/null) != v26.13.0 ]] ||
       ! env -i HOME="$install_dir" PATH="$(dirname "$node"):/usr/bin:/bin" "$node" "$npm" --version >/dev/null 2>&1; then
      koed_fail 'Private Node and npm validation failed.' "If $install_dir/node is damaged, remove it and rerun this installer."
      return 1
    fi
  fi
  if [[ ! -e $install_dir/package ]]; then
    : > "$install_dir/npm-user.conf" && : > "$install_dir/npm-global.conf" && mkdir "$install_dir/tmp/package" || return 1
    if ! (cd "$install_dir/tmp/package" && env -i HOME="$install_dir" TMPDIR="$install_dir/tmp" PATH="$(dirname "$node"):/usr/bin:/bin" \
      npm_config_userconfig="$install_dir/npm-user.conf" npm_config_globalconfig="$install_dir/npm-global.conf" npm_config_cache="$install_dir/cache" \
      npm_config_registry=https://registry.npmjs.org/ \
      "$node" "$npm" install --prefix "$install_dir/tmp/package" --ignore-scripts --engine-strict --no-audit --no-fund --package-lock=false "@koed-labs/server@$embedded"); then
      koed_fail 'Package installation failed; nothing was activated. Fix the cause and rerun this installer.'; return 1
    fi
    mv "$install_dir/tmp/package" "$install_dir/package" || return 1
  fi
  if ! python3 -I -c 'import json,os,sys; p=sys.argv[1]; assert os.path.realpath(p)==p and not os.path.islink(p+"/package.json") and not os.path.islink(p+"/bin/koed.js"); d=json.load(open(p+"/package.json")); assert d.get("name")=="@koed-labs/server" and d.get("version")==sys.argv[2] and os.path.isfile(p+"/bin/koed.js") and os.path.realpath(p+"/bin/koed.js").startswith(p+"/")' "$package" "$embedded" 2>/dev/null; then
    koed_fail 'Installed package validation failed.' "If $install_dir/package is damaged, remove it and rerun this installer."
    return 1
  fi
  koed_owner update "$embedded" package-staged "$node" || return 1
  if ! python3 -I -c 'import os,shlex,sys
home,node,entry,out=sys.argv[1:]
q=shlex.quote
text="""#!/bin/sh
# Koed Server launcher, owned by the Koed Server installer.
if [ -n "${KOED_HOME:-}" ] && [ "$KOED_HOME" != %s ]; then
  echo "This koed command manages" %s "- unset KOED_HOME to use it." >&2
  exit 1
fi
KOED_HOME=%s
export KOED_HOME
exec %s %s "$@"
""" % (q(home), q(home), q(home), q(node), q(entry))
f=open(out+".next","w"); f.write(text); f.close()
os.chmod(out+".next",0o700); os.replace(out+".next",out)' "$home" "$node" "$package/bin/koed.js" "$launcher"; then
    koed_fail 'Could not write the koed launcher.'; return 1
  fi
  if [[ ! -L $link ]]; then
    if ! mkdir -p "$HOME/.local/bin" || ! ln -s "$launcher" "$link"; then
      koed_fail "Could not publish the koed command at $link"; return 1
    fi
  fi
  local supervisor current asset deadline
  supervisor=$(koed_supervisor_pid) && kill -0 "$supervisor" 2>/dev/null || supervisor=''
  if [[ -z $supervisor ]]; then
    if ! koed_json "d.get('components',{}).get('base')=='active' and d.get('activeVersion')=='$embedded'" components status --json 2>/dev/null; then
      printf '%s\n' 'Installing Koed Base component...' >&2
      asset="https://github.com/koed-labs/koed/releases/download/v$embedded/koed-base-$embedded-$base_target.tar.gz"
      koed_json "d.get('state')=='active'" components install --component base --version "$embedded" \
        --archive-url "$asset" --manifest-url "$asset.manifest.json" --json || { koed_phase_fail 'Base component install'; return 1; }
    fi
    printf '%s\n' 'Installing native runtime...' >&2
    koed_json "d.get('ok') is True" runtime install --provider release --dependency-mode bundled-local --json ||
      { koed_phase_fail 'native runtime install'; return 1; }
    printf '%s\n' 'Installing embedding model...' >&2
    koed_json "d.get('ok') is True and d.get('state')=='installed'" models install --kind embedding --json ||
      { koed_phase_fail 'embedding model install'; return 1; }
    koed_owner update "$embedded" provisioned "$node" || return 1
    printf '%s\n' 'Starting Koed Server...' >&2
    koed_json "d.get('ok') is True and d.get('state')=='starting' and type(d.get('startedPid')) is int and d['startedPid']>1" \
      start --daemon --json || { koed_phase_fail 'server start'; return 1; }
    supervisor=$(cat "$install_dir/tmp/started-pid" 2>/dev/null) || supervisor=''
    [[ $supervisor =~ ^[0-9]+$ ]] || { koed_phase_fail 'server start'; return 1; }
  fi
  # A started daemon is not readiness: require the same live supervisor to hold
  # this home's lock and report healthy startup status.
  deadline=$((SECONDS + 600))
  while :; do
    if ! kill -0 "$supervisor" 2>/dev/null; then
      koed_fail "Koed Server supervisor exited; see $home/logs/supervisor.log"; koed_phase_fail 'server readiness'; return 1
    fi
    current=$(koed_supervisor_pid) || current=''
    if [[ -n $current && $current != "$supervisor" ]]; then
      koed_fail 'A different supervisor holds this KOED_HOME.'; koed_phase_fail 'server readiness'; return 1
    fi
    if [[ -n $current ]] && koed_json "d.get('ok') is True" status --startup --json 2>/dev/null; then break; fi
    if (( SECONDS >= deadline )); then
      koed_fail "Koed Server did not become ready in time; see $home/logs/supervisor.log"; koed_phase_fail 'server readiness'; return 1
    fi
    sleep "${KOED_INSTALL_POLL_SECONDS:-2}"
  done
  koed_json "d.get('ok') is True and d.get('state')=='healthy'" setup core --json || { koed_phase_fail 'core setup'; return 1; }
  koed_json "d.get('ok') is True" doctor --json || { koed_phase_fail 'final verification'; return 1; }
  koed_owner update "$embedded" installed "$node" || return 1
  printf '%s\n' "Koed Server $embedded is installed and running." "Command: $link" "Data: $home"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) printf '%s\n' "$HOME/.local/bin is not on your PATH; add it or run the command by its full path." ;;
  esac
  printf '%s\n' 'No AI Client was configured. Connect one separately; see the Koed documentation.'
}
koed_install "$@" 'koed-installer-complete-v1'