#!/bin/sh

set -eu

echo "Starting web server; database migrations are operator-controlled"
exec node apps/web/server.js
