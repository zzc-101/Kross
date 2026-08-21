#!/bin/sh
# Make the host mount covering JuiceFS rshared when it is not already shared.
# Native Linux/systemd is typically already shared; Docker Desktop VMs often are not.
# Must run before the JuiceFS container is created (rshared bind happens at create).
set -eu

# stdin stays on this script's fd; nsenter only switches the mount namespace.
nsenter -t 1 -m -- /bin/sh <<'EOF'
set -eu
mkdir -p /var/lib/kross/jfs /var/cache/kross-jfs
target=/var/lib/kross/jfs
if awk -v t="$target" '
  BEGIN { n = -1 }
  {
    m = $5
    if (t != m && index(t, m) != 1) next
    if (m != "/" && t != m && substr(t, length(m) + 1, 1) != "/") next
    if (length(m) < n) next
    n = length(m)
    s = 0
    for (i = 7; i <= NF; i++) {
      if ($i == "-") break
      if (index($i, "shared:") == 1) s = 1
    }
  }
  END { exit(s ? 0 : 1) }
' /proc/self/mountinfo; then
  exit 0
fi
mount --make-rshared / || true
EOF
