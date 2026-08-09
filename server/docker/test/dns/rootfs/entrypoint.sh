#!/bin/sh

# The user.com and virtu.email zones accept dynamic updates (nsupdate).
# Zone templates are re-copied fresh on every boot, so a journal left over
# from a previous run would be out of sync with the zone file and make
# named refuse to load the zone. Delete stale journals first.
for zone in user.com virtu.email; do
  if [ -f "/var/lib/bind/db.$zone.jnl" ]; then
    echo "Deleting old journal for $zone..."
    rm "/var/lib/bind/db.$zone.jnl"
  fi
done

if [ -f /templates/named.conf ]; then
  echo "Copying named.conf..."
  cp /templates/named.conf /etc/bind/named.conf
fi

if [ -d /templates/zones ]; then
  echo "Copying zones..."
  cp /templates/zones/* /var/lib/bind/
  chown named:named /var/lib/bind/*
fi

exec named -g -u named
