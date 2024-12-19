import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
import { Mutex } from "async-mutex";
import dotenv from "dotenv";
import db from "./db";

const setupWSConnection = require("y-websocket/bin/utils").setupWSConnection;

// Load environment variables from .env file
dotenv.config();

// CORS Configuration
export const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [];

const app = express();
app.use(
    cors({
        origin: (origin, callback) => {
            if (
                (typeof origin === "string" &&
                    allowedOrigins.includes(origin)) ||
                !origin // Allow requests with no origin (e.g., curl, Postman, etc.)
            ) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
            }
        },
        methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
        allowedHeaders: "Content-Type",
        credentials: true,
    })
);
app.use(express.json());

// HTTP server for both WebSocket servers
const httpServer = app.listen(1234, () => {
    console.log(`HTTP server is listening on port 1234`);
});

// Create WebSocket servers for Yjs and messages
const yWebSocketServer = new WebSocketServer({ noServer: true });
const controlWebSocketServer = new WebSocketServer({ noServer: true });

// Single upgrade handler for both WebSocket servers
httpServer.on("upgrade", (request, socket, head) => {
    try {
        // Provide a fallback for request.url if it's undefined
        const pathname = new URL(
            request.url || "/",
            `http://${request.headers.host}`
        ).pathname;

        if (pathname.startsWith("/yjs")) {
            yWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
                // Setup connection for the Yjs WebSocket
                yWebSocketServer.emit("connection", ws, request);
            });
        } else if (pathname === "/control") {
            controlWebSocketServer.handleUpgrade(
                request,
                socket,
                head,
                (ws) => {
                    controlWebSocketServer.emit("connection", ws, request);
                }
            );
        } else {
            console.log(`Unrecognized WebSocket path: ${pathname}`);
            socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
            socket.destroy();
        }
    } catch (error) {
        console.error("Error handling WebSocket upgrade:", error);
        socket.destroy();
    }
});

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
}
const RoomDataCache: Map<string, RoomData> = new Map();
const DirtyRooms: Set<string> = new Set();
// const RoomLocks: Map<string, Promise<void>> = new Map();
const RoomLocks: Map<string, Mutex> = new Map();

/**
 * Helper function to get room data from cache or database
 */
async function getRoomData(
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
async function fetchRoomData(roomId: string): Promise<RoomData | undefined> {
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
async function modifyRoomData(
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
            };
        }

        // Apply the modifier function to update the room data
        modifier(roomData);

        // Update the cache and mark the room as dirty
        RoomDataCache.set(roomId, roomData);
        DirtyRooms.add(roomId);
    });
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
                    console.log(`Syncing room data for roomId: ${roomId}`);

                    // Check if the room exists in the database
                    const existingRoom = await db("rooms")
                        .where({ room_id: roomId })
                        .first();

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
                                task_description_path:
                                    roomData.taskDescriptionPath,
                                learning_goals_path: roomData.learningGoalsPath,
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
                        });
                        console.log(
                            `Inserted new room data for roomId: ${roomId}`
                        );
                    }

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
 * Helper function to send messages to all clients in a specific room
 */
function sendToRoom(roomId: string, message: object) {
    controlWebSocketServer.clients.forEach((client) => {
        if (
            (client as any).roomId === roomId &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(JSON.stringify(message));
        }
    });
}

/**
 * Function to send accessLists to all clients in a room
 */
async function sendAccessLists(roomId: string) {
    const roomData = await getRoomData(roomId);
    if (!roomData) {
        console.log(`Room not found: ${roomId}`);
        return;
    }

    const accessListSimpleIDAsArray = Array.from(roomData.accessListSimpleID);
    const accessListClientIDAsArray = Array.from(roomData.accessListClientID);

    console.log("Sending access list (simpleID)", accessListSimpleIDAsArray);
    console.log("Sending access list (clientID)", accessListClientIDAsArray);

    sendToRoom(roomId, {
        type: "accessListResponse",
        payload: {
            roomId,
            accessListSimpleIDAsArray,
            accessListClientIDAsArray,
        },
    });

    console.log(
        `Sent access list for room: ${roomId} with simpleIDs: ${accessListSimpleIDAsArray}`
    );
}

