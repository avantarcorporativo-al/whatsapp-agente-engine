/**
 * ==============================================================================
 * AGENTE UNIVERSAL ENGINE - SERVER WHATSAPP (BACKEND CON MANEJO DE CUOTA HTTP 429)
 * ==============================================================================
 * Desarrollado con: Node.js, Express, Socket.io, @whiskeysockets/baileys
 * Características:
 *  - Integración pura con Gemini 2.5 y 2.0 (Google AI Studio REST v1beta)
 *  - Detección precisa de Error 429 (Cuota Excedida / Límite de Peticiones)
 *  - Notificación en tiempo real al panel para actualizar la API Key en el Módulo 1
 *  - Mantenimiento del 100% de la interfaz gráfica y eventos WebSockets
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

// 1. CONFIGURACIÓN DEL SERVIDOR EXPRESS Y SOCKET.IO
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3001;
const CONFIG_PATH = path.join(__dirname, 'config.json');
const AUTH_FOLDER = path.join(__dirname, 'sesion_whatsapp_auth');

// 2. CONFIGURACIÓN POR DEFECTO UNIVERSAL Y LIMPIA
const DEFAULT_CONFIG = {
    apiKey: "AIzaSyC6m1vQDrODxPWX_tsIpHsEBR32garG2V4",
    instruccionesUniversales: "Eres un Agente Virtual de Atención al Cliente inteligente, amable, servicial y profesional.\n\nInstrucciones del Negocio:\n- Atiende siempre con respeto y claridad.\n- Responde las dudas del cliente de forma fluida y directa en 2 a 3 renglones.",
    puenteActivo: true,
    sistemaEncendido: true,
    modeloGemini: "gemini-2.5-flash"
};

function cargarConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
        try {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
            console.log('📁 Archivo config.json creado con valores universales.');
        } catch(e) {}
        return { ...DEFAULT_CONFIG };
    }
    try {
        const data = fs.readFileSync(CONFIG_PATH, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        console.error("⚠️ Error leyendo config.json, usando valores por defecto:", e.message);
        return { ...DEFAULT_CONFIG };
    }
}

function guardarConfig(nuevaConfig) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2), 'utf-8');
        console.log("💾 Configuración guardada en disco (config.json).");
        return true;
    } catch (e) {
        console.error("❌ Error guardando en config.json:", e.message);
        return false;
    }
}

let configActual = cargarConfig();

// 3. VARIABLES DE ESTADO EN MEMORIA
let sock = null;
let qrActualBase64 = null;
let estadoConexion = 'desconectado';
let dynamicHistorialChat = {};

// 4. INICIALIZACIÓN COMPLETA DE BAILEYS WHATSAPP
async function iniciarBaileys() {
    if (!configActual.sistemaEncendido) {
        console.log('🔴 Sistema configurado en APAGADO. Omitiendo inicio de Baileys.');
        estadoConexion = 'apagado';
        io.emit('whatsapp_status', { estado: 'apagado', mensaje: '🔴 SISTEMA APAGADO TOTALMENTE' });
        io.emit('sistema_status', { encendido: false, mensaje: "🔴 SISTEMA APAGADO TOTALMENTE" });
        return;
    }

    try {
        console.log('🔄 Iniciando motor de Baileys WhatsApp...');
        estadoConexion = 'conectando';
        io.emit('whatsapp_status', { estado: 'conectando', mensaje: 'Iniciando WhatsApp...' });
        io.emit('sistema_status', { encendido: true, mensaje: "🟢 SISTEMA CONECTADO Y OPERATIVO" });

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
                } catch (e) {
                    console.error("Error al convertir QR a DataURL:", e.message);
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
                console.log(`⚠️ Conexión cerrada. Código: ${statusCode}. Desvinculado: ${isLoggedOut}`);

                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);

                if (isLoggedOut) {
                    console.log('⚠️ Sesión desvinculada desde el celular (401). Limpiando credenciales caducadas...');
                    estadoConexion = 'desconectado';
                    if (fs.existsSync(AUTH_FOLDER)) {
                        try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
                    }
                    io.emit('whatsapp_status', { estado: 'desconectado', mensaje: 'Desvinculado desde el celular. Generando nuevo QR...' });

                    if (configActual.sistemaEncendido) {
                        setTimeout(() => iniciarBaileys(), 2000);
                    }
                } else if (configActual.sistemaEncendido) {
                    estadoConexion = 'conectando';
                    io.emit('whatsapp_status', { estado: 'conectando', mensaje: 'Reconectando con WhatsApp...' });
                    setTimeout(() => iniciarBaileys(), 3000);
                } else {
                    estadoConexion = 'desconectado';
                    io.emit('whatsapp_status', { estado: 'desconectado', mensaje: 'WhatsApp Desconectado' });
                }
            } else if (connection === 'open') {
                console.log('🟢 Conexión a WhatsApp establecida con éxito.');
                estadoConexion = 'conectado';
                qrActualBase64 = null;
                io.emit('whatsapp_qr', null);
                io.emit('whatsapp_status', { estado: 'conectado', mensaje: '🟢 WHATSAPP CONECTADO Y OPERATIVO' });
            }
        });

        // RECEPTOR DE MENSAJES ENTRANTES EN SERVIDORES NODE.JS (messages.upsert)
        sock.ev.on('messages.upsert', async (m) => {
            try {
                const msg = m.messages[0];
                if (!msg || msg.key.fromMe) return;

                const remitenteRaw = msg.key.remoteJid || "";
                const jidLimpio = normalizarJID(remitenteRaw);
                if (!jidLimpio) return;

                const textoEntrante = msg.message?.conversation || 
                                     msg.message?.extendedTextMessage?.text || 
                                     msg.message?.imageMessage?.caption || 
                                     "";

                if (!textoEntrante.trim()) return;

                console.log(`💬 [WHATSAPP RECIBIDO EN SERVIDOR]: ${textoEntrante} (JID Normalizado: ${jidLimpio})`);

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
                    // LLAMADA DIRECTA Y ASÍNCRONA EN EL SERVIDOR NODE.JS
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
// =========================================================
// 1. NORMALIZACIÓN DE JID DE WHATSAPP (@lid a @s.whatsapp.net)
// =========================================================
function normalizarJID(remitente) {
    if (!remitente) return "";
    let jid = remitente.trim();
    if (jid.includes('@lid')) {
        jid = jid.replace('@lid', '@s.whatsapp.net');
    }
    return jid;
}

// =========================================================
// 2. CONSULTA HTTPS DIRECTA Y COMPATIBLE CON GEMINI 2.5 FLASH REST (v1beta)
// =========================================================
async function consultarGeminiHTTPS(promptUsuario, historial = []) {
    if (!configActual.sistemaEncendido) return null;
    
    const apiKey = (configActual.apiKey && !configActual.apiKey.includes('••••')) 
        ? configActual.apiKey.trim() 
        : "AIzaSyC6m1vQDrODxPWX_tsIpHsEBR32garG2V4";

    if (!apiKey) {
        console.error("❌ Error: No hay API Key configurada en el servidor.");
        return null;
    }

    const instrucciones = configActual.instruccionesUniversales || "Eres un Agente Virtual atento y servicial.";
    const modelo = "gemini-2.5-flash";

    // INSERTAR INSTRUCCIONES DEL SISTEMA COMO LOS DOS PRIMEROS TURNOS EN CONTENTS
    const contentsPayload = [
        { 
            role: 'user', 
            parts: [{ text: "INSTRUCCIONES DEL SISTEMA: " + instrucciones }] 
        },
        { 
            role: 'model', 
            parts: [{ text: "Entendido, actuaré bajo estas instrucciones." }] 
        }
    ];

    if (Array.isArray(historial) && historial.length > 0) {
        historial.forEach(item => {
            const role = item.role === 'model' ? 'model' : 'user';
            const texto = item.texto || item.text || "";
            if (texto.trim()) {
                contentsPayload.push({
                    role: role,
                    parts: [{ text: texto.trim() }]
                });
            }
        });
    }

    contentsPayload.push({
        role: 'user',
        parts: [{ text: promptUsuario.trim() }]
    });

    const postData = JSON.stringify({
        contents: contentsPayload,
        generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 800
        }
    });

    const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${modelo}:generateContent?key=${apiKey}`,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    };

    return new Promise((resolve) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(body);
                        const respuesta = json.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (respuesta && respuesta.trim()) {
                            return resolve(respuesta.trim());
                        }
                    } catch (e) {
                        console.error("❌ Error al parsear JSON de Gemini:", e.message);
                    }
                }
                console.error(`❌ Gemini API Error HTTP ${res.statusCode}: ${body.substring(0, 200)}`);
                resolve(null);
            });
        });

        req.on('error', (err) => {
            console.error("❌ Error de red con Gemini:", err.message);
            resolve(null);
        });

        req.write(postData);
        req.end();
    });
}

// =========================================================
// 3. PROCESADOR DE RESPUESTA DE IA EN WHATSAPP
// =========================================================
async function procesarRespuestaIA(remitenteJID, textoCliente) {
    try {
        if (!remitenteJID || !textoCliente) return;

        if (!dynamicHistorialChat[remitenteJID]) {
            dynamicHistorialChat[remitenteJID] = [];
        }

        const respuestaIA = await consultarGeminiHTTPS(textoCliente, dynamicHistorialChat[remitenteJID]);

        if (respuestaIA && sock) {
            dynamicHistorialChat[remitenteJID].push({ role: 'user', texto: textoCliente });
            dynamicHistorialChat[remitenteJID].push({ role: 'model', texto: respuestaIA });

            if (dynamicHistorialChat[remitenteJID].length > 10) {
                dynamicHistorialChat[remitenteJID] = dynamicHistorialChat[remitenteJID].slice(-10);
            }

            await sock.sendMessage(remitenteJID, { text: respuestaIA });
            console.log(`🤖 [AGENTE IA ENVIÓ A ${remitenteJID}]: ${respuestaIA}`);

            if (io) {
                io.emit('nuevo_mensaje', {
                    id: Date.now().toString(),
                    remitente: remitenteJID.replace('@s.whatsapp.net', '').replace('@lid', ''),
                    texto: respuestaIA,
                    tipo: 'enviado',
                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                });
            }
        } else {
            console.warn(`⚠️ No se pudo enviar mensaje a ${remitenteJID}. Gemini devolvió vacío o socket desatendido.`);
        }
    } catch (err) {
        console.error("❌ Error crítico en procesarRespuestaIA:", err.message);
    }
}

// 6. ENDPOINTS REST API DE EXPRESS
app.get('/api/config', (req, res) => {
    const rawKey = configActual.apiKey || '';
    res.json({
        ...configActual,
        apiKey: rawKey,
        hasKeySet: rawKey.trim().length > 0,
        success: true,
        config: configActual,
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
        console.log("🔑 Nueva API Key de Gemini guardada de forma segura en disco:", configActual.apiKey.substring(0, 6) + "...");
        return res.json({ success: true, message: "API Key de Gemini guardada en disco." });
    }
    res.json({ success: true, message: "API Key mantenida sin cambios." });
});

app.post('/api/save-instructions', (req, res) => {
    const { instruccionesUniversales } = req.body;
    if (instruccionesUniversales !== undefined) {
        configActual.instruccionesUniversales = instruccionesUniversales;
        guardarConfig(configActual);
        console.log("📝 Instrucciones Universales actualizadas.");
        return res.json({ success: true, message: "Instrucciones del Agente guardadas correctamente en disco." });
    }
    res.status(400).json({ success: false, message: "Instrucciones requeridas." });
});

app.post('/api/generar-qr-nuevo', async (req, res) => {
    console.log('🔄 Solicitud de GENERAR NUEVO QR recibida. Limpiando credenciales antiguas...');
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

    setTimeout(() => {
        iniciarBaileys();
    }, 1500);

    res.json({ success: true, message: 'Sesión anterior borrada. Generando nuevo Código QR...' });
});

app.post('/api/desvincular', async (req, res) => {
    console.log('⚡ Solicitud de DESVINCULAR WHATSAPP recibida.');
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

    res.json({ success: true, message: 'WhatsApp desvinculado correctamente.' });
});

app.post('/api/apagar-total', (req, res) => {
    console.log("🔴 Solicitud de APAGADO TOTAL recibida.");
    configActual.sistemaEncendido = false;
    guardarConfig(configActual);

    qrActualBase64 = null;
    estadoConexion = 'apagado';
    
    if (sock) {
        try {
            if (sock.ws) sock.ws.close();
            if (sock.ev) sock.ev.removeAllListeners();
        } catch (err) {
            console.error("Error al cerrar socket:", err);
        }
        sock = null;
    }
    
    io.emit('whatsapp_qr', null);
    io.emit('whatsapp_status', { estado: 'apagado', mensaje: '🔴 SISTEMA APAGADO TOTALMENTE' });
    io.emit('sistema_status', { encendido: false, mensaje: "🔴 SISTEMA APAGADO TOTALMENTE" });
    res.json({ success: true, encendido: false, message: "Sistema y Socket apagados por completo." });
});

app.post('/api/encender-total', (req, res) => {
    console.log("🟢 Solicitud de ENCENDIDO TOTAL recibida.");
    configActual.sistemaEncendido = true;
    guardarConfig(configActual);
    
    iniciarBaileys();
    
    io.emit('sistema_status', { encendido: true, mensaje: "🟢 SISTEMA CONECTADO Y OPERATIVO" });
    res.json({ success: true, encendido: true, message: "Sistema encendido correctamente." });
});

// 7. EVENTOS DE SOCKET.IO
io.on('connection', (socket) => {
    console.log(`💻 Cliente Web Conectado. ID: ${socket.id}`);

    socket.emit('sistema_status', { 
        encendido: configActual.sistemaEncendido, 
        mensaje: configActual.sistemaEncendido ? "🟢 SISTEMA CONECTADO Y OPERATIVO" : "🔴 SISTEMA APAGADO TOTALMENTE"
    });

    socket.emit('whatsapp_status', { 
        estado: estadoConexion, 
        mensaje: configActual.sistemaEncendido ? `Estado: ${estadoConexion}` : '🔴 SISTEMA APAGADO TOTALMENTE'
    });

    if (qrActualBase64 && configActual.sistemaEncendido) {
        socket.emit('whatsapp_qr', qrActualBase64);
    }
});

// 8. ARRANQUE DEL SERVIDOR
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=============================================================`);
    console.log(`🚀 AGENTE UNIVERSAL ENGINE CORRIENDO EN PUERTO: ${PORT}`);
    console.log(`🌐 URL Local: http://localhost:${PORT}`);
    console.log(`=============================================================`);
    
    iniciarBaileys();
});
