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

echo "Fetching with apt: ${missing[*]}"
sudo mkdir -p "${archives}/partial"
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  -o Dir::Cache::Archives="${archives}" \
  "${missing[@]}"
sudo rm -rf "${archives}/partial" "${archives}/lock"
sudo chown -R "$(id -u):$(id -g)" "${archives}"

mapfile -t missing < <(missing_packages)
if [ "${#missing[@]}" -ne 0 ]; then
  echo "Packages still missing after apt: ${missing[*]}" >&2
  exit 1
fi
set_output "downloaded=true"
