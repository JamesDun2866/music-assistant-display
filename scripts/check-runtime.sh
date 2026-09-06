#!/bin/bash
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

check_system_runtime() {
  local node=$1 npm=$2
  if [[ ! -x "$node" ]] || ! "$node" -e '
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || major >= 27 || (major === 22 && minor < 12)) {
      console.error(`Found Node.js ${process.versions.node}`);
      process.exit(1);
    }
  '; then
    echo "Missing or unsupported system Node.js at $node. Required: >=22.12.0 and <27." >&2
    echo "An nvm/user-shell runtime is not used by the service. See docs/installation-guide.md, section 3." >&2
    return 1
  fi
  # npm's env-node shebang must not select a different runtime from PATH.
  if [[ ! -r "$npm" ]] || ! "$node" "$npm" --version >/dev/null; then
    echo "System npm at $npm is missing or cannot run with $node." >&2
    echo "Provision Node.js with its matching npm first (NodeSource bundles npm in nodejs; do not add Debian npm)." >&2
    return 1
  fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  check_system_runtime /usr/bin/node /usr/bin/npm
  echo "System Node.js and npm are ready."
fi
