import express, { Request, Response } from "express";
import { createServer } from "http";
import cors from "cors";
import { WebSocketServer } from "ws";
const setupWSConnection = require("y-websocket/bin/utils").setupWSConnection;

/**
 * CORSConfiguration
 */
export const allowedOrigins = ["http://localhost:5173"];

/**
 * Server INITIALIZATION and CONFIGURATION
 * CORS configuration
 * Request body parsing
 */
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

/**
 * Create an http server
 */
const httpServer = app.listen(1234, () => {
    console.log(`Server is listening on port 1234`);
});

/**
 * Create a wss (Web Socket Secure) server
 */
export const wss = new WebSocketServer({ server: httpServer });

/**
 * On connection, use the utility file provided by y-websocket
 */
wss.on("connection", (ws, req) => {
    setupWSConnection(ws, req);
});
