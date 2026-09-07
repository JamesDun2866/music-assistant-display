#!/bin/bash

check_source_runtime() {
  local python=${1:-/usr/bin/python3}
  [[ -x "$python" ]] ||
    { echo "Missing system Python: $python" >&2; return 1; }
  "$python" -I -c 'import sys; sys.exit(not ((3, 12) <= sys.version_info[:2] < (3, 15)))' ||
    { echo "Python 3.12-3.14 is required (Trixie supplies 3.13)." >&2; return 1; }
}
