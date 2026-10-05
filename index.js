const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const preguntarNumero = (q) => new Promise((resolve) => rl.question(q, resolve));

const DB_FILE = path.join(__dirname, 'database.json');
let db = { 
    cartera: {}, 
    banco: {}, 
    nivelBanco: {},
    perfil: {}, 
    warns: {},
    owners: ['573226578596'] 
};

if (fs.existsSync(DB_FILE)) {
    try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
}

const guardarBD = () => {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (e) {}
};

const esOwner = (jidOrNum) => {
    if (!jidOrNum) return false;
    const num = jidOrNum.replace(/[^0-9]/g, '');
    return db.owners.includes(num);
};

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        browser: ["Desktop", "Chrome", "121.0.0.0"]
    });

    sock.ev.on('creds.update', saveCreds);

    // --- EMPAREJAMIENTO SEGURO ANTICÓDIGO 428 ---
    if (!sock.authState.creds.registered) {
        const numero = await preguntarNumero('\n📱 Ingrese su número de WhatsApp con código de país (ej: 573226578596): ');
        rl.close();
        
        console.log('⏳ Estableciendo conexión con WhatsApp para generar el código...');
        
        // Esperamos a que el socket tenga la conexión abierta o activa antes de pedir el código
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(numero.trim());
                code = code?.match(/.{1,4}/g)?.join("-") || code;
                console.log(`\n🔑 ========================================`);
                console.log(`🔑 CÓDIGO DE EMPAREJAMIENTO: ${code}`);
                console.log(`🔑 =======================================-\n`);
            } catch (err) {
                console.error('Error al solicitar el código:', err);
            }
        }, 6000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log('⚠️ Conexión cerrada. Motivo:', reason);
            if (reason !== DisconnectReason.loggedOut) {
                setTimeout(iniciarBot, 4000);
            } else {
                console.log('❌ Sesión cerrada permanentemente. Borre "auth_info_baileys".');
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Maki Bot conectada con éxito y completamente operativa!');
        }
    });

    const enviarRespuesta = async (jid, textoOpciones, options = {}) => {
        const contenido = typeof textoOpciones === 'string' ? { text: textoOpciones } : textoOpciones;
        return await sock.sendMessage(jid, {
            ...contenido,
            contextInfo: {
                ...options.contextInfo,
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '123@newsletter',
                    newsletterName: 'NATH SUPPORT | OFFICIAL BOT',
                    serverMessageId: 1
                }
            }
        }, { quoted: options.quoted });
    };

    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            if (mek.message.ephemeralMessage) mek.message = mek.message.ephemeralMessage.message;
            if (mek.key && mek.key.remoteJid === 'status@broadcast') return;

            const from = mek.key.remoteJid;
            const type = Object.keys(mek.message)[0];
            const body = (type === 'conversation') ? mek.message.conversation : 
                         (type === 'imageMessage') ? mek.message.imageMessage.caption : 
                         (type === 'videoMessage') ? mek.message.videoMessage.caption : 
                         (type === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

            const isGroup = from.endsWith('@g.us');
            const isFromMe = mek.key.fromMe;
            const sender = isGroup ? mek.key.participant : (isFromMe ? sock.user?.id : mek.key.remoteJid);
            const senderNum = sender ? sender.split('@')[0].split(':')[0] : '';
            const isOwner = isFromMe || esOwner(sender) || esOwner(senderNum);

            let groupMetadata = isGroup ? await sock.groupMetadata(from).catch(() => null) : null;
            let groupAdmins = groupMetadata ? groupMetadata.participants.filter(v => v.admin !== null).map(v => v.id) : [];
            let isAdmins = isGroup ? groupAdmins.includes(sender) : false;

            const trimmedBody = body.trim();
            const isCmd = /^[.#/]\s*[a-zA-Z0-9]+/.test(trimmedBody);

            if (!isCmd) {
                const botNumber = sock.user?.id ? sock.user.id.split(':')[0] : '';
                const isMentioned = mek.message?.extendedTextMessage?.contextInfo?.mentionedJid?.some(jid => jid.includes(botNumber));
                const isQuotedBot = mek.message?.extendedTextMessage?.contextInfo?.participant?.includes(botNumber);

                if ((isMentioned || isQuotedBot || !isGroup) && trimmedBody.length > 0 && !isFromMe) {
                    try {
                        await sock.sendPresenceUpdate('composing', from);
                        const promptLimpio = trimmedBody.replace(/@\d+/g, '').trim();
                        const promptIA = `Eres Maki Bot, una asistente virtual profesional y eficiente. Responde de forma natural, culta y clara a este mensaje: ${promptLimpio}`;
                        
                        const resApi = await fetch(`https://api.vreden.web.id/api/ai?query=${encodeURIComponent(promptIA)}`).catch(() => null);
                        let resJson = resApi ? await resApi.json().catch(() => null) : null;
                        let respuestaIA = resJson?.result || resJson?.response || `Hola. Escriba .menu para visualizar el directorio de comandos disponibles.`;

                        await enviarRespuesta(from, { text: respuestaIA, mentions: [sender] });
                        return;
                    } catch (e) {}
                }
                return;
            }

            const sinPrefijo = trimmedBody.slice(1).trim();
            const args = sinPrefijo.split(/ +/);
            const command = args.shift().toLowerCase();
            const footerCreditos = `\n\n──────────────────────────\nNATH SUPPORT • Professional System`;

            switch (command) {
                case 'ping':
                    await enviarRespuesta(from, `Sistema en línea y operando con estabilidad total.${footerCreditos}`);
                    break;

                case 'menu':
                case 'help':
                    const menuTexto = `
┌─────────────────────────┐
│     NATH SUPPORT WABOT  │
└─────────────────────────┘
• Usuario: @${senderNum}
• Rango: ${isOwner ? 'Administrador General' : 'Usuario Estándar'}

[ ECONOMÍA Y GESTIÓN BANCARIA ]
• .bal - Consulta de fondos (Cartera y Banco)
• .daily - Reclamación de asignación diaria
• .depositar <banco> <monto> - Transferencia a entidad (Nequi, Davplata, Bancobogota, Dale)
• .retirar <monto> - Retiro de fondos bancarios hacia cartera
• .robar @usuario - Operación de sustracción en cartera ajena
• .robargb @usuario - Invasión de sistemas de seguridad bancaria ajena
• .mejorarbanco - Ascenso de nivel de seguridad patrimonial (1 al 10)

[ PERFIL Y REGISTRO ]
• .profile / .perfil - Visualización de tarjeta de datos corporativos
• .setnombre <nombre> - Registro o cambio de identidad nominal
• .setedad <edad> - Configuración de parámetro de edad
• .setcumple <fecha> - Establecimiento de fecha conmemorativa
• .setbio <texto> - Redacción de biografía descriptiva

[ ADMINISTRACIÓN Y MODERACIÓN ]
• .abrir / .cerrar - Modificación de permisos de mensajería grupal
• .tagall - Notificación general a todos los integrantes
• .warn @usuario - Emisión formal de advertencia (Límite: 3)
• .kick @usuario - Expulsión de miembro del grupo
${footerCreditos}`.trim();
                    await enviarRespuesta(from, { text: menuTexto, mentions: [sender] });
                    break;

                case 'bal':
                case 'balance':
                    db.cartera ||= {};
                    db.banco ||= {};
                    db.nivelBanco ||= {};
                    const uBal = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
                    const balNum = uBal.split('@')[0].split(':')[0];
                    const lvBanco = db.nivelBanco[uBal] || 1;
                    
                    await enviarRespuesta(from, {
                        text: `┌─────────────────────────┐\n│    BALANCE FINANCIERO   │\n└─────────────────────────┘\n• Titular: @${balNum}\n• Cartera: $${db.cartera[uBal] || 0}\n• Banco: $${db.banco[uBal] || 0}\n• Seguridad: Nivel ${lvBanco}/10${footerCreditos}`,
                        mentions: [uBal]
                    });
                    break;

                case 'daily':
                case 'diario':
                    db.cartera ||= {};
                    db.cartera[sender] = (db.cartera[sender] || 0) + 2500;
                    guardarBD();
                    await enviarRespuesta(from, `Asignación diaria acreditada de forma exitosa: +$2,500 monedas.${footerCreditos}`);
                    break;

                case 'depositar':
                case 'dep':
                    db.cartera ||= {};
                    db.banco ||= {};
                    const bancoElegido = args[0]?.toLowerCase();
                    const bancosValidos = ['nequi', 'davplata', 'bancobogota', 'bogota', 'dale'];
                    if (!bancoElegido || !bancosValidos.includes(bancoElegido)) {
                        return enviarRespuesta(from, `Entidad bancaria no válida.\nSintaxis correcta: .depositar nequi 5000\nBancos disponibles: Nequi, Davplata, Bancobogota, Dale${footerCreditos}`);
                    }
                    let montoDep = parseInt(args[1]);
                    if (isNaN(montoDep) || montoDep <= 0) return enviarRespuesta(from, `Debe especificar un monto numérico válido para el depósito.${footerCreditos}`);
                    if ((db.cartera[sender] || 0) < montoDep) return enviarRespuesta(from, `Fondos insuficientes en cartera para realizar esta operación.${footerCreditos}`);
                    let com = (bancoElegido === 'bancobogota' || bancoElegido === 'bogota') ? 0.02 : 0.01;
                    let comision = Math.floor(montoDep * com);
                    let totalDescontar = montoDep + comision;
                    if ((db.cartera[sender] || 0) < totalDescontar) {
                        return enviarRespuesta(from, `No dispone de capital suficiente para cubrir la comisión estipulada ($${comision}).${footerCreditos}`);
                    }
                    db.cartera[sender] -= totalDescontar;
                    db.banco[sender] = (db.banco[sender] || 0) + montoDep;
                    guardarBD();
                    await enviarRespuesta(from, `DEPÓSITO EXITOSO (${bancoElegido.toUpperCase()})\n• Capital asegurado: $${montoDep}\n• Comisión aplicada: $${comision}${footerCreditos}`);
                    break;

                case 'retirar':
                    db.cartera ||= {};
                    db.banco ||= {};
                    let montoRet = parseInt(args[0]);
                    if (isNaN(montoRet) || montoRet <= 0) return enviarRespuesta(from, `Debe especificar la cantidad exacta que desea retirar. Ej: .retirar 2000${footerCreditos}`);
                    if ((db.banco[sender] || 0) < montoRet) return enviarRespuesta(from, `El saldo disponible en su cuenta bancaria es inferior al solicitado.${footerCreditos}`);
                    db.banco[sender] -= montoRet;
                    db.cartera[sender] = (db.cartera[sender] || 0) + montoRet;
                    guardarBD();
                    await enviarRespuesta(from, `Retiro procesado satisfactoriamente. Se han transferido $${montoRet} a su cartera.${footerCreditos}`);
                    break;

                case 'mejorarbanco':
                    db.nivelBanco ||= {};
                    db.banco ||= {};
                    let lvlActual = db.nivelBanco[sender] || 1;
                    if (lvlActual >= 10) return enviarRespuesta(from, `Su infraestructura bancaria ya se encuentra en el nivel máximo de seguridad (10/10).${footerCreditos}`);
                    let costoMejora = lvlActual * 5000;
                    if ((db.banco[sender] || 0) < costoMejora) {
                        return enviarRespuesta(from, `Fondos insuficientes en el banco. Se requiere un capital de $${costoMejora} para ascender al Nivel ${lvlActual + 1}.${footerCreditos}`);
                    }
                    db.banco[sender] -= costoMejora;
                    db.nivelBanco[sender] = lvlActual + 1;
                    guardarBD();
                    await enviarRespuesta(from, `Infraestructura de seguridad actualizada al Nivel ${lvlActual + 1} de forma exitosa.${footerCreditos}`);
                    break;

                case 'robar':
                    db.cartera ||= {};
                    const victimaRobo = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!victimaRobo) return enviarRespuesta(from, `Debe etiquetar al usuario objetivo de la operación de sustracción.${footerCreditos}`);
                    if (victimaRobo === sender) return enviarRespuesta(from, `No es posible ejecutar operaciones financieras sobre su propia cuenta.${footerCreditos}`);
                    let dineroVictima = db.cartera[victimaRobo] || 0;
                    if (dineroVictima < 500) return enviarRespuesta(from, `El objetivo no posee fondos significativos en su cartera.${footerCreditos}`);
                    if (Math.random() < 0.40) {
                        let botin = Math.floor(dineroVictima * 0.30);
                        db.cartera[victimaRobo] -= botin;
                        db.cartera[sender] = (db.cartera[sender] || 0) + botin;
                        guardarBD();
                        await enviarRespuesta(from, { text: `Operación de sustracción ejecutada con éxito. Botín obtenido: $${botin} sustraídos a @${victimaRobo.split('@')[0]}.`, mentions: [victimaRobo] } + footerCreditos);
                    } else {
                        let multa = 1000;
                        db.cartera[sender] = Math.max(0, (db.cartera[sender] || 0) - multa);
                        guardarBD();
                        await enviarRespuesta(from, `La operación ha fracasado. Autoridades locales han impuesto una sanción penal de $${multa}.${footerCreditos}`);
                    }
                    break;

                case 'robargb':
                case 'robarbanco':
                    db.banco ||= {};
                    db.nivelBanco ||= {};
                    const victimaBanco = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!victimaBanco) return enviarRespuesta(from, `Debe etiquetar al usuario titular de la cuenta bancaria a vulnerar.${footerCreditos}`);
                    let bancoVictima = db.banco[victimaBanco] || 0;
                    let lvVictima = db.nivelBanco[victimaBanco] || 1;
                    if (bancoVictima < 2000) return enviarRespuesta(from, `El banco del objetivo posee reservas insuficientes para justificar la operación.${footerCreditos}`);
                    let probabilidadExito = 0.35 - (lvVictima * 0.025);
                    if (Math.random() < probabilidadExito) {
                        let botinBanco = Math.floor(bancoVictima * 0.15);
                        db.banco[victimaBanco] -= botinBanco;
                        db.cartera[sender] = (db.cartera[sender] || 0) + botinBanco;
                        guardarBD();
                        await enviarRespuesta(from, { text: `Invasión informática superada. Se han vulnerado las defensas Nv.${lvVictima} y extraído $${botinBanco} de la cuenta de @${victimaBanco.split('@')[0]}.`, mentions: [victimaBanco] } + footerCreditos);
                    } else {
                        let perdidaAtraco = 2500;
                        db.cartera[sender] = Math.max(0, (db.cartera[sender] || 0) - perdidaAtraco);
                        guardarBD();
                        await enviarRespuesta(from, `Los cortafuegos de seguridad Nv.${lvVictima} han repelido el ataque. Se han incautado $${perdidaAtraco} como penalización.${footerCreditos}`);
                    }
                    break;

                case 'profile':
                case 'perfil':
                    db.perfil ||= {};
                    db.cartera ||= {};
                    db.banco ||= {};
                    const targetP = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || sender;
                    const pNum = targetP.split('@')[0].split(':')[0];
                    const userDat = db.perfil[targetP] || { nombre: 'No registrado', edad: 'N/A', cumple: 'N/A', bio: 'Sin descripción' };
                    const perfilTexto = `
┌─────────────────────────┐
│     TARJETA DE PERFIL   │
└─────────────────────────┘
• Titular: @${pNum}
• Nombre: ${userDat.nombre}
• Edad: ${userDat.edad}
• Cumpleaños: ${userDat.cumple}
• Contacto: +${pNum}
• Cartera: $${db.cartera[targetP] || 0}
• Banco: $${db.banco[targetP] || 0}
───────────────────────────
[ BIOGRAFÍA ]
${userDat.bio}${footerCreditos}`.trim();
                    await enviarRespuesta(from, { text: perfilTexto, mentions: [targetP] });
                    break;

                case 'setnombre':
                    db.perfil ||= {};
                    db.perfil[sender] ||= {};
                    if (!args.length) return enviarRespuesta(from, `Debe indicar el nombre a registrar. Ej: .setnombre Carlos${footerCreditos}`);
                    db.perfil[sender].nombre = args.join(' ');
                    guardarBD();
                    await enviarRespuesta(from, `Nombre corporativo actualizado a: *${db.perfil[sender].nombre}*.${footerCreditos}`);
                    break;

                case 'setedad':
                    db.perfil ||= {};
                    db.perfil[sender] ||= {};
                    if (!args[0]) return enviarRespuesta(from, `Debe indicar su edad numérica. Ej: .setedad 20${footerCreditos}`);
                    db.perfil[sender].edad = args[0];
                    guardarBD();
                    await enviarRespuesta(from, `Parámetro de edad actualizado exitosamente.${footerCreditos}`);
                    break;

                case 'setcumple':
                    db.perfil ||= {};
                    db.perfil[sender] ||= {};
                    if (!args.length) return enviarRespuesta(from, `Debe indicar su fecha conmemorativa. Ej: .setcumple 29 de Mayo${footerCreditos}`);
                    db.perfil[sender].cumple = args.join(' ');
                    guardarBD();
                    await enviarRespuesta(from, `Fecha de cumpleaños registrada de forma correcta.${footerCreditos}`);
                    break;

                case 'setbio':
                    db.perfil ||= {};
                    db.perfil[sender] ||= {};
                                        if (!args.length) return enviarRespuesta(from, `Debe indicar el texto biográfico. Ej: .setbio Ingeniero de sistemas${footerCreditos}`);
                    db.perfil[sender].bio = args.join(' ');
                    guardarBD();
                    await enviarRespuesta(from, `Biografía actualizada satisfactoriamente.${footerCreditos}`);
                    break;

                // --- MODERACIÓN ---
                case 'abrir':
                case 'cerrar':
                    if (!isGroup) return enviarRespuesta(from, `Comando disponible exclusivamente para grupos.${footerCreditos}`);
                    if (!isAdmins && !isOwner) return enviarRespuesta(from, `Acceso restringido a administradores del grupo.${footerCreditos}`);
                    await sock.groupSettingUpdate(from, command === 'abrir' ? 'not_announcement' : 'announcement');
                    await enviarRespuesta(from, `Configuración modificada: El grupo se encuentra ahora ${command === 'abrir' ? 'abierto' : 'restringido'}.${footerCreditos}`);
                    break;

                case 'tagall':
                    if (!isGroup) return enviarRespuesta(from, `Comando disponible exclusivamente para grupos.${footerCreditos}`);
                    if (!isAdmins && !isOwner) return enviarRespuesta(from, `Acceso restringido a administradores del grupo.${footerCreditos}`);
                    const members = groupMetadata.participants.map(v => v.id);
                    let txtTag = `AVISO GENERAL DE ADMINISTRACIÓN\n\n${args.join(' ') || 'Atención requerida para todos los miembros'}\n\n`;
                    for (let m of members) txtTag += `• @${m.split('@')[0]}\n`;
                    await enviarRespuesta(from, { text: txtTag + footerCreditos, mentions: members });
                    break;

                case 'warn':
                    if (!isGroup) return enviarRespuesta(from, `Comando disponible exclusivamente para grupos.${footerCreditos}`);
                    if (!isAdmins && !isOwner) return enviarRespuesta(from, `Acceso restringido a administradores del grupo.${footerCreditos}`);
                    const targetWarn = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!targetWarn) return enviarRespuesta(from, `Debe etiquetar al usuario que recibirá la amonestación.${footerCreditos}`);
                    db.warns[from] ||= {};
                    db.warns[from][targetWarn] = (db.warns[from][targetWarn] || 0) + 1;
                    guardarBD();
                    await enviarRespuesta(from, { text: `Advertencia aplicada formalmente a @${targetWarn.split('@')[0]} (${db.warns[from][targetWarn]}/3 acumuladas).`, mentions: [targetWarn] } + footerCreditos);
                    if (db.warns[from][targetWarn] >= 3) {
                        try {
                            await sock.groupParticipantsUpdate(from, [targetWarn], 'remove');
                            delete db.warns[from][targetWarn];
                            guardarBD();
                        } catch (e) {}
                    }
                    break;

                case 'kick':
                    if (!isGroup) return enviarRespuesta(from, `Comando disponible exclusivamente para grupos.${footerCreditos}`);
                    if (!isAdmins && !isOwner) return enviarRespuesta(from, `Acceso restringido a administradores del grupo.${footerCreditos}`);
                    const targetKick = mek.message.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
                    if (!targetKick) return enviarRespuesta(from, `Debe etiquetar al miembro que será expulsado.${footerCreditos}`);
                    try {
                        await sock.groupParticipantsUpdate(from, [targetKick], 'remove');
                        await enviarRespuesta(from, { text: `El usuario @${targetKick.split('@')[0]} ha sido apartado del grupo.`, mentions: [targetKick] } + footerCreditos);
                    } catch (e) {}
                    break;
            }
        } catch (err) {
            console.error('Error interno procesando mensaje:', err);
        }
    });
}

iniciarBot();
