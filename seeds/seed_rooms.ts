import type { Knex } from "knex";

export async function seed(knex: Knex): Promise<void> {
    // Deletes ALL existing entries
    await knex("rooms").del();

    // Inserts seed entries to populate the rooms table
    // await knex("rooms").insert([
    //     {
    //         room_id: "test_room_1",
    //         simple_id_counter: 1,
    //         simple_id_to_client_id_map: JSON.stringify({}),
    //         access_list_simple_id: JSON.stringify([]),
    //         access_list_client_id: JSON.stringify([]),
    //         instructor_file: "",
    //         password_hash: "",
    //         salt: "",
    //         task_description_path: "",
    //         learning_goals_path: "",
    //         clients: JSON.stringify([]),
    //     },
    // ]);
}
