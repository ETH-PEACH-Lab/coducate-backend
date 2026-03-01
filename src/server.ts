import express from "express";
import cors from "cors";
import crypto from "crypto";
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import dotenv from "dotenv";
const { setupWSConnection, docs: yjsDocs } = require("y-websocket/bin/utils");
import {
    getRoom,
    createRoom,
    updateRoom,
    endRoom,
    reactivateRoom,
    softDeleteRoom,
    isRoomActive,
    cleanupStaleRooms,
    validatePassword,
    hashPassword,
    generateSalt,
    getClientMap,
    upsertClient,
    getAccessList,
    grantAccess,
    grantAccessAll,
    revokeAccess,
    revokeAccessAll,
    validateClientSecret,
} from "./rooms";
import { createToken, verifyToken } from "./auth";
import rateLimit from "express-rate-limit";
import { z } from "zod";

// Load environment variables from .env file
dotenv.config();

const app = express();

// CORS — restrict to the production frontend origin and localhost for development
const allowedOrigins = [
    "https://coducate.live",
    "https://www.coducate.live",
    "http://localhost:5173",
    "http://localhost:3000",
];
app.use(
    cors({
        origin: (origin, callback) => {
            // Allow requests with no origin (e.g., server-to-server, curl, VS Code extension)
            if (!origin || allowedOrigins.includes(origin)) {
                callback(null, true);
            } else {
                callback(new Error("Not allowed by CORS"));
            }
        },
    })
);

// Body size limit — 1MB max for JSON payloads
app.use(express.json({ limit: "1mb" }));

// Rate limiter for password verification — 10 attempts per 15 minutes per IP
const passwordRateLimit = rateLimit({
    windowMs: 2 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many password attempts. Please try again later.",
    },
});

// Rate limiter for room verification — 30 attempts per 15 minutes per IP
const verifyRoomRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        message: "Too many requests. Please try again later.",
    },
});

// ── Zod validation schemas ──

const roomIdSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Room ID must only contain letters, numbers, hyphens, and underscores"
    );

const createSessionSchema = z.object({
    roomId: roomIdSchema,
    password: z.string().min(1).max(256),
    taskDescriptionPath: z.string().max(500).optional(),
    learningGoalsPath: z.string().max(500).optional(),
});

const verifyPasswordSchema = z.object({
    roomId: roomIdSchema,
    password: z.string().min(1).max(256),
});

const verifyRoomSchema = z.object({
    roomId: roomIdSchema,
});

const wsMessageSchema = z.object({
    type: z.string().min(1).max(100),
    payload: z.object({
        roomId: z.string().max(100).optional(),
        simpleID: z.number().int().nonnegative().optional().nullable(),
        clientID: z.number().int().nonnegative().optional().nullable(),
        targetSimpleID: z.number().int().nonnegative().optional().nullable(),
        instructorFile: z.string().max(1000).optional(),
        password: z.string().max(256).optional(),
        taskDescriptionPath: z.string().max(500).optional(),
        learningGoalsPath: z.string().max(500).optional(),
        increase: z.boolean().optional(),
        changedTheme: z.string().max(50).optional(),
        clientSecret: z.string().max(128).optional(),
    }),
});

// Create an HTTP server and attach Express
const server = createServer(app);

// WebSocket server for Yjs (1MB max message size)
const wssYjs = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

// WebSocket server for custom messages (64KB max — control messages are small)
const wssCustom = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

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
    "end_session_request",
]);

// Both WebSocket servers share the same HTTP server
server.on("upgrade", async (request, socket, head) => {
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

    // Check if the room is still active before allowing WebSocket connections
    const roomId = tokenPayload.roomId;
    const room = await getRoom(roomId);
    if (!room || room.status === "ended") {
        socket.write("HTTP/1.1 410 Gone\r\n\r\n");
        socket.destroy();
        return;
    }

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
    setupWSConnection(ws, req);
});

