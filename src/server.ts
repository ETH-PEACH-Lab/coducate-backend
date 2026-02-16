import express from "express";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { Mutex } from "async-mutex";
import dotenv from "dotenv";
const setupWSConnection = require("y-websocket/bin/utils").setupWSConnection;
import {
    RoomLocks,
    fetchRoomData,
    getRoomData,
    modifyRoomData,
    cleanUpRoomCache,
    validatePassword,
    hashPassword,
    generateSalt,
} from "./rooms";
import { createToken, verifyToken } from "./auth";
import rateLimit from "express-rate-limit";

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

// Rate limiter for password verification — 10 attempts per 15 minutes per IP
const passwordRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many password attempts. Please try again later.",
    },
});

// Create an HTTP server and attach Express
const server = createServer(app);

// WebSocket server for Yjs
const wssYjs = new WebSocketServer({ noServer: true });

// WebSocket server for custom messages
const wssCustom = new WebSocketServer({ noServer: true });

// Message types that require the instructor role
const INSTRUCTOR_ONLY_TYPES = new Set([
    "set_session_data_request",
    "grant_access_request",
    "revoke_access_request",
    "open_terminal_request",
    "close_terminal_request",
    "open_explorer_request",
    "close_explorer_request",
    "show_room_id_request",
    "hide_room_id_request",
    "change_font_size_request",
    "change_theme_request",
]);

// Both WebSocket servers share the same HTTP server
// Requires to check the pathname to determine which websocket server needs to handle the connection
server.on("upgrade", (request, socket, head) => {
    const url = new URL(
        request.url || "/",
        `http://${request.headers.host}`
    );
    const pathname = url.pathname;
    const token = url.searchParams.get("token");

    // Validate token for all WebSocket connections
    if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    const tokenPayload = verifyToken(token);
    if (!tokenPayload) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    // Attach verified token data to the request for use in connection handlers
    (request as any).tokenPayload = tokenPayload;

    if (pathname.startsWith("/yjs")) {
        wssYjs.handleUpgrade(request, socket, head, (ws) => {
            wssYjs.emit("connection", ws, request);
        });
    } else if (pathname.startsWith("/control")) {
        wssCustom.handleUpgrade(request, socket, head, (ws) => {
            wssCustom.emit("connection", ws, request);
        });
    } else {
        socket.destroy();
    }
});

// Handle Yjs WebSocket connections
wssYjs.on("connection", (ws, req) => {
    // Attach Yjs WebSocket handling
    setupWSConnection(ws, req);
});

