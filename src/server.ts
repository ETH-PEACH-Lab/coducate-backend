import express from "express";
import cors from "cors";
import { WebSocketServer, WebSocket } from "ws";
const setupWSConnection = require("y-websocket/bin/utils").setupWSConnection;

// CORS Configuration
export const allowedOrigins = ["http://localhost:5173"];

const app = express();
app.use(
    cors({
        origin: allowedOrigins,
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
        controlWebSocketServer.handleUpgrade(request, socket, head, (ws) => {
            controlWebSocketServer.emit("connection", ws, request);
        });
    } else {
        // If path is not recognized, destroy the socket
        socket.destroy();
    }
});

// In-memory storage
interface RoomData {
    simpleIDCounter: number;
    simpleIDtoClientIDMap: Record<number, number>;
    accessListSimpleID: Set<number>;
    accessListClientID: Set<number>;
    instructorSimpleID: number | null;
    instructorFile: string;
    passwordHash: string;
    salt: string;
}
const rooms: Record<string, RoomData> = {};

/**
 * Helper function to get or initialize room data
 */
function getRoomData(roomId: string): RoomData {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            simpleIDCounter: 1,
            simpleIDtoClientIDMap: {},
            accessListSimpleID: new Set<number>(),
            accessListClientID: new Set<number>(),
            instructorSimpleID: null,
            instructorFile: "",
            passwordHash: "",
            salt: "",
        };
    }
    return rooms[roomId];
}

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
function sendAccessLists(roomId: string) {
    const roomData = getRoomData(roomId);
    const accessListSimpleIDAsArray = Array.from(roomData.accessListSimpleID);
    const accessListClientIDAsArray = Array.from(roomData.accessListClientID);

    console.log("Sending access list", accessListSimpleIDAsArray);
    console.log("Sending access list", accessListClientIDAsArray);

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
                increase,
            } = payload;

            // Ensure roomId is in payload for room-specific actions
            if (!roomId || roomId !== roomIdUrl) {
                // Ignore messages without a roomId
                return;
            }

            const roomData = getRoomData(roomId);

            console.log("Received message: ", type, payload);

            switch (type) {
                case "setRoomPassword":
                    if (!password) {
                        console.log("Invalid setRoomPassword payload.");
                        return;
                    }

                    const salt = generateSalt(16);
                    const passwordHash = await hashPassword(password, salt);

                    roomData.salt = salt;
                    roomData.passwordHash = passwordHash;

                    ws.send(
                        JSON.stringify({
                            type: "roomPasswordSetResponse",
                            payload: { roomId },
                        })
                    );

                    console.log(`Password set for room ${roomId}`);
                    break;

                case "requestSimpleID":
                    // Assign a new simpleID to the client in the specified room
                    const newSimpleID = roomData.simpleIDCounter++;
                    roomData.simpleIDtoClientIDMap[Number(newSimpleID)] =
                        Number(clientID);

                    let isValidPassword = false;
                    if (password && roomData.passwordHash && roomData.salt) {
                        isValidPassword = await validatePassword(
                            password,
                            roomData.passwordHash,
                            roomData.salt
                        );

                        if (isValidPassword) {
                            roomData.instructorSimpleID = newSimpleID;
                            console.log("Instructor simpleID", newSimpleID);
                        }
                    }

                    ws.send(
                        JSON.stringify({
                            type: "assignSimpleID",
                            payload: {
                                roomId,
                                newSimpleID,
                                isClientInstructor: isValidPassword,
                            },
                        })
                    );
                    console.log(
                        `Assigned new simpleID ${newSimpleID} to ${clientID} in room ${roomId}`
                    );
                    sendAccessLists(roomId);
                    break;

                case "registerClient":
                    // Register client with simpleID and clientID in the specified room
                    // Delete old clientID from access list
                    roomData.accessListClientID.delete(
                        Number(roomData.simpleIDtoClientIDMap[Number(simpleID)])
                    );
                    // If the simpleID is in the access list, add the new clientID
                    if (roomData.accessListSimpleID.has(Number(simpleID))) {
                        roomData.accessListClientID.add(Number(clientID));
                        console.log(
                            "Added clientID to access list in registerClient",
                            clientID
                        );
                    }

                    roomData.simpleIDtoClientIDMap[Number(simpleID)] =
                        Number(clientID);
                    console.log(
                        `Registered client with simpleID: ${simpleID} and clientID: ${clientID} in room: ${roomId}`
                    );

                    if (password && roomData.passwordHash && roomData.salt) {
                        const isValidPassword = await validatePassword(
                            password,
                            roomData.passwordHash,
                            roomData.salt
                        );

                        if (isValidPassword) {
                            roomData.instructorSimpleID = simpleID;
                        }

                        ws.send(
                            JSON.stringify({
                                type: "instructorStatus",
                                payload: {
                                    roomId,
                                    isClientInstructor: isValidPassword,
                                },
                            })
                        );
                    }
                    sendAccessLists(roomId);
                    break;

                case "grantAccess":
                    // Grant access to a given simpleID in the specified room
                    roomData.accessListSimpleID.add(Number(targetSimpleID));
                    roomData.accessListClientID.add(
                        Number(
                            roomData.simpleIDtoClientIDMap[
                                Number(targetSimpleID)
                            ]
                        )
                    );

                    console.log(
                        "client ID from Map",
                        roomData.simpleIDtoClientIDMap[targetSimpleID]
                    );
                    ws.send(
                        JSON.stringify({
                            type: "accessGranted",
                            payload: { roomId, simpleID: targetSimpleID },
                        })
                    );
                    console.log(
                        `Granted access to simpleID: ${targetSimpleID} in room: ${roomId}`
                    );
                    sendAccessLists(roomId);
                    break;

                case "revokeAccess":
                    // Revoke access for a given simpleID in the specified room
                    roomData.accessListSimpleID.delete(Number(targetSimpleID));
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
                            payload: { roomId, simpleID: targetSimpleID },
                        })
                    );
                    console.log(
                        `Revoked access for simpleID: ${targetSimpleID} in room: ${roomId}`
                    );
                    sendAccessLists(roomId);
                    break;

                case "setInstructorFile":
                    // Set the current instructor file for the specified room
                    roomData.instructorFile = instructorFile;
                    break;

                case "requestInstructorFile":
                    // Send the current instructor file to the client
                    ws.send(
                        JSON.stringify({
                            type: "instructorFileResponse",
                            payload: {
                                roomId,
                                instructorFileServer: roomData.instructorFile,
                            },
                        })
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

                default:
                    // Ignore unknown message types
                    break;
            }
        } catch {
            // Ignore invalid messages
        }
    });
});
