/**
 * ==============================================================================
 * AGENTE UNIVERSAL ENGINE - SERVIDOR WHATSAPP & MULTI-IA
 * ==============================================================================
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
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

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.options('*', cors());
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

const DEFAULT_CONFIG = {
    apiKey: process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || "",
    instruccionesUniversales: "Eres el mejor Vendedor del mundo, experto en neuroventas y atención al cliente. Te llamas \"AL\". Responde siempre de forma corta, amable y directa en 2 a 3 renglones. Saluda solo en el primer mensaje.",
    puenteActivo: true,
    sistemaEncendido: true,
    modeloGemini: "gemini-flash-latest"
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
        const parsed = JSON.parse(data);
        return { 
            ...DEFAULT_CONFIG, 
            ...parsed,
            apiKey: parsed.apiKey || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || ""
        };
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
}

function guardarConfigDisco(nuevaConfig) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(nuevaConfig, null, 2), 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
}

let configActual = cargarConfig();
let sock = null;
let qrActualBase64 = null;
let estadoConexion = 'desconectado';
let historialChat = [];
let historialConversacionPorCliente = {};

function identificarProveedorClave(key) {
    const k = (key || '').trim();
    if (!k) return "NINGUNO (Clave Vacía)";
    if (k.startsWith('sk-or-')) return "OpenRouter (DeepSeek R1 / V3)";
    if (k.startsWith('sk-')) return "DeepSeek Oficial";
    if (k.startsWith('AIza')) return "Google Gemini";
    return "API OpenAI Compatible Genérica";
}

function extraerTextoMensaje(m) {
    if (!m || !m.message) return null;
    const msg = m.message.ephemeralMessage?.message || m.message;
    return msg.conversation || 
           msg.extendedTextMessage?.text || 
           msg.imageMessage?.caption || 
           msg.videoMessage?.caption || 
           msg.buttonsResponseMessage?.selectedButtonId || 
           null;
}

function realizarPeticionOpenAICompatible(endpointUrl, apiKey, modelName, systemPrompt, userMessage, conversationHistory = []) {
    return new Promise((resolve, reject) => {
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: userMessage }
        ];
        const payloadObj = { model: modelName, messages: messages, stream: false };
        const payload = JSON.stringify(payloadObj);
        const urlParsed = new URL(endpointUrl);
        const options = {
            hostname: urlParsed.hostname,
            path: urlParsed.pathname + urlParsed.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey.trim()}`,
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const reply = json.choices?.[0]?.message?.content;
                    if (reply) {
                        resolve(reply);
                    } else {
                        const errMsg = json.error?.message || `HTTP ${res.statusCode}: ${body.substring(0, 150)}`;
                        reject(new Error(errMsg));
                    }
                } catch (e) {
                    reject(new Error(`Respuesta de API inválida (Status ${res.statusCode})`));
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

function realizarPeticionGeminiHTTP(modelName, systemPrompt, userMessage, apiKey, conversationHistory = []) {
    return new Promise((resolve, reject) => {
        const contents = [];
        for (const h of conversationHistory) {
            contents.push({
                role: h.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: h.content }]
            });
        }
        contents.push({ role: 'user', parts: [{ text: userMessage }] });
        const payloadObj = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: contents
        };
        const payload = JSON.stringify(payloadObj);
        const options = {
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(body);
                    const reply = json.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (reply) {
                        resolve(reply);
                    } else {
                        const msgErr = json.error?.message || `HTTP Status ${res.statusCode}`;
                        reject(new Error(msgErr));
                    }
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', (e) => reject(e));
        req.write(payload);
        req.end();
    });
}

async function consultarIAUniversal(userMessage, systemPromptReq, apiKeyReq, conversationHistory = []) {
    const keyLimpia = (apiKeyReq || configActual.apiKey || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || '').trim();
    const sistema = systemPromptReq || configActual.instruccionesUniversales || "Eres un Agente Virtual atento y servicial.";
    
    if (!keyLimpia) {
        throw new Error("No hay API Key configurada. Ingrésala en el panel o en Render Environment Variables.");
    }

    if (keyLimpia.startsWith('sk-or-')) {
        const modelosOR = ["deepseek/deepseek-chat", "deepseek/deepseek-r1", "google/gemini-2.0-flash-exp:free"];
        let errores = [];
        for (const m of modelosOR) {
            try {
                const reply = await realizarPeticionOpenAICompatible("https://openrouter.ai/api/v1/chat/completions", keyLimpia, m, sistema, userMessage, conversationHistory);
                if (reply) return reply;
            } catch(e) { errores.push(e.message); }
        }
        throw new Error(`OpenRouter Error: ${errores[0] || 'Clave de OpenRouter inválida'}`);
    }

    if (keyLimpia.startsWith('sk-')) {
        try {
            const reply = await realizarPeticionOpenAICompatible("https://api.deepseek.com/v1/chat/completions", keyLimpia, "deepseek-chat", sistema, userMessage, conversationHistory);
            if (reply) return reply;
        } catch(e) {
            throw new Error(`DeepSeek API: ${e.message}`);
        }
    }

    const modelosGemini = ["gemini-flash-latest", "gemini-flash-lite-latest", "gemini-2.0-flash"];
    let ultimoError = "";
    for (const m of modelosGemini) {
        try {
            const reply = await realizarPeticionGeminiHTTP(m, sistema, userMessage, keyLimpia, conversationHistory);
            if (reply) return reply;
        } catch(e) { 
            ultimoError = e.message;
            if (ultimoError.includes("Quota exceeded") || ultimoError.includes("quota")) {
                throw new Error(`Cuota de Google Gemini Agotada en esta clave AIza. Usa tu clave de OpenRouter (sk-or-...).`);
            }
        }
    }
    throw new Error(`Error en Gemini API: ${ultimoError || "Verifica tu API Key"}`);
}

async function iniciarBaileys(forceReset = false) {
    if (!configActual.sistemaEncendido) {
        estadoConexion = 'apagado';
        io.emit('whatsapp_status', 'disconnected');
        return;
    }
    if (forceReset) {
        qrActualBase64 = null;
        if (sock) { try { sock.end(undefined); } catch(e){} sock = null; }
        if (fs.existsSync(AUTH_FOLDER)) {
            try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e){}
        }
    } else if (sock) {
        if (qrActualBase64 && estadoConexion !== 'conectado') io.emit('whatsapp_qr', qrActualBase64);
        return;
    }

    try {
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
            logger: pino({ level: 'fatal' }),
            browser: ["Agente Universal Engine", "Chrome", "1.0.0"]
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) {
                try {
                    qrActualBase64 = await QRCode.toDataURL(qr);
                    estadoConexion = 'qr';
                    io.emit('whatsapp_qr', qrActualBase64);
                    io.emit('whatsapp_status', 'qr');
                } catch (e) {}
            }
            if (connection === 'connecting') {
                estadoConexion = 'conectando';
                io.emit('whatsapp_status', 'connecting');
            }
            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                sock = null;
                if (reason === DisconnectReason.loggedOut || reason === 401) {
                    estadoConexion = 'desconectado';
                    io.emit('whatsapp_status', 'disconnected');
                    iniciarBaileys(true);
                } else {
                    estadoConexion = 'conectando';
                    io.emit('whatsapp_status', 'connecting');
                    setTimeout(() => iniciarBaileys(false), 1500);
                }
            } else if (connection === 'open') {
                qrActualBase64 = null;
                estadoConexion = 'conectado';
                io.emit('whatsapp_status', 'conectado');
                io.emit('whatsapp_qr', '');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (!m.message || m.key.fromMe) continue;
                const textoCliente = extraerTextoMensaje(m);
                const remitente = m.key.remoteJid;
                if (textoCliente && remitente) {
                    const nombre = m.pushName || remitente.split('@')[0];
                    const itemRecibido = {
                        id: Date.now().toString(),
                        remitente: nombre,
                        texto: textoCliente,
                        tipo: 'recibido',
                        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    };
                    historialChat.unshift(itemRecibido);
                    if (historialChat.length > 50) historialChat.pop();
                    io.emit('nuevo_mensaje', itemRecibido);

                    if (configActual.puenteActivo && configActual.sistemaEncendido) {
                        try {
                            if (!historialConversacionPorCliente[remitente]) {
                                historialConversacionPorCliente[remitente] = [];
                            }
                            const contextoCliente = historialConversacionPorCliente[remitente];
                            const respuestaIA = await consultarIAUniversal(textoCliente, configActual.instruccionesUniversales, configActual.apiKey, contextoCliente);
                            if (respuestaIA && sock) {
                                await sock.sendMessage(remitente, { text: respuestaIA });
                                historialConversacionPorCliente[remitente].push({ role: 'user', content: textoCliente });
                                historialConversacionPorCliente[remitente].push({ role: 'assistant', content: respuestaIA });
                                if (historialConversacionPorCliente[remitente].length > 50) {
                                    historialConversacionPorCliente[remitente] = historialConversacionPorCliente[remitente].slice(-50);
                                }
                                const itemEnviado = {
                                    id: (Date.now() + 1).toString(),
                                    remitente: '🤖 IA Gemini / OpenRouter',
                                    texto: respuestaIA,
                                    tipo: 'enviado',
                                    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                                };
                                historialChat.unshift(itemEnviado);
                                io.emit('nuevo_mensaje', itemEnviado);
                            }
                        } catch (errIA) {
                            console.error("❌ Error procesando respuesta con IA:", errIA.message);
                        }
                    }
                }
            }
        });
    } catch (e) {
        console.error("❌ Error iniciando Baileys:", e);
    }
}

// ENDPOINTS HTTP
app.get('/api/config', (_req, res) => {
    res.json({
        success: true,
        config: configActual,
        proveedorNombre: identificarProveedorClave(configActual.apiKey || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY || "")
    });
});

app.post('/api/save-key', (req, res) => {
    const { apiKey } = req.body;
    if (typeof apiKey === 'string') {
        configActual.apiKey = apiKey.trim();
        guardarConfigDisco(configActual);
    }
    res.json({ success: true, message: 'Clave guardada exitosamente.', proveedorNombre: identificarProveedorClave(configActual.apiKey) });
});

app.post('/api/save-instructions', (req, res) => {
    const { instruccionesUniversales } = req.body;
    if (typeof instruccionesUniversales === 'string') {
        configActual.instruccionesUniversales = instruccionesUniversales;
        guardarConfigDisco(configActual);
    }
    res.json({ success: true, message: 'Instrucciones guardadas exitosamente.' });
});

// NUEVO ENDPOINT REST PARA PROBAR IA DESDE LA WEB SIN CORS
app.post('/api/probar-ia', async (req, res) => {
    try {
        const { mensaje, instrucciones, apiKey } = req.body;
        const respuesta = await consultarIAUniversal(mensaje, instrucciones, apiKey);
        res.json({ success: true, respuesta });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/generar-qr-nuevo', (_req, res) => {
    iniciarBaileys(true);
    res.json({ success: true, message: 'Regenerando código QR...' });
});

app.post('/api/desvincular', (_req, res) => {
    iniciarBaileys(true);
    res.json({ success: true, message: 'Sesión desvinculada exitosamente.' });
});

app.post('/api/apagar-total', (_req, res) => {
    configActual.sistemaEncendido = false;
    guardarConfigDisco(configActual);
    if (sock) { try { sock.end(undefined); } catch(e){} sock = null; }
    estadoConexion = 'apagado';
    io.emit('whatsapp_status', 'disconnected');
    res.json({ success: true, message: 'Sistema Apagado Totalmente.' });
});

app.post('/api/encender-total', (_req, res) => {
    configActual.sistemaEncendido = true;
    guardarConfigDisco(configActual);
    iniciarBaileys(true);
    res.json({ success: true, message: 'Sistema Encendido.' });
});

let historialProbadorWeb = [];
io.on('connection', (socket) => {
    socket.emit('whatsapp_status', estadoConexion);
    if (qrActualBase64) socket.emit('whatsapp_qr', qrActualBase64);
    socket.emit('historial_chat', historialChat);

    socket.on('probar_ia_web', async ({ mensaje, instrucciones, apiKey }) => {
        try {
            const respuesta = await consultarIAUniversal(mensaje, instrucciones || configActual.instruccionesUniversales, apiKey || configActual.apiKey, historialProbadorWeb);
            historialProbadorWeb.push({ role: 'user', content: mensaje });
            historialProbadorWeb.push({ role: 'assistant', content: respuesta });
            if (historialProbadorWeb.length > 50) historialProbadorWeb = historialProbadorWeb.slice(-50);
            socket.emit('respuesta_ia_web', { ok: true, respuesta });
        } catch(err) {
            socket.emit('respuesta_ia_web', { ok: false, error: err.message });
        }
    });

    socket.on('toggle_puente', (nuevoEstado) => {
        configActual.puenteActivo = !!nuevoEstado;
        guardarConfigDisco(configActual);
        io.emit('puente_estado', configActual.puenteActivo);
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor ejecutándose en puerto ${PORT}`);
    iniciarBaileys(false);
});
