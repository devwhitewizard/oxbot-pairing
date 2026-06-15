import express from 'express';
import fs from 'fs';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { delay } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { pairingSessions } from './sessionStore.js';

const router = express.Router();

// Function to remove files or directories
function removeFile(FilePath) {
    try {
        if (!fs.existsSync(FilePath)) return false;
        fs.rmSync(FilePath, { recursive: true, force: true });
        return true;
    } catch (e) {
        console.error('Error removing file:', e);
        return false;
    }
}

router.get('/', async (req, res) => {
    // Generate unique session for each request to avoid conflicts
    const sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
    const dirs = `./qr_sessions/session_${sessionId}`;

    // Ensure qr_sessions directory exists
    if (!fs.existsSync('./qr_sessions')) {
        fs.mkdirSync('./qr_sessions', { recursive: true });
    }

    // Initialize session state
    pairingSessions.set(sessionId, {
        status: 'pending',
        qr: null,
        sessionID: null,
        error: null,
        sock: null,
        _ts: Date.now()
    });

    const sessionStoreEntry = pairingSessions.get(sessionId);

    // Start socket initialization in the background
    initiateSession(sessionId, dirs, sessionStoreEntry).catch(err => {
        console.error('Background socket connection error:', err);
    });

    // Send the session ID immediately to the client so they can start polling
    res.send({ success: true, id: sessionId });
});

