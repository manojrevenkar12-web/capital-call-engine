#!/usr/bin/env bash
# Starts a throwaway MySQL 8 on 127.0.0.1:3307 for tests and the evaluation.
# CI uses a mysql:8.0 service instead; both are reached through CCE_DATABASE_URL.
set -euo pipefail
DIR="${CCE_MYSQL_DIR:-$PWD/.mysql}"
PORT="${CCE_MYSQL_PORT:-3307}"
if mysqladmin --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1; then
  echo "mysql already up on $PORT"; exit 0
fi
mkdir -p "$DIR"
if [ ! -d "$DIR/data/mysql" ]; then
  mysqld --no-defaults --initialize-insecure --datadir="$DIR/data" --user="$(whoami)" >/dev/null 2>&1
fi
mysqld --no-defaults --datadir="$DIR/data" --port="$PORT" --bind-address=127.0.0.1 --socket="$DIR/mysqld.sock" \
  --mysqlx=OFF --user="$(whoami)" --pid-file="$DIR/mysqld.pid" --log-error="$DIR/error.log" \
  --innodb-buffer-pool-size=128M --skip-log-bin >/dev/null 2>&1 &
for _ in $(seq 1 60); do
  if mysqladmin --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot ping >/dev/null 2>&1; then
    mysql --protocol=tcp -h127.0.0.1 -P"$PORT" -uroot -e "CREATE DATABASE IF NOT EXISTS cce;"
    echo "mysql up on $PORT"; exit 0
  fi
  sleep 1
done
echo "mysql did not start"; tail -20 "$DIR/error.log"; exit 1
