import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.string("status").notNullable().defaultTo("active");
        table.timestamp("ended_at").nullable();
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.dropColumn("status");
        table.dropColumn("ended_at");
    });
}
