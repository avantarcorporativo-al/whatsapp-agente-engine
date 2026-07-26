/**
 * ==============================================================================
 * AGENTE UNIVERSAL ENGINE - SERVIDOR WHATSAPP & GEMINI IA (RECONSTRUCCIÓN LIMPIA)
 * ==============================================================================
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
const QRCode = require('qrcode');
const pino = require('pino');

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

// 2. CARGA Y GUARDADO DE CONFIGURACIÓN
const DEFAULT_CONFIG = {
    apiKey: "AIzaSyC3kCmKY9Kjgm0XOa-gD-ITtZCBZhvh3oA",
    instruccionesUniversales: "Eres un Agente Virtual de Atención al Cliente inteligente, amable, servicial y profesional.\n\nInstrucciones del Negocio:\n- Atiende siempre con respeto y claridad.\n- Responde las dudas del cliente de forma fluida y directa en 2 a 3 renglones.",
    puenteActivo: true,
    sistemaEncendido: true,
    modeloGemini: "gemini-2.0-flash"
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

// 4. SANITIZACIÓN DE JID (CONVIERTE @lid EN @s.whatsapp.net)
function normalizarJID(jidRaw) {
    if (!jidRaw) return "";
    let jid = jidRaw.trim();
    if (jid.includes('@lid')) {
        jid = jid.replace('@lid', '@s.whatsapp.net');
    }
    return jid;
}

// 5. MOTOR DE CONSULTA DIRECTA A GEMINI REST API
async function consultarGeminiHTTPS(promptCliente, historial = []) {
    if (!configActual.sistemaEncendido) return null;

    const apiKey = (configActual.apiKey && !configActual.apiKey.includes('••••'))
        ? configActual.apiKey.trim()
        : "AIzaSyC3kCmKY9Kjgm0XOa-gD-ITtZCBZhvh3oA";

    if (!apiKey) {
        console.error("❌ No hay API Key configurada.");
        return null;
    }

    const instrucciones = configActual.instruccionesUniversales || "Eres un Agente Virtual atento y servicial.";
    const modelos = [configActual.modeloGemini || "gemini-2.0-flash", "gemini-1.5-flash", "gemini-2.5-flash"];
    const modelosUnicos = [...new Set(modelos)];

    // Construir historial limpio con alternancia estricta
    const contents = [];
    if (Array.isArray(historial) && historial.length > 0) {
        let lastRole = null;
        historial.forEach(item => {
            const role = item.role === 'model' ? 'model' : 'user';
            const text = (item.texto || item.text || "").trim();
            if (text && role !== lastRole) {
                contents.push({ role, parts: [{ text }] });
                lastRole = role;
            }
        });
    }

    if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts[0].text += "\n" + promptCliente.trim();
    } else {
        contents.push({ role: 'user', parts: [{ text: promptCliente.trim() }] });
    }

    const payloadObj = {
        system_instruction: { parts: [{ text: instrucciones }] },
        contents: contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 800 }
    };

    const payloadJSON = JSON.stringify(payloadObj);

    for (const mod of modelosUnicos) {
        const respuesta = await new Promise((resolve) => {
            const options = {
                hostname: 'generativelanguage.googleapis.com',
                port: 443,
                path: `/v1beta/models/${mod}:generateContent?key=${apiKey}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payloadJSON)
                }
            };

            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        try {
                            const json = JSON.parse(body);
                            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (text && text.trim()) return resolve(text.trim());
                        } catch (e) {}
                    }
                    console.error(`⚠️ Gemini API (${mod}) HTTP ${res.statusCode}: ${body.substring(0, 150)}`);
                    resolve(null);
                });
            });

            req.on('error', (e) => resolve(null));
            req.write(payloadJSON);
            req.end();
        });

        if (respuesta) return respuesta;
    }

    return null;
}

// 6. PROCESADOR DE RESPUESTA DE IA Y ENVÍO POR WHATSAPP
async function procesarRespuestaIA(jidCliente, textoCliente) {
    try {
        if (!jidCliente || !textoCliente) return;

        if (!dynamicHistorialChat[jidCliente]) {
            dynamicHistorialChat[jidCliente] = [];
        }

        console.log(`🧠 Procesando mensaje de [${jidCliente}] con Gemini IA...`);
        const respuestaIA = await consultarGeminiHTTPS(textoCliente, dynamicHistorialChat[jidCliente]);

        if (respuestaIA && sock) {
            dynamicHistorialChat[jidCliente].push({ role: 'user', texto: textoCliente });
            dynamicHistorialChat[jidCliente].push({ role: 'model', texto: respuestaIA });

            if (dynamicHistorialChat[jidCliente].length > 10) {
                dynamicHistorialChat[jidCliente] = dynamicHistorialChat[jidCliente].slice(-10);
            }

            await sock.sendMessage(jidCliente, { text: respuestaIA });
            console.log(`🤖 [RESPUESTA IA ENVIADA A ${jidCliente}]: ${respuestaIA}`);

            if (io) {
                io.emit('nuevo_mensaje', {
                    id: Date.now().toString(),
                    remitente: jidCliente.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    texto: respuestaIA,
                    tipo: 'enviado',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        } else {
            console.warn(`⚠️ Gemini no devolvió respuesta para [${jidCliente}].`);
        }
    } catch (err) {
        console.error("❌ Error en procesarRespuestaIA:", err.message);
    }
}

// 7. ARRANQUE DE BAILEYS (WHATSAPP)
async function iniciarBaileys() {
    if (!configActual.sistemaEncendido) {
        estadoConexion = 'apagado';
        io.emit('whatsapp_status', { estado: 'apagado', mensaje: '🔴 SISTEMA APAGADO TOTALMENTE' });
        return;
    }

    try {
        console.log('🔄 Iniciando motor de Baileys WhatsApp...');
        estadoConexion = 'conectando';
        io.emit('whatsapp_status', { estado: 'conectando', mensaje: 'Iniciando WhatsApp...' });

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
            browser: ['Ubuntu', 'Chrome', '20.0.04'],
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
                    io.emit('whatsapp_status', { estado: 'esperando_qr', mensaje: 'Escanea el Código QR en vivo' });
                } catch (e) {}
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                console.log(`⚠️ Conexión cerrada. Código: ${statusCode}. Desvinculado: ${isLoggedOut}`);

                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);

                if (isLoggedOut) {
                    estadoConexion = 'desconectado';
                    if (fs.existsSync(AUTH_FOLDER)) {
                        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
                    }
                    io.emit('whatsapp_status', { estado: 'desconectado', mensaje: 'Desvinculado desde el celular. Generando nuevo QR...' });
                    if (configActual.sistemaEncendido) setTimeout(() => iniciarBaileys(), 2000);
                } else if (configActual.sistemaEncendido) {
                    estadoConexion = 'conectando';
                    io.emit('whatsapp_status', { estado: 'conectando', mensaje: 'Reconectando con WhatsApp...' });
                    setTimeout(() => iniciarBaileys(), 3000);
                }
            } else if (connection === 'open') {
                console.log('🟢 Conexión a WhatsApp establecida con éxito.');
                estadoConexion = 'conectado';
                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);
                io.emit('whatsapp_status', { estado: 'conectado', mensaje: '🟢 WHATSAPP CONECTADO Y OPERATIVO' });
            }
        });

        // ESCUCHA DE MENSAJES ENTRANTES
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg || msg.key.fromMe) return;

                const remitenteRaw = msg.key.remoteJid || "";
                const jidLimpio = normalizarJID(remitenteRaw);
                if (!jidLimpio) return;

                const textoEntrante = msg.message?.conversation ||
                                     msg.message?.extendedTextMessage?.text ||
                                     msg.message?.imageMessage?.caption || "";

                if (!textoEntrante.trim()) return;

                console.log(`💬 [WHATSAPP RECIBIDO]: ${textoEntrante} (JID: ${jidLimpio})`);

                if (io) {
                    io.emit('nuevo_mensaje', {
                        id: msg.key.id || Date.now().toString(),
                        remitente: jidLimpio.replace('@s.whatsapp.net', ''),
                        texto: textoEntrante,
                        tipo: 'recibido',
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    });
                }

                if (configActual.puenteActivo && configActual.sistemaEncendido) {
                    procesarRespuestaIA(jidLimpio, textoEntrante);
                }
            } catch (e) {
                console.error("Error en messages.upsert:", e);
            }
        });

    } catch (err) {
        console.error('❌ Error fatal al iniciar Baileys:', err.message);
    }
}

// 8. ENDPOINTS API REST
app.get('/api/config', (req, res) => {
    res.json({
        ...configActual,
        apiKey: configActual.apiKey || '',
        hasKeySet: (configActual.apiKey || '').trim().length > 0,
        success: true,
        estadoConexion,
        tieneQR: !!qrActualBase64,
        instruccionesUniversales: configActual.instruccionesUniversales
    });
});

app.post('/api/save-key', (req, res) => {
    const { apiKey } = req.body;
    if (apiKey !== undefined && apiKey.trim() !== '') {
        configActual.apiKey = apiKey.trim();
        guardarConfig(configActual);
        console.log("🔑 Nueva API Key guardada.");
        return res.json({ success: true, message: "API Key de Gemini guardada." });
    }
    res.json({ success: true, message: "API Key mantenida." });
});

app.post('/api/save-instructions', (req, res) => {
    const { instruccionesUniversales } = req.body;
    if (instruccionesUniversales !== undefined) {
        configActual.instruccionesUniversales = instruccionesUniversales;
        guardarConfig(configActual);
        console.log("📝 Instrucciones Universales guardadas.");
        return res.json({ success: true, message: "Instrucciones guardadas." });
    }
    res.status(400).json({ success: false, message: "Instrucciones requeridas." });
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
    io.emit('whatsapp_status', { estado: 'conectando', mensaje: 'Generando nuevo Código QR...' });
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
    io.emit('whatsapp_status', { estado: 'desconectado', mensaje: 'WhatsApp Desvinculado Totalmente' });
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
    io.emit('whatsapp_status', { estado: 'apagado', mensaje: '🔴 SISTEMA APAGADO TOTALMENTE' });
    res.json({ success: true, encendido: false });
});

app.post('/api/encender-total', (req, res) => {
    configActual.sistemaEncendido = true;
    guardarConfig(configActual);
    iniciarBaileys();
    res.json({ success: true, encendido: true });
});

// 9. EVENTOS SOCKET.IO
io.on('connection', (socket) => {
    console.log(`💻 Cliente Web Conectado. ID: ${socket.id}`);
    socket.emit('sistema_status', { encendido: configActual.sistemaEncendido });
    socket.emit('whatsapp_status', { estado: estadoConexion });
    if (qrActualBase64 && configActual.sistemaEncendido) {
        socket.emit('whatsapp_qr', qrActualBase64);
    }
});

// 10. ARRANQUE DEL SERVIDOR
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=============================================================`);
    console.log(`🚀 AGENTE UNIVERSAL ENGINE CORRIENDO EN PUERTO: ${PORT}`);
    console.log(`🌐 URL Local: http://localhost:${PORT}`);
    console.log(`=============================================================`);
    iniciarBaileys();
});
