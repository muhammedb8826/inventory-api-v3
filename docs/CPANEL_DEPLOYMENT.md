# cPanel deployment

The `deploy` job in `.github/workflows/ci.yml` uploads the exact build that passed quality checks on pushes to `main` or `master`. Pull requests never deploy. To redeploy, run CI (API) or Quality (web) manually on the production branch. The SSH release workflow remains an optional alternative.

## GitHub settings in each repository

Repository secrets:

- `FTP_SERVER_VGATE`: hostname only, without a protocol or path.
- `FTP_USERNAME_VGATE` and `FTP_PASSWORD_VGATE`: cPanel FTP credentials.
- `CPANEL_DIR_VGATE`: existing dedicated application directory relative to that FTP account's home, for example `api.vgatefurnishing.com/`. Use the API folder in the API repository and the web folder in the web repository. Never point both at the same directory.

Repository variables:

- `FTP_PROTOCOL`: defaults to `ftps` (explicit TLS on port 21 with certificate verification). Set `ftp` only if your hosting account requires unencrypted FTP. SFTP is a different protocol and is not used here.
- `FTP_PORT`: defaults to `21`.
- `API_URL` (web): full public backend base URL, including `/api/v1`, used for build-time values. Set the runtime API_URL in cPanel as well.
- `CPANEL_AUTO_RESTART`: defaults to disabled. Set `true` only when dependencies and database migrations are already ready on the host; the upload then writes Passenger's `tmp/restart.txt` last.

The workflow uses repository secrets, not the separate SSH production environment. If you stored these secrets only under a GitHub environment, move/add them at repository level or explicitly configure that environment on the deploy job.

## cPanel setup and completion

Use Node 22 or later. Point Setup Node.js App at the existing FTP application directory. API startup file: `dist/main.js`. Web startup file: `server.js`. Keep production environment settings on the host: `.env` or cPanel environment variables. Never commit secrets. For the API use `DB_SYNCHRONIZE=false` and `DB_SEED=false`.

FTP transfers files only. It cannot execute commands, install dependencies, back up the database, apply migrations, or verify application readiness. After the first deployment, and whenever dependencies change, use cPanel's Run NPM Install. If API schema changes are included, back up the database and run from the application directory in cPanel Terminal with the application's Node environment activated:

```sh
NODE_ENV=production npm run backup
NODE_ENV=production DB_SYNCHRONIZE=false npm run migration:run:prod
```

Then restart the application in cPanel and verify the API readiness endpoint (`/api/v1/health/ready`) and web login. Leave automatic restart disabled for releases requiring these manual steps. Backups need PostgreSQL client tools and the application's database credentials.

The uploader overwrites only staged release files; it does not delete remote files. `.env`, `node_modules`, user uploads, logs, and host configuration are not included in the payload. API payload: `dist`, `scripts`, package manifests. Web payload: production `.next` (without cache/dev output), `public`, `server.js`, `next.config.mjs`, package manifests. Hidden production build files are explicitly retained in the GitHub artifact.

An FTP upload is not atomic and has no automatic rollback. Deploy during a maintenance window when needed; retain a known-good backup. Obsolete remote files are intentionally preserved and may require a separate reviewed cleanup. Green upload status confirms file transfer, not successful application startup.

FTP/TLS behavior follows Python's [ftplib documentation](https://docs.python.org/3/library/ftplib.html).

## FTPS certificate verification failure

`SSLCertVerificationError` occurs during TLS setup, before the upload. Both GitHub deployment workflows now default `FTP_TLS_VERIFY` to `false` at the hosting owner's request for factory.vgatefurnishing.com. FTPS encryption remains enabled, but server identity verification is skipped. Set repository variable `FTP_TLS_VERIFY=true` to restore verification after the hosting certificate is corrected. The standalone Python script still defaults to verification when the environment variable is absent.

1. Read the new verification code/message in the workflow log. A hostname mismatch means `FTP_SERVER_VGATE` must use the hostname covered by the FTP service certificate (often the hosting server hostname supplied by your provider, rather than your website domain).
2. For an expired certificate or incomplete chain, ask the hosting provider to renew or repair the FTP service certificate. Changing the website certificate alone might not change the FTP service certificate.
3. For an intentional private/self-signed hosting certificate, obtain the trusted PEM CA certificate from your provider and add it as repository secret `FTP_CA_CERT` in both repositories. Verification and hostname checks remain enabled.
4. If you knowingly need to proceed without server identity verification, add repository **variable** `FTP_TLS_VERIFY=false` in each repository. Traffic remains encrypted, but this permits server impersonation. The workflows use this explicit override by default; they never retry a failed verified connection with weaker settings. Set it to `true` after the certificate is fixed. Switching to plain FTP is not necessary for this error.

Commit and push the workflow/script changes before rerunning. A rerun of an older workflow run uses the older commit; run CI/Quality on the updated production branch instead.

Certificate trust uses Python's [SSL context API](https://docs.python.org/3/library/ssl.html#ssl.SSLContext.load_verify_locations).
