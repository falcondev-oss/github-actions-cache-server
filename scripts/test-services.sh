#!/bin/sh
# Starts the database and storage the test suite runs against, in Docker.
# usage: scripts/test-services.sh <sqlite|postgres|mysql> <filesystem|s3|gcs|azblob>
# Host ports follow the test suite's TEST_<SERVICE>_PORT overrides.
set -eu

postgres_port=${TEST_POSTGRES_PORT:-5432}
mysql_port=${TEST_MYSQL_PORT:-3306}
s3_port=${TEST_S3_PORT:-9000}
gcs_port=${TEST_GCS_PORT:-4443}
azblob_port=${TEST_AZBLOB_PORT:-10000}

retry() {
  curl --silent --show-error --fail --retry 60 --retry-delay 1 --retry-all-errors "$@" > /dev/null
}

case "$1" in
  sqlite) ;;
  postgres)
    docker run -d --name gha-test-postgres -p "$postgres_port:5432" -e POSTGRES_PASSWORD=postgres postgres:17
    # Over TCP: the image's temporary init server only listens on the Unix socket.
    until docker exec gha-test-postgres pg_isready -h 127.0.0.1 -U postgres > /dev/null 2>&1; do sleep 1; done
    ;;
  mysql)
    docker run -d --name gha-test-mysql -p "$mysql_port:3306" -e MYSQL_ROOT_PASSWORD=root mysql:8.4
    # Over TCP: the image's temporary init server skips networking.
    until docker exec gha-test-mysql mysqladmin --protocol=tcp -h 127.0.0.1 -uroot -proot ping > /dev/null 2>&1; do sleep 1; done
    ;;
  *) echo "unknown database driver: $1" >&2; exit 1 ;;
esac

case "$2" in
  filesystem) ;;
  s3)
    docker run -d --name gha-test-s3 -p "$s3_port:9000" \
      -e RUSTFS_ACCESS_KEY=rustfsadmin -e RUSTFS_SECRET_KEY=rustfsadmin rustfs/rustfs:1.0.0-glibc
    retry --aws-sigv4 aws:amz:us-east-1:s3 --user rustfsadmin:rustfsadmin -X PUT "http://localhost:$s3_port/test"
    ;;
  gcs)
    # object_store's fork: upstream fake-gcs-server rejects its XML API uploads.
    docker run -d --name gha-test-gcs -p "$gcs_port:4443" tustvold/fake-gcs-server \
      -scheme http -backend memory -public-host "localhost:$gcs_port"
    retry -X POST -H 'content-type: application/json' -d '{"name":"test"}' "http://localhost:$gcs_port/storage/v1/b"
    ;;
  azblob)
    docker run -d --name gha-test-azblob -p "$azblob_port:10000" mcr.microsoft.com/azure-storage/azurite \
      azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck --loose
    until curl --silent --output /dev/null "http://localhost:$azblob_port"; do sleep 1; done
    # Creates container "test" with a SharedKey-signed request using Azurite's well-known key.
    AZBLOB_PORT=$azblob_port python3 - << 'EOF'
import base64, email.utils, hashlib, hmac, os, urllib.request

account = 'devstoreaccount1'
key = base64.b64decode('Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==')
date, version = email.utils.formatdate(usegmt=True), '2021-08-06'
to_sign = 'PUT\n' + '\n' * 11 + f'x-ms-date:{date}\nx-ms-version:{version}\n/{account}/{account}/test\nrestype:container'
signature = base64.b64encode(hmac.new(key, to_sign.encode(), hashlib.sha256).digest()).decode()
urllib.request.urlopen(urllib.request.Request(
    f'http://localhost:{os.environ["AZBLOB_PORT"]}/{account}/test?restype=container',
    method='PUT',
    headers={'x-ms-date': date, 'x-ms-version': version, 'Authorization': f'SharedKey {account}:{signature}', 'Content-Length': '0'},
))
EOF
    ;;
  *) echo "unknown storage driver: $2" >&2; exit 1 ;;
esac
