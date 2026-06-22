# Coducate Backend

This is the backend server for Coducate. It provides WebSocket connections for real-time collaboration and a REST API for room management.

## Getting Started

For complete setup instructions, please refer to the [main project README](https://github.com/madbeamer/coducate-app/blob/57ff5802af539000dac73fc02fc84685cd986863/README.md).

## Quick Start (Standalone)

If you want to run the backend without Docker:

1. Ensure MariaDB is running (locally or via Docker)
2. Create a `.env` file with database credentials
3. Install dependencies and run migrations:
   
    ```bash
    npm install
    npx knex migrate:latest --knexfile knexfile.ts
    npm start
    ```

The server will run on port 1234.

## License

[GNU Affero General Public License v3.0 or later](LICENSE)
