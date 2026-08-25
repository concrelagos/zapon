const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const mysql = require('mysql2/promise');
const cron = require('node-cron');
const express = require('express');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

const app = express();
app.use(express.json());

let sock;

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

// Função para formatar o número com DDI 55
function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (limpo.length === 10 || limpo.length === 11) {
    limpo = '55' + limpo;
  }
  return limpo + '@s.whatsapp.net';
}

// Inicializa a sessão do WhatsApp com Baileys
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Escaneie este QR Code no seu WhatsApp:');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
      console.log('Conexão fechada. Reconectando...', shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === 'open') {
      console.log('✅ WhatsApp Conectado com Sucesso!');
    }
  });
}

connectToWhatsApp();

// Endpoint para envio imediato (quando cria o agendamento no PHP)
app.post('/send-message', async (req, res) => {
  const { telefone, mensagem } = req.body;
  try {
    if (!sock) return res.status(500).json({ error: 'WhatsApp ainda não inicializado' });
    const jid = formatarNumero(telefone);
    await sock.sendMessage(jid, { text: mensagem });
    return res.json({ status: 'sucesso' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Rota de saúde para o Render manter o serviço ativo
app.get('/', (req, res) => {
  res.send('Servidor do WhatsApp está rodando!');
});

// CRON JOB: Executa a cada 5 minutos procurando agendamentos a 30 min de distância
cron.schedule('*/5 * * * *', async () => {
  console.log('🔍 Checando lembretes de 30 minutos...');
  try {
    const connection = await pool.getConnection();

    // Query para pegar agendamentos de hoje entre 25 e 35 min a frente
    const [agendamentos] = await connection.execute(`
      SELECT a.id, a.hora, c.nome AS nome_cliente, c.telefone 
      FROM agendamentos a 
      INNER JOIN clientes c ON a.cliente = c.id
      WHERE a.data = CURDATE()
        AND (a.lembrete_enviado IS NULL OR a.lembrete_enviado = 'Não')
        AND TIMESTAMPDIFF(MINUTE, NOW(), CONCAT(a.data, ' ', a.hora)) BETWEEN 25 AND 35
    `);

    for (const item of agendamentos) {
      const msg = `Olá *${item.nome_cliente}*! ⏰\n\nPassando para lembrar que seu agendamento é daqui a *30 minutos* (${item.hora}).\n\nAté logo!`;
      const jid = formatarNumero(item.telefone);

      await sock.sendMessage(jid, { text: msg });

      // Atualiza no MySQL para não reenviar
      await connection.execute(
        'UPDATE agendamentos SET lembrete_enviado = "Sim" WHERE id = ?',
        [item.id]
      );
      console.log(`Lembrete enviado para ${item.nome_cliente}`);
    }

    connection.release();
  } catch (error) {
    console.error('Erro na rotina de lembretes:', error);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});