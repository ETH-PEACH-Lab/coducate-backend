import type { Knex } from "knex";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

const getConnectionConfig = () => {
    const base = {
        host: process.env.DB_HOST,
        port: parseInt(process.env.DB_PORT!),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    };

    // Enable SSL in production (required by RDS)
    if (process.env.NODE_ENV === "production") {
        return {
            ...base,
            ssl: {
                ca: fs.readFileSync("/usr/local/share/ca-certificates/rds-global-bundle.pem"),
            },
        };
    }

    return base;
};

const baseConfig: any = {
    client: "mysql2",
    migrations: {
        directory: "./migrations",
        extension: "ts",
    },
    seeds: {
        directory: "./seeds",
        extension: "ts",
    },
};

const config: { [key: string]: Knex.Config } = {
    development: {
        ...baseConfig,
        connection: getConnectionConfig(),
    },
    production: {
        ...baseConfig,
        connection: getConnectionConfig(),
    },
};

export default config;
