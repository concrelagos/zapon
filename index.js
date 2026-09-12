const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const P = require('pino');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// Configuração da Conexão com o Banco de Dados MySQL (mesmo usado no PHP/Hostinger)
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'sistema'
};

let sock;

// Função para formatar o número de telefone para o padrão do Baileys (@s.whatsapp.net)
function formatarNumero(telefone) {
    let numeroLimpo = telefone.replace(/\D/g, '');
    if (!numeroLimpo.startsWith('55')) {
        numeroLimpo = '55' + numeroLimpo;
    }
    return numeroLimpo + '@s.whatsapp.net';
}

// Inicialização da Conexão do WhatsApp utilizando o MySQL para salvar as sessões
async function conectarWhatsApp() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        
        // Garante que a tabela de sessões existe no banco
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessoes (
                id VARCHAR(255) PRIMARY KEY,
                data TEXT
            )
        `);
        await connection.end();

        // Custom auth state usando MySQL para persistir a sessão na Render
        const { state, saveCreds } = await useMySQLAuthState(dbConfig);

        sock = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: P({ level: 'silent' })
        });

        sock.-ev.on('creds.update', saveCreds);

        sock.-ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log('Conexão fechada. Tentando reconectar...', shouldReconnect);
                if (shouldReconnect) {
                    conectarWhatsApp();
                }
            } else if (connection === 'open') {
                console.log('Bot do WhatsApp conectado com sucesso!');
            }
        });

    } catch (err) {
        console.error('Erro ao conectar o WhatsApp:', err);
    }
}

// Implementação do Auth State no MySQL
async function useMySQLAuthState(dbConfig) {
    const pool = mysql.createPool(dbConfig);

    const writeData = async (data, id) => {
        const json = JSON.stringify(data, (key, value) => {
            return Buffer.isBuffer(value) ? { type: 'Buffer', data: Array.from(value) } : value;
        });
        await pool.execute(
            'INSERT INTO whatsapp_sessoes (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
            [id, json, json]
        );
    };

    const readData = async (id) => {
        try {
            const [rows] = await pool.execute('SELECT data FROM whatsapp_sessoes WHERE id = ?', [id]);
            if (!rows.length) return null;
            return JSON.parse(rows[0].data, (key, value) => {
                if (value !== null && typeof value === 'object' && value.type === 'Buffer') {
                    return Buffer.from(value.data);
                }
                return value;
            });
        } catch (error) {
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await pool.execute('DELETE FROM whatsapp_sessoes WHERE id = ?', [id]);
        } catch {}
    };

    const creds = await readData('creds') || (await useMultiFileAuthState('temp')).state.creds;

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    for (const id of ids) {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// ----------------------------------------------------
// ENDPOINT PARA O PHP ENVIAR MENSAGENS VIA CURL
// ----------------------------------------------------
app.post('/send-message', async (req, res) => {
    const { telefone, mensagem } = req.body;

    if (!telefone || !mensagem) {
        return res.status(400).json({ error: 'Telefone e mensagem são obrigatórios.' });
    }

    try {
        if (!sock) {
            return res.status(500).json({ error: 'WhatsApp ainda não inicializado.' });
        }

        const jid = formatarNumero(telefone);
        await sock.sendMessage(jid, { text: mensagem, linkPreview: null });

        return res.json({ status: 'sucesso', mensagem: 'Mensagem enviada com sucesso!' });
    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        return res.status(500).json({ error: err.message });
    }
});

// Inicia o servidor Express e a conexão com o Baileys
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    conectarWhatsApp();
});
