const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
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

// Função para formatar o número com DDI 55
function formatarNumero(numero) {
  let limpo = String(numero).replace(/\D/g, '');
  if (limpo.length === 10 || limpo.length === 11) {
    limpo = '55' + limpo;
  }
  return limpo + '@s.whatsapp.net';
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

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

// Rota raiz para teste rápido
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

// Rota para envio imediato (disparado via PHP do site)
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

// CRON JOB: Checa lembretes de 30 minutos
cron.schedule('*/5 * * * *', async () => {
  console.log('🔍 Checando lembretes...');
  try {
    const connection = await pool.getConnection();
    const [agendamentos] = await connection.execute(`
      SELECT a.id, a.hora, c.nome AS nome_cliente, c.telefone 
      FROM agendamentos a 
      INNER JOIN clientes c ON a.cliente = c.id
      WHERE a.data = CURDATE()
        AND (a.lembrete_enviado IS NULL OR a.lembrete_enviado = 'Não')
        AND TIMESTAMPDIFF(MINUTE, NOW(), CONCAT(a.data, ' ', a.hora)) BETWEEN 25 AND 35
    `);

    for (const item of agendamentos) {
      const msg = `Olá *${item.nome_cliente}*! ⏰\n\nLembrete: seu agendamento é daqui a *30 minutos* (${item.hora}).`;
      const jid = formatarNumero(item.telefone);

      await sock.sendMessage(jid, { text: msg });

      await connection.execute(
        'UPDATE agendamentos SET lembrete_enviado = "Sim" WHERE id = ?',
        [item.id]
      );
      console.log(`Lembrete enviado para ${item.nome_cliente}`);
    }

    connection.release();
  } catch (error) {
    console.error('Erro no cron:', error);
  }
});

// OBRIGATÓRIO PARA O RENDER: Liga o servidor web na porta informada pelo sistema
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor escutando na porta ${PORT}`);
});
