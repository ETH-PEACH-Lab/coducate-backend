import { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
    // Drop tables if they exist from a partial previous run (ensures correct column types)
    if (await knex.schema.hasTable("room_access")) {
        await knex.schema.dropTable("room_access");
    }
    if (await knex.schema.hasTable("room_clients")) {
        await knex.schema.dropTable("room_clients");
    }

    // Create room_clients table (replaces simple_id_to_client_id_map JSON column)
    await knex.schema.createTable("room_clients", (table) => {
        table.string("room_id").notNullable();
        table.integer("simple_id").notNullable();
        table.bigInteger("client_id").notNullable();
        table.primary(["room_id", "simple_id"]);
        table
            .foreign("room_id")
            .references("room_id")
            .inTable("rooms")
            .onDelete("CASCADE");
    });

    // Create room_access table (replaces access_list_simple_id JSON column)
    await knex.schema.createTable("room_access", (table) => {
        table.string("room_id").notNullable();
        table.integer("simple_id").notNullable();
        table.primary(["room_id", "simple_id"]);
        table
            .foreign("room_id")
            .references("room_id")
            .inTable("rooms")
            .onDelete("CASCADE");
    });

    // Migrate existing data from JSON columns into the new tables
    // Only if the JSON columns still exist (not yet dropped from a partial run)
    const hasMapColumn = await knex.schema.hasColumn(
        "rooms",
        "simple_id_to_client_id_map"
    );
    const hasAccessColumn = await knex.schema.hasColumn(
        "rooms",
        "access_list_simple_id"
    );

    if (hasMapColumn && hasAccessColumn) {
        const rooms = await knex("rooms").select(
            "room_id",
            "simple_id_to_client_id_map",
            "access_list_simple_id"
        );

        for (const room of rooms) {
            let map: any = room.simple_id_to_client_id_map || {};
            // Handle string (possibly double-encoded JSON)
            while (typeof map === "string") {
                map = JSON.parse(map);
            }
            if (typeof map !== "object" || map === null) map = {};

            const clientRows = Object.entries(map)
                .filter(([simpleId, clientId]) => {
                    const sid = Number(simpleId);
                    const cid = Number(clientId);
                    return !isNaN(sid) && !isNaN(cid) && clientId != null;
                })
                .map(([simpleId, clientId]) => ({
                    room_id: room.room_id,
                    simple_id: Number(simpleId),
                    client_id: Number(clientId),
                }));
            if (clientRows.length > 0) {
                await knex("room_clients").insert(clientRows);
            }

            let accessList: any = room.access_list_simple_id || [];
            // Handle string (possibly double-encoded JSON)
            while (typeof accessList === "string") {
                accessList = JSON.parse(accessList);
            }
            if (!Array.isArray(accessList)) accessList = [];

            const accessRows = (accessList as number[])
                .filter((simpleId) => typeof simpleId === "number" && !isNaN(simpleId))
                .map((simpleId: number) => ({
                    room_id: room.room_id,
                    simple_id: simpleId,
                }));
            if (accessRows.length > 0) {
                await knex("room_access").insert(accessRows);
            }
        }

        // Drop the JSON columns from rooms
        await knex.schema.alterTable("rooms", (table) => {
            table.dropColumn("simple_id_to_client_id_map");
            table.dropColumn("access_list_simple_id");
        });
    }
}

export async function down(knex: Knex): Promise<void> {
    // Re-add JSON columns
    await knex.schema.alterTable("rooms", (table) => {
        table.json("simple_id_to_client_id_map").notNullable().defaultTo("{}");
        table.json("access_list_simple_id").notNullable().defaultTo("[]");
    });

    // Migrate data back from normalized tables to JSON columns
    const rooms = await knex("rooms").select("room_id");
    for (const room of rooms) {
        const clients = await knex("room_clients")
            .where({ room_id: room.room_id })
            .select("simple_id", "client_id");

        const map: Record<number, number> = {};
        clients.forEach((c) => {
            map[c.simple_id] = c.client_id;
        });

        const access = await knex("room_access")
            .where({ room_id: room.room_id })
            .select("simple_id");

        const accessList = access.map((a) => a.simple_id);

        await knex("rooms").where({ room_id: room.room_id }).update({
            simple_id_to_client_id_map: JSON.stringify(map),
            access_list_simple_id: JSON.stringify(accessList),
        });
    }

    // Drop the normalized tables
    await knex.schema.dropTable("room_access");
    await knex.schema.dropTable("room_clients");
}