/**
 * Helper function to generate a random salt
 */
function generateSalt(length: number): string {
    const array = new Uint8Array(length);
    crypto.getRandomValues(array);
    return Array.from(array)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

/**
 * Helper function to hash a password using PBKDF2
 */
async function hashPassword(password: string, salt: string): Promise<string> {
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
            iterations: 1000,
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
async function validatePassword(
    providedPassword: string,
    storedPassword: string,
    salt: string
): Promise<boolean> {
    const derivedHash = await hashPassword(providedPassword, salt);
    return derivedHash === storedPassword;
}

// Endpoint to verify a password
app.post("/api/verify-password", async (req, res) => {
    const { password, roomId } = req.body;

    // Ensure a mutex exists for this roomId
    if (!RoomLocks.has(roomId)) {
        RoomLocks.set(roomId, new Mutex());
    }

    const roomMutex = RoomLocks.get(roomId)!;

    await roomMutex.runExclusive(async () => {
        try {
            const roomData = await getRoomData(roomId, true);
            if (!roomData) {
                res.status(404).json({
                    success: false,
                    message: "Room not found",
                });
                return;
            }

            const isValidPassword = await validatePassword(
                password,
                roomData.passwordHash,
                roomData.salt
            );

            if (isValidPassword) {
                res.status(200).json({ success: true });
            } else {
                res.status(401).json({
                    success: false,
                    message: "Invalid password",
                });
            }
        } catch (error) {
            console.error(
                `Error verifying password for roomId: ${roomId}`,
                error
            );
            res.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    });
});

// Endpoint to verify if room exists
app.post("/api/verify-room", async (req, res) => {
    const { roomId } = req.body;

    // Ensure a mutex exists for this roomId
    if (!RoomLocks.has(roomId)) {
        RoomLocks.set(roomId, new Mutex());
    }

    const roomMutex = RoomLocks.get(roomId)!;

    await roomMutex.runExclusive(async () => {
        try {
            // Use getRoomData to retrieve or initialize the room data
            const roomData = await getRoomData(roomId, true);
            const roomExists = !!roomData;

            if (roomExists) {
                res.json({ success: true });
            } else {
                res.json({ success: false, message: "Room not found" });
            }
        } catch (error) {
            console.error(
                `Error verifying room existence for roomId: ${roomId}`,
                error
            );
            res.status(500).json({
                success: false,
                message: "Internal server error",
            });
        }
    });
});

// Yjs WebSocket connection setup
yWebSocketServer.on("connection", (ws, request) => {
    setupWSConnection(ws, request); // Setup Yjs connection
});

// Control WebSocket connection setup
controlWebSocketServer.on("connection", (ws: WebSocket, request) => {
    // Extract roomId from query parameters
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const roomIdUrl = url.searchParams.get("roomId");

    if (!roomIdUrl) {
        ws.close(4000, "Room ID is required");
        return;
    }

    // Associate the WebSocket (client) with the roomId
    (ws as any).roomId = roomIdUrl;

    console.log(`Client connected to room: ${roomIdUrl}`);

    // Periodically send pings to clients
    const interval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();
        }
    }, 30000); // Every 30 seconds

    ws.on("message", async (message: string) => {
        try {
            const { type, payload } = JSON.parse(message);
            const {
                roomId,
                simpleID,
                clientID,
                targetSimpleID,
                instructorFile,
                password,
                taskDescriptionPath,
                learningGoalsPath,
                increase,
                changedTheme,
            } = payload;

            console.log("Received message: ", type, payload);

            // Ensure roomId is in payload for room-specific actions
            if (!roomId || roomId !== roomIdUrl) {
                // Ignore messages without a roomId
                console.log("Invalid roomId in message payload.");
                return;
            }

            switch (type) {
                case "setSessionData":
                    if (!password) {
                        console.log("Invalid setRoomPassword payload.");
                        return;
                    }

                    await modifyRoomData(roomId, async (roomData) => {
                        const salt = generateSalt(16);
                        const passwordHash = await hashPassword(password, salt);

                        roomData.salt = salt;
                        roomData.passwordHash = passwordHash;
                        roomData.taskDescriptionPath = taskDescriptionPath;
                        roomData.learningGoalsPath = learningGoalsPath;
                    });

                    ws.send(
                        JSON.stringify({
                            type: "sessionDataSetResponse",
                            payload: { roomId },
                        })
                    );

                    console.log(`Set session data for room: ${roomId}`);
                    break;

                case "requestSimpleID": {
                    // Assign a new simpleID to the client in the specified room
                    await modifyRoomData(roomId, (roomData) => {
                        const newSimpleID = roomData.simpleIDCounter++;
                        roomData.simpleIDtoClientIDMap[newSimpleID] = clientID;

                        ws.send(
                            JSON.stringify({
                                type: "requestSimpleIDResponse",
                                payload: {
                                    roomId,
                                    newSimpleID,
                                    taskDescriptionPath:
                                        roomData.taskDescriptionPath,
                                    learningGoalsPath:
                                        roomData.learningGoalsPath,
                                },
                            })
                        );

                        console.log(
                            `Assigned new simpleID ${newSimpleID} to ${clientID} in room ${roomId}`
                        );
                    });

                    sendAccessLists(roomId);
                    break;
                }

                case "registerClient":
                    // Register client with simpleID and clientID in the specified room
                    // Delete old clientID from the access list
                    await modifyRoomData(roomId, (roomData) => {
                        const oldClientID =
                            roomData.simpleIDtoClientIDMap[Number(simpleID)];
                        if (oldClientID) {
                            roomData.accessListClientID.delete(oldClientID);
                        }

                        if (roomData.accessListSimpleID.has(Number(simpleID))) {
                            roomData.accessListClientID.add(Number(clientID));
                        }

                        roomData.simpleIDtoClientIDMap[Number(simpleID)] =
                            Number(clientID);

                        ws.send(
                            JSON.stringify({
                                type: "sessionDataResponse",
                                payload: {
                                    roomId,
                                    taskDescriptionPath:
                                        roomData.taskDescriptionPath,
                                    learningGoalsPath:
                                        roomData.learningGoalsPath,
                                },
                            })
                        );

                        console.log(
                            `Registered client with simpleID: ${simpleID} and clientID: ${clientID} in room: ${roomId}`
                        );
                    });

                    sendAccessLists(roomId);
                    break;

                case "grantAccess":
                    // Check if access should be granted for all clients
                    await modifyRoomData(roomId, (roomData) => {
                        if (targetSimpleID === null) {
                            roomData.accessListSimpleID = new Set(
                                Object.keys(roomData.simpleIDtoClientIDMap).map(
                                    (simpleID) => Number(simpleID)
                                )
                            );
                            roomData.accessListClientID = new Set(
                                Object.values(
                                    roomData.simpleIDtoClientIDMap
                                ).map((clientID) => Number(clientID))
                            );

                            ws.send(
                                JSON.stringify({
                                    type: "accessGranted",
                                    payload: {
                                        roomId,
                                        simpleID: Array.from(
                                            roomData.accessListSimpleID
                                        ),
                                    },
                                })
                            );
                            console.log(
                                `Granted access for all clients in room: ${roomId}`
                            );
                        } else {
                            // Check if the simpleID is valid
                            if (
                                !roomData.simpleIDtoClientIDMap[targetSimpleID]
                            ) {
                                console.log(
                                    `SimpleID ${targetSimpleID} not found in room ${roomId}`
                                );
                                return;
                            }

                            // Grant access to a given simpleID in the specified room
                            roomData.accessListSimpleID.add(
                                Number(targetSimpleID)
                            );
                            roomData.accessListClientID.add(
                                Number(
                                    roomData.simpleIDtoClientIDMap[
                                        Number(targetSimpleID)
                                    ]
                                )
                            );

                            ws.send(
                                JSON.stringify({
                                    type: "accessGranted",
                                    payload: {
                                        roomId,
                                        simpleID: targetSimpleID,
                                    },
                                })
                            );
                            console.log(
                                `Granted access to simpleID: ${targetSimpleID} in room: ${roomId}`
                            );
                        }
                    });

                    sendAccessLists(roomId);
                    break;

                case "revokeAccess":
                    // Check if access should be revoked for all clients
                    await modifyRoomData(roomId, (roomData) => {
                        if (targetSimpleID === null) {
                            roomData.accessListSimpleID.clear();
                            roomData.accessListClientID.clear();
                            ws.send(
                                JSON.stringify({
                                    type: "accessRevoked",
                                    payload: { roomId, simpleID: null },
                                })
                            );
                            console.log(
                                `Revoked access for all clients in room: ${roomId}`
                            );
                        } else {
                            // Revoke access for a given simpleID in the specified room
                            roomData.accessListSimpleID.delete(
                                Number(targetSimpleID)
                            );
                            roomData.accessListClientID.delete(
                                Number(
                                    roomData.simpleIDtoClientIDMap[
                                        Number(targetSimpleID)
                                    ]
                                )
                            );
                            ws.send(
                                JSON.stringify({
                                    type: "accessRevoked",
                                    payload: {
                                        roomId,
                                        simpleID: targetSimpleID,
                                    },
                                })
                            );
                            console.log(
                                `Revoked access for simpleID: ${targetSimpleID} in room: ${roomId}`
                            );
                        }
                    });

                    sendAccessLists(roomId);
                    break;

                case "setInstructorFile":
                    // Set the current instructor file for the specified room
                    await modifyRoomData(roomId, (roomData) => {
                        roomData.instructorFile = instructorFile;
                    });
                    console.log(`Updated instructor file for room: ${roomId}`);
                    break;

                case "requestInstructorFile":
                    // Send the current instructor file to the client
                    const instructorFileResponse = await modifyRoomData(
                        roomId,
                        (roomData) => {
                            const instructorFile = roomData.instructorFile;
                            ws.send(
                                JSON.stringify({
                                    type: "instructorFileResponse",
                                    payload: {
                                        roomId,
                                        instructorFileServer: instructorFile,
                                    },
                                })
                            );
                        }
                    );

                    break;

                case "requestTerminalOpen":
                    // Notify the clients in the room to open the terminal
                    sendToRoom(roomId, {
                        type: "terminalOpened",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent terminal opened message to room:",
                        roomId
                    );
                    break;

                case "requestTerminalClose":
                    // Notify the clients in the room to close the terminal
                    sendToRoom(roomId, {
                        type: "terminalClosed",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent terminal closed message to room:",
                        roomId
                    );
                    break;

                case "requestExplorerOpen":
                    // Notify the clients in the room to open the explorer
                    sendToRoom(roomId, {
                        type: "explorerOpened",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent explorer opened message to room:",
                        roomId
                    );
                    break;

                case "requestExplorerClose":
                    // Notify the clients in the room to close the explorer
                    sendToRoom(roomId, {
                        type: "explorerClosed",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent explorer closed message to room:",
                        roomId
                    );
                    break;

                case "requestFontSizeChange":
                    // Notify the clients in the room to change the font size
                    sendToRoom(roomId, {
                        type: "fontSizeChanged",
                        payload: {
                            roomId,
                            increase,
                        },
                    });
                    console.log(
                        "Sent font size change message to room:",
                        roomId
                    );
                    break;

                case "requestThemeChange":
                    // Notify the clients in the room to change the theme
                    sendToRoom(roomId, {
                        type: "themeChanged",
                        payload: { roomId, changedTheme },
                    });
                    console.log("Sent theme change message to room:", roomId);
                    break;

                default:
                    // Ignore unknown message types
                    break;
            }
        } catch (error) {
            console.error(error);
        }
    });

    ws.on("close", () => {
        clearInterval(interval);
        console.log(`Client disconnected from room: ${roomIdUrl}`);
    });
});
