import type { Knex } from "knex";

const config: { [key: string]: Knex.Config } = {
    development: {
        client: "mysql2",
        connection: {
            host: process.env.DATABASE_HOST || "localhost",
            port: Number(process.env.DATABASE_PORT) || 3306,
            user: process.env.DATABASE_USER || "root",
            password: process.env.DATABASE_PASSWORD || "rootpassword",
            database: process.env.DATABASE_NAME || "coducate",
        },
        migrations: {
            directory: "./migrations",
            extension: "ts",
        },
        seeds: {
            directory: "./seeds",
            extension: "ts",
        },
    },
    production: {
        client: "mysql2",
        connection: {
            host: process.env.DATABASE_HOST || "mysql",
            port: Number(process.env.DATABASE_PORT) || 3306,
            user: process.env.DATABASE_USER || "coducate_user",
            password: process.env.DATABASE_PASSWORD || "coducate_password",
            database: process.env.DATABASE_NAME || "coducate",
        },
        migrations: {
            directory: "./migrations",
            extension: "ts",
        },
        seeds: {
            directory: "./seeds",
            extension: "ts",
        },
    },
};

export default config;