// Handle custom WebSocket connections
wssCustom.on("connection", async (ws, req) => {
    // Use the verified roomId and role from the token (set during upgrade)
    const tokenPayload = (req as any).tokenPayload;
    const roomId = tokenPayload.roomId;
    const role = tokenPayload.role;

    // Attach role and roomId to the WebSocket for message authorization
    (ws as any).role = role;
    (ws as any).roomId = roomId;

    console.log(`Client connected to room: ${roomId} (role: ${role})`);

    await modifyRoomData(roomId, (roomData) => {
        roomData.clients.add(ws);
    });

    ws.on("message", async (message) => {
        try {
            const { type, payload } = JSON.parse(message.toString());
            const {
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

            // Use the verified roomId from the token, not from the payload
            const wsRoomId = (ws as any).roomId;

            // Log message type (excluding sensitive payload data)
            console.log("Received message: ", type, "for room:", wsRoomId);

            // Ensure payload roomId matches the authenticated roomId
            if (payload.roomId && payload.roomId !== wsRoomId) {
                console.log(
                    `Room ID mismatch: payload has ${payload.roomId}, authenticated as ${wsRoomId}`
                );
                ws.send(
                    JSON.stringify({
                        type: "error",
                        payload: { message: "Room ID mismatch" },
                    })
                );
                return;
            }

            // Enforce role-based authorization for instructor-only messages
            if (
                INSTRUCTOR_ONLY_TYPES.has(type) &&
                (ws as any).role !== "instructor"
            ) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        payload: {
                            message:
                                "Unauthorized: instructor role required",
                        },
                    })
                );
                console.log(
                    `Rejected ${type} from non-instructor in room: ${wsRoomId}`
                );
                return;
            }

            switch (type) {
                case "set_session_data_request":
                    if (!password) {
                        console.log("Invalid setRoomPassword payload.");
                        return;
                    }

                    await modifyRoomData(wsRoomId, async (roomData) => {
                        const salt = generateSalt(16);
                        const passwordHash = await hashPassword(password, salt);

                        roomData.salt = salt;
                        roomData.passwordHash = passwordHash;
                        roomData.taskDescriptionPath = taskDescriptionPath;
                        roomData.learningGoalsPath = learningGoalsPath;
                    });

                    ws.send(
                        JSON.stringify({
                            type: "set_session_data_response",
                            payload: { roomId: wsRoomId },
                        })
                    );

                    console.log(`Set session data for room: ${wsRoomId}`);
                    break;

                case "get_task_data_request":
                    // Send the task description and learning goals to the client
                    const roomData = await fetchRoomData(wsRoomId);
                    if (!roomData) {
                        console.log(`Room not found: ${wsRoomId}`);
                        return;
                    }

                    ws.send(
                        JSON.stringify({
                            type: "get_task_data_response",
                            payload: {
                                roomId: wsRoomId,
                                taskDescriptionPath:
                                    roomData.taskDescriptionPath,
                                learningGoalsPath: roomData.learningGoalsPath,
                            },
                        })
                    );

                    console.log(`Sent task data for room: ${wsRoomId}`);
                    break;

                case "get_simple_id_request": {
                    // Assign a new simpleID to the client in the specified room
                    await modifyRoomData(wsRoomId, (roomData) => {
                        const newSimpleID = roomData.simpleIDCounter++;
                        roomData.simpleIDtoClientIDMap[newSimpleID] = clientID;

                        ws.send(
                            JSON.stringify({
                                type: "get_simple_id_response",
                                payload: {
                                    roomId: wsRoomId,
                                    newSimpleID,
                                    taskDescriptionPath:
                                        roomData.taskDescriptionPath,
                                    learningGoalsPath:
                                        roomData.learningGoalsPath,
                                },
                            })
                        );

                        console.log(
                            `Assigned new simpleID ${newSimpleID} to ${clientID} in room ${wsRoomId}`
                        );
                    });

                    sendAccessLists(wsRoomId);
                    break;
                }

                case "register_client_request":
                    // Register client with simpleID and clientID in the specified room
                    // Delete old clientID from the access list
                    await modifyRoomData(wsRoomId, (roomData) => {
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
                                type: "register_client_response",
                                payload: {
                                    roomId: wsRoomId,
                                    taskDescriptionPath:
                                        roomData.taskDescriptionPath,
                                    learningGoalsPath:
                                        roomData.learningGoalsPath,
                                },
                            })
                        );

                        console.log(
                            `Registered client with simpleID: ${simpleID} and clientID: ${clientID} in room: ${wsRoomId}`
                        );
                    });

                    sendAccessLists(wsRoomId);
                    break;

                case "grant_access_request":
                    // Check if access should be granted for all clients
                    await modifyRoomData(wsRoomId, (roomData) => {
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
                                    type: "grant_access_response",
                                    payload: {
                                        roomId: wsRoomId,
                                        simpleID: Array.from(
                                            roomData.accessListSimpleID
                                        ),
                                    },
                                })
                            );
                            console.log(
                                `Granted access for all clients in room: ${wsRoomId}`
                            );
                        } else {
                            // Check if the simpleID is valid
                            if (
                                !roomData.simpleIDtoClientIDMap[targetSimpleID]
                            ) {
                                console.log(
                                    `SimpleID ${targetSimpleID} not found in room ${wsRoomId}`
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
                                    type: "grant_access_response",
                                    payload: {
                                        roomId: wsRoomId,
                                        simpleID: targetSimpleID,
                                    },
                                })
                            );
                            console.log(
                                `Granted access to simpleID: ${targetSimpleID} in room: ${wsRoomId}`
                            );
                        }
                    });

                    sendAccessLists(wsRoomId);
                    break;

                case "revoke_access_request":
                    // Check if access should be revoked for all clients
                    await modifyRoomData(wsRoomId, (roomData) => {
                        if (targetSimpleID === null) {
                            roomData.accessListSimpleID.clear();
                            roomData.accessListClientID.clear();
                            ws.send(
                                JSON.stringify({
                                    type: "revoke_access_response",
                                    payload: {
                                        roomId: wsRoomId,
                                        simpleID: null,
                                    },
                                })
                            );
                            console.log(
                                `Revoked access for all clients in room: ${wsRoomId}`
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
                                    type: "revoke_access_response",
                                    payload: {
                                        roomId: wsRoomId,
                                        simpleID: targetSimpleID,
                                    },
                                })
                            );
                            console.log(
                                `Revoked access for simpleID: ${targetSimpleID} in room: ${wsRoomId}`
                            );
                        }
                    });

                    sendAccessLists(wsRoomId);
                    break;

                case "set_instructor_file_request":
                    // Set the current instructor file for the specified room
                    await modifyRoomData(wsRoomId, (roomData) => {
                        roomData.instructorFile = instructorFile;
                    });
                    console.log(
                        `Updated instructor file for room: ${wsRoomId}`
                    );
                    break;

                case "get_instructor_file_request":
                    // Send the current instructor file to the client
                    await modifyRoomData(wsRoomId, (roomData) => {
                        const instructorFile = roomData.instructorFile;
                        ws.send(
                            JSON.stringify({
                                type: "get_instructor_file_response",
                                payload: {
                                    roomId: wsRoomId,
                                    instructorFileServer: instructorFile,
                                },
                            })
                        );
                    });

                    break;

                case "open_terminal_request":
                    roomBroadcast(wsRoomId, {
                        type: "open_terminal_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent terminal opened message to room:",
                        wsRoomId
                    );
                    break;

                case "close_terminal_request":
                    roomBroadcast(wsRoomId, {
                        type: "close_terminal_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent terminal closed message to room:",
                        wsRoomId
                    );
                    break;

                case "open_explorer_request":
                    roomBroadcast(wsRoomId, {
                        type: "open_explorer_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent explorer opened message to room:",
                        wsRoomId
                    );
                    break;

                case "close_explorer_request":
                    roomBroadcast(wsRoomId, {
                        type: "close_explorer_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent explorer closed message to room:",
                        wsRoomId
                    );
                    break;

                case "show_room_id_request":
                    roomBroadcast(wsRoomId, {
                        type: "show_room_id_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent show room ID message to room:",
                        wsRoomId
                    );
                    break;

                case "hide_room_id_request":
                    roomBroadcast(wsRoomId, {
                        type: "hide_room_id_response",
                        payload: { roomId: wsRoomId },
                    });
                    console.log(
                        "Sent hide room ID message to room:",
                        wsRoomId
                    );
                    break;

                case "change_font_size_request":
                    roomBroadcast(wsRoomId, {
                        type: "change_font_size_response",
                        payload: {
                            roomId: wsRoomId,
                            increase,
                        },
                    });
                    console.log(
                        "Sent font size change message to room:",
                        wsRoomId
                    );
                    break;

                case "change_theme_request":
                    roomBroadcast(wsRoomId, {
                        type: "change_theme_response",
                        payload: { roomId: wsRoomId, changedTheme },
                    });
                    console.log(
                        "Sent theme change message to room:",
                        wsRoomId
                    );
                    break;

                default:
                    // Ignore unknown message types
                    break;
            }
        } catch (error) {
            console.error(error);
        }
    });

    ws.on("close", async () => {
        console.log(`Client disconnected from room: ${roomId}`);

        await modifyRoomData(roomId, (roomData) => {
            roomData.clients.delete(ws);
        });

        cleanUpRoomCache();
    });

    // FIXME: Use error handling, maybe also remove it from the clients list of the room data
    ws.on("error", console.error);
});

