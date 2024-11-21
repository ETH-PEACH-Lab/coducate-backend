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
    instructorFile: string;
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
            instructorFile: "",
        };
    }
    return rooms[roomId];
}

/**
 * Helper function to send accessLists to all clients in a room
 */
function sendAccessLists(roomId: string) {
    const roomData = getRoomData(roomId);
    const accessListSimpleIDAsArray = Array.from(roomData.accessListSimpleID);
    const accessListClientIDAsArray = Array.from(roomData.accessListClientID);

    console.log("Sending access list", accessListSimpleIDAsArray);
    console.log("Sending access list", accessListClientIDAsArray);

    controlWebSocketServer.clients.forEach((client) => {
        client.send(
            JSON.stringify({
                type: "accessListResponse",
                payload: {
                    roomId,
                    accessListSimpleIDAsArray,
                    accessListClientIDAsArray,
                },
            })
        );
    });
    console.log(
        `Sent access list for room: ${roomId} with simpleIDs: ${accessListSimpleIDAsArray}`
    );
}

// Yjs WebSocket connection setup
yWebSocketServer.on("connection", (ws, request) => {
    setupWSConnection(ws, request); // Setup Yjs connection
});

// Control WebSocket connection setup
controlWebSocketServer.on("connection", (ws: WebSocket) => {
    ws.on("message", (message: string) => {
        try {
            const { type, payload } = JSON.parse(message);
            const {
                roomId,
                simpleID,
                clientID,
                targetSimpleID,
                instructorFile,
                increase,
            } = payload;

            if (!roomId) {
                // Ignore messages without a roomId
                return;
            }
            const roomData = getRoomData(roomId);

            console.log("Received message: ", type, payload);

            switch (type) {
                case "requestSimpleID":
                    // Assign a new simpleID to the client in the specified room
                    const newSimpleID = roomData.simpleIDCounter++;
                    roomData.simpleIDtoClientIDMap[Number(newSimpleID)] =
                        Number(clientID);
                    ws.send(
                        JSON.stringify({
                            type: "assignSimpleID",
                            payload: { roomId, newSimpleID },
                        })
                    );
                    console.log(
                        `Assigned new simpleID: ${newSimpleID} in room: ${roomId}`
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
                                instructorFile: roomData.instructorFile,
                            },
                        })
                    );
                    break;

                case "requestTerminalOpen":
                    // Notify the clients to open the terminal
                    controlWebSocketServer.clients.forEach((client) => {
                        client.send(
                            JSON.stringify({
                                type: "terminalOpened",
                                payload: { roomId },
                            })
                        );
                    });
                    console.log("Sent terminal opened message");
                    break;

                case "requestTerminalClose":
                    // Notify the clients to close the terminal
                    controlWebSocketServer.clients.forEach((client) => {
                        client.send(
                            JSON.stringify({
                                type: "terminalClosed",
                                payload: { roomId },
                            })
                        );
                    });
                    console.log("Sent terminal closed message");
                    break;

                case "requestFontSizeChange":
                    // Notify the clients to change the font size
                    controlWebSocketServer.clients.forEach((client) => {
                        client.send(
                            JSON.stringify({
                                type: "fontSizeChanged",
                                payload: {
                                    roomId,
                                    targetSimpleID: 1,
                                    increase,
                                },
                            })
                        );
                    });
                    console.log("Sent font size change message");
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
