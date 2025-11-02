#!/bin/bash
set -e

echo "Starting Coducate Backend..."

if [ -n "$DB_HOST" ]; then
    echo "Waiting for database at $DB_HOST:$DB_PORT..."
    
    timeout=60
    counter=0

    # Wait until the database is reachable
    until mariadb -h"$DB_HOST" -P"$DB_PORT" -u"$DB_USER" -p"$DB_PASSWORD" -e "SELECT 1" > /dev/null 2>&1; do
        counter=$((counter + 1))
        if [ $counter -gt $timeout ]; then
            echo "Database connection timeout after ${timeout} seconds"
            exit 1
        fi
        echo "Waiting for database... ($counter/$timeout)"
        sleep 1
    done

    echo "Database is ready"

    echo "Running database migrations..."
    npx knex migrate:latest --knexfile knexfile.ts
fi

echo "Starting application..."
exec "$@"
