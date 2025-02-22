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

// Load environment variables from .env file
dotenv.config();

const app = express();
app.use(express.json());

// Create an HTTP server and attach Express
const server = createServer(app);

// WebSocket server for Yjs
const wssYjs = new WebSocketServer({ noServer: true });

// WebSocket server for custom messages
const wssCustom = new WebSocketServer({ noServer: true });

// Both WebSocket servers share the same HTTP server
// Requires to check the pathname to determine which websocket server needs to handle the connection
server.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(
        request.url || "/",
        `http://${request.headers.host}`
    );

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
    const roomId = req.url?.split("/")?.pop();

    if (!roomId) {
        console.log("Closing client connection");
        ws.close();
        return;
    }

    console.log(`Client connected to room: ${roomId}`);

    await modifyRoomData(roomId, (roomData) => {
        roomData.clients.add(ws);
    });

    ws.on("message", async (message) => {
        try {
            const { type, payload } = JSON.parse(message.toString());
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
            if (!roomId || roomId !== payload.roomId) {
                // Ignore messages without a roomId
                console.log("Invalid roomId in message payload.");
                return;
            }

            switch (type) {
                case "set_session_data_request":
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
                            type: "set_session_data_response",
                            payload: { roomId },
                        })
                    );

                    console.log(`Set session data for room: ${roomId}`);
                    break;

                case "get_task_data_request":
                    // Send the task description and learning goals to the client
                    const roomData = await fetchRoomData(roomId);
                    if (!roomData) {
                        console.log(`Room not found: ${roomId}`);
                        return;
                    }

                    ws.send(
                        JSON.stringify({
                            type: "get_task_data_response",
                            payload: {
                                roomId,
                                taskDescriptionPath:
                                    roomData.taskDescriptionPath,
                                learningGoalsPath: roomData.learningGoalsPath,
                            },
                        })
                    );

                    console.log(`Sent task data for room: ${roomId}`);
                    break;

                case "get_simple_id_request": {
                    // Assign a new simpleID to the client in the specified room
                    await modifyRoomData(roomId, (roomData) => {
                        const newSimpleID = roomData.simpleIDCounter++;
                        roomData.simpleIDtoClientIDMap[newSimpleID] = clientID;

                        ws.send(
                            JSON.stringify({
                                type: "get_simple_id_response",
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

                case "register_client_request":
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
                                type: "register_client_response",
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

                case "grant_access_request":
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
                                    type: "grant_access_response",
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
                                    type: "grant_access_response",
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

                case "revoke_access_request":
                    // Check if access should be revoked for all clients
                    await modifyRoomData(roomId, (roomData) => {
                        if (targetSimpleID === null) {
                            roomData.accessListSimpleID.clear();
                            roomData.accessListClientID.clear();
                            ws.send(
                                JSON.stringify({
                                    type: "revoke_access_response",
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
                                    type: "revoke_access_response",
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

                case "set_instructor_file_request":
                    // Set the current instructor file for the specified room
                    await modifyRoomData(roomId, (roomData) => {
                        roomData.instructorFile = instructorFile;
                    });
                    console.log(`Updated instructor file for room: ${roomId}`);
                    break;

                case "get_instructor_file_request":
                    // Send the current instructor file to the client
                    await modifyRoomData(roomId, (roomData) => {
                        const instructorFile = roomData.instructorFile;
                        ws.send(
                            JSON.stringify({
                                type: "get_instructor_file_response",
                                payload: {
                                    roomId,
                                    instructorFileServer: instructorFile,
                                },
                            })
                        );
                    });

                    break;

                case "open_terminal_request":
                    // Notify the clients in the room to open the terminal
                    roomBroadcast(roomId, {
                        type: "open_terminal_response",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent terminal opened message to room:",
                        roomId
                    );
                    break;

                case "close_terminal_request":
                    // Notify the clients in the room to close the terminal
                    roomBroadcast(roomId, {
                        type: "close_terminal_response",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent terminal closed message to room:",
                        roomId
                    );
                    break;

                case "open_explorer_request":
                    // Notify the clients in the room to open the explorer
                    roomBroadcast(roomId, {
                        type: "open_explorer_response",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent explorer opened message to room:",
                        roomId
                    );
                    break;

                case "close_explorer_request":
                    // Notify the clients in the room to close the explorer
                    roomBroadcast(roomId, {
                        type: "close_explorer_response",
                        payload: { roomId },
                    });
                    console.log(
                        "Sent explorer closed message to room:",
                        roomId
                    );
                    break;

                case "show_room_id_request":
                    // Notify the clients in the room to show the room ID
                    roomBroadcast(roomId, {
                        type: "show_room_id_response",
                        payload: { roomId },
                    });
                    console.log("Sent show room ID message to room:", roomId);
                    break;

                case "hide_room_id_request":
                    // Notify the clients in the room to hide the room ID
                    roomBroadcast(roomId, {
                        type: "hide_room_id_response",
                        payload: { roomId },
                    });
                    console.log("Sent hide room ID message to room:", roomId);
                    break;

                case "change_font_size_request":
                    // Notify the clients in the room to change the font size
                    roomBroadcast(roomId, {
                        type: "change_font_size_response",
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

                case "change_theme_request":
                    // Notify the clients in the room to change the theme
                    roomBroadcast(roomId, {
                        type: "change_theme_response",
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

// API route to verify if a password is correct
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
                res.status(200).json({ success: true });
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

// Start the server
const PORT = process.env.PORT || 1234;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
