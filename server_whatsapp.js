/**
 * ==============================================================================
 * AGENTE UNIVERSAL ENGINE - SERVIDOR WHATSAPP & GEMINI IA (SDK @google/genai)
 * ==============================================================================
 * Stack: Node.js, Express, Socket.io, @whiskeysockets/baileys, @google/genai
 * ==============================================================================
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const { GoogleGenAI } = require('@google/genai');

const baileys = require('@whiskeysockets/baileys');
const makeWASocket = baileys.default || baileys.makeWASocket || baileys;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

// 1. CONFIGURACIÓN DEL SERVIDOR EXPRESS & SOCKET.IO
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3001;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_FOLDER = path.join(__dirname, 'sesion_whatsapp_auth');

// 2. CONFIGURACIÓN POR DEFECTO UNIVERSAL
const DEFAULT_CONFIG = {
    apiKey: "",
    instruccionesUniversales: "Eres el mejor Vendedor del mundo, experto en neuroventas y atención al cliente. Te llamas \"AL\". Responde siempre de forma corta, amable y directa en 2 a 3 renglones.",
    puenteActivo: true,
    sistemaEncendido: true,
    modeloGemini: "gemini-2.5-flash"
};

function cargarConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
        } catch(e) {}
        return { ...DEFAULT_CONFIG };
    }
    try {
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
}

function guardarConfig(nuevaConfig) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2), 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
}

let configActual = cargarConfig();

// 3. ESTADO GLOBAL EN MEMORIA
let sock = null;
let qrActualBase64 = null;
let estadoConexion = 'desconectado';
let dynamicHistorialChat = {};

// 4. SANITIZACIÓN DE JID DE WHATSAPP (@lid a @s.whatsapp.net)
function normalizarJID(jidRaw) {
    if (!jidRaw) return "";
    let jid = jidRaw.trim();
    if (jid.includes('@lid')) {
        jid = jid.replace('@lid', '@s.whatsapp.net');
    }
    return jid;
}

// 5. MOTOR DE CONSULTA DIRECTA A GEMINI USANDO EL SDK OFICIAL @google/genai (gemini-2.5-flash)
async function consultarGeminiSDK(promptCliente) {
    if (!configActual.sistemaEncendido) return null;

    const apiKey = (configActual.apiKey && !configActual.apiKey.includes('••••') && configActual.apiKey.trim().length > 0)
        ? configActual.apiKey.trim()
        : (process.env.GEMINI_API_KEY || "");

    if (!apiKey) {
        console.error("❌ Error: No hay API Key de Gemini configurada. Ingresa tu clave en el Módulo 1.");
        return null;
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: promptCliente,
            config: {
                systemInstruction: configActual.instruccionesUniversales || "Eres un Agente Virtual atento y servicial."
            }
        });

        const textoRespuesta = response.text;
        if (textoRespuesta && textoRespuesta.trim()) {
            return textoRespuesta.trim();
        }
    } catch (error) {
        console.error("❌ Error en SDK @google/genai (gemini-2.5-flash):", error.message || error);
    }

    return null;
}

// 6. PROCESADOR DE RESPUESTA DE IA Y ENVÍO A WHATSAPP
async function procesarRespuestaIA(jidCliente, textoCliente) {
    try {
        if (!jidCliente || !textoCliente) return;

        console.log(`🧠 Consultando @google/genai SDK (gemini-2.5-flash) para [${jidCliente}]...`);
        const respuestaIA = await consultarGeminiSDK(textoCliente);

        if (respuestaIA && sock) {
            await sock.sendMessage(jidCliente, { text: respuestaIA });
            console.log(`🤖 [RESPUESTA IA ENVIADA A ${jidCliente}]: ${respuestaIA}`);

            if (io) {
                io.emit('activity_log', { user: '🤖 IA', msg: respuestaIA, type: 'outgoing', ai: respuestaIA });
                io.emit('nuevo_mensaje', {
                    id: Date.now().toString(),
                    remitente: jidCliente.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    texto: respuestaIA,
                    tipo: 'enviado',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        } else {
            console.warn(`⚠️ No se pudo enviar mensaje a [${jidCliente}]. Gemini devolvió vacío o falta API Key válida.`);
        }
    } catch (err) {
        console.error("❌ Error crítico en procesarRespuestaIA:", err.message);
    }
}

// 7. INICIALIZACIÓN Y EVENTOS DE BAILEYS WHATSAPP
async function iniciarBaileys() {
    if (!configActual.sistemaEncendido) {
        console.log('🔴 Sistema configurado en APAGADO.');
        estadoConexion = 'apagado';
        io.emit('whatsapp_status', 'disconnected');
        return;
    }

    try {
        console.log('🔄 Iniciando motor de Baileys WhatsApp...');
        estadoConexion = 'conectando';
        io.emit('whatsapp_status', 'connecting');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
        let version;
        try {
            const vRes = await fetchLatestBaileysVersion();
            version = vRes.version;
        } catch (e) {
            version = [2, 3000, 1015901307];
        }

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['Agente Universal Engine', 'Chrome', '1.0.0'],
            syncFullHistory: false,
            markOnlineOnConnect: false,
            connectTimeoutMs: 30000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📸 Nuevo Código QR generado.');
                try {
                    qrActualBase64 = await QRCode.toDataURL(qr);
                    io.emit('whatsapp_qr', qrActualBase64);
                    io.emit('whatsapp_status', 'qr');
                } catch (e) {}
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                console.log(`⚠️ Conexión cerrada. Código: ${statusCode}. Desvinculado: ${isLoggedOut}`);

                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);
                io.emit('whatsapp_status', 'disconnected');

                if (isLoggedOut) {
                    estadoConexion = 'desconectado';
                    if (fs.existsSync(AUTH_FOLDER)) {
                        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
                    }
                    if (configActual.sistemaEncendido) setTimeout(() => iniciarBaileys(), 2000);
                } else if (configActual.sistemaEncendido) {
                    estadoConexion = 'conectando';
                    setTimeout(() => iniciarBaileys(), 3000);
                }
            } else if (connection === 'open') {
                console.log('🟢 WhatsApp Conectado con éxito!');
                estadoConexion = 'conectado';
                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);
                io.emit('whatsapp_status', 'connected');
            }
        });

        // RECEPTOR Y MONITOR DE MENSAJES ENTRANTES
        sock.ev.on('messages.upsert', async ({ messages }) => {
            try {
                if (!messages || messages.length === 0) return;

                for (const msg of messages) {
                    if (!msg || msg.key.fromMe) continue;

                    const remitenteRaw = msg.key.remoteJid || "";
                    const jidLimpio = normalizarJID(remitenteRaw);
                    if (!jidLimpio) continue;

                    const textoEntrante = msg.message?.conversation ||
                                         msg.message?.extendedTextMessage?.text ||
                                         msg.message?.imageMessage?.caption || "";

                    if (!textoEntrante.trim()) continue;

                    console.log(`💬 Mensaje recibido de ${jidLimpio}: ${textoEntrante}`);

                    if (io) {
                        io.emit('activity_log', { user: jidLimpio.split('@')[0], msg: textoEntrante, type: 'incoming' });
                        io.emit('nuevo_mensaje', {
                            id: msg.key.id || Date.now().toString(),
                            remitente: jidLimpio.replace('@s.whatsapp.net', ''),
                            texto: textoEntrante,
                            tipo: 'recibido',
                            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                        });
                    }

                    // COMPROBACIÓN DEL BOTÓN DE ACTIVACIÓN (MÓDULO 3 / PUENTE ACTIVO)
                    if (configActual.puenteActivo && configActual.sistemaEncendido) {
                        io.emit('procesar_con_ia', { texto: textoEntrante, remitente: jidLimpio });
                        await procesarRespuestaIA(jidLimpio, textoEntrante);
                    }
                }
            } catch (e) {
                console.error("Error en messages.upsert:", e);
            }
        });

    } catch (err) {
        console.error('❌ Error fatal al iniciar Baileys:', err.message);
    }
}

// 8. COMUNICACIÓN DE SOCKET.IO Y FRONTEND
io.on('connection', (socket) => {
    console.log(`💻 Frontend Conectado vía Socket.io. ID: ${socket.id}`);

    socket.emit('sistema_status', { encendido: configActual.sistemaEncendido });
    socket.emit('whatsapp_status', estadoConexion === 'conectado' ? 'connected' : estadoConexion);

    if (qrActualBase64 && configActual.sistemaEncendido) {
        socket.emit('whatsapp_qr', qrActualBase64);
    }

    socket.on('enviar_respuesta_whatsapp', async ({ respuesta, remitente }) => {
        if (sock && remitente && respuesta) {
            try {
                const jidLimpio = normalizarJID(remitente);
                await sock.sendMessage(jidLimpio, { text: respuesta });
                io.emit('activity_log', { user: '🤖 IA', msg: respuesta, type: 'outgoing', ai: respuesta });
            } catch (err) {
                console.error("Error al enviar mensaje a WhatsApp desde socket:", err);
            }
        }
    });
});

// 9. ENDPOINTS REST API
app.get('/api/config', (req, res) => {
    res.json({
        ...configActual,
        apiKey: configActual.apiKey || '',
        instrucciones: configActual.instruccionesUniversales,
        puente: configActual.puenteActivo,
        success: true,
        estadoConexion,
        tieneQR: !!qrActualBase64
    });
});

app.post('/api/config', (req, res) => {
    if (req.body.instrucciones !== undefined) configActual.instruccionesUniversales = req.body.instrucciones;
    if (req.body.puente !== undefined) configActual.puenteActivo = req.body.puente;
    guardarConfig(configActual);
    console.log("Configuración actualizada:", { puenteActivo: configActual.puenteActivo, instrucciones: configActual.instruccionesUniversales });
    res.json({ status: 'ok', success: true });
});

app.post('/api/save-key', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey !== undefined && apiKey.trim() !== '') {
        configActual.apiKey = apiKey.trim();
        guardarConfig(configActual);
        console.log("🔑 Nueva API Key de Gemini guardada en disco.");
        return res.json({ success: true, message: "API Key de Gemini guardada en disco." });
    }
    res.json({ success: true, message: "API Key mantenida." });
});

app.post('/api/save-instructions', (req, res) => {
    const { instruccionesUniversales } = req.body;
    if (instruccionesUniversales !== undefined) {
        configActual.instruccionesUniversales = instruccionesUniversales;
        guardarConfig(configActual);
        console.log("📝 Instrucciones Universales actualizadas.");
        return res.json({ success: true, message: "Instrucciones del Agente guardadas correctamente." });
    }
    res.status(400).json({ success: false, message: "Instrucciones requeridas." });
});

app.get('/api/start', (_req, res) => {
    console.log("Iniciando conexión de WhatsApp...");
    configActual.sistemaEncendido = true;
    guardarConfig(configActual);
    iniciarBaileys();
    res.json({ status: 'iniciando' });
});

app.post('/api/generar-qr-nuevo', async (req, res) => {
    qrActualBase64 = null;
    estadoConexion = 'conectando';
    if (sock) {
        try {
            if (sock.ws) sock.ws.close();
            if (sock.ev) sock.ev.removeAllListeners();
            sock = null;
        } catch (e) {}
    }
    if (fs.existsSync(AUTH_FOLDER)) {
        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
    }
    io.emit('whatsapp_qr', null);
    io.emit('whatsapp_status', 'connecting');
    configActual.sistemaEncendido = true;
    guardarConfig(configActual);
    setTimeout(() => iniciarBaileys(), 1500);
    res.json({ success: true, message: 'Generando nuevo Código QR...' });
});

app.post('/api/desvincular', async (req, res) => {
    qrActualBase64 = null;
    estadoConexion = 'desconectado';
    if (sock) {
        try {
            if (sock.ws) sock.ws.close();
            if (sock.ev) sock.ev.removeAllListeners();
            sock = null;
        } catch (e) {}
    }
    if (fs.existsSync(AUTH_FOLDER)) {
        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
    }
    io.emit('whatsapp_qr', null);
    io.emit('whatsapp_status', 'disconnected');
    res.json({ success: true, message: 'WhatsApp desvinculado.' });
});

app.post('/api/apagar-total', (req, res) => {
    configActual.sistemaEncendido = false;
    guardarConfig(configActual);
    qrActualBase64 = null;
    estadoConexion = 'apagado';
    if (sock) {
        try {
            if (sock.ws) sock.ws.close();
            if (sock.ev) sock.ev.removeAllListeners();
        } catch (err) {}
        sock = null;
    }
    io.emit('whatsapp_qr', null);
    io.emit('whatsapp_status', 'disconnected');
    res.json({ success: true, encendido: false });
});

app.post('/api/encender-total', (req, res) => {
    configActual.sistemaEncendido = true;
    guardarConfig(configActual);
    iniciarBaileys();
    res.json({ success: true, encendido: true });
});

// 10. ARRANQUE DEL SERVIDOR
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=============================================================`);
    console.log(`🚀 AGENTE UNIVERSAL ENGINE CORRIENDO EN PUERTO: ${PORT}`);
    console.log(`🌐 URL Local: http://localhost:${PORT}`);
    console.log(`=============================================================`);
    iniciarBaileys();
});
