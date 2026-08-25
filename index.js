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

// Rota para visualizar o QR Code perfeito como imagem na web
app.get('/qr', async (req, res) => {
  if (!latestQR) {
    return res.send('<h2>O WhatsApp já está conectado ou nenhum QR Code foi gerado ainda.</h2>');
  }
  try {
    const qrImage = await QRCode.toDataURL(latestQR);
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-center;height:100vh;font-family:sans-serif;background:#0f172a;color:#fff;">
          <h2>Escaneie o QR Code abaixo com o WhatsApp:</h2>
          <img src="${qrImage}" style="border:10px solid white;border-radius:10px;margin-top:20px;" />
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Erro ao gerenciar QR Code: ' + err.message);
  }
});
