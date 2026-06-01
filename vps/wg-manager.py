#!/usr/bin/env python3
"""
JTM wg-manager: small HTTP service that lets the Render-hosted API
add/remove/list WireGuard peers on the local wg0 interface.

Listens on 127.0.0.1:8080 (Caddy reverse-proxies https://vpn/<domain>/wg/* here).
Auth: shared bearer token via WG_MANAGER_TOKEN env var.

Endpoints:
  GET    /peers              -> {peers: [{publicKey, allowedIps, latestHandshake, transferRx, transferTx}]}
  POST   /peers              -> body {publicKey, tunnelIp} -> 201 {ok:true}
  DELETE /peers/<publicKey>  -> 200 {ok:true}
"""
import json
import os
import re
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import unquote

TOKEN = os.environ.get('WG_MANAGER_TOKEN', '')
PORT = int(os.environ.get('WG_MANAGER_PORT', '8080'))
IFACE = os.environ.get('WG_MANAGER_IFACE', 'wg0')
CONF_PATH = f'/etc/wireguard/{IFACE}.conf'
SSH_KEY_PATH = os.environ.get('WG_MANAGER_SSH_KEY', '/opt/wg-manager/router-ssh-key')
SSH_PUBKEY_PATH = SSH_KEY_PATH + '.pub'
DEFAULT_ROUTER_SSH_PORT = int(os.environ.get('ROUTER_SSH_PORT', '22'))

if not TOKEN or len(TOKEN) < 24:
    print('FATAL: WG_MANAGER_TOKEN env var required (>= 24 chars)', file=sys.stderr)
    sys.exit(1)

_lock = threading.Lock()


def _run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def wg_show_peers():
    out = _run(['wg', 'show', IFACE, 'dump']).stdout
    lines = out.strip().split('\n')
    peers = []
    # First line is the interface itself, subsequent are peers.
    for line in lines[1:]:
        parts = line.split('\t')
        if len(parts) < 8:
            continue
        peers.append({
            'publicKey': parts[0],
            'endpoint': parts[2] if parts[2] != '(none)' else None,
            'allowedIps': parts[3],
            'latestHandshake': int(parts[4]) if parts[4] != '0' else None,
            'transferRx': int(parts[5]),
            'transferTx': int(parts[6]),
        })
    return peers


def add_peer(public_key, tunnel_ip):
    # Live-add via wg set (takes effect immediately, no interface reload).
    _run(['wg', 'set', IFACE, 'peer', public_key, 'allowed-ips', f'{tunnel_ip}/32'])
    # Persist to wg0.conf so it survives reboot. Idempotent: skip if already there.
    with open(CONF_PATH, 'r') as f:
        conf = f.read()
    if public_key not in conf:
        with open(CONF_PATH, 'a') as f:
            f.write(f'\n[Peer]\nPublicKey = {public_key}\nAllowedIPs = {tunnel_ip}/32\n')


def read_ssh_pubkey():
    """Return wg-manager's SSH public key (one line) so MikroTiks can fetch it
    during provisioning and authorize it for admin SSH access."""
    try:
        with open(SSH_PUBKEY_PATH, 'r') as f:
            return f.read().strip()
    except FileNotFoundError:
        return ''


