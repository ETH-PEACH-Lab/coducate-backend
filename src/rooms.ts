import nodeCrypto from "crypto";
import db from "./db";

/**
 * Get a room row from the database.
 */
export async function getRoom(roomId: string) {
    return db("rooms").where({ room_id: roomId }).first();
}

/**
 * Create a new room in the database.
 */
export async function createRoom(
    roomId: string,
    data: {
        passwordHash: string;
        salt: string;
        taskDescriptionPath?: string;
        learningGoalsPath?: string;
    }
) {
    await db("rooms").insert({
        room_id: roomId,
        simple_id_counter: 1,
        instructor_file: "",
        password_hash: data.passwordHash,
        salt: data.salt,
        task_description_path: data.taskDescriptionPath || "",
        learning_goals_path: data.learningGoalsPath || "",
    });
}

/**
 * Update specific fields of an existing room.
 * Automatically updates last_active_at timestamp.
 */
export async function updateRoom(
    roomId: string,
    fields: Record<string, any>
) {
    await db("rooms")
        .where({ room_id: roomId })
        .update({ ...fields, last_active_at: db.fn.now() });
}

/**
 * Mark a room as ended. The room record persists in the database
 * so the instructor can rejoin later. WebSocket connections are rejected.
 */
export async function endRoom(roomId: string) {
    await db("rooms")
        .where({ room_id: roomId })
        .update({
            status: "ended",
            ended_at: db.fn.now(),
            last_active_at: db.fn.now(),
        });
}

/**
 * Reactivate an ended room so it can accept connections again.
 */
export async function reactivateRoom(roomId: string) {
    await db("rooms")
        .where({ room_id: roomId })
        .update({
            status: "active",
            ended_at: null,
            last_active_at: db.fn.now(),
        });
}

/**
 * Mark a room for deletion. Backend cleanup will hard-delete it.
 */
export async function softDeleteRoom(roomId: string) {
    await db("rooms")
        .where({ room_id: roomId })
        .update({
            status: "deleted",
            ended_at: db.raw("COALESCE(ended_at, NOW())"),
            last_active_at: db.fn.now(),
        });
}

/**
 * Check if a room is active (not ended or deleted).
 */
export async function isRoomActive(roomId: string): Promise<boolean> {
    const room = await getRoom(roomId);
    return room?.status === "active";
}

/**
 * Delete stale rooms from the database.
 * - Soft-deleted rooms (status = "deleted") are removed immediately
 * - Active rooms with no activity for 6 months (orphaned, safety net)
 */
export async function cleanupStaleRooms(): Promise<number> {
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);

    const deletedSoftDeleted = await db("rooms")
        .where("status", "deleted")
        .delete();

    const deletedOrphaned = await db("rooms")
        .where("status", "active")
        .where("last_active_at", "<", sixMonthsAgo)
        .delete();

    return deletedSoftDeleted + deletedOrphaned;
}

// ── room_clients table helpers ──

/**
 * Get the simpleID-to-clientID mapping for a room.
 */
export async function getClientMap(
    roomId: string
): Promise<Record<number, number>> {
    const rows = await db("room_clients")
        .where({ room_id: roomId })
        .select("simple_id", "client_id");
    const map: Record<number, number> = {};
    rows.forEach((r) => {
        map[r.simple_id] = r.client_id;
    });
    return map;
}

/**
 * Set (upsert) a simpleID-to-clientID mapping entry.
 */
export async function upsertClient(
    roomId: string,
    simpleId: number,
    clientId: number,
    clientSecret?: string
) {
    const data: Record<string, unknown> = {
        room_id: roomId,
        simple_id: simpleId,
        client_id: clientId,
    };
    const mergeData: Record<string, unknown> = { client_id: clientId };

    if (clientSecret) {
        data.client_secret = clientSecret;
        mergeData.client_secret = clientSecret;
    }

    await db("room_clients")
        .insert(data)
        .onConflict(["room_id", "simple_id"])
        .merge(mergeData);
}

/**
 * Validate that a client secret matches the stored secret for a simpleID.
 */
export async function validateClientSecret(
    roomId: string,
    simpleId: number,
    clientSecret: string
): Promise<boolean> {
    const row = await db("room_clients")
        .where({
            room_id: roomId,
            simple_id: simpleId,
            client_secret: clientSecret,
        })
        .first();
    return !!row;
}

// ── room_access table helpers ──

/**
 * Get the list of simple IDs that have write access in a room.
 */
export async function getAccessList(roomId: string): Promise<number[]> {
    const rows = await db("room_access")
        .where({ room_id: roomId })
        .select("simple_id");
    return rows.map((r) => r.simple_id);
}

/**
 * Grant write access to a single simpleID.
 */
export async function grantAccess(roomId: string, simpleId: number) {
    await db("room_access")
        .insert({ room_id: roomId, simple_id: simpleId })
        .onConflict(["room_id", "simple_id"])
        .ignore();
}

/**
 * Grant write access to all known clients in a room.
 */
export async function grantAccessAll(roomId: string) {
    const clients = await db("room_clients")
        .where({ room_id: roomId })
        .select("simple_id");

    if (clients.length === 0) return;

    const rows = clients.map((c) => ({
        room_id: roomId,
        simple_id: c.simple_id,
    }));

    // Use a transaction to batch-insert with conflict ignore
    await db("room_access")
        .insert(rows)
        .onConflict(["room_id", "simple_id"])
        .ignore();
}

/**
 * Revoke write access for a single simpleID.
 */
export async function revokeAccess(roomId: string, simpleId: number) {
    await db("room_access")
        .where({ room_id: roomId, simple_id: simpleId })
        .delete();
}

/**
 * Revoke write access for all clients in a room.
 */
export async function revokeAccessAll(roomId: string) {
    await db("room_access").where({ room_id: roomId }).delete();
}

/**
 * Generates a random salt for password hashing.
 */
export function generateSalt(length: number): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Hashes a password using PBKDF2 with the salt.
 */
export async function hashPassword(
    password: string,
    salt: string
): Promise<string> {
    const encoder = new TextEncoder();
    const passwordKey = await crypto.subtle.importKey(
        "raw",
        encoder.encode(password),
        { name: "PBKDF2" },
        false,
        ["deriveBits"]
    );

    const derivedBits = await crypto.subtle.deriveBits(
        {
            name: "PBKDF2",
            salt: encoder.encode(salt),
            iterations: 600000,
            hash: "SHA-256",
        },
        passwordKey,
        256
    );

    return Array.from(new Uint8Array(derivedBits))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Validates a password using PBKDF2 with the salt and stored hash.
 */
export async function validatePassword(
    providedPassword: string,
    storedPassword: string,
    salt: string
): Promise<boolean> {
    const derivedHash = await hashPassword(providedPassword, salt);
    const a = Buffer.from(derivedHash, "hex");
    const b = Buffer.from(storedPassword, "hex");
    return a.length === b.length && nodeCrypto.timingSafeEqual(a, b);
}
