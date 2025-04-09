# Coducate Backend

This is the backend server for Coducate. It provides WebSocket connections for real-time collaboration and a REST API for room management.

## Prerequisites

-   Node.js (22+)
-   npm (11+)
-   Docker and Docker Compose

## Getting Started

### Environment Setup

1. Clone the repository
2. Create a `.env` file in the root directory with the necessary environment variables.

### Running the Database

Start the MySQL database:

```bash
docker compose up -d mysql
```

Apply database migrations (if the `data/mysql` directory doesn't exist):

```bash
npx knex migrate:latest --knexfile knexfile.ts
```

### Starting the Server

Install dependencies:

```bash
npm install
```

Start the server:

```bash
npm start
```

The server will run on port 1234 by default.

## Development Tools

### Database Management

Connect to the MySQL database:

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p
```

Query the rooms table:

```sql
USE coducate;
SELECT * FROM rooms;
```

Reset the rooms table:

```bash
npx knex migrate:down --knexfile knexfile.ts
npx knex migrate:latest --knexfile knexfile.ts
```

Seed the database (after creating a seed file):

```bash
npx knex seed:run --knexfile knexfile.ts
```

## Production Deployment

For production, set the NODE_ENV to 'production' in your .env file:

```
NODE_ENV=production
```

Use the production database configuration from knexfile.ts.

## License

TBD
