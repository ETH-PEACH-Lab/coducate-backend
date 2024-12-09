import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    await knex.schema.createTable("rooms", (table) => {
        table.string("room_id").primary();
        table.integer("simple_id_counter").notNullable();
        table.json("simple_id_to_client_id_map").notNullable();
        table.json("access_list_simple_id").notNullable();
        table.json("access_list_client_id").notNullable();
        table.text("instructor_file");
        table.text("password_hash");
        table.text("salt");
        table.text("task_description_path");
        table.text("learning_goals_path");
    });
}

export async function down(knex: Knex): Promise<void> {
    await knex.schema.dropTable("rooms");
}
