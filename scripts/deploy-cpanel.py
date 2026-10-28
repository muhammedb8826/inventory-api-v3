#!/usr/bin/env python3
"""Upload only the CI release payload; preserve remote environment and user data."""
import ftplib
import io
import os
from pathlib import Path, PurePosixPath
import ssl
import sys


def deploy():
    required = ('FTP_SERVER_VGATE', 'FTP_USERNAME_VGATE', 'FTP_PASSWORD_VGATE', 'CPANEL_DIR_VGATE')
    if any(not os.environ.get(key) for key in required):
        raise ValueError('Configure all four VGATE deployment secrets in this repository.')
    host = os.environ['FTP_SERVER_VGATE']
    root = os.environ['CPANEL_DIR_VGATE'].rstrip('/')
    if not root or root == '.' or '..' in PurePosixPath(root).parts or any(c in root + host for c in '\r\n'):
        raise ValueError('CPANEL_DIR_VGATE must identify a dedicated application directory.')
    if '://' in host or '/' in host:
        raise ValueError('FTP_SERVER_VGATE must be a hostname, without a protocol or path.')
    protocol = os.environ.get('FTP_PROTOCOL', 'ftps') or 'ftps'
    if protocol not in ('ftp', 'ftps'):
        raise ValueError('FTP_PROTOCOL must be ftp or ftps.')
    payload = Path('release-payload')
    if not (payload / 'package.json').is_file():
        raise ValueError('Missing release payload.')
    client = ftplib.FTP_TLS(context=ssl.create_default_context()) if protocol == 'ftps' else ftplib.FTP()
    client.connect(host, int(os.environ.get('FTP_PORT', '21') or '21'), timeout=90)
    try:
        client.login(os.environ['FTP_USERNAME_VGATE'], os.environ['FTP_PASSWORD_VGATE'])
        if protocol == 'ftps':
            client.prot_p()
        # Require the target to exist; a mistyped root must not silently create a new app.
        client.cwd(root)
        remote_root = client.pwd()
        for directory, subdirs, filenames in os.walk(payload):
            subdirs.sort()
            relative = Path(directory).relative_to(payload)
            client.cwd(remote_root)
            for part in relative.parts:
                try:
                    client.cwd(part)
                except ftplib.error_perm as error:
                    if not str(error).startswith('550'):
                        raise
                    client.mkd(part)
                    client.cwd(part)
            for filename in sorted(filenames):
                with (Path(directory) / filename).open('rb') as source:
                    client.storbinary('STOR ' + filename, source)
        # Restart only after the complete upload, and only when host prerequisites are ready.
        if os.environ.get('CPANEL_AUTO_RESTART', '').lower() == 'true':
            client.cwd(remote_root)
            try:
                client.cwd('tmp')
            except ftplib.error_perm as error:
                if not str(error).startswith('550'):
                    raise
                client.mkd('tmp')
                client.cwd('tmp')
            client.storbinary('STOR restart.txt', io.BytesIO(os.environ.get('GITHUB_SHA', 'deployment').encode()))
        print('Release files uploaded. Remote .env, node_modules, uploads and other unlisted files were preserved.')
    finally:
        client.close()


if __name__ == '__main__':
    try:
        deploy()
    except Exception as error:
        # Avoid server responses that might contain credentials or private paths.
        print(f'Deployment failed ({type(error).__name__}). Check secrets, TLS, path and FTP permissions.', file=sys.stderr)
        sys.exit(1)