/**
 * Broadcast a message to all clients in a room
 */
async function roomBroadcast(roomId: string, message: object) {
    const roomData = await getRoomData(roomId);
    if (!roomData) {
        console.log(`Room not found: ${roomId}`);
        return;
    }

    roomData.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

/**
 * Sends the access list to all clients in the room
 */
async function sendAccessLists(roomId: string) {
    const roomData = await getRoomData(roomId);
    if (!roomData) {
        console.log(`Room not found: ${roomId}`);
        return;
    }

    const accessListSimpleIDAsArray = Array.from(roomData.accessListSimpleID);
    const accessListClientIDAsArray = Array.from(roomData.accessListClientID);

    roomBroadcast(roomId, {
        type: "access_list_response",
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

// API route to create a new session (used by the VS Code extension)
app.post("/api/create-session", async (req, res) => {
    const { roomId, password, taskDescriptionPath, learningGoalsPath } =
        req.body;

    if (!roomId || !password) {
        res.status(400).json({
            success: false,
            message: "roomId and password are required",
        });
        return;
    }

    try {
        // Check if the room already exists
        const existingRoom = await fetchRoomData(roomId);
        if (existingRoom) {
            res.status(409).json({
                success: false,
                message: "Room already exists",
            });
            return;
        }

        // Create the room with password hash
        const salt = generateSalt(16);
        const passwordHash = await hashPassword(password, salt);

        await modifyRoomData(roomId, (roomData) => {
            roomData.salt = salt;
            roomData.passwordHash = passwordHash;
            roomData.taskDescriptionPath = taskDescriptionPath || "";
            roomData.learningGoalsPath = learningGoalsPath || "";
        });

        const token = createToken(roomId, "instructor");

        res.status(200).json({ success: true, token });
    } catch (error) {
        console.error(
            `Error creating session for roomId: ${roomId}`,
            error
        );
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
});

// API route to verify if a password is correct
app.post("/api/verify-password", passwordRateLimit, async (req, res) => {
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
                const token = createToken(roomId, "instructor");
                res.status(200).json({ success: true, token });
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

// API route to verify if a room exists
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
                const token = createToken(roomId, "student");
                res.status(200).json({ success: true, token });
            } else {
                res.status(401).json({
                    success: false,
                    message: "Room not found",
                });
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

// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// Start the server
const PORT = process.env.PORT;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