async function initiateSession(sessionId, dirs, sessionStoreEntry) {
    // Ensure the session folder exists
    if (!fs.existsSync(dirs)) fs.mkdirSync(dirs, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(dirs);

    try {
        const { version } = await fetchLatestBaileysVersion();
        
        let isLinked = false;

        // QR Code handling logic
        const handleQRCode = async (qr) => {
            try {
                // Generate QR code as data URL
                const qrDataURL = await QRCode.toDataURL(qr, {
                    errorCorrectionLevel: 'M',
                    type: 'image/png',
                    quality: 0.92,
                    margin: 1,
                    color: {
                        dark: '#000000',
                        light: '#FFFFFF'
                    }
                });

                sessionStoreEntry.status = 'qr_ready';
                sessionStoreEntry.qr = qrDataURL;
            } catch (qrError) {
                console.error('Error generating QR code:', qrError);
            }
        };

        // Socket configuration
        const socketConfig = {
            version,
            logger: pino({ level: 'silent' }),
            browser: Browsers.windows('Chrome'),
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
            },
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: false,
            defaultQueryTimeoutMs: 60000,
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            retryRequestDelayMs: 250,
            maxRetries: 5,
        };

        // Create socket
        let sock = makeWASocket(socketConfig);
        sessionStoreEntry.sock = sock;

        let reconnectAttempts = 0;
        const maxReconnectAttempts = 3;

        // Connection event handler function
        const handleConnectionUpdate = async (update) => {
            const { connection, lastDisconnect, qr } = update;
            console.log(`🔄 Connection update: ${connection || 'undefined'}`);

            if (qr) {
                await handleQRCode(qr);
            }

            if (connection === 'open') {
                console.log('✅ Connected successfully!');
                console.log('💾 Session saved to:', dirs);
                reconnectAttempts = 0;
                isLinked = true;
                
                try {
                    // Get the user's JID from the session
                    const userJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
                        
                    if (userJid) {
                        // Wait for saveCreds() to flush the full creds (including 'me' field) to disk
                        // before reading — without this delay, creds.json may be missing 'me',
                        // causing the dashboard to reject it with "Session incomplete".
                        await delay(3000);
                        const sessionContent = fs.readFileSync(dirs + '/creds.json', 'utf8');
                        const b64 = Buffer.from(sessionContent).toString('base64');
                        const waNumber = userJid.split('@')[0].split(':')[0];
                        const sessionName = 'oxbot_' + waNumber;
                        const fullSession = sessionName + '::::' + b64;

                        // Save the generated session to session store
                        sessionStoreEntry.status = 'linked';
                        sessionStoreEntry.sessionID = fullSession;

                        // Send plain text session ID to user
                        await sock.sendMessage(userJid, { text: fullSession });
                        console.log("📄 Session ID sent successfully to", userJid);
                        
                        await delay(1500);
                        
                        // Send warning/instructions message
                        const instructions = `⚠️ *Do not share this session ID with anyone.*\n\nCopy the raw Session ID message above and paste it in your OxBot dashboard to connect your bot.`;
                        await sock.sendMessage(userJid, { text: instructions });
                        console.log("⚠️ Warning message sent successfully");
                    } else {
                        console.log("❌ Could not determine user JID to send session ID");
                        sessionStoreEntry.status = 'error';
                        sessionStoreEntry.error = 'Could not determine user ID';
                    }
                } catch (error) {
                    console.error("Error sending session ID:", error);
                    sessionStoreEntry.status = 'error';
                    sessionStoreEntry.error = error.message;
                }
                
                // Clean up session after successful connection and sending files
                setTimeout(() => {
                    console.log('🧹 Cleaning up session...');
                    try { sock.ws?.close(); } catch {}
                    try { sock.end(); } catch {}
                    const deleted = removeFile(dirs);
                    if (deleted) {
                        console.log('✅ Session cleaned up successfully');
                    } else {
                        console.log('❌ Failed to clean up session folder');
                    }
                    pairingSessions.delete(sessionId);
                }, 15000); // Wait 15 seconds before cleanup to ensure messages are sent
            }

            if (connection === 'close') {
                console.log('❌ Connection closed');
                if (isLinked) {
                    console.log('ℹ️ Connection closed gracefully after successful link.');
                    return;
                }
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                
                // Handle specific error codes
                if (statusCode === 401) {
                    console.log('🔐 Logged out - need new QR code');
                    sessionStoreEntry.status = 'error';
                    sessionStoreEntry.error = 'Logged out from device';
                    removeFile(dirs);
                    pairingSessions.delete(sessionId);
                } else if (statusCode === 515 || statusCode === 503) {
                    console.log(`🔄 Stream error (${statusCode}) - attempting to reconnect...`);
                    reconnectAttempts++;
                    
                    if (reconnectAttempts <= maxReconnectAttempts) {
                        console.log(`🔄 Reconnect attempt ${reconnectAttempts}/${maxReconnectAttempts}`);
                        // Wait a bit before reconnecting
                        setTimeout(() => {
                            try {
                                sock = makeWASocket(socketConfig);
                                sessionStoreEntry.sock = sock;
                                sock.ev.on('connection.update', handleConnectionUpdate);
                                sock.ev.on('creds.update', saveCreds);
                            } catch (err) {
                                console.error('Failed to reconnect:', err);
                            }
                        }, 2000);
                    } else {
                        console.log('❌ Max reconnect attempts reached');
                        sessionStoreEntry.status = 'error';
                        sessionStoreEntry.error = 'Connection failed after multiple attempts';
                        pairingSessions.delete(sessionId);
                    }
                } else {
                    console.log('🔄 Connection lost - attempting to reconnect...');
                    // Let it reconnect automatically
                }
            }
        };

        // Bind the event handler
        sock.ev.on('connection.update', handleConnectionUpdate);
        sock.ev.on('creds.update', saveCreds);

        // Set a timeout to clean up if no QR is generated/scanned
        setTimeout(() => {
            if (pairingSessions.has(sessionId) && !isLinked) {
                sessionStoreEntry.status = 'error';
                sessionStoreEntry.error = 'QR generation/connection timeout';
                try { sock.end(); } catch {}
                removeFile(dirs);
                pairingSessions.delete(sessionId);
            }
        }, 180000); // 3 minute timeout

    } catch (err) {
        console.error('Error initializing session:', err);
        sessionStoreEntry.status = 'error';
        sessionStoreEntry.error = 'Service Unavailable';
        removeFile(dirs);
        pairingSessions.delete(sessionId);
    }
}

// Global uncaught exception handler
process.on('uncaughtException', (err) => {
    let e = String(err);
    if (e.includes("conflict")) return;
    if (e.includes("not-authorized")) return;
    if (e.includes("Socket connection timeout")) return;
    if (e.includes("rate-overlimit")) return;
    if (e.includes("Connection Closed")) return;
    if (e.includes("Timed Out")) return;
    if (e.includes("Value not found")) return;
    if (e.includes("Stream Errored")) return;
    if (e.includes("Stream Errored (restart required)")) return;
    if (e.includes("statusCode: 515")) return;
    if (e.includes("statusCode: 503")) return;
    console.log('Caught exception: ', err);
});

export default router;