// Handle custom WebSocket connections
wssCustom.on("connection", async (ws, req) => {
    const tokenPayload = (req as any).tokenPayload;
    const roomId = tokenPayload.roomId;
    const role = tokenPayload.role;

    // Attach role and roomId to the WebSocket for message authorization and broadcasting
    (ws as any).role = role;
    (ws as any).roomId = roomId;

    console.log(`Client connected to room: ${roomId} (role: ${role})`);

    // Update last_active_at on instructor connection
    if (role === "instructor") {
        updateRoom(roomId, {}).catch(() => {});
    }

    ws.on("message", async (message) => {
        try {
            const raw = JSON.parse(message.toString());
            const parsed = wsMessageSchema.safeParse(raw);
            if (!parsed.success) {
                ws.send(
                    JSON.stringify({
                        type: "error",
                        payload: { message: "Invalid message format" },
                    })
                );
                return;
            }

            const { type, payload } = parsed.data;
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
                case "set_session_data_request": {
                    if (!password) {
                        console.log("Invalid setRoomPassword payload.");
                        return;
                    }

                    const salt = generateSalt(16);
                    const passwordHash = await hashPassword(password, salt);

                    await updateRoom(wsRoomId, {
                        salt,
                        password_hash: passwordHash,
                        task_description_path: taskDescriptionPath || "",
                        learning_goals_path: learningGoalsPath || "",
                    });

                    ws.send(
                        JSON.stringify({
                            type: "set_session_data_response",
                            payload: { roomId: wsRoomId },
                        })
                    );

                    console.log(`Set session data for room: ${wsRoomId}`);
                    break;
                }

                case "get_task_data_request": {
                    const room = await getRoom(wsRoomId);
                    if (!room) {
                        console.log(`Room not found: ${wsRoomId}`);
                        return;
                    }

                    ws.send(
                        JSON.stringify({
                            type: "get_task_data_response",
                            payload: {
                                roomId: wsRoomId,
                                taskDescriptionPath: room.task_description_path,
                                learningGoalsPath: room.learning_goals_path,
                            },
                        })
                    );

                    console.log(`Sent task data for room: ${wsRoomId}`);
                    break;
                }

                case "get_simple_id_request": {
                    if (clientID == null) return;

                    const room = await getRoom(wsRoomId);
                    if (!room) {
                        console.log(`Room not found: ${wsRoomId}`);
                        return;
                    }

                    const newSimpleID = room.simple_id_counter;
                    const clientSecret = crypto.randomBytes(32).toString("hex");

                    await upsertClient(wsRoomId, newSimpleID, clientID, clientSecret);
                    await updateRoom(wsRoomId, {
                        simple_id_counter: newSimpleID + 1,
                    });

                    ws.send(
                        JSON.stringify({
                            type: "get_simple_id_response",
                            payload: {
                                roomId: wsRoomId,
                                newSimpleID,
                                clientSecret,
                                taskDescriptionPath: room.task_description_path,
                                learningGoalsPath: room.learning_goals_path,
                            },
                        })
                    );

                    console.log(
                        `Assigned new simpleID ${newSimpleID} to ${clientID} in room ${wsRoomId}`
                    );

                    sendAccessLists(wsRoomId);
                    break;
                }

                case "register_client_request": {
                    if (simpleID == null || clientID == null) return;

                    const clientSecret = payload.clientSecret;
                    if (!clientSecret) {
                        ws.send(
                            JSON.stringify({
                                type: "register_client_response",
                                payload: {
                                    roomId: wsRoomId,
                                    error: "Client secret is required",
                                },
                            })
                        );
                        return;
                    }

                    const room = await getRoom(wsRoomId);
                    if (!room) {
                        console.log(`Room not found: ${wsRoomId}`);
                        return;
                    }

                    const isValid = await validateClientSecret(wsRoomId, simpleID, clientSecret);
                    if (!isValid) {
                        ws.send(
                            JSON.stringify({
                                type: "register_client_response",
                                payload: {
                                    roomId: wsRoomId,
                                    error: "Invalid client secret",
                                },
                            })
                        );
                        console.log(
                            `Rejected register_client_request: invalid secret for simpleID ${simpleID} in room ${wsRoomId}`
                        );
                        return;
                    }

                    await upsertClient(wsRoomId, simpleID, clientID);

                    ws.send(
                        JSON.stringify({
                            type: "register_client_response",
                            payload: {
                                roomId: wsRoomId,
                                taskDescriptionPath: room.task_description_path,
                                learningGoalsPath: room.learning_goals_path,
                            },
                        })
                    );

                    console.log(
                        `Registered client with simpleID: ${simpleID} and clientID: ${clientID} in room: ${wsRoomId}`
                    );

                    sendAccessLists(wsRoomId);
                    break;
                }

                case "grant_access_request": {
                    if (targetSimpleID === null || targetSimpleID === undefined) {
                        // Grant access to all
                        await grantAccessAll(wsRoomId);

                        const allAccess = await getAccessList(wsRoomId);
                        ws.send(
                            JSON.stringify({
                                type: "grant_access_response",
                                payload: {
                                    roomId: wsRoomId,
                                    simpleID: allAccess,
                                },
                            })
                        );
                        console.log(
                            `Granted access for all clients in room: ${wsRoomId}`
                        );
                    } else {
                        // Validate the simpleID exists
                        const map = await getClientMap(wsRoomId);
                        if (map[targetSimpleID] === undefined) {
                            console.log(
                                `SimpleID ${targetSimpleID} not found in room ${wsRoomId}`
                            );
                            return;
                        }

                        await grantAccess(wsRoomId, Number(targetSimpleID));

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

                    sendAccessLists(wsRoomId);
                    break;
                }

                case "revoke_access_request": {
                    if (targetSimpleID === null || targetSimpleID === undefined) {
                        // Revoke all
                        await revokeAccessAll(wsRoomId);
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
                        // Revoke a single simpleID
                        await revokeAccess(
                            wsRoomId,
                            Number(targetSimpleID)
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

                    sendAccessLists(wsRoomId);
                    break;
                }

                case "set_instructor_file_request":
                    await updateRoom(wsRoomId, {
                        instructor_file: instructorFile,
                    });
                    console.log(
                        `Updated instructor file for room: ${wsRoomId}`
                    );
                    break;

                case "get_instructor_file_request": {
                    const room = await getRoom(wsRoomId);
                    if (!room) {
                        console.log(`Room not found: ${wsRoomId}`);
                        return;
                    }

                    ws.send(
                        JSON.stringify({
                            type: "get_instructor_file_response",
                            payload: {
                                roomId: wsRoomId,
                                instructorFileServer: room.instructor_file,
                            },
                        })
                    );
                    break;
                }

                case "open_terminal_request":
                    roomBroadcast(wsRoomId, {
                        type: "open_terminal_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "close_terminal_request":
                    roomBroadcast(wsRoomId, {
                        type: "close_terminal_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "open_explorer_request":
                    roomBroadcast(wsRoomId, {
                        type: "open_explorer_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "close_explorer_request":
                    roomBroadcast(wsRoomId, {
                        type: "close_explorer_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "show_room_id_request":
                    roomBroadcast(wsRoomId, {
                        type: "show_room_id_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "hide_room_id_request":
                    roomBroadcast(wsRoomId, {
                        type: "hide_room_id_response",
                        payload: { roomId: wsRoomId },
                    });
                    break;

                case "change_font_size_request":
                    roomBroadcast(wsRoomId, {
                        type: "change_font_size_response",
                        payload: { roomId: wsRoomId, increase },
                    });
                    break;

                case "change_theme_request":
                    roomBroadcast(wsRoomId, {
                        type: "change_theme_response",
                        payload: { roomId: wsRoomId, changedTheme },
                    });
                    break;

                case "end_session_request": {
                    await endRoom(wsRoomId);

                    roomBroadcast(wsRoomId, {
                        type: "session_ended",
                        payload: { roomId: wsRoomId },
                    });

                    console.log(`Session ended for room: ${wsRoomId}`);

                    // Clean up the Yjs document from memory after a short delay
                    // (gives clients time to disconnect gracefully after receiving session_ended)
                    setTimeout(() => {
                        const docName = "yjs/" + wsRoomId;
                        if (yjsDocs.has(docName)) {
                            yjsDocs.delete(docName);
                            console.log(
                                `Cleaned up Yjs document for room: ${wsRoomId}`
                            );
                        }
                    }, 5000);

                    break;
                }

                default:
                    break;
            }
        } catch (error) {
            console.error(error);
        }
    });

    ws.on("close", () => {
        console.log(`Client disconnected from room: ${roomId}`);
    });

    ws.on("error", console.error);
});

/**
 * Broadcast a message to all clients in a room using wssCustom.clients.
 */
function roomBroadcast(roomId: string, message: object) {
    const data = JSON.stringify(message);
    wssCustom.clients.forEach((client) => {
        if (
            (client as any).roomId === roomId &&
            client.readyState === WebSocket.OPEN
        ) {
            client.send(data);
        }
    });
}

/**
 * Sends the access list to all clients in the room.
 */
async function sendAccessLists(roomId: string) {
    const [accessListSimpleID, simpleIDtoClientIDMap] = await Promise.all([
        getAccessList(roomId),
        getClientMap(roomId),
    ]);

    roomBroadcast(roomId, {
        type: "access_list_response",
        payload: {
            roomId,
            accessListSimpleIDAsArray: accessListSimpleID,
            simpleIDtoClientIDMap,
        },
    });
}

// API route to create a new session (used by the VS Code extension)
app.post("/api/create-session", async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            message: parsed.error.issues[0]?.message || "Invalid input",
        });
        return;
    }

    const { roomId, password, taskDescriptionPath, learningGoalsPath } =
        parsed.data;

    try {
        const existingRoom = await getRoom(roomId);
        if (existingRoom) {
            res.status(409).json({
                success: false,
                message: "Room already exists",
            });
            return;
        }

        const salt = generateSalt(16);
        const passwordHash = await hashPassword(password, salt);

        await createRoom(roomId, {
            passwordHash,
            salt,
            taskDescriptionPath: taskDescriptionPath || "",
            learningGoalsPath: learningGoalsPath || "",
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
    const parsed = verifyPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            message: parsed.error.issues[0]?.message || "Invalid input",
        });
        return;
    }

    const { password, roomId } = parsed.data;

    try {
        const room = await getRoom(roomId);
        if (!room) {
            res.status(404).json({
                success: false,
                message: "Room not found",
            });
            return;
        }

        const isValidPassword = await validatePassword(
            password,
            room.password_hash,
            room.salt
        );

        if (isValidPassword) {
            // Only reactivate ended rooms when the VS Code extension rejoins
            if (room.status === "ended" || room.status === "deleted") {
                const source = req.headers["x-coducate-source"];
                if (source === "vscode") {
                    await reactivateRoom(roomId);
                } else {
                    res.status(410).json({
                        success: false,
                        message: "This session has ended.",
                        ended: true,
                    });
                    return;
                }
            }

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

// API route to verify if a room exists
app.post("/api/verify-room", verifyRoomRateLimit, async (req, res) => {
    const parsed = verifyRoomSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            message: parsed.error.issues[0]?.message || "Invalid input",
        });
        return;
    }

    const { roomId } = parsed.data;

    try {
        const room = await getRoom(roomId);

        if (!room) {
            res.status(401).json({
                success: false,
                message: "Room not found",
            });
            return;
        }

        if (room.status === "ended" || room.status === "deleted") {
            res.status(410).json({
                success: false,
                message: "This session has ended.",
                ended: true,
            });
            return;
        }

        const token = createToken(roomId, "student");
        res.status(200).json({ success: true, token });
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

// API route to soft-delete a session (marks for backend cleanup)
app.post("/api/delete-session", passwordRateLimit, async (req, res) => {
    const parsed = verifyPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            message: parsed.error.issues[0]?.message || "Invalid input",
        });
        return;
    }

    const { password, roomId } = parsed.data;

    try {
        const room = await getRoom(roomId);
        if (!room) {
            // Room already deleted or never existed — treat as success
            res.status(200).json({ success: true });
            return;
        }

        const isValidPassword = await validatePassword(
            password,
            room.password_hash,
            room.salt
        );

        if (isValidPassword) {
            await softDeleteRoom(roomId);
            res.status(200).json({ success: true });
        } else {
            res.status(401).json({
                success: false,
                message: "Invalid password",
            });
        }
    } catch (error) {
        console.error(
            `Error deleting session for roomId: ${roomId}`,
            error
        );
        res.status(500).json({
            success: false,
            message: "Internal server error",
        });
    }
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// Start the server
const PORT = process.env.PORT;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);

    // Clean up stale rooms on startup
    cleanupStaleRooms().then((count) => {
        if (count > 0) console.log(`Cleaned up ${count} stale room(s).`);
    });

    // Clean up stale rooms every 24 hours
    setInterval(() => {
        cleanupStaleRooms().then((count) => {
            if (count > 0) console.log(`Cleaned up ${count} stale room(s).`);
        });
    }, 24 * 60 * 60 * 1000);
});
