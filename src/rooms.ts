import nodeCrypto from "crypto";
import db from "./db";
import { Mutex } from "async-mutex";
import { WebSocket } from "ws";

interface RoomData {
    simpleIDCounter: number;
    simpleIDtoClientIDMap: Record<number, number>;
    accessListSimpleID: Set<number>;
    accessListClientID: Set<number>;
    instructorFile: string;
    passwordHash: string;
    salt: string;
    taskDescriptionPath: string;
    learningGoalsPath: string;
    clients: Set<WebSocket>;
}
const RoomDataCache: Map<string, RoomData> = new Map();
const DirtyRooms: Set<string> = new Set();
export const RoomLocks: Map<string, Mutex> = new Map();

/**
 * Remove empty rooms from the cache
 */
export function cleanUpRoomCache() {
    for (const [roomId, roomData] of RoomDataCache) {
        if (roomData.clients.size === 0) {
            RoomDataCache.delete(roomId);
            DirtyRooms.delete(roomId);
        }
    }
}

/**
 * Get room data from cache or database
 */
export async function getRoomData(
    roomId: string,
    skipLock = false
): Promise<RoomData | undefined> {
    // Ensure the mutex for this roomId exists
    if (!RoomLocks.has(roomId)) {
        RoomLocks.set(roomId, new Mutex());
    }

    const roomMutex = RoomLocks.get(roomId)!;

    if (skipLock) {
        // Skip acquiring the lock if the caller already holds it
        console.log(`Skipping lock acquisition for roomId: ${roomId}`);
        return await fetchRoomData(roomId);
    }

    // Acquire the lock
    return await roomMutex.runExclusive(async () => {
        return await fetchRoomData(roomId);
    });
}

/**
 * Core logic to fetch room data from cache or database
 */
export async function fetchRoomData(
    roomId: string
): Promise<RoomData | undefined> {
    // Check if the room data is already in the cache
    if (RoomDataCache.has(roomId)) {
        console.log("Room data found in cache");
        return RoomDataCache.get(roomId)!;
    }

    console.log("Room not found in cache, checking database");

    // Fetch the room data from the database
    const room = await db("rooms").where({ room_id: roomId }).first();
    if (room) {
        console.log("Room found in database");

        const roomData: RoomData = {
            simpleIDCounter: room.simple_id_counter,
            simpleIDtoClientIDMap: room.simple_id_to_client_id_map,
            accessListSimpleID: new Set(room.access_list_simple_id),
            accessListClientID: new Set(room.access_list_client_id),
            instructorFile: room.instructor_file,
            passwordHash: room.password_hash,
            salt: room.salt,
            taskDescriptionPath: room.task_description_path,
            learningGoalsPath: room.learning_goals_path,
            clients: new Set(room.clients),
        };

        RoomDataCache.set(roomId, roomData);
        return roomData;
    }

    console.log("Room not found in database");

    return undefined;
}

/**
 * Helper function to modify room data
 */
export async function modifyRoomData(
    roomId: string,
    modifier: (roomData: RoomData) => void
) {
    // Ensure the mutex for this roomId exists
    if (!RoomLocks.has(roomId)) {
        RoomLocks.set(roomId, new Mutex());
    }

    const roomMutex = RoomLocks.get(roomId)!;

    await roomMutex.runExclusive(async () => {
        // Ensure room data is initialized, skipping lock since we already hold it
        let roomData = await getRoomData(roomId, true);

        if (!roomData) {
            console.log("Creating a new entry in cache only");

            // If room does not exist, create a new entry in the cache
            roomData = {
                simpleIDCounter: 1,
                simpleIDtoClientIDMap: {},
                accessListSimpleID: new Set<number>(),
                accessListClientID: new Set<number>(),
                instructorFile: "",
                passwordHash: "",
                salt: "",
                taskDescriptionPath: "",
                learningGoalsPath: "",
                clients: new Set<WebSocket>(),
            };
        }

        // Apply the modifier function to update the room data
        modifier(roomData);

        // Update the cache and mark the room as dirty
        RoomDataCache.set(roomId, roomData);
        DirtyRooms.add(roomId);
    });
}

/**
 * Save room data to the database
 */
async function saveRoomDataToDB(roomId: string, roomData: RoomData) {
    console.log(`Syncing room data for roomId: ${roomId}`);

    // Check if the room exists in the database
    const existingRoom = await db("rooms").where({ room_id: roomId }).first();

    if (existingRoom) {
        // Update the existing room
        await db("rooms")
            .where({ room_id: roomId })
            .update({
                simple_id_counter: roomData.simpleIDCounter,
                simple_id_to_client_id_map: JSON.stringify(
                    roomData.simpleIDtoClientIDMap
                ),
                access_list_simple_id: JSON.stringify(
                    Array.from(roomData.accessListSimpleID)
                ),
                access_list_client_id: JSON.stringify(
                    Array.from(roomData.accessListClientID)
                ),
                instructor_file: roomData.instructorFile,
                password_hash: roomData.passwordHash,
                salt: roomData.salt,
                task_description_path: roomData.taskDescriptionPath,
                learning_goals_path: roomData.learningGoalsPath,
                clients: JSON.stringify(Array.from(roomData.clients)),
            });
        console.log(`Updated room data for roomId: ${roomId}`);
    } else {
        // Insert a new room
        await db("rooms").insert({
            room_id: roomId,
            simple_id_counter: roomData.simpleIDCounter,
            simple_id_to_client_id_map: JSON.stringify(
                roomData.simpleIDtoClientIDMap
            ),
            access_list_simple_id: JSON.stringify(
                Array.from(roomData.accessListSimpleID)
            ),
            access_list_client_id: JSON.stringify(
                Array.from(roomData.accessListClientID)
            ),
            instructor_file: roomData.instructorFile,
            password_hash: roomData.passwordHash,
            salt: roomData.salt,
            task_description_path: roomData.taskDescriptionPath,
            learning_goals_path: roomData.learningGoalsPath,
            clients: JSON.stringify(Array.from(roomData.clients)),
        });
        console.log(`Inserted new room data for roomId: ${roomId}`);
    }
}

// Periodically sync room data to the database
setInterval(async () => {
    const promises = [];

    for (const roomId of DirtyRooms) {
        // Ensure a mutex exists for the roomId
        if (!RoomLocks.has(roomId)) {
            RoomLocks.set(roomId, new Mutex());
        }

        const roomMutex = RoomLocks.get(roomId)!;

        const syncPromise = roomMutex.runExclusive(async () => {
            const roomData = RoomDataCache.get(roomId);
            if (roomData) {
                try {
                    await saveRoomDataToDB(roomId, roomData);

                    DirtyRooms.delete(roomId);
                } catch (error) {
                    console.error(
                        `Error syncing room data for roomId: ${roomId}`,
                        error
                    );
                }
            }
        });

        promises.push(syncPromise);
    }

    // Wait for all sync operations to complete
    await Promise.all(promises);
}, 60000); // Sync every 60 seconds to reduce database load

/**
 * Generates a random salt for password hashing
 */
export function generateSalt(length: number): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Hashes a password using PBKDF2 with the salt
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
        256 // Output length in bits
    );

    return Array.from(new Uint8Array(derivedBits))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Validates a password using PBKDF2 with the salt and stored hash
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
