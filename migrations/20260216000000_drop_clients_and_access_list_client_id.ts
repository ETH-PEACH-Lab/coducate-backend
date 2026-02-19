import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.dropColumn("clients");
        table.dropColumn("access_list_client_id");
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("rooms", (table) => {
        table.json("clients").notNullable().defaultTo("[]");
        table.json("access_list_client_id").notNullable().defaultTo("[]");
    });
}