def exec_on_router(tunnel_ip, command, ssh_port=DEFAULT_ROUTER_SSH_PORT, user='admin', timeout=10):
    """SSH into the MikroTik (at tunnel_ip, via wg0) and run `command`.
    Returns {stdout, stderr, returncode}. Auth via key, no password."""
    try:
        result = subprocess.run(
            [
                'ssh',
                '-p', str(ssh_port),
                '-i', SSH_KEY_PATH,
                '-o', 'StrictHostKeyChecking=no',
                '-o', 'UserKnownHostsFile=/dev/null',
                '-o', 'BatchMode=yes',
                '-o', f'ConnectTimeout={timeout}',
                '-o', 'LogLevel=ERROR',
                f'{user}@{tunnel_ip}',
                command,
            ],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        return {
            'stdout': result.stdout,
            'stderr': result.stderr,
            'returncode': result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {'stdout': '', 'stderr': 'ssh timeout', 'returncode': -1}


def remove_peer(public_key):
    _run(['wg', 'set', IFACE, 'peer', public_key, 'remove'])
    with open(CONF_PATH, 'r') as f:
        conf = f.read()
    pattern = (
        r'\n*\[Peer\][^\[]*?PublicKey\s*=\s*' + re.escape(public_key) + r'[^\[]*'
    )
    new_conf = re.sub(pattern, '\n', conf)
    if new_conf != conf:
        with open(CONF_PATH, 'w') as f:
            f.write(new_conf)


class Handler(BaseHTTPRequestHandler):
    def _auth(self):
        return self.headers.get('Authorization', '') == f'Bearer {TOKEN}'

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # /ssh-pubkey is intentionally unauthenticated — public keys are public,
        # and MikroTiks during provisioning need to fetch it without a token.
        if self.path == '/ssh-pubkey':
            pub = read_ssh_pubkey()
            if not pub:
                return self._send_json(500, {'error': 'ssh key not generated'})
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain; charset=utf-8')
            self.send_header('Content-Length', str(len(pub) + 1))
            self.end_headers()
            self.wfile.write((pub + '\n').encode())
            return
        if not self._auth():
            return self._send_json(401, {'error': 'unauthorized'})
        if self.path == '/peers':
            try:
                with _lock:
                    return self._send_json(200, {'peers': wg_show_peers()})
            except subprocess.CalledProcessError as e:
                return self._send_json(500, {'error': e.stderr.strip()})
        return self._send_json(404, {'error': 'not_found'})

    def do_POST(self):
        if not self._auth():
            return self._send_json(401, {'error': 'unauthorized'})
        # POST /coa/disconnect  body: {"nasIp": "10.66.0.25", "sessionId": "...", "secret": "...", "username": "..."}
        # Sends a RADIUS Disconnect-Request to the MikroTik to kick a live session.
        if self.path == '/coa/disconnect':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                body = json.loads(self.rfile.read(length)) if length else {}
                nas_ip = body.get('nasIp')
                session_id = body.get('sessionId')
                secret = body.get('secret')
                username = body.get('username', '')
                if not nas_ip or not session_id or not secret:
                    return self._send_json(400, {'error': 'nasIp, sessionId, secret required'})
                attrs = (
                    f'User-Name={username}\n'
                    f'Acct-Session-Id={session_id}\n'
                )
                result = subprocess.run(
                    ['radclient', '-x', f'{nas_ip}:3799', 'disconnect', secret],
                    input=attrs, capture_output=True, text=True, timeout=5,
                )
                ok = 'Disconnect-ACK' in result.stdout
                return self._send_json(200 if ok else 502, {
                    'ok': ok,
                    'stdout': result.stdout,
                    'stderr': result.stderr,
                })
            except (json.JSONDecodeError, ValueError, subprocess.TimeoutExpired) as e:
                return self._send_json(400, {'error': str(e)})
        # POST /routers/<tunnel-ip>/exec  body: {"command": "...", "sshPort": 22}
        m = re.match(r'^/routers/([\d.]+)/exec$', self.path)
        if m:
            tunnel_ip = m.group(1)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                body = json.loads(self.rfile.read(length)) if length else {}
                command = body.get('command')
                if not command or not isinstance(command, str):
                    return self._send_json(400, {'error': 'missing command'})
                ssh_port = int(body.get('sshPort', DEFAULT_ROUTER_SSH_PORT))
                user = body.get('user', 'admin')
                result = exec_on_router(tunnel_ip, command, ssh_port=ssh_port, user=user)
                code = 200 if result['returncode'] == 0 else 502
                return self._send_json(code, result)
            except (json.JSONDecodeError, ValueError) as e:
                return self._send_json(400, {'error': str(e)})
        if self.path == '/peers':
            try:
                length = int(self.headers.get('Content-Length', '0'))
                body = json.loads(self.rfile.read(length))
                pk = body['publicKey']
                ip = body['tunnelIp']
                if not re.match(r'^[A-Za-z0-9+/=]{40,50}$', pk):
                    return self._send_json(400, {'error': 'invalid publicKey'})
                if not re.match(r'^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$', ip):
                    return self._send_json(400, {'error': 'invalid tunnelIp'})
                with _lock:
                    add_peer(pk, ip)
                return self._send_json(201, {'ok': True})
            except subprocess.CalledProcessError as e:
                return self._send_json(500, {'error': e.stderr.strip()})
            except (KeyError, json.JSONDecodeError, ValueError) as e:
                return self._send_json(400, {'error': str(e)})
        return self._send_json(404, {'error': 'not_found'})

    def do_DELETE(self):
        if not self._auth():
            return self._send_json(401, {'error': 'unauthorized'})
        m = re.match(r'^/peers/(.+)$', self.path)
        if not m:
            return self._send_json(404, {'error': 'not_found'})
        pk = unquote(m.group(1))
        try:
            with _lock:
                remove_peer(pk)
            return self._send_json(200, {'ok': True})
        except subprocess.CalledProcessError as e:
            return self._send_json(500, {'error': e.stderr.strip()})

    def log_message(self, fmt, *args):
        if os.environ.get('DEBUG'):
            super().log_message(fmt, *args)


if __name__ == '__main__':
    print(f'wg-manager listening on 127.0.0.1:{PORT} (iface={IFACE})')
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
