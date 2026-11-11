#!/usr/bin/env bash
# Install the system packages the Linux Desktop smoke needs without depending
# on the package mirrors when it can be avoided:
#   1. packages already on the runner image are left alone;
#   2. missing packages are installed from the cached archive directory;
#   3. only what is still missing is fetched with apt, and those archives are
#      kept in the same directory for the workflow to cache.
set -euo pipefail

archives="${1:?usage: install-linux-smoke-deps.sh <archive-dir> <package>...}"
shift
packages=("$@")

missing_packages() {
  local package
  for package in "${packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "${package}" 2>/dev/null |
      grep -q '^install ok installed$'; then
      echo "${package}"
    fi
  done
}

set_output() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "$1" >>"${GITHUB_OUTPUT}"
  fi
}

mapfile -t missing < <(missing_packages)
if [ "${#missing[@]}" -eq 0 ]; then
  echo "Linux Desktop smoke packages are already installed."
  set_output "downloaded=false"
  exit 0
fi
echo "Missing packages: ${missing[*]}"

if compgen -G "${archives}/*.deb" >/dev/null; then
  echo "Installing cached archives from ${archives}."
  # Never replace a same or newer version already on the runner image.
  if ! sudo dpkg -i --skip-same-version --refuse-downgrade "${archives}"/*.deb; then
    echo "Cached archives did not install cleanly; falling back to apt."
  fi
  mapfile -t missing < <(missing_packages)
fi

if [ "${#missing[@]}" -eq 0 ]; then
  echo "Linux Desktop smoke packages installed without the package mirrors."
  set_output "downloaded=false"
  exit 0
fi

# Fetch and install what is still missing. Extra arguments select the package
# sources. Each apt call is time-boxed so unreachable mirrors fail quickly.
apt_fetch() {
  sudo timeout 120 apt-get "$@" update &&
    sudo timeout 300 apt-get "$@" install -y --no-install-recommends \
      -o Dir::Cache::Archives="${archives}" \
      "${missing[@]}"
}

echo "Fetching with apt: ${missing[*]}"
sudo mkdir -p "${archives}/partial"
if ! apt_fetch; then
  # The runner's configured mirrors are unreachable. Retry against an
  # independent mirror; apt still verifies it with the Ubuntu archive keyring.
  mirror="${KOED_APT_FALLBACK_MIRROR:-https://mirrors.edge.kernel.org/ubuntu}"
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME}")"
  keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
  sources="$(mktemp)"
  for pocket in "${codename}" "${codename}-updates" "${codename}-security"; do
    echo "deb [signed-by=${keyring}] ${mirror} ${pocket} main universe"
  done >"${sources}"
  chmod 644 "${sources}"
  echo "Configured mirrors failed; retrying with ${mirror}."
  apt_fetch \
    -o Dir::Etc::sourcelist="${sources}" \
    -o Dir::Etc::sourceparts=- \
    -o APT::Get::List-Cleanup=0
  rm -f "${sources}"
fi
sudo rm -rf "${archives}/partial" "${archives}/lock"
sudo chown -R "$(id -u):$(id -g)" "${archives}"

mapfile -t missing < <(missing_packages)
if [ "${#missing[@]}" -ne 0 ]; then
  echo "Packages still missing after apt: ${missing[*]}" >&2
  exit 1
fi
set_output "downloaded=true"
