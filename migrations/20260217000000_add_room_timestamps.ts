import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.timestamp("created_at").notNullable().defaultTo(knex.fn.now());
        table
            .timestamp("last_active_at")
            .notNullable()
            .defaultTo(knex.fn.now());
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.dropColumn("created_at");
        table.dropColumn("last_active_at");
    });
}
