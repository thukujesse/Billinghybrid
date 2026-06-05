#!/usr/bin/env python3
"""
One-shot fix for FreeRADIUS SQL override loading on jtm-vps.

Replaces the multi-line `authorize_check_query` and `authorize_reply_query`
blocks in /etc/freeradius/3.0/mods-available/sql with single-line versions.

Why: FreeRADIUS on this VPS silently fails to parse the multi-line `"\` line
continuation in our override block, so it falls back to the default queries.conf
which only consults the `radcheck` table — meaning our `active_devices`
join never runs and every hotspot MAC gets rejected.

Usage:
    sudo python3 /tmp/fix_sql_override.py
    sudo systemctl restart freeradius
"""
import re
import os
import shutil
import time

PATH = '/etc/freeradius/3.0/mods-available/sql'

CHECK_Q = (
    "SELECT id, username, attribute, value, op FROM ("
    "SELECT 0::bigint AS id, mac AS username, 'Cleartext-Password' AS attribute, "
    "mac AS value, ':=' AS op "
    "FROM active_devices "
    "WHERE mac = lower('%{SQL-User-Name}') AND expires_at > now() "
    "UNION ALL "
    "SELECT id::bigint, username, attribute, value, op FROM ${authcheck_table} "
    "WHERE username = '%{SQL-User-Name}'"
    ") t ORDER BY id"
)

REPLY_Q = (
    "SELECT id, username, attribute, value, op FROM ("
    "SELECT 0::bigint AS id, mac AS username, 'Session-Timeout' AS attribute, "
    "GREATEST(60, EXTRACT(EPOCH FROM (expires_at - now()))::int)::text AS value, ':=' AS op "
    "FROM active_devices WHERE mac = lower('%{SQL-User-Name}') AND expires_at > now() "
    "UNION ALL "
    "SELECT 1::bigint AS id, mac AS username, 'Idle-Timeout' AS attribute, "
    "idle_timeout_seconds::text AS value, ':=' AS op "
    "FROM active_devices WHERE mac = lower('%{SQL-User-Name}') AND expires_at > now() "
    "UNION ALL "
    "SELECT 2::bigint AS id, mac AS username, 'Mikrotik-Rate-Limit' AS attribute, "
    "rate_limit AS value, '=' AS op "
    "FROM active_devices WHERE mac = lower('%{SQL-User-Name}') AND expires_at > now() "
    "AND rate_limit IS NOT NULL "
    "UNION ALL "
    "SELECT id::bigint + 10, username, attribute, value, op FROM ${authreply_table} "
    "WHERE username = '%{SQL-User-Name}'"
    ") t ORDER BY id"
)


def main() -> int:
    if not os.path.exists(PATH):
        print(f"ERROR: {PATH} does not exist")
        return 1

    backup = f"{PATH}.bak.{int(time.time())}"
    shutil.copy2(PATH, backup)
    print(f"Backup written to {backup}")

    with open(PATH) as f:
        content = f.read()

    new_block = (
        '    authorize_check_query = "' + CHECK_Q + '"\n\n'
        '    authorize_reply_query = "' + REPLY_Q + '"'
    )

    new_content, n = re.subn(
        r'authorize_check_query\s*=\s*".*?"\s*\n\s*\n\s*authorize_reply_query\s*=\s*".*?"',
        new_block,
        content,
        flags=re.DOTALL,
        count=1,
    )

    if n == 0:
        print(
            "ERROR: could not find the multi-line override block to replace. "
            "Either it was already replaced, or the file structure changed. "
            "Inspect the file manually."
        )
        return 1

    with open(PATH, 'w') as f:
        f.write(new_content)
    print(f"Replaced override with single-line versions in {PATH}.")
    print("Now run: sudo systemctl restart freeradius && sudo systemctl is-active freeradius")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
