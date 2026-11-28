#!/bin/sh
set -eu

if ! owner=$(stat -c '%u:%g' /data); then
  echo 'Could not determine the owner of the project mount at /data.' >&2
  exit 1
fi

uid=${owner%:*}
gid=${owner#*:}
if [ "$uid" = 0 ]; then
  # Docker Desktop's fakeowner mount presents files as owned by the
  # accessing identity and maps writes to the desktop user on the host.
  if [ "$(findmnt -n -o FSTYPE --mountpoint /data)" != fakeowner ]; then
    echo 'The project mount at /data must be owned by a nonroot user.' >&2
    exit 1
  fi
  uid=65534
  gid=65534
fi

exec setpriv --reuid "$uid" --regid "$gid" --clear-groups --no-new-privs --reset-env \
  sh -c '
    if ! ([ -d /data ] && [ -r /data ] && [ -w /data ] && [ -x /data ]); then
      echo "The project owner needs read, write, and search access to /data." >&2
      exit 1
    fi
    exec "$@"
  ' editor "$@"
