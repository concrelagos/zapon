const { default: makeWASocket, initAuthCreds, proto, DisconnectReason } = require('@whiskeysockets/baileys');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const express = require('express');
const QRCode = require('qrcode');
require('dotenv').config();

const app = express();
app.use(express.json());

let sock;
let latestQR = '';

// Pool de conexão com o MySQL na Hostinger
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Adapter de autenticação usando MySQL (Sessão perpétua no banco)
async function useMySQLAuthState(pool) {
  const writeData = async (data, id) => {
    const jsonStr = JSON.stringify(data, (key, value) => {
      if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
        return { type: 'Buffer', data: Array.from(value) };
      }
      return value;
    });
    await pool.query(
      'INSERT INTO whatsapp_sessoes (id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = ?',
      [id, jsonStr, jsonStr]
    );
  };

  const readData = async (id) => {
    try {
      const [rows] = await pool.query('SELECT data FROM whatsapp_sessoes WHERE id = ?', [id]);
      if (rows.length === 0) return null;
      return JSON.parse(rows[0].data, (key, value) => {
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
          return Buffer.from(value.data);
        }
        return value;
      });
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id) => {
    await pool.query('DELETE FROM whatsapp_sessoes WHERE id = ?', [id]);
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
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

// Função para formatar o número com DDI 55 para o Baileys
function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (limpo.length === 10 || limpo.length === 11) {
    limpo = '55' + limpo;
  }
  return limpo + '@s.whatsapp.net';
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMySQLAuthState(pool);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      console.log('Novo QR Code gerado! Acesse a rota /qr no seu navegador para escanear.');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Conexão fechada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      latestQR = '';
      console.log('✅ WhatsApp Conectado com Sucesso!');
    }
  });
}

connectToWhatsApp();

// Rota raiz para verificação de status (usada pelo UptimeRobot)
app.get('/', (req, res) => {
  res.send('Servidor do Bot está rodando!');
});

// Rota para visualizar o QR Code como imagem
app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send('<h2>O WhatsApp já está conectado ou nenhum QR Code foi gerado ainda.</h2>');
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0f172a;color:#fff;">
          <h2>Escaneie o QR Code abaixo com o WhatsApp:</h2>
          <img src="${qrImage}" style="border:10px solid white;border-radius:10px;margin-top:20px;" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao gerar QR Code: ' + err.message);
  }
});

// Rota para envio imediato (disparado via PHP para o funcionário)
app.post('/send-message', async (req, res) => {
  const { telefone, mensagem } = req.body;
  try {
    if (!sock) return res.status(500).json({ error: 'WhatsApp ainda não inicializado' });
    const jid = formatarNumero(telefone);
    await sock.sendMessage(jid, { text: mensagem });
    return res.json({ status: 'sucesso' });
  } catch (err) {
    console.error('Erro no endpoint /send-message:', err);
    return res.status(500).json({ error: err.message });
  }
});

// CRON JOB: Checa e envia lembretes de 30 minutos PARA O FUNCIONÁRIO
cron.schedule('*/5 * * * *', async () => {
  console.log('🔍 Checando lembretes de 30 minutos para funcionários...');
  try {
    const connection = await pool.getConnection();
    const [agendamentos] = await connection.execute(`
      SELECT 
        a.id, 
        a.hora, 
        a.obs,
        c.nome AS nome_cliente, 
        c.telefone AS tel_cliente,
        u.nome AS nome_funcionario, 
        u.telefone AS tel_funcionario,
        s.nome AS nome_servico
      FROM agendamentos a 
      INNER JOIN clientes c ON a.cliente = c.id
      INNER JOIN usuarios u ON a.funcionario = u.id
      LEFT JOIN servicos s ON a.servico = s.id
      WHERE a.data = CURDATE()
        AND (a.lembrete_enviado IS NULL OR a.lembrete_enviado = 'Não')
        AND TIMESTAMPDIFF(MINUTE, NOW(), CONCAT(a.data, ' ', a.hora)) BETWEEN 25 AND 35
    `);

    for (const item of agendamentos) {
      if (item.tel_funcionario) {
        // Formata o número do cliente para criar o link do WhatsApp (wa.me)
        let telLimpo = String(item.tel_cliente).replace(/\D/g, '');
        if (telLimpo.length === 10 || telLimpo.length === 11) {
          telLimpo = '55' + telLimpo;
        }
        const linkWa = `https://wa.me/${telLimpo}`;

        const msg = `Olá *${item.nome_funcionario}*! ⏰\n\nLembrete de atendimento em *30 minutos*!\n\n👤 *Cliente:* ${item.nome_cliente}\n✂️ *Serviço:* ${item.nome_servico || 'Não informado'}\n⏰ *Horário:* ${item.hora}\n📝 *Obs:* ${item.obs || 'Nenhuma'}\n\n💬 *Falar com o cliente:*\n${linkWa}`;
        
        const jid = formatarNumero(item.tel_funcionario);

        await sock.sendMessage(jid, { text: msg });
        console.log(`Lembrete enviado com sucesso para o funcionário ${item.nome_funcionario}`);
      }

      // Atualiza para prevenir disparos duplicados
      await connection.execute(
        'UPDATE agendamentos SET lembrete_enviado = "Sim" WHERE id = ?',
        [item.id]
      );
    }

    connection.release();
  } catch (error) {
    console.error('Erro no cron de lembretes:', error);
  }
});

// Proteção global contra falhas não tratadas
process.on('uncaughtException', (err) => {
  console.error('Erro não tratado capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Rejeição não tratada em:', promise, 'motivo:', reason);
});

// Inicialização do servidor na porta fornecida pelo Render
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escutando na porta ${PORT}`);
});
