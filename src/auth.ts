import crypto from "crypto";

// Secret generated at startup — tokens become invalid on server restart
// (acceptable since WebSocket connections are also lost on restart)
const TOKEN_SECRET = crypto.randomBytes(32);

const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

interface TokenPayload {
    roomId: string;
    role: "instructor" | "student";
    exp: number;
}

/**
 * Creates a signed token containing roomId, role, and expiration.
 * Format: base64url(payload).base64url(hmac-sha256-signature)
 */
export function createToken(
    roomId: string,
    role: "instructor" | "student"
): string {
    const payload: TokenPayload = {
        roomId,
        role,
        exp: Date.now() + TOKEN_EXPIRY_MS,
    };

    const payloadStr = Buffer.from(JSON.stringify(payload)).toString(
        "base64url"
    );
    const signature = crypto
        .createHmac("sha256", TOKEN_SECRET)
        .update(payloadStr)
        .digest("base64url");

    return `${payloadStr}.${signature}`;
}

/**
 * Verifies a token's signature and expiration.
 * Returns the decoded payload if valid, or null if invalid/expired.
 */
export function verifyToken(token: string): TokenPayload | null {
    const parts = token.split(".");
    if (parts.length !== 2) {
        return null;
    }

    const [payloadStr, providedSignature] = parts;

    const expectedSignature = crypto
        .createHmac("sha256", TOKEN_SECRET)
        .update(payloadStr)
        .digest("base64url");

    // Constant-time comparison to prevent timing attacks
    const sigBuffer = Buffer.from(providedSignature, "base64url");
    const expectedBuffer = Buffer.from(expectedSignature, "base64url");

    if (
        sigBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
        return null;
    }

    try {
        const payload: TokenPayload = JSON.parse(
            Buffer.from(payloadStr, "base64url").toString("utf-8")
        );

        if (payload.exp < Date.now()) {
            return null;
        }

        if (!payload.roomId || !payload.role) {
            return null;
        }

        return payload;
    } catch {
        return null;
    }
}
