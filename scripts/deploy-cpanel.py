#!/usr/bin/env python3
"""Upload only the CI release payload; preserve remote environment and user data."""
import ftplib
import io
import os
from pathlib import Path, PurePosixPath
import ssl
import sys
import time


def log(message):
    print(message, flush=True)


def tls_context():
    """Verify by default; allow a supplied hosting CA or an explicit override."""
    verify = (os.environ.get('FTP_TLS_VERIFY', '') or 'true').lower()
    if verify not in ('true', 'false'):
        raise ValueError('FTP_TLS_VERIFY must be true or false.')
    context = ssl.create_default_context()
    certificate = os.environ.get('FTP_CA_CERT', '').strip()
    if certificate:
        context.load_verify_locations(cadata=certificate)
    if verify == 'false':
        print('WARNING: FTP_TLS_VERIFY=false disables server identity verification. '
              'The connection is encrypted but the FTP server is not authenticated.', file=sys.stderr)
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


def report_error(error):
    if isinstance(error, ssl.SSLCertVerificationError):
        # Verification details contain certificate/hostname information, not credentials.
        print(f'FTPS certificate verification failed (code {error.verify_code}): '
              f'{error.verify_message}', file=sys.stderr)
        print('Use the FTP hostname covered by the hosting certificate. For a private CA, '
              'set the FTP_CA_CERT secret to the trusted PEM certificate. Renew expired '
              'certificates or have the host repair an incomplete certificate chain. '
              'See docs/CPANEL_DEPLOYMENT.md for the explicit verification override.', file=sys.stderr)
    elif isinstance(error, TimeoutError):
        print('FTP operation timed out after 90 seconds without socket activity. '
              'If the last stage was uploading, check the hosting firewall/passive FTP '
              'data ports and FTPS data-channel support. If connecting or authenticating, '
              'check host reachability and hosting IP restrictions.', file=sys.stderr)
    elif isinstance(error, ftplib.error_perm):
        code = str(error)[:3]
        code = code if code.isdigit() else 'unknown'
        print(f'FTP server rejected the operation (reply {code}). '
              '530: login/access; 550: directory or file permissions; '
              '522: FTPS data-channel/TLS session requirements. '
              'Check the last logged stage.', file=sys.stderr)
    elif isinstance(error, ValueError):
        print(f'Deployment configuration error: {error}', file=sys.stderr)
    else:
        # Do not print arbitrary FTP responses, which can contain private paths.
        print(f'Deployment failed ({type(error).__name__}). '
              'Check FTP connectivity, credentials, target directory and permissions.', file=sys.stderr)


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
    files = sorted(path for path in payload.rglob('*') if path.is_file())
    total_bytes = sum(path.stat().st_size for path in files)
    log(f'Release payload: {len(files)} files, {total_bytes / 1048576:.1f} MiB. '
        'Socket inactivity timeout: 90 seconds.')
    started = time.monotonic()
    client = ftplib.FTP_TLS(context=tls_context()) if protocol == 'ftps' else ftplib.FTP()
    stage = 'connecting to FTP server'
    try:
        log('Connecting to FTP server...')
        client.connect(host, int(os.environ.get('FTP_PORT', '21') or '21'), timeout=90)
        log('Connected. Authenticating and negotiating TLS (for FTPS)...')
        stage = 'authentication/TLS negotiation'
        client.login(os.environ['FTP_USERNAME_VGATE'], os.environ['FTP_PASSWORD_VGATE'])
        log('Authenticated.')
        if protocol == 'ftps':
            stage = 'enabling encrypted FTP data transfers'
            client.prot_p()
            log('Encrypted data transfers enabled.')
        client.set_pasv(True)
        stage = 'opening configured application directory'
        log('Opening configured application directory...')
        # Require the target to exist; a mistyped root must not silently create a new app.
        client.cwd(root)
        remote_root = client.pwd()
        log('Application directory opened. Starting passive-mode uploads...')
        uploaded = 0
        transferred = 0
        for directory, subdirs, filenames in os.walk(payload):
            subdirs.sort()
            relative = Path(directory).relative_to(payload)
            stage = 'preparing release subdirectory ' + relative.as_posix()
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
                path = Path(directory) / filename
                name = path.relative_to(payload).as_posix()
                size = path.stat().st_size
                stage = 'uploading ' + name
                log(f'Uploading [{uploaded + 1}/{len(files)}] {name} ({size / 1048576:.2f} MiB)...')
                last_progress = time.monotonic()

                def progress(block):
                    nonlocal transferred, last_progress
                    transferred += len(block)
                    now = time.monotonic()
                    if now - last_progress >= 10:
                        log(f'Transferring: {transferred / 1048576:.1f}/{total_bytes / 1048576:.1f} MiB; '
                            f'{uploaded}/{len(files)} files complete.')
                        last_progress = now

                with path.open('rb') as source:
                    client.storbinary('STOR ' + filename, source, blocksize=65536, callback=progress)
                uploaded += 1
        # Restart only after the complete upload, and only when host prerequisites are ready.
        if os.environ.get('CPANEL_AUTO_RESTART', '').lower() == 'true':
            stage = 'requesting Passenger restart'
            log('All release files uploaded. Requesting Passenger restart...')
            client.cwd(remote_root)
            try:
                client.cwd('tmp')
            except ftplib.error_perm as error:
                if not str(error).startswith('550'):
                    raise
                client.mkd('tmp')
                client.cwd('tmp')
            client.storbinary('STOR restart.txt', io.BytesIO(os.environ.get('GITHUB_SHA', 'deployment').encode()))
        log(f'Release upload complete: {uploaded} files in {time.monotonic() - started:.0f}s. '
            'Remote .env, node_modules, uploads and other unlisted files were preserved.')
    except Exception:
        log('Failed during: ' + stage)
        raise
    finally:
        client.close()


if __name__ == '__main__':
    try:
        deploy()
    except Exception as error:
        report_error(error)
        sys.exit(1)
